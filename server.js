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

// ---- Card database (name -> {name, cost, type, civs[]}), loaded from the
// spreadsheet at carddata/Duel_Masters_Card_Database.xlsx. Re-upload that
// file (same path) to update it — checked on every request via its file
// modified-time, so no server restart is needed for changes to take effect.
// Cards missing from it, or missing a cost/type, are simply never gated (fail-open by design).
const CARD_DATA_PATH = path.join(__dirname, 'carddata', 'Duel_Masters_Card_Database.xlsx');
let CARD_DB = new Map();
let CARD_DB_MTIME = 0;

function loadCardDatabase() {
  try {
    const wb = XLSX.readFile(CARD_DATA_PATH);
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
    console.log('Card database (re)loaded:', CARD_DB.size, 'unique card names.');
  } catch (e) {
    console.warn('Card database not loaded (' + CARD_DATA_PATH + '):', e.message);
    CARD_DB = new Map();
  }
}

function ensureCardDatabaseFresh() {
  try {
    const stat = fs.statSync(CARD_DATA_PATH);
    if (stat.mtimeMs !== CARD_DB_MTIME) {
      loadCardDatabase();
      CARD_DB_MTIME = stat.mtimeMs;
    }
  } catch (e) {
    // file missing — leave CARD_DB whatever it last was (likely empty on first boot)
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

// Shared by summonCard and castFreeFromHand — both are "a card entered the battlezone" events.
function applyOnSummonTriggers(me, cardId) {
  const name = cardLabel(cardId).toLowerCase();
  if (name === 'corile') me.pendingCorileUses = (me.pendingCorileUses || 0) + 1;
  if (name === SKYSWORD_NAME) me.pendingSkyswordMana = (me.pendingSkyswordMana || 0) + 1;
  if (name === BRONZE_ARM_NAME) me.pendingBronzeArm = (me.pendingBronzeArm || 0) + 1;
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
    showingHand: false, pendingCorileUses: 0, pendingSkyswordMana: 0, pendingSkyswordShield: 0, pendingBronzeArm: 0
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
  broadcastRaw(room, { type: 'log', text: playerLabel(room, idx) + ': ' + text });
}

function viewFor(room, viewerIdx) {
  const s = room.state;
  const mask = (p, isSelf) => ({
    hand: p.hand.map(c => ({ key: c.key, id: (isSelf || p.showingHand) ? c.id : undefined })),
    showingHand: isSelf ? p.showingHand : undefined,
    deckCount: p.deck.length,
    mana: p.mana,
    battlezone: p.battlezone,
    shields: p.shields.map(sh => ({ key: sh.key, faceUp: sh.faceUp, id: sh.faceUp ? sh.id : undefined })),
    graveyard: p.graveyard,
    pendingCorileUses: isSelf ? (p.pendingCorileUses || 0) : undefined,
    pendingSkyswordMana: isSelf ? (p.pendingSkyswordMana || 0) : undefined,
    pendingSkyswordShield: isSelf ? (p.pendingSkyswordShield || 0) : undefined,
    pendingBronzeArm: isSelf ? (p.pendingBronzeArm || 0) : undefined
  });
  return {
    dealt: [!!room.decks[0], !!room.decks[1]],
    names: [nameFor(room, 0), nameFor(room, 1)],
    gameOver: s.gameOver,
    endGameRequestBy: s.endGameRequestBy,
    surrenderBy: s.surrenderBy,
    rematch: s.rematch,
    soundMap: s.soundMap,
    players: [mask(s.players[0], viewerIdx === 0), mask(s.players[1], viewerIdx === 1)],
    you: viewerIdx
  };
}

function battlefieldSlot(me) {
  const slot = me.battlezone.length;
  const cols = 6;
  const col = slot % cols, row = Math.floor(slot / cols);
  return { x: 4 + col * 15.5, y: 4 + row * 34 };
}

function manaSlot(me) {
  const slot = me.mana.length;
  const cols = 8;
  const col = slot % cols, row = Math.floor(slot / cols);
  return { x: 3 + col * 12, y: 4 + row * 44 };
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
  p.shields = deck.splice(0, 6).map(id => ({ id, key: newKey(), targeted: false, faceUp: false }));
  p.hand = deck.splice(0, 5).map(id => ({ id, key: newKey() }));
  p.deck = deck;
  p.battlezone = []; p.mana = []; p.graveyard = []; p.showingHand = false;
}

function freshMatchState() {
  return {
    gameOver: null, endGameRequestBy: null, surrenderBy: null, rematch: [false, false],
    soundMap: Math.random() < 0.5 ? [0, 1] : [1, 0], // which chat-tone index (0 or 1) each player idx uses
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
    let logText = null; // set by a case below to emit a log line after the switch
    let shieldTriggerOfferKey = null, shieldTriggerOfferId = null; // set when a shield-trigger card is returned to hand
    let sfxToPlay = null; // set by a case below to broadcast a sound-effect cue

    switch (msg.type) {
      case 'drawCard': {
        const c = me.deck.shift();
        if (c) { me.hand.push({ id: c, key: newKey() }); logText = 'drew a card.'; }
        break;
      }
      case 'shuffleDeck': { me.deck = shuffle(me.deck); logText = 'shuffled their deck.'; break; }

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
            send(ws, { type: 'summonRejected', reason: 'Not enough mana to summon ' + cardLabel(cardId) + ' — costs ' + meta.cost + civText + '.' });
            return;
          }
          plan.forEach(k => { const m = me.mana.find(mm => mm.key === k); if (m) m.tapped = true; });
        }
        const [c] = me.hand.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y });
        logText = 'summoned ' + cardLabel(c.id) + '.';
        applyOnSummonTriggers(me, c.id);
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
        applyOnSummonTriggers(me, c.id);
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
        if (cardId) me.shields.push({ id: cardId, key: newKey(), faceUp: false });
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

      case 'requestEndGame': {
        if (s.gameOver) return;
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
        if (s.rematch[0] && s.rematch[1]) {
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
