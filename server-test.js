// Loads server.js with stubbed dependencies and drives real message handlers.
// node --check only proves the file parses; this catches the faults that actually
// reach players — use-before-declaration, bad references, thrown handlers.
const path = require('path');
const Module = require('module');

// --- stub express / ws so the server can start without network deps ---
const routes = {};
const fakeApp = {
  get: (p, fn) => { routes[p] = fn; }, use: () => {}, post: () => {},
  listen: () => ({ on: () => {} })
};
const fakeExpress = () => fakeApp;
fakeExpress.static = () => (req, res, next) => {};
fakeExpress.json = () => (req, res, next) => {};

class FakeWSS {
  constructor() { this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; }
}
const fakeWs = { Server: FakeWSS, WebSocketServer: FakeWSS, OPEN: 1 };

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return fakeExpress;
  if (request === 'ws') return fakeWs;
  if (request === 'http') return { createServer: () => ({ listen: () => {}, on: () => {} }) };
  if (request === 'xlsx') return {
    readFile: () => ({ SheetNames: ['Cards'], Sheets: { Cards: {} } }),
    utils: { sheet_to_json: () => [
      { Name: 'Test Creature', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Fire', Power: 3000, Race: 'Dragonoid',
        'Speed Attacker (yes/No)': 'Yes' },
      { Name: 'Test Gear', Set: 'DM-01', 'Mana Cost': 2, Type: 'Cross Gear',
        Civilization: 'Light', Effect: 'static: +2000 crossedCreature' }
    ] }
  };
  return origLoad.apply(this, arguments);
};

let server;
try {
  server = require('./server.js');
  console.log('server.js: loads without throwing');
} catch (e) {
  console.error('server.js THREW AT LOAD:', e.message);
  console.error((e.stack || '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}
console.log('routes registered:', Object.keys(routes).join(', ') || '(none)');

// --- drive the real websocket handler through a full attack, which is where the
// use-before-declaration bug lived: node --check passed, the game did not ---
const wss = server && server.__wss;
if (!wss || !wss.handlers.connection) {
  console.log('(no exported wss — skipping message drive; export __wss to enable)');
  process.exit(0);
}
const sent = [];
const mkSock = () => {
  const inbox = [];
  return { readyState: 1, OPEN: 1, inbox,
    send(d) { const m = JSON.parse(d); inbox.push(m); sent.push(m); },
    on(ev, fn) { this['_' + ev] = fn; }, close() {} };
};
const a = mkSock(), b = mkSock();
wss.handlers.connection(a); wss.handlers.connection(b);
const say = (sock, msg) => sock._message(JSON.stringify(msg));

try {
  say(a, { type: 'create', name: 'A' });
  const joined = a.inbox.find(m => m.type === 'joined');
  if (!joined) { console.error('no room was created'); process.exit(1); }
  say(b, { type: 'join', room: joined.room, name: 'B' });
  say(a, { type: 'acceptJoin' });
  const deck = new Array(40).fill('DM-01/Test Creature');
  say(a, { type: 'submitDeck', deck });
  say(b, { type: 'submitDeck', deck });
  const latest = (sock) => {
    const m = sock.inbox.filter(x => x.type === 'state').pop();
    return m && m.state;
  };

  let st = latest(a);
  if (!st || !st.players) {
    console.log('no dealt state — messages seen: ' + [...new Set(a.inbox.map(m => m.type))].join(', '));
    process.exit(1);
  }
  const meSeat = st.you;
  console.log('dealt in: hand ' + st.players[meSeat].hand.length + ', shields ' + st.players[meSeat].shields.length);

  // take the turn, build mana, drop a speed attacker, and swing at a shield
  say(a, { type: 'claimTurn' });
  for (let t = 0; t < 3; t++) {
    st = latest(a);
    const h = st.players[meSeat].hand;
    if (h.length) say(a, { type: 'chargeMana', key: h[0].key });
  }
  st = latest(a);
  const hand = st.players[meSeat].hand;
  if (hand.length) say(a, { type: 'summonCard', key: hand[0].key });

  st = latest(a);
  const bz = st.players[meSeat].battlezone;
  if (!bz.length) {
    const why = a.inbox.filter(m => m.type === 'summonRejected').pop();
    console.error('FAIL: no creature reached the battle zone' + (why ? ' — ' + why.reason : ''));
    process.exit(1);
  }
  const oppSeat = meSeat === 0 ? 1 : 0;
  const shieldsBefore = st.players[oppSeat].shields.length;
  const mark = a.inbox.length;
  say(a, { type: 'declareAttack', key: bz[0].key, target: { type: 'shield' } });
  const after = latest(a);
  const rej = a.inbox.slice(mark).filter(m => m.type === 'summonRejected').pop();
  const combat = after && after.combat;
  const shieldsAfter = after.players[oppSeat].shields.length;
  console.log('attack -> shields ' + shieldsBefore + ' -> ' + shieldsAfter +
              ', combat: ' + (combat ? combat.phase : 'resolved') +
              (rej ? ' | rejected: ' + rej.reason.slice(0, 50) : ''));
  // The point of this drive is that the handler RUNS. A use-before-declaration throws
  // out of the message handler, which the surrounding try/catch reports as a failure.
  // Reaching this line at all means the attack path executed end to end.
  if (rej && /Cannot read|is not defined|before initialization/.test(rej.reason || '')) {
    console.error('FAIL: attack handler errored — ' + rej.reason);
    process.exit(1);
  }
  console.log('attack path executed without throwing');
} catch (e) {
  console.error('HANDLER THREW:', e.message);
  console.error((e.stack || '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}
