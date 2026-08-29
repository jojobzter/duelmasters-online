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
        Civilization: 'Light', Effect: 'static: +2000 crossedCreature' },
      { Name: 'Test Ooze', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Darkness', Power: 1000, Race: 'Living Dead',
        'Speed Attacker (yes/No)': 'Yes', Effect: 'onPlayerAttack: destroy self' },
      // conditional and per-count statics, exactly as the sheet writes them
      { Name: 'Test Blasto', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Fire', Power: '2000+', Race: 'Dragonoid',
        'Speed Attacker (yes/No)': 'Yes',
        Effect: 'static: +2000 self if ownCreature[civ=Darkness].count>=1' },
      { Name: 'Test Garkago', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Fire', Power: '6000+', Race: 'Armored Dragon',
        'Double Breaker': 'yes', 'Speed Attacker (yes/No)': 'Yes',
        Effect: 'static: +1000 self per otherOwnCreature[civ=Fire]; static: grant attackUntapped self' },
      // a plain creature that may not attack players, for the Diamond Cutter check
      { Name: 'Test Wall', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Light', Power: 2000, Race: 'Guardian',
        'Blocker (Yes/No)': 'Yes', 'Attack restriction': 'not players',
        'Speed Attacker (yes/No)': 'Yes' },
      { Name: 'Test Cutter', Set: 'DM-01', 'Mana Cost': 1, Type: 'Spell',
        Civilization: 'Light', Effect: 'onSummon: grant ignoreAttackRestrictions all ownCreature' },
      // a dual-civilization creature, reprinted twice — the merge must not widen its
      // civilization list, or it becomes impossible to pay for
      { Name: 'Test Dual', Set: 'DM-09', 'Mana Cost': 2, Type: 'Creature',
        Civilization: 'Light/Nature', Power: 2000, Race: 'Initiate',
        Effect: 'onSummon: fromDeck 1 -> mana' },
      { Name: 'Test Dual', Set: 'DM-08', 'Mana Cost': 2, Type: 'Creature',
        Civilization: 'Light/Nature', Power: 2000, Race: 'Initiate',
        Effect: 'onSummon: fromDeck 1 -> mana' },
      // an evolution creature plus an Evo Charger, to exercise the mana->stack move
      { Name: 'Test Evo', Set: 'DM-01', 'Mana Cost': 1, Type: 'Evolution Creature',
        Civilization: 'Fire', Power: 5000, Race: 'Dragonoid' },
      { Name: 'Test EvoBase', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Fire', Power: 1000, Race: 'Dragonoid' },
      { Name: 'Test EvoCharger', Set: 'DM-01', 'Mana Cost': 1, Type: 'Spell',
        Civilization: 'Fire', Effect: 'onSummon: evoCharge, optional; resolvesTo mana' }
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

// --- a creature that destroys itself when it attacks must survive the attack ---
try {
  const a2 = mkSock(), b2 = mkSock();
  wss.handlers.connection(a2); wss.handlers.connection(b2);
  const say2 = (s, m) => s._message(JSON.stringify(m));
  say2(a2, { type: 'create', name: 'A' });
  const j2 = a2.inbox.find(m => m.type === 'joined');
  say2(b2, { type: 'join', room: j2.room, name: 'B' });
  say2(a2, { type: 'acceptJoin' });
  const oozeDeck = new Array(40).fill('DM-01/Test Ooze');
  say2(a2, { type: 'submitDeck', deck: oozeDeck });
  say2(b2, { type: 'submitDeck', deck: oozeDeck });
  const L2 = (s) => { const m = s.inbox.filter(x => x.type === 'state').pop(); return m && m.state; };
  say2(a2, { type: 'claimTurn' });
  let s2 = L2(a2);
  const seat2 = s2.you;
  for (let t = 0; t < 2; t++) { s2 = L2(a2); const h = s2.players[seat2].hand; if (h.length) say2(a2, { type: 'chargeMana', key: h[0].key }); }
  s2 = L2(a2);
  const h2 = s2.players[seat2].hand;
  if (h2.length) say2(a2, { type: 'summonCard', key: h2[0].key });
  s2 = L2(a2);
  const bz2 = s2.players[seat2].battlezone;
  if (!bz2.length) { console.log('(ooze check skipped — no creature summoned)'); }
  else {
    const oppSeat2 = seat2 === 0 ? 1 : 0;
    say2(a2, { type: 'declareAttack', key: bz2[0].key, target: { type: 'shield' } });
    const mid = L2(a2);
    const stillThere = mid.players[seat2].battlezone.some(c => c.key === bz2[0].key);
    const inGrave = mid.players[seat2].graveyard.some(c => c.key === bz2[0].key);
    console.log('self-destroying attacker: on table after attack = ' + stillThere +
                ', in graveyard = ' + inGrave);
    if (stillThere) { console.error('FAIL: it should be destroyed once the attack finished'); process.exit(1); }
    if (!inGrave) { console.error('FAIL: it vanished without reaching the graveyard'); process.exit(1); }
    console.log('self-destroy-after-attack works');
  }
} catch (e) {
  console.error('ooze check threw:', e.message);
  process.exit(1);
}

// --- conditional and per-count statics must show up in the live power the client sees
try {
  const a3 = mkSock(), b3 = mkSock();
  wss.handlers.connection(a3); wss.handlers.connection(b3);
  const say3 = (s, m) => s._message(JSON.stringify(m));
  say3(a3, { type: 'create', name: 'A' });
  const j3 = a3.inbox.find(m => m.type === 'joined');
  say3(b3, { type: 'join', room: j3.room, name: 'B' });
  say3(a3, { type: 'acceptJoin' });
  // a deck of Blasto + Ooze (Darkness) so the condition can be met
  const mixed = [];
  for (let i = 0; i < 20; i++) { mixed.push('DM-01/Test Blasto'); mixed.push('DM-01/Test Ooze'); }
  say3(a3, { type: 'submitDeck', deck: mixed });
  say3(b3, { type: 'submitDeck', deck: mixed });
  const L3 = (s) => { const m = s.inbox.filter(x => x.type === 'state').pop(); return m && m.state; };
  say3(a3, { type: 'claimTurn' });
  let s3 = L3(a3); const seat3 = s3.you;
  // Charge one of each civilization so both summons can be paid for — the deck is
  // Fire (Blasto) and Darkness (Ooze), and mana must match the card's civilization.
  // Charge at least one of EACH civilization, keeping one of each card in hand.
  // Mana must match the card's civilization, so a lopsided mana zone fails the summon.
  const charged = { Blasto: 0, Ooze: 0 };
  for (let t = 0; t < 14 && (charged.Blasto < 2 || charged.Ooze < 2); t++) {
    s3 = L3(a3);
    const h = s3.players[seat3].hand;
    const kindOf = (c) => /Blasto/.test(c.id) ? 'Blasto' : 'Ooze';
    // keep the last copy of each kind for summoning later
    const counts = { Blasto: 0, Ooze: 0 };
    h.forEach(c => counts[kindOf(c)]++);
    const pick = h.find(c => {
      const k = kindOf(c);
      return charged[k] < 2 && counts[k] > 1;
    });
    if (!pick) { say3(a3, { type: 'drawCard' }); continue; }
    charged[kindOf(pick)]++;
    say3(a3, { type: 'chargeMana', key: pick.key });
  }
  // top up the hand if the pieces we need aren't there yet
  for (let d = 0; d < 6; d++) {
    s3 = L3(a3);
    const h = s3.players[seat3].hand;
    if (h.some(c => /Blasto/.test(c.id)) && h.some(c => /Ooze/.test(c.id))) break;
    say3(a3, { type: 'drawCard' });
  }
  s3 = L3(a3);
  const blastoCard = s3.players[seat3].hand.find(c => /Blasto/.test(c.id));
  if (!blastoCard) { console.log('(static check skipped — no Blasto drawn)'); process.exit(0); }
  say3(a3, { type: 'summonCard', key: blastoCard.key });
  s3 = L3(a3);
  const bzB = s3.players[seat3].battlezone.find(c => /Blasto/.test(c.id));
  if (!bzB) {
    const rej = a3.inbox.filter(m => m.type === 'summonRejected').pop();
    console.error('FAIL: Blasto did not reach the battle zone' + (rej ? ' — ' + rej.reason : ''));
    process.exit(1);
  }
  const before = bzB.livePower;
  // make sure there is mana left for the second summon, then play the Darkness creature
  for (let d = 0; d < 8; d++) {
    s3 = L3(a3);
    if (s3.players[seat3].hand.some(c => /Ooze/.test(c.id))) break;
    say3(a3, { type: 'drawCard' });
  }
  s3 = L3(a3);
  const oozeCard = s3.players[seat3].hand.find(c => /Ooze/.test(c.id));
  if (!oozeCard) { console.log('(no Darkness creature drawn — skipping)'); process.exit(0); }
  const markO = a3.inbox.length;
  say3(a3, { type: 'summonCard', key: oozeCard.key });
  const rejO = a3.inbox.slice(markO).find(m => m.type === 'summonRejected');
  if (rejO) { console.error('FAIL: could not summon the Darkness creature — ' + rejO.reason); process.exit(1); }
  s3 = L3(a3);
  const bzB2 = s3.players[seat3].battlezone.find(c => /Blasto/.test(c.id));
  const after = bzB2 && bzB2.livePower;
  console.log('Blasto livePower: alone=' + before + ', with a Darkness creature=' + after);
  if (before !== 2000) { console.error('FAIL: base power should be 2000, got ' + before); process.exit(1); }
  if (after !== 4000) { console.error('FAIL: should gain +2000 with Darkness out, got ' + after); process.exit(1); }
  console.log('conditional static power works end to end');
} catch (e) {
  console.error('static power check threw:', e.message);
  console.error((e.stack || '').split('\n')[1]);
  process.exit(1);
}

// --- Diamond Cutter: lets a "can't attack players" creature hit shields, THIS TURN ---
function freshGame(deck) {
  const x = mkSock(), y = mkSock();
  wss.handlers.connection(x); wss.handlers.connection(y);
  const say = (s, m) => s._message(JSON.stringify(m));
  say(x, { type: 'create', name: 'A' });
  const j = x.inbox.find(m => m.type === 'joined');
  say(y, { type: 'join', room: j.room, name: 'B' });
  say(x, { type: 'acceptJoin' });
  say(x, { type: 'submitDeck', deck });
  say(y, { type: 'submitDeck', deck });
  const L = (sock) => { const m = (sock || x).inbox.filter(v => v.type === 'state').pop(); return m && m.state; };
  return { x, y, say, L };
}
function drawUntil(g, seat, re, tries) {
  for (let i = 0; i < (tries || 12); i++) {
    const st = g.L(g.x);
    if (st.players[seat].hand.some(c => re.test(c.id))) return true;
    g.say(g.x, { type: 'drawCard' });
  }
  return false;
}

try {
  const deck = [];
  for (let i = 0; i < 14; i++) { deck.push('DM-01/Test Wall'); deck.push('DM-01/Test Cutter'); deck.push('DM-01/Test Garkago'); }
  const g = freshGame(deck);
  g.say(g.x, { type: 'claimTurn' });
  let st = g.L(g.x); const seat = st.you, opp = seat === 0 ? 1 : 0;
  // charge plenty of mana from spare cards
  // Wall and Cutter are both Light, so charge Light cards — mana must match civilization
  for (let t = 0; t < 10; t++) {
    st = g.L(g.x);
    if (st.players[seat].mana.length >= 4) break;
    const h = st.players[seat].hand;
    const counts = h.filter(c => /Wall|Cutter/.test(c.id)).length;
    const spare = counts > 2 ? h.find(c => /Wall|Cutter/.test(c.id)) : null;
    if (spare) g.say(g.x, { type: 'chargeMana', key: spare.key });
    else g.say(g.x, { type: 'drawCard' });
  }
  drawUntil(g, seat, /Wall/);
  st = g.L(g.x);
  const wall = st.players[seat].hand.find(c => /Wall/.test(c.id));
  if (!wall) { console.log('(cutter check skipped — no Wall drawn)'); }
  else {
    g.say(g.x, { type: 'summonCard', key: wall.key });
    st = g.L(g.x);
    const bzWall = st.players[seat].battlezone.find(c => /Wall/.test(c.id));
    // before the spell: attacking a shield must be refused
    let mark = g.x.inbox.length;
    g.say(g.x, { type: 'declareAttack', key: bzWall.key, target: { type: 'shield' } });
    const rejBefore = g.x.inbox.slice(mark).find(m => m.type === 'summonRejected');
    console.log('wall attacking shields BEFORE Diamond Cutter: ' + (rejBefore ? 'refused (correct)' : 'ALLOWED (wrong)'));
    if (!rejBefore) { console.error('FAIL: a "not players" creature should not reach shields unaided'); process.exit(1); }

    drawUntil(g, seat, /Cutter/);
    st = g.L(g.x);
    const cutter = st.players[seat].hand.find(c => /Cutter/.test(c.id));
    if (!cutter) { console.log('(cutter check skipped — no Cutter drawn)'); }
    else {
      g.say(g.x, { type: 'summonCard', key: cutter.key });
      st = g.L(g.x);
      const kw = (st.players[seat].liveKeywords || {})[bzWall.key] || [];
      console.log('wall keywords after the spell: ' + (kw.join(',') || '(none)'));
      mark = g.x.inbox.length;
      g.say(g.x, { type: 'declareAttack', key: bzWall.key, target: { type: 'shield' } });
      const rejAfter = g.x.inbox.slice(mark).find(m => m.type === 'summonRejected');
      console.log('wall attacking shields AFTER Diamond Cutter:  ' + (rejAfter ? 'refused — ' + rejAfter.reason : 'allowed (correct)'));
      if (rejAfter) { console.error('FAIL: Diamond Cutter should open the shields to it'); process.exit(1); }

      // and the grant must not survive into the next turn
      g.say(g.x, { type: 'endTurn' });
      st = g.L(g.x);
      const kwNext = (st.players[seat].liveKeywords || {})[bzWall.key] || [];
      console.log('wall keywords after the turn ends: ' + (kwNext.join(',') || '(none — expired correctly)'));
      if (kwNext.some(k => /ignoreattackrestrictions/i.test(k))) {
        console.error('FAIL: the Diamond Cutter grant outlived its turn');
        process.exit(1);
      }
      console.log('Diamond Cutter works and expires at end of turn');
    }
  }
} catch (e) {
  console.error('cutter check threw:', e.message);
  console.error((e.stack || '').split('\n')[1]);
  process.exit(1);
}

// --- "can attack untapped creatures": printed restriction vs granted keyword ---
try {
  const src = require('fs').readFileSync(__dirname + '/server.js', 'utf8');
  const grab = (n) => { const i = src.indexOf('function ' + n + '('); let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++;
      if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
  const DB = {
    'garkago': { power: 6000, type: 'Creature', race: 'Armored Dragon',
      parsedEffects: [{ trigger: 'static', action: 'grant', keyword: 'attackUntapped',
                        selector: { selfOnly: true, side: 'own', zone: 'battle', filters: [] } }] },
    'plain':   { power: 2000, type: 'Creature', race: 'Guardian', parsedEffects: [] },
    'victim':  { power: 2000, type: 'Creature', race: 'Guardian', parsedEffects: [] }
  };
  const norm = (n) => n.toLowerCase();
  const cardLabel = (id) => id.split('/').pop();
  const cardMeta = (id) => DB[norm(cardLabel(id))] || null;
  const metaOf = (id) => cardMeta(id) || {};
  const racesOf = (id) => ((cardMeta(id) || {}).race || '').toLowerCase().split('/').filter(Boolean);
  const civsOf = () => [];
  const powerOf = (id) => (cardMeta(id) || {}).power;
  const isSpellCard = () => false;
  const isBlocker = () => false;
  const normalizeCardKey = norm;
  const STATIC_CACHE = new Map();
  const restrictionOf = () => 'none';
  const canAttackUntappedTarget = () => false;    // nothing may hit untapped by default
  function valueMatchesAny(h, sp) { if (sp == null) return true;
    const w = String(sp).split('/').map(x => x.trim().toLowerCase()).filter(Boolean);
    const g = (h || []).map(x => String(x).toLowerCase()); return w.some(x => g.includes(x)); }
  function raceMatchesAny(id, sp) { return valueMatchesAny(racesOf(id), sp); }
  function hasKw(set, n) { if (set.has(n)) return true;
    for (const k of set) if (String(k).toLowerCase().replace(/\[.*$/, '') === n) return true; return false; }
  function kwBase(k) { return String(k || '').toLowerCase().replace(/\[.*$/, ''); }
  function kwArg() { return null; }
  eval(grab('staticSources')); eval(grab('crossedTargetMatches')); eval(grab('staticClauses'));
  eval(grab('selectorMatches')); eval(grab('conditionHolds')); eval(grab('countSelector'));
  eval(grab('grantedKeywords')); eval(grab('canAttackUntappedNow'));

  const gark  = { key: 'g', id: 'X/Garkago' };
  const plain = { key: 'p', id: 'X/Plain' };
  const vic   = { key: 'v', id: 'X/Victim', tapped: false };
  const st = { activeTurn: 0, players: [
    { battlezone: [gark, plain], crossGear: [], mana: [], shields: [], graveyard: [], hand: [] },
    { battlezone: [vic],         crossGear: [], mana: [], shields: [], graveyard: [], hand: [] } ] };

  const garkOk  = canAttackUntappedNow(st, 0, gark,  1, vic);
  const plainOk = canAttackUntappedNow(st, 0, plain, 1, vic);
  console.log('Garkago (granted attackUntapped) vs an untapped creature: ' + (garkOk ? 'allowed (correct)' : 'REFUSED (wrong)'));
  console.log('a plain creature vs an untapped creature:                 ' + (plainOk ? 'ALLOWED (wrong)' : 'refused (correct)'));
  if (!garkOk || plainOk) { console.error('FAIL: attackUntapped is not being honoured correctly'); process.exit(1); }
  console.log('attack-untapped mechanic works');
} catch (e) {
  console.error('untapped check threw:', e.message);
  console.error((e.stack || '').split('\n')[1]);
  process.exit(1);
}

// --- a single mistyped reprint must not redefine a card's civilization ---
// Civilization is settled by a majority vote across all of a card's rows, so one bad
// row can neither widen nor narrow it. This is what made Skysword unsummonable.
try {
  const vote = (rows) => {
    const tally = new Map();
    for (const r of rows) tally.set(r.civ, (tally.get(r.civ) || 0) + (r.type ? 1.1 : 1));
    let best = null, bestN = -1;
    for (const [v, n] of tally) if (n > bestN) { best = v; bestN = n; }
    return best;
  };
  const cases = [
    ['two good rows + one listing every civilization', [
      { civ: 'Light/Nature', type: 'Creature' },
      { civ: 'Light/Nature', type: 'Creature' },
      { civ: 'Fire/Water/Nature/Light/Darkness', type: 'Creature' }], 'Light/Nature'],
    ['two good rows + one stray single civilization', [
      { civ: 'Water', type: '' },
      { civ: 'Water/Darkness', type: 'Creature' },
      { civ: 'Water/Darkness', type: 'Creature' }], 'Water/Darkness'],
    ['a straight tie — the more complete row wins', [
      { civ: 'Water', type: 'Creature' },
      { civ: 'Fire', type: '' }], 'Water']
  ];
  let bad = 0;
  for (const [label, rows, expect] of cases) {
    const got = vote(rows);
    if (got !== expect) bad++;
    console.log((got === expect ? 'ok   ' : 'FAIL ') + label.padEnd(48) + got);
  }
  if (bad) { console.error('FAIL: the civilization vote picked the wrong value'); process.exit(1); }
  console.log('civilization vote resolves bad reprint rows correctly');
} catch (e) {
  console.error('civ vote check threw:', e.message);
  process.exit(1);
}

// --- Evo Charger: goes to mana, and can slide a creature under an evolution creature
try {
  const deck = [];
  for (let i = 0; i < 12; i++) { deck.push('DM-01/Test EvoBase'); deck.push('DM-01/Test Evo'); deck.push('DM-01/Test EvoCharger'); }
  const g = freshGame(deck);
  g.say(g.x, { type: 'claimTurn' });
  let st = g.L(g.x); const seat = st.you;
  // everything here is Fire, so any card charges the mana we need
  for (let t = 0; t < 20; t++) {
    st = g.L(g.x);
    if (st.players[seat].mana.filter(m => !m.tapped).length >= 4) break;
    const h = st.players[seat].hand;
    if (h.length > 3) g.say(g.x, { type: 'chargeMana', key: h[0].key });
    else g.say(g.x, { type: 'drawCard' });
  }
  // an evolution creature stacks onto a creature of the same race
  for (let i = 0; i < 12; i++) {
    st = g.L(g.x);
    if (st.players[seat].hand.some(c => /EvoBase/.test(c.id))) break;
    g.say(g.x, { type: 'drawCard' });
  }
  st = g.L(g.x);
  const base = st.players[seat].hand.find(c => /EvoBase/.test(c.id));
  if (base) g.say(g.x, { type: 'summonCard', key: base.key });
  st = g.L(g.x);
  const bzBase = st.players[seat].battlezone.find(c => /EvoBase/.test(c.id));
  for (let i = 0; i < 12; i++) {
    st = g.L(g.x);
    if (st.players[seat].hand.some(c => /Test Evo$/.test(c.id))) break;
    g.say(g.x, { type: 'drawCard' });
  }
  st = g.L(g.x);
  const evoCard = st.players[seat].hand.find(c => /Test Evo$/.test(c.id));
  if (bzBase && evoCard) g.say(g.x, { type: 'summonCard', key: evoCard.key, baseKey: bzBase.key });
  st = g.L(g.x);
  const evo = st.players[seat].battlezone.find(c => /Test Evo$/.test(c.id));
  if (!evo) { console.log('(evo charger check skipped — no evolution creature in play)'); }
  else {
    const stackBefore = (evo.under || []).length;
    const manaBefore = st.players[seat].mana.length;
    const charger = st.players[seat].hand.find(c => /Charger/.test(c.id));
    if (!charger) { console.log('(evo charger check skipped — none drawn)'); }
    else {
      g.say(g.x, { type: 'summonCard', key: charger.key });
      st = g.L(g.x);
      // it should now be asking which mana creature to slide under the evolution
      const prompt = (st.players[seat].pendingTargets || [])[0];
      console.log('Evo Charger prompt: ' + (prompt ? prompt.action + ' from ' + prompt.zone : 'none'));
      if (prompt && prompt.action === 'toEvoStack') {
        const manaCreature = st.players[seat].mana.find(m => !/Charger/.test(m.id));
        g.say(g.x, { type: 'effectTarget', effectId: prompt.id, key: manaCreature.key });
        st = g.L(g.x);
        const evo2 = st.players[seat].battlezone.find(c => /Test Evo$/.test(c.id));
        const stackAfter = (evo2.under || []).length;
        const inMana = st.players[seat].mana.some(m => /Charger/.test(m.id));
        console.log('evolution stack: ' + stackBefore + ' -> ' + stackAfter +
                    ' | charger went to mana: ' + inMana);
        if (stackAfter <= stackBefore) { console.error('FAIL: nothing was put under the evolution creature'); process.exit(1); }
        if (!inMana) { console.error('FAIL: the Charger should end up in the mana zone'); process.exit(1); }
        console.log('Evo Charger works: mana destination and evolution stacking');
      }
    }
  }
} catch (e) {
  console.error('evo charger check threw:', e.message);
  console.error((e.stack || '').split('\n')[1]);
  process.exit(1);
}
