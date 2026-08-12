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

// Per-player filtered view. Hand and shield *identity* are only ever sent to
// the owner (and shields never reveal identity at all, even to the owner —
// only a stable "key" so the owner can still target/resolve them).
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
    ready: room.decks.every(d => d),
    started: room.started,
    players: [mask(s.players[0], viewerIdx === 0), mask(s.players[1], viewerIdx === 1)],
    you: viewerIdx
  };
}

function startGameIfReady(room) {
  if (room.started) return;
  if (!room.decks[0] || !room.decks[1]) return;
  if (!room.sockets[0] || !room.sockets[1]) return;

  room.started = true;
  const s = room.state;
  s.players = [emptyPlayerState(), emptyPlayerState()];

  for (let i = 0; i < 2; i++) {
    const deck = shuffle(room.decks[i]);
    const p = s.players[i];
    p.shields = deck.splice(0, 6).map(id => ({ id, key: newKey(), targeted: false }));
    p.hand = deck.splice(0, 5);
    p.deck = deck;
  }

  s.die = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  while (s.die[0] === s.die[1]) {
    s.die = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  }
  s.turn = s.die[0] > s.die[1] ? 0 : 1;
  s.phase = 'charge';
  broadcastState(room);
}

wss.on('connection', (ws) => {
  let roomCode = null;
  let idx = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      roomCode = newRoomCode();
      const room = {
        code: roomCode,
        sockets: [ws, null],
        decks: [null, null],
        started: false,
        state: { turn: 0, phase: 'waiting', die: [null, null], players: [emptyPlayerState(), emptyPlayerState()] }
      };
      rooms.set(roomCode, room);
      idx = 0;
      send(ws, { type: 'joined', room: roomCode, you: 0 });
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get((msg.room || '').toUpperCase());
      if (!room) { send(ws, { type: 'error', message: 'Room not found.' }); return; }
      if (room.sockets[0] && room.sockets[1]) { send(ws, { type: 'error', message: 'Room is full.' }); return; }
      idx = room.sockets[0] ? 1 : 0;
      room.sockets[idx] = ws;
      roomCode = room.code;
      send(ws, { type: 'joined', room: roomCode, you: idx });
      broadcastState(room);
      return;
    }

    const room = rooms.get(roomCode);
    if (!room || idx === null) return;

    if (msg.type === 'submitDeck') {
      if (!Array.isArray(msg.deck)) return;
      room.decks[idx] = msg.deck.slice(0, 40);
      broadcastState(room);
      startGameIfReady(room);
      return;
    }

    if (!room.started) return;
    const s = room.state;
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
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.sockets[idx] = null;
    broadcastState(room);
    if (!room.sockets[0] && !room.sockets[1]) rooms.delete(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Duel Masters table running on port ' + PORT));
