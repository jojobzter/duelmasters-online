// Regression test for the "grant <keyword> ownCreature; grant <keyword2> target"
// pattern (Magma Gazer: "One of your creatures gets Power Attacker +4000 and
// Double Breaker until the end of the turn"). Loads server.js with stubbed
// dependencies, drives real message handlers end to end, and checks:
//   1. With exactly one legal creature, both keywords land on it immediately
//      (no prompt needed).
//   2. With two legal creatures, the player is prompted ONCE (a single
//      pendingTargets entry, not two), and choosing one applies BOTH keywords
//      to that creature only.
const Module = require('module');

const routes = {};
const fakeApp = { get: (p, fn) => { routes[p] = fn; }, use: () => {}, post: () => {}, listen: () => ({ on: () => {} }) };
const fakeExpress = () => fakeApp;
fakeExpress.static = () => (req, res, next) => {};
fakeExpress.json = () => (req, res, next) => {};
class FakeWSS { constructor() { this.handlers = {}; } on(ev, fn) { this.handlers[ev] = fn; } }
const fakeWs = { Server: FakeWSS, WebSocketServer: FakeWSS, OPEN: 1 };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return fakeExpress;
  if (request === 'ws') return fakeWs;
  if (request === 'http') return { createServer: () => ({ listen: () => {}, on: () => {} }) };
  if (request === 'xlsx') return {
    readFile: () => ({ SheetNames: ['Cards'], Sheets: { Cards: {} } }),
    utils: { sheet_to_json: () => [
      { Name: 'Test Attacker', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Fire', Power: 1000, Race: 'Dragonoid' },
      { Name: 'Test Magma Gazer', Set: 'DM-01', 'Mana Cost': 3, Type: 'Spell',
        Civilization: 'Fire',
        Effect: 'onSummon: grant powerAttacker[+4000] ownCreature; onSummon: grant doubleBreaker target' }
    ] }
  };
  return origLoad.apply(this, arguments);
};

const server = require('./server.js');
const wss = server.__wss;
if (!wss || !wss.handlers.connection) { console.error('no exported wss'); process.exit(1); }

const mkSock = () => {
  const inbox = [];
  return { readyState: 1, OPEN: 1, inbox,
    send(d) { inbox.push(JSON.parse(d)); },
    on(ev, fn) { this['_' + ev] = fn; }, close() {} };
};
const say = (sock, msg) => sock._message(JSON.stringify(msg));
const latest = (sock) => { const m = sock.inbox.filter(x => x.type === 'state').pop(); return m && m.state; };

function newRoom() {
  const a = mkSock(), b = mkSock();
  wss.handlers.connection(a); wss.handlers.connection(b);
  say(a, { type: 'create', name: 'A' });
  const joined = a.inbox.find(m => m.type === 'joined');
  say(b, { type: 'join', room: joined.room, name: 'B' });
  say(a, { type: 'acceptJoin' });
  const deck = [];
  for (let i = 0; i < 20; i++) deck.push('DM-01/Test Attacker');
  for (let i = 0; i < 20; i++) deck.push('DM-01/Test Magma Gazer');
  say(a, { type: 'submitDeck', deck });
  say(b, { type: 'submitDeck', deck });
  say(a, { type: 'claimTurn' });
  return { a, b };
}

// Draw until the hand has at least `attackers` "Test Attacker" and one
// "Test Magma Gazer", then charge `manaNeeded` filler cards to mana.
function setupHand(a, meSeat, attackersWanted, manaNeeded) {
  for (let i = 0; i < 30; i++) {
    const st = latest(a);
    const hand = st.players[meSeat].hand;
    const atk = hand.filter(c => c.id.endsWith('Test Attacker')).length;
    const gazer = hand.filter(c => c.id.endsWith('Test Magma Gazer')).length;
    if (atk >= attackersWanted + manaNeeded && gazer >= 1) break;
    say(a, { type: 'drawCard' });
  }
  let st = latest(a);
  let hand = st.players[meSeat].hand;
  // charge fillers (extra attacker copies) into mana, keep the ones we need to summon
  let charged = 0;
  for (const c of hand.slice()) {
    if (charged >= manaNeeded) break;
    if (!c.id.endsWith('Test Attacker')) continue;
    const attackersLeftInHand = latest(a).players[meSeat].hand.filter(x => x.id.endsWith('Test Attacker')).length;
    if (attackersLeftInHand <= attackersWanted) continue; // keep enough to summon
    say(a, { type: 'chargeMana', key: c.key });
    charged++;
  }
  st = latest(a);
  if (st.players[meSeat].mana.length < manaNeeded) { console.error('FAIL: could not charge enough mana'); process.exit(1); }
}

function summonAttackers(a, meSeat, n) {
  for (let i = 0; i < n; i++) {
    const st = latest(a);
    const c = st.players[meSeat].hand.find(x => x.id.endsWith('Test Attacker'));
    if (!c) { console.error('FAIL: no attacker left in hand to summon'); process.exit(1); }
    say(a, { type: 'summonCard', key: c.key });
  }
}

function castMagmaGazer(a, meSeat) {
  const st = latest(a);
  const c = st.players[meSeat].hand.find(x => x.id.endsWith('Test Magma Gazer'));
  if (!c) { console.error('FAIL: no Magma Gazer in hand'); process.exit(1); }
  say(a, { type: 'summonCard', key: c.key });
}

let failed = false;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label);
  if (!cond) failed = true;
}

// ---- scenario 1: exactly one legal creature -> both keywords apply immediately ----
{
  const { a } = newRoom();
  const meSeat = latest(a).you;
  setupHand(a, meSeat, /*attackers*/ 1, /*mana*/ 4); // 1 to summon the attacker + 3 for the spell
  summonAttackers(a, meSeat, 1);
  castMagmaGazer(a, meSeat);
  const st = latest(a);
  const bz = st.players[meSeat].battlezone.filter(c => c.id.endsWith('Test Attacker'));
  check('one creature on board after summon', bz.length === 1);
  const grants = (bz[0].tempGrants || []).map(g => g.keyword);
  check('single creature got powerattacker immediately (no prompt needed)', grants.includes('powerattacker'));
  check('single creature got doublebreaker immediately (no prompt needed)', grants.includes('doublebreaker'));
  check('no leftover prompt', (st.players[meSeat].pendingTargets || []).length === 0);
}

// ---- scenario 2: two legal creatures -> exactly one prompt, chosen one gets both ----
{
  const { a } = newRoom();
  const meSeat = latest(a).you;
  setupHand(a, meSeat, /*attackers*/ 2, /*mana*/ 5); // 2 to summon the attackers + 3 for the spell
  summonAttackers(a, meSeat, 2);
  castMagmaGazer(a, meSeat);
  let st = latest(a);
  const pending = st.players[meSeat].pendingTargets || [];
  check('exactly one pendingTargets prompt (clauses folded together)', pending.length === 1);
  check('prompt action is grantKeyword', pending[0] && pending[0].action === 'grantKeyword');
  check('prompt carries both keywords', pending[0] && (pending[0].grants || []).map(g => g.keyword).sort().join(',') === 'doublebreaker,powerattacker');

  const bzBefore = st.players[meSeat].battlezone.filter(c => c.id.endsWith('Test Attacker'));
  check('two creatures on board', bzBefore.length === 2);
  const chosen = bzBefore[0];
  const other = bzBefore[1];
  say(a, { type: 'effectTarget', effectId: pending[0].id, key: chosen.key });

  st = latest(a);
  const chosenAfter = st.players[meSeat].battlezone.find(c => c.key === chosen.key);
  const otherAfter = st.players[meSeat].battlezone.find(c => c.key === other.key);
  const chosenKw = (chosenAfter.tempGrants || []).map(g => g.keyword);
  const otherKw = (otherAfter.tempGrants || []).map(g => g.keyword);
  check('chosen creature got powerattacker', chosenKw.includes('powerattacker'));
  check('chosen creature got doublebreaker', chosenKw.includes('doublebreaker'));
  check('other creature got nothing', otherKw.length === 0);
  check('prompt cleared after resolving', (st.players[meSeat].pendingTargets || []).length === 0);
}

process.exit(failed ? 1 : 0);
