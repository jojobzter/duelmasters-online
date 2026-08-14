// Duel Masters virtual tabletop — relay/authority server.
// No phases, no turn locks — both players can act on their own cards at any
// time. Server only enforces ownership, not turn order.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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
    showingHand: false
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
    graveyard: p.graveyard
  });
  return {
    dealt: [!!room.decks[0], !!room.decks[1]],
    names: [nameFor(room, 0), nameFor(room, 1)],
    gameOver: s.gameOver,
    endGameRequestBy: s.endGameRequestBy,
    surrenderBy: s.surrenderBy,
    rematch: s.rematch,
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
  return { gameOver: null, endGameRequestBy: null, surrenderBy: null, rematch: [false, false],
    players: [emptyPlayerState(), emptyPlayerState()] };
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

    if (!room.decks[idx]) return; // must have dealt your own hand first
    const me = s.players[idx];
    const opp = s.players[oppIdx];
    let logText = null; // set by a case below to emit a log line after the switch

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
        me.mana.push({ id: c.id, key: c.key, tapped: false });
        logText = 'charged ' + cardLabel(c.id) + ' to their mana zone.';
        break;
      }
      case 'summonCard': {
        const i = me.hand.findIndex(c => c.key === msg.key);
        if (i === -1) return;
        const [c] = me.hand.splice(i, 1);
        const { x, y } = battlefieldSlot(me);
        me.battlezone.push({ id: c.id, key: c.key, tapped: false, x, y });
        logText = 'summoned ' + cardLabel(c.id) + '.';
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
