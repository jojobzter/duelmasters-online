// Duel Masters virtual tabletop — relay/authority server.
// No phases, no turn locks — both players can act on their own cards at any
// time. Server only enforces ownership, not turn order.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ---- Card database (name -> {name, cost, type, civs[]}), loaded from any
// .xlsx file sitting in the carddata/ folder — no specific filename required.
// Re-upload an updated file (same folder, any name) to update it — checked on
// every request via file modified-time, so no server restart is needed.
// Cards missing from it, or missing a cost/type, are simply never gated (fail-open by design).
const CARD_DATA_DIR = path.join(__dirname, 'carddata');
let CARD_DB = new Map();
let CARD_DB_SOURCE_PATH = null;
let CARD_DB_MTIME = 0;

function findCardDataFile() {
  try {
    const files = fs.readdirSync(CARD_DATA_DIR).filter(f => f.toLowerCase().endsWith('.xlsx'));
    if (!files.length) return null;
    // if more than one .xlsx is sitting in there, use whichever was modified most recently
    let chosen = files[0], latest = -1;
    for (const f of files) {
      const m = fs.statSync(path.join(CARD_DATA_DIR, f)).mtimeMs;
      if (m > latest) { latest = m; chosen = f; }
    }
    return path.join(CARD_DATA_DIR, chosen);
  } catch (e) {
    return null;
  }
}

function loadCardDatabase(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const db = new Map();
    for (const row of rows) {
      const name = (row['Name'] || '').toString().trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (db.has(key)) continue; // first occurrence wins if the sheet has conflicting duplicate rows
      const costRaw = row['Mana Cost'];
      const costNum = Number(costRaw);
      const cost = (costRaw === undefined || costRaw === null || costRaw === '' || !Number.isFinite(costNum)) ? null : costNum;
      const type = (row['Type'] || '').toString().trim() || null;
      const civRaw = (row['Civilization'] || '').toString().trim();
      const civs = civRaw ? civRaw.split('/').map(s => s.trim()).filter(Boolean) : [];
      db.set(key, { name, cost, type, civs });
    }
    CARD_DB = db;
    console.log('Card database (re)loaded from', filePath, '-', CARD_DB.size, 'unique card names.');
  } catch (e) {
    console.warn('Card database not loaded (' + filePath + '):', e.message);
    CARD_DB = new Map();
  }
}

function ensureCardDatabaseFresh() {
  const filePath = findCardDataFile();
  if (!filePath) {
    if (CARD_DB.size > 0) console.warn('No .xlsx file found in carddata/ anymore — card database cleared.');
    CARD_DB = new Map(); CARD_DB_SOURCE_PATH = null; CARD_DB_MTIME = 0;
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (filePath !== CARD_DB_SOURCE_PATH || stat.mtimeMs !== CARD_DB_MTIME) {
      loadCardDatabase(filePath);
      CARD_DB_SOURCE_PATH = filePath;
      CARD_DB_MTIME = stat.mtimeMs;
    }
  } catch (e) {
    // ignore transient read errors — keep whatever was last loaded
  }
}
ensureCardDatabaseFresh();

app.get('/api/carddata', (req, res) => {
  ensureCardDatabaseFresh();
  res.set('Cache-Control', 'no-store');
  res.json({ count: CARD_DB.size, cards: [...CARD_DB.values()] });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const connMeta = new Map(); // ws -> { roomCode, idx }

function newRoomCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function newKey() { return crypto.randomBytes(6).toString('hex'); }

// Human-readable label for a log line, e.g. "DM-1/Bolshack Dragon.jpg" -> "Bolshack Dragon"
function cardLabel(id) {
  if (!id) return 'a card';
  const file = id.split('/').pop() || id;
  return file.replace(/\.[^.]+$/, '');
}

// Names of cards whose "search your deck" ability the app is allowed to facilitate.
// Add more here if other search-granting cards come up.
const SEARCH_DECK_ENABLERS = ['crystal memory'];
function hasNamedCard(player, nameLower) {
  return player.battlezone.some(c => cardLabel(c.id).toLowerCase() === nameLower);
}
function canSearchDeck(player) {
  return SEARCH_DECK_ENABLERS.some(n => hasNamedCard(player, n));
}
const SKYSWORD_NAME = 'skysword, the savage vizier';
const BRONZE_ARM_NAME = 'bronze-arm tribe';
const ICE_VAPOR_NAME = 'ice vapor, shadow of anguish';

// --- Card effect tables -------------------------------------------------
// Adding another card with one of these behaviours is a one-line change.

// "Choose a creature in the opponent's battlezone and do X to it."
const TARGET_EFFECTS = {
  'spiral gate':  { kind: 'returnToHand' },
  'aqua surfer':  { kind: 'returnToHand' },
  'terror pit':   { kind: 'destroy' },
  'death smoke':  { kind: 'destroyUntapped' }   // untapped creatures only
};

// "The opponent discards from hand."
const OPPONENT_DISCARD_EFFECTS = {
  'ghost touch':   { kind: 'random', count: 1 },
  'cranium clamp': { kind: 'choose', count: 2 },
  'lost soul':     { kind: 'all' }
};

// Shared by summonCard and castFreeFromHand — both are "a card entered the battlezone" events.
function applyOnSummonTriggers(me, opp, cardId) {
  const name = cardLabel(cardId).toLowerCase();
  if (name === 'corile') me.pendingCorileUses = (me.pendingCorileUses || 0) + 1;
  if (name === SKYSWORD_NAME) me.pendingSkyswordMana = (me.pendingSkyswordMana || 0) + 1;
  if (name === BRONZE_ARM_NAME) me.pendingBronzeArm = (me.pendingBronzeArm || 0) + 1;

  const targetEff = TARGET_EFFECTS[name];
  if (targetEff) me.pendingTargets.push({ id: newKey(), kind: targetEff.kind, source: cardLabel(cardId) });

  const discardEff = OPPONENT_DISCARD_EFFECTS[name];
  if (discardEff) opp.pendingDiscards.push({ id: newKey(), kind: discardEff.kind, count: discardEff.count || 0, source: cardLabel(cardId) });

  // Ice Vapor is a passive on the OPPONENT's board: casting a spell into it costs
  // the caster a card from hand and one from mana. Each half is only queued if the
  // caster actually has cards there — otherwise it would sit pending forever.
  const meta = cardMeta(cardId);
  const isSpell = meta && meta.type && /spell/i.test(meta.type);
  if (isSpell && opp.battlezone.some(c => cardLabel(c.id).toLowerCase() === ICE_VAPOR_NAME)) {
    if (me.hand.length) {
      me.pendingDiscards.push({ id: newKey(), kind: 'choose', count: 1, source: 'Ice Vapor, Shadow of Anguish' });
    }
    if (me.mana.length) {
      me.pendingManaDiscards = (me.pendingManaDiscards || 0) + 1;
    }
  }
}

// Cards with Shield Trigger — when returned to hand FROM the shield zone specifically
// (not destroyed, not from mana), the player may cast them immediately for free.
const SHIELD_TRIGGER_CARDS = new Set([
  'holy awe', 'solar ray', 'apocalypse day', 'logic cube', 'logic sphere', 'super spark',
  'miele, vizier of lightning', 'kolon, the oracle', 'phal eega, dawn guardian',
  'syforce, aurora elemental', 'spiral gate', 'teleportation', 'brain serum', 'crystal memory',
  'liquid scope', 'aqua surfer', 'hunter fish', 'aqua jolter', 'terror pit', 'ghost touch',
  'dark reversal', 'critical blade', 'zombie carnival', 'bone assassin, the ambusher',
  'locomotiver', 'burst shot', 'tornado flame', "phantom dragon's flame", 'rikabu, the dismantler',
  'natural snare', 'dimension gate', 'mana crisis', 'mystic inscription', 'torcon', 'dome shell',
  'mighty shouter'
]);
function hasShieldTrigger(id) { return SHIELD_TRIGGER_CARDS.has(cardLabel(id).toLowerCase()); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emptyPlayerState() {
  return {
    hand: [], deck: [], mana: [], battlezone: [], shields: [], graveyard: [],
    showingHand: false, pendingCorileUses: 0, pendingSkyswordMana: 0, pendingSkyswordShield: 0, pendingBronzeArm: 0,
    pendingTargets: [], pendingDiscards: [], pendingManaDiscards: 0
  };
}

function send(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

function broadcastState(room) {
  for (let i = 0; i < 2; i++) {
    const ws = room.sockets[i];
    if (!ws) continue;
    send(ws, { type: 'state', you: i, state: viewFor(room, i) });
  }
}
function broadcastRaw(room, msg) {
  for (let i = 0; i < 2; i++) send(room.sockets[i], msg);
}
function nameFor(room, idx) {
  const ws = room.sockets[idx];
  if (!ws) return null;
  const m = connMeta.get(ws);
  return (m && m.name) || null;
}
function playerLabel(room, idx) {
  return nameFor(room, idx) || ('Player ' + (idx + 1));
}
function logMsg(room, idx, text) {
  broadcastRaw(room, { type: 'log', fromIdx: idx, text: playerLabel(room, idx) + ': ' + text });
}

function viewFor(room, viewerIdx) {
  const s = room.state;
  const mask = (p, isSelf) => ({
    hand: p.hand.map(c => ({ key: c.key, id: (isSelf || p.showingHand) ? c.id : undefined })),
    showingHand: isSelf ? p.showingHand : undefined,
    deckCount: p.deck.length,
    mana: p.mana,
    battlezone: p.battlezone,
    shields: p.shields.map(sh => ({ key: sh.key, faceUp: sh.faceUp, slot: sh.slot, id: sh.faceUp ? sh.id : undefined })),
    graveyard: p.graveyard,
    pendingCorileUses: isSelf ? (p.pendingCorileUses || 0) : undefined,
    pendingSkyswordMana: isSelf ? (p.pendingSkyswordMana || 0) : undefined,
    pendingSkyswordShield: isSelf ? (p.pendingSkyswordShield || 0) : undefined,
    pendingBronzeArm: isSelf ? (p.pendingBronzeArm || 0) : undefined,
    pendingTargets: isSelf ? p.pendingTargets : undefined,
    pendingDiscards: isSelf ? p.pendingDiscards : undefined,
    pendingManaDiscards: isSelf ? (p.pendingManaDiscards || 0) : undefined
  });
  return {
    dealt: [!!room.decks[0], !!room.decks[1]],
    names: [nameFor(room, 0), nameFor(room, 1)],
    gameOver: s.gameOver,
    endGameRequestBy: s.endGameRequestBy,
    surrenderBy: s.surrenderBy,
    rematch: s.rematch,
    soundMap: s.soundMap,
    activeTurn: s.activeTurn,
    players: [mask(s.players[0], viewerIdx === 0), mask(s.players[1], viewerIdx === 1)],
    you: viewerIdx
  };
}

// y is "distance from the owner's own base": 0 = right at their shields.
// Clamped because a card is taller than the half-zone is deep — going higher
// pushes the card body out past the zone and into the shield row.
// Cards render at 1.35x in the battlezone, so columns are spaced wider to match.
function battlefieldSlot(me) {
  const slot = me.battlezone.length;
  const cols = 7;
  const col = slot % cols, row = Math.floor(slot / cols);
  return { x: 2 + col * 13.8, y: Math.min(20, row * 20) };
}

// Single row — overlap is fine and preferred over wrapping to a second row.
function manaSlot(me) {
  const slot = me.mana.length;
  const cols = 14;
  const col = slot % cols;
  return { x: 2 + col * 7, y: 0 };
}

// Shields keep a fixed slot so breaking one leaves a visible gap instead of the
// rest sliding over. A newly added shield fills the lowest free slot.
function nextShieldSlot(me) {
  const used = new Set(me.shields.map(s => s.slot));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

function cardMeta(id) { ensureCardDatabaseFresh(); return CARD_DB.get(cardLabel(id).toLowerCase()) || null; }

// Figures out which untapped mana cards would pay for a card, respecting both
// the total cost and needing at least one untapped mana of each required
// civilization. Returns a Set of mana keys to tap, or null if it can't be paid.
// Pure/read-only — callers tap the returned keys themselves.
//
// After covering the civilization requirements, the remaining generic cost is
// filled by preferring whichever civilization currently has the MOST spare
// untapped mana — e.g. with 2 Nature + 2 Fire untapped and a cost-2 mono-Nature
// card, this pays with 1 Nature + 1 Fire (not 2 Nature), so a second copy of
// that same card can still be paid for afterward instead of getting starved.
function planManaPayment(me, meta) {
  const untapped = me.mana.filter(m => !m.tapped);
  if (untapped.length < meta.cost) return null;
  const reserved = new Set();
  for (const civ of (meta.civs || [])) {
    const found = untapped.find(m => {
      if (reserved.has(m.key)) return false;
      const mMeta = cardMeta(m.id);
      return mMeta && mMeta.civs.includes(civ);
    });
    if (!found) return null;
    reserved.add(found.key);
  }
  while (reserved.size < meta.cost) {
    const remaining = untapped.filter(m => !reserved.has(m.key));
    if (!remaining.length) return null;
    const civCounts = new Map();
    for (const m of remaining) {
      const mMeta = cardMeta(m.id);
      const civs = (mMeta && mMeta.civs.length) ? mMeta.civs : ['__unknown__'];
      for (const cv of civs) civCounts.set(cv, (civCounts.get(cv) || 0) + 1);
    }
    let best = remaining[0], bestScore = -1;
    for (const m of remaining) {
      const mMeta = cardMeta(m.id);
      const civs = (mMeta && mMeta.civs.length) ? mMeta.civs : ['__unknown__'];
      const score = Math.max(...civs.map(cv => civCounts.get(cv) || 0));
      if (score > bestScore) { bestScore = score; best = m; }
    }
    reserved.add(best.key);
  }
  return reserved;
}

function dealPlayer(room, idx) {
  const s = room.state;
  const deck = shuffle(room.decks[idx]);
  const p = s.players[idx];
  p.shields = deck.splice(0, 6).map((id, i) => ({ id, key: newKey(), targeted: false, faceUp: false, slot: i }));
  p.hand = deck.splice(0, 5).map(id => ({ id, key: newKey() }));
  p.deck = deck;
  p.battlezone = []; p.mana = []; p.graveyard = []; p.showingHand = false;
}

function freshMatchState() {
  return {
    gameOver: null, endGameRequestBy: null, surrenderBy: null, rematch: [false, false],
    soundMap: Math.random() < 0.5 ? [0, 1] : [1, 0], // which chat-tone index (0 or 1) each player idx uses
    // Purely advisory — nothing is actually locked to turns, this just tracks
    // whose turn the players have agreed it is. null until someone ends a turn.
    activeTurn: null,
    players: [emptyPlayerState(), emptyPlayerState()]
  };
}

function cleanupRoom(room) {
  if (!room.sockets[0] && !room.sockets[1] && !room.pendingJoin) rooms.delete(room.code);
}

wss.on('connection', (ws) => {
  connMeta.set(ws, { roomCode: null, idx: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = connMeta.get(ws);

    if (msg.type === 'create') {
      const roomCode = newRoomCode();
      const room = { code: roomCode, sockets: [ws, null], pendingJoin: null, decks: [null, null], state: freshMatchState() };
      rooms.set(roomCode, room);
      meta.roomCode = roomCode; meta.idx = 0;
      meta.name = (msg.name || '').trim().slice(0, 24) || null;
      send(ws, { type: 'joined', room: roomCode, you: 0 });
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get((msg.room || '').toUpperCase());
      if (!room) { send(ws, { type: 'error', message: 'Room not found.' }); return; }
      if (room.sockets[1]) { send(ws, { type: 'error', message: 'Room is full.' }); return; }
      if (!room.sockets[0]) { send(ws, { type: 'error', message: 'Host is not connected.' }); return; }
      if (room.pendingJoin) { send(ws, { type: 'error', message: 'Someone else is already asking to join — try again shortly.' }); return; }
      room.pendingJoin = ws;
      meta.roomCode = room.code; meta.idx = null;
      meta.name = (msg.name || '').trim().slice(0, 24) || null;
      send(ws, { type: 'joinPending' });
      send(room.sockets[0], { type: 'joinRequest', name: meta.name });
      return;
    }

    if (msg.type === 'respondJoin') {
      const room = rooms.get(meta.roomCode);
      if (!room || meta.idx !== 0 || !room.pendingJoin) return;
      const reqWs = room.pendingJoin;
      room.pendingJoin = null;
      if (msg.accept) {
        room.sockets[1] = reqWs;
        connMeta.get(reqWs).idx = 1;
        send(reqWs, { type: 'joined', room: room.code, you: 1 });
        broadcastState(room);
      } else {
        send(reqWs, { type: 'joinDeclined' });
      }
      return;
    }

    if (!meta.roomCode || meta.idx === null) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const idx = meta.idx;
    const oppIdx = idx === 0 ? 1 : 0;
    const s = room.state;

    if (msg.type === 'submitDeck') {
      if (!Array.isArray(msg.deck) || !msg.deck.length) return;
      room.decks[idx] = msg.deck.slice(0, 40);
      dealPlayer(room, idx);
      broadcastState(room);
      logMsg(room, idx, 'joined the table and drew their opening hand.');
      return;
    }

    if (msg.type === 'flash') {
      broadcastRaw(room, { type: 'flash', zone: msg.zone, ownerIdx: msg.ownerIdx, key: msg.key });
      return;
    }

    if (msg.type === 'chatMessage') {
      const text = (msg.text || '').toString().trim().slice(0, 500);
      if (!text) return;
      broadcastRaw(room, { type: 'chat', from: playerLabel(room, idx), fromIdx: idx, text });
      return;
    }

    if (msg.type === 'requestSearchDeck') {
      if (!room.decks[idx]) return;
      const me0 = s.players[idx];
      if (!canSearchDeck(me0)) return;
      send(ws, { type: 'searchDeckOffer', cards: me0.deck.slice() });
      return;
    }

    if (!room.decks[idx]) return; // must have dealt your own hand first
    const me = s.players[idx];
    const opp = s.players[oppIdx];

    // An unpaid Ice Vapor mana cost blocks the caster's own plays until it's paid.
    // Only their own board actions are gated — they can still chat, resolve the
    // debt itself, tap/untap, or concede, so it can never soft-lock the game.
    const BLOCKED_WHILE_OWING = new Set([
      'chargeMana', 'summonCard', 'castFreeFromHand', 'drawCard', 'shuffleDeck',
      'requestSearchDeck', 'searchDeckPick', 'endTurn',
      'skyswordToMana', 'skyswordToShield', 'bronzeArmToMana'
    ]);
    if (me.pendingManaDiscards > 0 && BLOCKED_WHILE_OWING.has(msg.type)) {
      send(ws, { type: 'summonRejected', reason: 'Ice Vapor: you must send a card from your mana zone to the graveyard first.\n\nRight-click a card in your mana zone and choose "Send to Graveyard (Ice Vapor)".' });
      return;
    }

    let logText = null; // set by a case below to emit a log line after the switch
    let shieldTriggerOfferKey = null, shieldTriggerOfferId = null; // set when a shield-trigger card is returned to hand
    let sfxToPlay = null; // set by a case below to broadcast a sound-effect cue

    switch (msg.type) {
      case 'drawCard': {
        const c = me.deck.shift();
        if (c) {
          me.hand.push({ id: c, key: newKey() });
          // Off-turn draws are legitimate (shield triggers, forced draws, etc.) but
          // are flagged in the log so an accidental one is easy to spot after the fact.
          const offTurn = (s.activeTurn !== null && s.activeTurn !== undefined && s.activeTurn !== idx);
          logText = offTurn ? 'drew a card OUT OF TURN.' : 'drew a card.';
          sfxToPlay = 'draw';
        }
        break;
      }
      case 'shuffleDeck': { me.deck = shuffle(me.deck); logText = 'shuffled their deck.'; break; }
      case 'endTurn': {
        // advisory only — passes the turn marker, doesn't restrict what either player can do
        s.activeTurn = oppIdx;
        // untap step: the player whose turn is starting untaps their mana and creatures
        let untapped = 0;
        for (const m of opp.mana) { if (m.tapped) { m.tapped = false; untapped++; } }
        for (const c of opp.battlezone) { if (c.tapped) { c.tapped = false; untapped++; } }
        logText = 'ended their turn.' + (untapped ? " (Opponent's cards untapped.)" : '');
        sfxToPlay = 'turn';
        break;
      }
      case 'claimTurn': {
        s.activeTurn = idx;
        logText = 'took the turn.';
        break;
      }

      case 'chargeMana': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        const mSlot = manaSlot(me);
        me.mana.push({ id: c.id, key: c.key, tapped: false, x: mSlot.x, y: mSlot.y });
        logText = 'charged ' + cardLabel(c.id) + ' to their mana zone.';
        break;
      }
      case 'summonCard': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const cardId = me.hand[i].id;
        const meta = cardMeta(cardId);
        if (meta && meta.cost != null) {
          const plan = planManaPayment(me, meta);
          if (!plan) {
            const civText = meta.civs.length ? (' (needs ' + meta.civs.join('/') + ' civilization mana)') : '';
            const untappedDesc = me.mana.filter(m => !m.tapped).map(m => {
              const mMeta = cardMeta(m.id);
              const civLabel = !mMeta ? 'not found in card database' : (mMeta.civs.length ? mMeta.civs.join('/') : 'no civilization data');
              return cardLabel(m.id) + ' [' + civLabel + ']';
            }).join(', ') || 'none';
            send(ws, {
              type: 'summonRejected',
              reason: 'Not enough mana to summon ' + cardLabel(cardId) + ' — costs ' + meta.cost + civText + '.\n\nYour untapped mana: ' + untappedDesc
            });
            return;
          }
          plan.forEach(k => { const m = me.mana.find(mm => mm.key === k); if (m) m.tapped = true; });
        }
        const [c] = me.hand.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y });
        logText = 'summoned ' + cardLabel(c.id) + '.';
        applyOnSummonTriggers(me, opp, c.id);
        break;
      }
      case 'castFreeFromHand': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        if (!hasShieldTrigger(me.hand[i].id)) return; // only valid for actual Shield Trigger cards
        const [c] = me.hand.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y });
        logText = 'used Shield Trigger to cast ' + cardLabel(c.id) + ' for free.';
        sfxToPlay = 'shieldTrigger';
        applyOnSummonTriggers(me, opp, c.id);
        break;
      }
      case 'discardFromHand': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'discarded ' + cardLabel(c.id) + '.';
        break;
      }
      case 'handCardToDeckShuffle': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        me.deck.push(c.id);
        me.deck = shuffle(me.deck);
        logText = 'returned a card from hand to their deck and shuffled.';
        break;
      }
      case 'setShowingHand': {
        me.showingHand = !!msg.show;
        logText = me.showingHand ? 'started showing their hand to their opponent.' : 'stopped showing their hand.';
        break;
      }

      case 'manaTap': {
        const c = me.mana.find(c => c.key === msg.key);
        if (c) { c.tapped = !c.tapped; logText = (c.tapped ? 'tapped ' : 'untapped ') + cardLabel(c.id) + ' in their mana zone.'; }
        break;
      }
      case 'manaMove': {
        const c = me.mana.find(c => c.key === msg.key);
        if (c) { c.x = msg.x; c.y = msg.y; logText = 'repositioned ' + cardLabel(c.id) + ' in their mana zone.'; }
        break;
      }
      case 'manaReturnToHand': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.mana.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' from mana to hand.';
        break;
      }
      case 'manaDestroy': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.mana.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'sent ' + cardLabel(c.id) + ' from mana to the graveyard.';
        break;
      }
      case 'manaToDeckShuffle': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.mana.splice(i, 1);
        me.deck.push(c.id);
        me.deck = shuffle(me.deck);
        logText = 'put ' + cardLabel(c.id) + ' from mana back into their deck and shuffled.';
        break;
      }

      case 'shieldReturnToHand': {
        const i = me.shields.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.shields.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = c.faceUp ? ('returned shield ' + cardLabel(c.id) + ' to hand.') : 'returned a shield to hand.';
        if (hasShieldTrigger(c.id)) { shieldTriggerOfferKey = c.key; shieldTriggerOfferId = c.id; }
        break;
      }
      case 'shieldToGraveyard': {
        const i = me.shields.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.shields.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'put a shield (' + cardLabel(c.id) + ') into the graveyard.';
        break;
      }
      case 'shieldFlip': {
        const c = me.shields.find(c => c.key === msg.key);
        if (c) { c.faceUp = !c.faceUp; logText = c.faceUp ? ('flipped a shield face up: ' + cardLabel(c.id) + '.') : 'turned a shield back face down.'; }
        break;
      }

      case 'battleTap': {
        // deliberately not owner-restricted: some cards let you tap an opponent's creature
        for (const owner of [me, opp]) {
          const c = owner.battlezone.find(c => c.key === msg.key);
          if (c) { c.tapped = !c.tapped; logText = (c.tapped ? 'tapped ' : 'untapped ') + cardLabel(c.id) + '.'; break; }
        }
        break;
      }
      case 'battleMove': {
        const c = me.battlezone.find(c => c.key === msg.key);
        if (c) { c.x = msg.x; c.y = msg.y; logText = 'repositioned ' + cardLabel(c.id) + ' on the battlefield.'; }
        break;
      }
      case 'battleDestroy': {
        const i = me.battlezone.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.battlezone.splice(i, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        logText = 'destroyed ' + cardLabel(c.id) + '.';
        break;
      }
      case 'battleReturn': {
        const i = me.battlezone.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.battlezone.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' from the battlefield to hand.';
        break;
      }

      case 'gyReturnToHand': {
        const i = me.graveyard.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.graveyard.splice(i, 1);
        me.hand.push({ id: c.id, key: c.key });
        logText = 'returned ' + cardLabel(c.id) + ' from the graveyard to hand.';
        break;
      }
      case 'gyReturnToDeckShuffle': {
        const i = me.graveyard.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.graveyard.splice(i, 1);
        me.deck.push(c.id);
        me.deck = shuffle(me.deck);
        logText = 'shuffled ' + cardLabel(c.id) + ' from the graveyard back into their deck.';
        break;
      }
      case 'gyReturnToBattlefield': {
        const i = me.graveyard.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.graveyard.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y });
        logText = 'returned ' + cardLabel(c.id) + ' from the graveyard to the battlefield.';
        break;
      }

      case 'searchDeckPick': {
        if (!canSearchDeck(me)) return;
        const i = msg.index;
        if (typeof i !== 'number' || i < 0 || i >= me.deck.length) return;
        const [cardId] = me.deck.splice(i, 1);
        me.hand.push({ id: cardId, key: newKey() });
        me.deck = shuffle(me.deck);
        logText = 'searched their deck and shuffled.'; // card taken is intentionally not named, per privacy
        break;
      }
      case 'searchDeckCancel': {
        if (!canSearchDeck(me)) return;
        me.deck = shuffle(me.deck);
        logText = 'searched their deck and shuffled.';
        break;
      }
      case 'corilePutOnDeck': {
        if (!me.pendingCorileUses) return;
        const i = opp.battlezone.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = opp.battlezone.splice(i, 1);
        opp.deck.unshift(c.id);
        me.pendingCorileUses -= 1;
        logText = "used Corile to put " + cardLabel(c.id) + " on top of their opponent's deck.";
        break;
      }
      case 'corileSkip': {
        if (!me.pendingCorileUses) return;
        me.pendingCorileUses -= 1;
        logText = 'chose not to use a pending Corile ability.';
        break;
      }
      case 'skyswordToMana': {
        if (!me.pendingSkyswordMana) return;
        const cardId = me.deck.shift();
        me.pendingSkyswordMana -= 1;
        me.pendingSkyswordShield = (me.pendingSkyswordShield || 0) + 1;
        if (cardId) {
          const mSlot = manaSlot(me);
          me.mana.push({ id: cardId, key: newKey(), tapped: false, x: mSlot.x, y: mSlot.y });
          logText = 'used Skysword, the Savage Vizier to put ' + cardLabel(cardId) + ' from their deck into their mana zone.';
        } else {
          logText = "used Skysword, the Savage Vizier, but their deck was empty.";
        }
        break;
      }
      case 'skyswordToShield': {
        if (!me.pendingSkyswordShield) return;
        const cardId = me.deck.shift();
        me.pendingSkyswordShield -= 1;
        if (cardId) me.shields.push({ id: cardId, key: newKey(), faceUp: false, slot: nextShieldSlot(me) });
        logText = 'used Skysword, the Savage Vizier to put the next card of their deck face down into their shield zone.';
        break;
      }
      case 'bronzeArmToMana': {
        if (!me.pendingBronzeArm) return;
        const cardId = me.deck.shift();
        me.pendingBronzeArm -= 1;
        if (cardId) {
          const mSlot = manaSlot(me);
          me.mana.push({ id: cardId, key: newKey(), tapped: false, x: mSlot.x, y: mSlot.y });
          logText = 'used Bronze-Arm Tribe to put ' + cardLabel(cardId) + ' from their deck into their mana zone.';
        } else {
          logText = 'used Bronze-Arm Tribe, but their deck was empty.';
        }
        break;
      }

      case 'effectTarget': {
        const i = me.pendingTargets.findIndex(t => t.id === msg.effectId);
        if (i === -1) return;
        const eff = me.pendingTargets[i];
        const ci = opp.battlezone.findIndex(c => c.key === msg.key);
        if (ci === -1) return;
        const card = opp.battlezone[ci];
        if (eff.kind === 'destroyUntapped' && card.tapped) {
          send(ws, { type: 'summonRejected', reason: eff.source + ' can only destroy an UNTAPPED creature. That one is tapped.' });
          return;
        }
        opp.battlezone.splice(ci, 1);
        if (eff.kind === 'returnToHand') {
          opp.hand.push({ id: card.id, key: card.key });
          logText = 'used ' + eff.source + ' to return ' + cardLabel(card.id) + " to their opponent's hand.";
        } else {
          opp.graveyard.push({ id: card.id, key: card.key });
          logText = 'used ' + eff.source + ' to destroy ' + cardLabel(card.id) + '.';
        }
        me.pendingTargets.splice(i, 1);
        break;
      }
      case 'effectTargetSkip': {
        const i = me.pendingTargets.findIndex(t => t.id === msg.effectId);
        if (i === -1) return;
        logText = "didn't use " + me.pendingTargets[i].source + '.';
        me.pendingTargets.splice(i, 1);
        break;
      }
      case 'effectDiscardResolve': {
        const i = me.pendingDiscards.findIndex(d => d.id === msg.effectId);
        if (i === -1) return;
        const eff = me.pendingDiscards[i];
        const moved = [];
        if (eff.kind === 'random') {
          if (me.hand.length) {
            const r = Math.floor(Math.random() * me.hand.length);
            const [c] = me.hand.splice(r, 1);
            me.graveyard.push({ id: c.id, key: c.key });
            moved.push(cardLabel(c.id));
          }
        } else if (eff.kind === 'all') {
          while (me.hand.length) {
            const [c] = me.hand.splice(0, 1);
            me.graveyard.push({ id: c.id, key: c.key });
            moved.push(cardLabel(c.id));
          }
        } else { // 'choose'
          const keys = Array.isArray(msg.keys) ? msg.keys.slice(0, eff.count) : [];
          for (const k of keys) {
            const idx = me.hand.findIndex(c => c.key === k);
            if (idx !== -1) {
              const [c] = me.hand.splice(idx, 1);
              me.graveyard.push({ id: c.id, key: c.key });
              moved.push(cardLabel(c.id));
            }
          }
        }
        // naming them is fine — they're in the graveyard now, which both players can inspect
        logText = moved.length
          ? ('discarded ' + moved.join(', ') + ' to ' + eff.source + '.')
          : ('had no cards to discard to ' + eff.source + '.');
        me.pendingDiscards.splice(i, 1);
        break;
      }
      case 'effectDiscardMana': {
        if (!me.pendingManaDiscards) return;
        const idx = me.mana.findIndex(c => c.key === msg.key);
        if (idx === -1) return;
        const [c] = me.mana.splice(idx, 1);
        me.graveyard.push({ id: c.id, key: c.key });
        me.pendingManaDiscards -= 1;
        logText = 'sent ' + cardLabel(c.id) + ' from mana to the graveyard (Ice Vapor).';
        break;
      }

      case 'requestEndGame': {
        if (s.gameOver) return;
        // If no opponent is actually seated/dealt in, there's nobody to agree —
        // end it straight away instead of waiting on a confirmation that can never come.
        if (!room.sockets[oppIdx] || !room.decks[oppIdx]) {
          s.gameOver = { reason: 'agreed' };
          s.endGameRequestBy = null;
          logText = 'ended the game.';
          break;
        }
        s.endGameRequestBy = idx;
        logText = 'asked to end the game.';
        break;
      }
      case 'respondEndGame': {
        if (s.endGameRequestBy === null || s.endGameRequestBy === idx) return;
        if (msg.accept) { s.gameOver = { reason: 'agreed' }; logText = 'agreed to end the game.'; }
        else logText = 'declined to end the game.';
        s.endGameRequestBy = null;
        break;
      }
      case 'surrender': {
        if (s.gameOver || s.surrenderBy !== null) return;
        // no opponent seated to accept it — just end the game
        if (!room.sockets[oppIdx] || !room.decks[oppIdx]) {
          s.gameOver = { reason: 'agreed' };
          logText = 'ended the game.';
          break;
        }
        s.surrenderBy = idx;
        logText = 'surrendered.';
        break;
      }
      case 'acceptSurrender': {
        if (s.surrenderBy === null || s.surrenderBy === idx) return;
        s.gameOver = { reason: 'surrender', by: s.surrenderBy };
        s.surrenderBy = null;
        logText = "accepted their opponent's surrender.";
        break;
      }
      case 'rematchVote': {
        s.rematch[idx] = true;
        logText = 'voted for a rematch.';
        // solo in the room: no second vote is coming, so restart immediately
        const oppPresent = room.sockets[oppIdx] && room.decks[oppIdx];
        if ((s.rematch[0] && s.rematch[1]) || !oppPresent) {
          room.state = freshMatchState();
          if (room.decks[0]) dealPlayer(room, 0);
          if (room.decks[1]) dealPlayer(room, 1);
        }
        break;
      }

      default: return;
    }
    broadcastState(room);
    if (logText) logMsg(room, idx, logText);
    if (shieldTriggerOfferKey) send(ws, { type: 'shieldTriggerOffer', key: shieldTriggerOfferKey, id: shieldTriggerOfferId });
    if (sfxToPlay) broadcastRaw(room, { type: 'sfx', name: sfxToPlay });
  });

  ws.on('close', () => {
    const meta = connMeta.get(ws);
    connMeta.delete(ws);
    if (!meta || !meta.roomCode) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    if (room.pendingJoin === ws) room.pendingJoin = null;
    if (meta.idx !== null) room.sockets[meta.idx] = null;
    broadcastState(room);
    cleanupRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Duel Masters table running on port ' + PORT));
