// Duel Masters virtual tabletop — relay/authority server
// Serves the static client and keeps authoritative game state per room.
// Card images never touch this server — only filenames/paths (strings) do.

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
const connMeta = new Map(); // ws -> { roomCode, idx (null until seated) }

function newRoomCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function newKey() { return crypto.randomBytes(6).toString('hex'); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emptyPlayerState() {
  return { hand: [], deck: [], mana: [], battlezone: [], shields: [], graveyard: [] };
}

function send(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

function broadcastState(room) {
  for (let i = 0; i < 2; i++) {
    const ws = room.sockets[i];
    if (!ws) continue;
    send(ws, { type: 'state', you: i, state: viewFor(room, i) });
  }
}

function viewFor(room, viewerIdx) {
  const s = room.state;
  const mask = (p, isSelf) => ({
    handCount: p.hand.length,
    hand: isSelf ? p.hand : undefined,
    deckCount: p.deck.length,
    mana: p.mana,
    battlezone: p.battlezone,
    shieldCount: p.shields.length,
    shields: p.shields.map(sh => ({ key: sh.key, targeted: sh.targeted })),
    graveyard: p.graveyard
  });
  return {
    turn: s.turn,
    phase: s.phase,
    die: s.die,
    players: [mask(s.players[0], viewerIdx === 0), mask(s.players[1], viewerIdx === 1)],
    you: viewerIdx
  };
}

// Deal ONE player's own zone from their own submitted deck. Independent of the
// other player — nobody has to wait for an opponent to see their own hand.
function dealPlayer(room, idx) {
  const s = room.state;
  const deck = shuffle(room.decks[idx]);
  const p = s.players[idx];
  p.shields = deck.splice(0, 6).map(id => ({ id, key: newKey(), targeted: false }));
  p.hand = deck.splice(0, 5);
  p.deck = deck;
  if (s.phase === 'waiting') s.phase = 'setup';
}

function maybeStartMatch(room) {
  const s = room.state;
  if (s.die[0] !== null) return; // already rolled
  if (!room.decks[0] || !room.decks[1]) return; // both must have dealt
  s.die = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  while (s.die[0] === s.die[1]) {
    s.die = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  }
  s.turn = s.die[0] > s.die[1] ? 0 : 1;
  s.phase = 'charge';
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
      const room = {
        code: roomCode,
        sockets: [ws, null],
        pendingJoin: null,
        decks: [null, null],
        state: { turn: 0, phase: 'waiting', die: [null, null], players: [emptyPlayerState(), emptyPlayerState()] }
      };
      rooms.set(roomCode, room);
      meta.roomCode = roomCode; meta.idx = 0;
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
      send(ws, { type: 'joinPending' });
      send(room.sockets[0], { type: 'joinRequest' });
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

    if (msg.type === 'submitDeck') {
      if (!Array.isArray(msg.deck) || !msg.deck.length) return;
      room.decks[idx] = msg.deck.slice(0, 40);
      dealPlayer(room, idx);
      maybeStartMatch(room);
      broadcastState(room);
      return;
    }

    const s = room.state;
    if (!room.decks[idx]) return; // must have dealt your own hand first
    const me = s.players[idx];
    const opp = s.players[idx === 0 ? 1 : 0];

    switch (msg.type) {
      case 'chargeMana': {
        if (s.turn !== idx || s.phase !== 'charge') return;
        const i = me.hand.indexOf(msg.cardId);
        if (i === -1) return;
        me.hand.splice(i, 1);
        me.mana.push({ id: msg.cardId, key: newKey(), tapped: false });
        break;
      }
      case 'placeCard': {
        if (s.turn !== idx || s.phase !== 'main') return;
        const i = me.hand.indexOf(msg.cardId);
        if (i === -1) return;
        me.hand.splice(i, 1);
        me.battlezone.push({ id: msg.cardId, key: newKey(), tapped: false, targeted: false });
        break;
      }
      case 'discardFromHand': {
        const i = me.hand.indexOf(msg.cardId);
        if (i === -1) return;
        me.hand.splice(i, 1);
        me.graveyard.push(msg.cardId);
        break;
      }
      case 'tapMana': {
        const c = me.mana.find(c => c.key === msg.key);
        if (c) c.tapped = !c.tapped;
        break;
      }
      case 'tapCard': {
        for (const owner of [me, opp]) {
          const c = owner.battlezone.find(c => c.key === msg.key);
          if (c) { c.tapped = !c.tapped; break; }
        }
        break;
      }
      case 'targetCard': {
        if (msg.zone === 'battlezone') {
          const c = opp.battlezone.find(c => c.key === msg.key);
          if (c) c.targeted = !c.targeted;
        } else if (msg.zone === 'shield') {
          const c = opp.shields.find(c => c.key === msg.key);
          if (c) c.targeted = !c.targeted;
        }
        break;
      }
      case 'resolveTarget': {
        let i = me.battlezone.findIndex(c => c.key === msg.key && c.targeted);
        if (i !== -1) {
          const item = me.battlezone.splice(i, 1)[0];
          if (msg.dest === 'hand') me.hand.push(item.id); else me.graveyard.push(item.id);
          break;
        }
        i = me.shields.findIndex(c => c.key === msg.key && c.targeted);
        if (i !== -1) {
          const item = me.shields.splice(i, 1)[0];
          if (msg.dest === 'hand') me.hand.push(item.id); else me.graveyard.push(item.id);
          break;
        }
        break;
      }
      case 'sendManaToGraveyard': {
        const i = me.mana.findIndex(c => c.key === msg.key);
        if (i !== -1) { const item = me.mana.splice(i, 1)[0]; me.graveyard.push(item.id); }
        break;
      }
      case 'sendBattleToGraveyard': {
        const i = me.battlezone.findIndex(c => c.key === msg.key);
        if (i !== -1) { const item = me.battlezone.splice(i, 1)[0]; me.graveyard.push(item.id); }
        break;
      }
      case 'battleToHand': {
        const i = me.battlezone.findIndex(c => c.key === msg.key);
        if (i !== -1) { const item = me.battlezone.splice(i, 1)[0]; me.hand.push(item.id); }
        break;
      }
      case 'endPhase': {
        if (s.turn !== idx) return;
        if (s.phase === 'charge') s.phase = 'main';
        else if (s.phase === 'main') s.phase = 'end';
        break;
      }
      case 'endTurn': {
        if (s.turn !== idx) return;
        s.turn = idx === 0 ? 1 : 0;
        s.phase = 'charge';
        break;
      }
      case 'drawCard': {
        if (s.turn !== idx) return;
        const c = me.deck.shift();
        if (c) me.hand.push(c);
        break;
      }
      default: return;
    }
    broadcastState(room);
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
