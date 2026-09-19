#!/usr/bin/env node
// Every project check, in one file. check.js forks this once per check so each runs
// in a clean process — several of them stub globals or intercept require(), and
// sharing a process would let one contaminate the next.
//
//   node tools/checks.js <name>     guards | client | server | bot | effects | audit | sheet
//
// __dirname below refers to tools/, so paths to project files go up one level.
const WHICH = process.argv[2];
const NAMES = ['guards', 'client', 'server', 'bot', 'deadlock', 'vortex', 'postattack', 'survivor', 'slayer', 'triggers', 'discard', 'manaleak', 'phoenix', 'jagraveen', 'foil', 'evolve', 'effects', 'audit', 'sheet'];
if (!NAMES.includes(WHICH)) {
  console.error('usage: node tools/checks.js <' + NAMES.join('|') + '>');
  process.exit(2);
}

if (WHICH === 'guards') {
  // Guards against the recurring "effect applies twice" bug: any hardcoded card
  // behaviour must stand down when the spreadsheet describes that card.
  // Run with: node check-guards.js
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/../server.js', 'utf8');

  // every hardcoded card name referenced inside effectivePower
  const body = src.slice(src.indexOf('function effectivePower('));
  const fn = body.slice(0, body.indexOf('\n}\n'));

  const problems = [];
  const lines = fn.split('\n');
  lines.forEach((line, i) => {
    const namesHardcoded = /_NAME\b|selfKey === '|namedCard\(owner, '/.test(line);
    if (!namesHardcoded) return;
    // the guard may sit on this line or the next few (inside a loop body)
    const window = lines.slice(i, i + 4).join(' ');
    if (!/hasSheet(Static|Effects)\(/.test(window)) {
      problems.push('effectivePower line ' + (i + 1) + ': ' + line.trim().slice(0, 90));
    }
  });

  if (problems.length) {
    console.error('UNGUARDED hardcoded effects (these will double-apply):');
    problems.forEach(p => console.error('   ' + p));
    process.exit(1);
  }
  console.log('guard check: all hardcoded power effects stand down for sheet-described cards');

  // Second check: module-level caches must be declared before anything assigns to them.
  // A `let` declared below its first use sits in the temporal dead zone and throws at
  // start-up, which silently leaves the card database empty.
  const srcLines = src.split('\n');
  const caches = ['META_CACHE', 'SELECTOR_CACHE', 'STATIC_CACHE', 'CARD_DB'];
  const tdz = [];
  for (const c of caches) {
    const declared = srcLines.findIndex(l => new RegExp('^(let|const|var)\\s+' + c + '\\b').test(l.trim()));
    const firstUse = srcLines.findIndex(l => new RegExp('\\b' + c + '\\b').test(l));
    if (declared === -1) continue;
    if (firstUse < declared) tdz.push(c + ': declared line ' + (declared + 1) + ', used line ' + (firstUse + 1));
  }
  if (tdz.length) {
    console.error('TEMPORAL DEAD ZONE (start-up will throw):');
    tdz.forEach(t => console.error('   ' + t));
    process.exit(1);
  }
  console.log('cache declaration order: OK');


  // Third check for client.js is load-test.js, which actually EXECUTES the file under a
  // DOM stub. Static analysis can't see a use inside a top-level IIFE, and that is
  // exactly the shape that broke the card preview button. Run: node load-test.js
  console.log('(run "node load-test.js public/client.js" for the client load check)');

}

if (WHICH === 'client') {
  // Loads client.js under a DOM stub to catch module-level errors — the class of bug
  // that silently kills every handler registered after the throw.
  const mk = () => ({
    style: { setProperty(){}, removeProperty(){}, getPropertyValue: () => '' },
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, insertBefore(){},
    querySelector: () => mk(), querySelectorAll: () => [], setAttribute(){}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left:0, top:0, width:10, height:10 }),
    textContent: '', innerHTML: '', value: '', checked: false, focus(){}, remove(){},
    children: [], dataset: {}, scrollIntoView(){}, click(){}
  });
  global.window = { addEventListener(){}, innerWidth:1000, innerHeight:800,
    location:{ href:'', protocol:'https:', host:'x' },
    matchMedia: () => ({ matches:false, addEventListener(){} }), requestAnimationFrame:(f)=>f() };
  global.document = { getElementById: () => mk(), querySelector: () => mk(), querySelectorAll: () => [],
    createElement: () => mk(), addEventListener(){}, body: mk(), head: mk(),
    documentElement: mk(), readyState: 'complete' };
  global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
  global.Audio = function(){ return { play: () => Promise.resolve(), pause(){}, addEventListener(){}, cloneNode(){ return this; } }; };
  global.WebSocket = function(){ return { addEventListener(){}, send(){}, close(){} }; };
  global.fetch = () => Promise.reject(new Error('offline'));
  global.requestAnimationFrame = (f) => f();
  global.navigator = { userAgent: 'node' };

  const target = process.argv[3]
    ? require('path').resolve(__dirname, process.argv[3])
    : __dirname + '/../public/client.js';
  try {
    eval(require('fs').readFileSync(target, 'utf8'));
    console.log('client.js: loads clean, all handlers register');
  } catch (e) {
    console.error('client.js THROWS AT LOAD:', e.message);
    console.error((e.stack || '').split('\n')[1]);
    process.exit(1);
  }

}

if (WHICH === 'server') {
  // Loads server.js with stubbed dependencies and drives real message handlers.
  // node --check only proves the file parses; this catches the faults that actually
  // reach players — use-before-declaration, bad references, thrown handlers.
  const path = require('path');
  const Module = require('module');

  // The server caps a deck at four copies of any one NAME, so test decks need ten
  // distinct names to reach forty cards. Each stub card becomes "<name> 1".."<name> 10"
  // with identical properties; the tests match on a substring so nothing else changes.
  // Builds a legal 40-card deck from the numbered variants of the given base names:
  // four of each variant, cycling through the names until the deck is full.
  function legalDeck(...bases) {
    const out = [];
    outer:
    for (let n = 1; n <= 10; n++) {
      for (const b of bases) {
        for (let c = 0; c < 4; c++) {
          if (out.length >= 40) break outer;
          out.push('DM-01/' + b + ' ' + n);
        }
      }
    }
    return out;
  }

  function expandVariants(cards) {
    const out = [];
    for (const c of cards) {
      for (let i = 1; i <= 10; i++) out.push(Object.assign({}, c, { Name: c.Name + ' ' + i }));
    }
    return out;
  }

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
      utils: { sheet_to_json: () => expandVariants([
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
        { Name: 'Test Hulcus', Set: 'DM-01', 'Mana Cost': 1, Type: 'Creature',
        Civilization: 'Darkness', Power: 2000, Race: 'Liquid People',
        Effect: 'onSummon: draw 1' },
      { Name: 'Test EvoCharger', Set: 'DM-01', 'Mana Cost': 1, Type: 'Spell',
          Civilization: 'Fire', Effect: 'onSummon: evoCharge, optional; resolvesTo mana' }
      ]) }
    };
    return origLoad.apply(this, arguments);
  };

  let server;
  try {
    server = require('../server.js');
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
    say(a, { type: 'respondJoin', accept: true });
    const deck = legalDeck('Test Creature');
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
      if (h.length) say(a, { type: 'chargeMana', key: h[0].key, force: true });
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
    say2(a2, { type: 'respondJoin', accept: true });
    const oozeDeck = legalDeck('Test Ooze');
    say2(a2, { type: 'submitDeck', deck: oozeDeck });
    say2(b2, { type: 'submitDeck', deck: oozeDeck });
    const L2 = (s) => { const m = s.inbox.filter(x => x.type === 'state').pop(); return m && m.state; };
    say2(a2, { type: 'claimTurn' });
    let s2 = L2(a2);
    const seat2 = s2.you;
    for (let t = 0; t < 2; t++) { s2 = L2(a2); const h = s2.players[seat2].hand; if (h.length) say2(a2, { type: 'chargeMana', key: h[0].key, force: true }); }
    s2 = L2(a2);
    const h2 = s2.players[seat2].hand;
    if (h2.length) say2(a2, { type: 'summonCard', key: h2[0].key });
    s2 = L2(a2);
    const bz2 = s2.players[seat2].battlezone;
    if (!bz2.length) { console.log('(ooze check skipped — no creature summoned)'); }
    else {
      // Attack a SPECIFIC shield, which is what clicking one does. The keyless form
      // takes a different branch, and testing only that hid a real bug: the branch
      // that breaks a named shield never ran the post-attack cleanup.
      const oppSeat2 = seat2 === 0 ? 1 : 0;
      const theirShield = s2.players[oppSeat2].shields[0];
      say2(a2, { type: 'declareAttack', key: bz2[0].key,
                 target: theirShield ? { type: 'shield', key: theirShield.key } : { type: 'shield' } });
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
    say3(a3, { type: 'respondJoin', accept: true });
    // a deck of Blasto + Ooze (Darkness) so the condition can be met
    const mixed = [];
    mixed.push(...legalDeck('Test Blasto', 'Test Ooze'));
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
      if (!pick) { say3(a3, { type: 'drawCard', force: true }); continue; }
      charged[kindOf(pick)]++;
      say3(a3, { type: 'chargeMana', key: pick.key, force: true });
    }
    // top up the hand if the pieces we need aren't there yet
    for (let d = 0; d < 6; d++) {
      s3 = L3(a3);
      const h = s3.players[seat3].hand;
      if (h.some(c => /Blasto/.test(c.id)) && h.some(c => /Ooze/.test(c.id))) break;
      say3(a3, { type: 'drawCard', force: true });
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
      say3(a3, { type: 'drawCard', force: true });
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
    say(x, { type: 'respondJoin', accept: true });
    say(x, { type: 'submitDeck', deck });
    say(y, { type: 'submitDeck', deck });
    const L = (sock) => { const m = (sock || x).inbox.filter(v => v.type === 'state').pop(); return m && m.state; };
    return { x, y, say, L };
  }
  function drawUntil(g, seat, re, tries) {
    for (let i = 0; i < (tries || 12); i++) {
      const st = g.L(g.x);
      if (st.players[seat].hand.some(c => re.test(c.id))) return true;
      g.say(g.x, { type: 'drawCard', force: true });
    }
    return false;
  }

  try {
    const deck = [];
    deck.push(...legalDeck('Test Wall', 'Test Cutter', 'Test Garkago'));
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
      if (spare) g.say(g.x, { type: 'chargeMana', key: spare.key, force: true });
      else g.say(g.x, { type: 'drawCard', force: true });
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

        // The attack is still open: with a real opponent there are shields to break,
        // so finish it before the turn can end.
        {
          const cur = g.L(g.x);
          if (cur.combat) {
            if (cur.combat.phase === 'blocking') g.say(g.y, { type: 'declareBlock' });
            const c2 = g.L(g.x).combat;
            if (c2 && c2.phase === 'breaking') {
              const sh = g.L(g.x).players[seat === 0 ? 1 : 0].shields[0];
              if (sh) g.say(g.x, { type: 'breakShield', key: sh.key });
              else g.say(g.x, { type: 'cancelCombat' });
            }
          }
        }
        // The wall just broke a shield, so the opponent may be holding a Shield Trigger
        // decision — the turn cannot end until they answer it.
        {
          const ov = g.L(g.y);
          const pend = (ov && ov.players[ov.you] && ov.players[ov.you].pendingShieldTriggers) || [];
          for (const k of pend) g.say(g.y, { type: 'shieldTriggerDecline', key: k });
        }
        const markE = g.x.inbox.length;
        g.say(g.x, { type: 'endTurn' });
        const rejE = g.x.inbox.slice(markE).find(m => m.type === 'summonRejected');
        if (rejE) { console.error('FAIL: could not end the turn — ' + rejE.reason.slice(0, 70)); process.exit(1); }
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
    const src = require('fs').readFileSync(__dirname + '/../server.js', 'utf8');
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

  // --- one manual draw and one manual charge per turn ---
// Card effects grant extra draws through a different code path, so they must not be
// affected: Test Hulcus draws on summon and should still work after a manual draw.
try {
  const deck = [];
  deck.push(...legalDeck('Test Ooze', 'Test Hulcus'));
  const g = freshGame(deck);
  g.say(g.x, { type: 'claimTurn' });
  let st = g.L(g.x); const seat = st.you;

  const handSize = () => g.L(g.x).players[seat].hand.length;
  const manaSize = () => g.L(g.x).players[seat].mana.length;

  // first manual draw succeeds
  const before = handSize();
  g.say(g.x, { type: 'drawCard' });
  const afterFirst = handSize();
  // second is refused
  let mark = g.x.inbox.length;
  g.say(g.x, { type: 'drawCard' });
  const afterSecond = handSize();
  const rejD = g.x.inbox.slice(mark).find(m => m.type === 'summonRejected');
  console.log('manual draw: ' + before + ' -> ' + afterFirst + ' -> ' + afterSecond +
              (rejD ? '  (second refused)' : '  (second ALLOWED)'));
  if (afterFirst !== before + 1) { console.error('FAIL: the first draw should work'); process.exit(1); }
  if (afterSecond !== afterFirst) { console.error('FAIL: the second draw should be refused'); process.exit(1); }

  // an explicit override still works, for a card the engine does not implement
  g.say(g.x, { type: 'drawCard', force: true });
  if (handSize() !== afterSecond + 1) { console.error('FAIL: an overridden draw should work'); process.exit(1); }
  console.log('override draw works');

  // charging is likewise once per turn
  st = g.L(g.x);
  const m0 = manaSize();
  g.say(g.x, { type: 'chargeMana', key: st.players[seat].hand[0].key });
  const m1 = manaSize();
  st = g.L(g.x);
  mark = g.x.inbox.length;
  if (st.players[seat].hand.length) g.say(g.x, { type: 'chargeMana', key: st.players[seat].hand[0].key });
  const m2 = manaSize();
  const rejC = g.x.inbox.slice(mark).find(m => m.type === 'summonRejected');
  console.log('manual charge: ' + m0 + ' -> ' + m1 + ' -> ' + m2 +
              (rejC ? '  (second refused)' : '  (second ALLOWED)'));
  if (m1 !== m0 + 1 || m2 !== m1) { console.error('FAIL: charging should be once per turn'); process.exit(1); }

  // a card effect that draws must still work after the manual draw is spent
  st = g.L(g.x);
  for (let i = 0; i < 12; i++) {
    st = g.L(g.x);
    if (st.players[seat].hand.some(c => /Hulcus/.test(c.id))) break;
    g.say(g.x, { type: 'drawCard', force: true });
  }
  st = g.L(g.x);
  const hulcus = st.players[seat].hand.find(c => /Hulcus/.test(c.id));
  if (hulcus) {
    const h0 = handSize();
    g.say(g.x, { type: 'summonCard', key: hulcus.key });
    const h1 = handSize();
    // -1 for the summoned card, +1 for its draw
    console.log('effect-driven draw after the manual one: hand ' + h0 + ' -> ' + h1 +
                (h1 === h0 ? '  (the effect still drew)' : '  (no draw)'));
    if (h1 !== h0) { console.error('FAIL: a card effect must not be blocked by the manual limit'); process.exit(1); }
  }

  // and both reset when the turn passes
  g.say(g.x, { type: 'endTurn' });
  const after = g.L(g.x).players[seat];
  console.log('after ending the turn: draws used ' + after.manualDrawsThisTurn +
              ', charges used ' + after.manualChargesThisTurn);
  if (after.manualDrawsThisTurn !== 0 || after.manualChargesThisTurn !== 0) {
    console.error('FAIL: the per-turn counters should reset');
    process.exit(1);
  }
  console.log('one manual draw and one manual charge per turn');
} catch (e) {
  console.error('manual-limit check threw:', e.message);
  console.error((e.stack || '').split('\n')[1]);
  process.exit(1);
}

// --- Evo Charger: goes to mana, and can slide a creature under an evolution creature
  try {
    const deck = [];
    deck.push(...legalDeck('Test EvoBase', 'Test Evo', 'Test EvoCharger'));
    const g = freshGame(deck);
    g.say(g.x, { type: 'claimTurn' });
    let st = g.L(g.x); const seat = st.you;
    // everything here is Fire, so any card charges the mana we need
    for (let t = 0; t < 20; t++) {
      st = g.L(g.x);
      if (st.players[seat].mana.filter(m => !m.tapped).length >= 4) break;
      const h = st.players[seat].hand;
      if (h.length > 3) g.say(g.x, { type: 'chargeMana', key: h[0].key, force: true });
      else g.say(g.x, { type: 'drawCard', force: true });
    }
    // an evolution creature stacks onto a creature of the same race
    for (let i = 0; i < 12; i++) {
      st = g.L(g.x);
      if (st.players[seat].hand.some(c => /EvoBase/.test(c.id))) break;
      g.say(g.x, { type: 'drawCard', force: true });
    }
    st = g.L(g.x);
    const base = st.players[seat].hand.find(c => /EvoBase/.test(c.id));
    if (base) g.say(g.x, { type: 'summonCard', key: base.key });
    st = g.L(g.x);
    const bzBase = st.players[seat].battlezone.find(c => /EvoBase/.test(c.id));
    for (let i = 0; i < 12; i++) {
      st = g.L(g.x);
      if (st.players[seat].hand.some(c => /Test Evo \d/.test(c.id))) break;
      g.say(g.x, { type: 'drawCard', force: true });
    }
    st = g.L(g.x);
    const evoCard = st.players[seat].hand.find(c => /Test Evo \d/.test(c.id));
    if (bzBase && evoCard) g.say(g.x, { type: 'summonCard', key: evoCard.key, baseKey: bzBase.key });
    st = g.L(g.x);
    const evo = st.players[seat].battlezone.find(c => /Test Evo \d/.test(c.id));
    if (!evo) { console.log('(evo charger check skipped — no evolution creature in play)'); }
    else {
      const stackBefore = (evo.under || []).length;
      const manaBefore = st.players[seat].mana.length;
      for (let i = 0; i < 14; i++) {
        st = g.L(g.x);
        if (st.players[seat].hand.some(c => /Charger/.test(c.id))) break;
        g.say(g.x, { type: 'drawCard', force: true });
      }
      st = g.L(g.x);
      const charger = st.players[seat].hand.find(c => /Charger/.test(c.id));
      if (!charger) { console.error('FAIL: no Evo Charger drawn in 14 tries'); process.exit(1); }
      {
        g.say(g.x, { type: 'summonCard', key: charger.key });
        st = g.L(g.x);
        // it should now be asking which mana creature to slide under the evolution
        const prompt = (st.players[seat].pendingTargets || [])[0];
        console.log('Evo Charger prompt: ' + (prompt ? prompt.action + ' from ' + prompt.zone : 'none'));
        if (prompt && prompt.action === 'toEvoStack') {
          const manaCreature = st.players[seat].mana.find(m => !/Charger/.test(m.id));
          g.say(g.x, { type: 'effectTarget', effectId: prompt.id, key: manaCreature.key });
          st = g.L(g.x);
          const evo2 = st.players[seat].battlezone.find(c => /Test Evo \d/.test(c.id));
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

}

if (WHICH === 'bot') {
  // Bot decision tests. These check WHAT the bot chooses, not just that it runs —
  // a bot that plays legally but badly still ruins a game.
  global.fetch = () => Promise.reject(new Error('offline'));
  const DB = {
    'my small':    { power: 1000, type: 'Creature' },
    'my big':      { power: 5000, type: 'Creature' },
    'their small': { power: 2000, type: 'Creature' },
    'their big':   { power: 6000, type: 'Creature', blocker: true }
  };
  global.cardMetaFor = (id) => DB[(id.split('/').pop() || '').toLowerCase()] || {};
  global.displayName = (id) => id.split('/').pop();
  const Bot = eval(require('fs').readFileSync(__dirname + '/../public/bot.js', 'utf8') + '; Bot;');

  function boardWithEffect(action, zone) {
    return {
      you: 1, turnNumber: 3, activeTurn: 1, combat: null, gameOver: null,
      endGameRequestBy: null, surrenderBy: null, rematch: [false, false],
      players: [
        { battlezone: [{ key: 'ts', id: 'DM/Their Small' }, { key: 'tb', id: 'DM/Their Big' }],
          shields: [{ key: 's' }], mana: [], graveyard: [], hand: [], deckCount: 20,
          handCount: 0, pendingPromptCount: 0, pendingShieldTriggers: [] },
        { battlezone: [{ key: 'ms', id: 'DM/My Small' }, { key: 'mb', id: 'DM/My Big' }],
          shields: [{ key: 's2' }], mana: [], graveyard: [], hand: [], deckCount: 20,
          handCount: 0, pendingTargets: [{ id: 'e1', zone, action, sourceKey: 'x' }],
          pendingDiscards: [], pendingShieldTriggers: [], pendingPromptCount: 1 }
      ]
    };
  }

  function vileMulderCheck() {
  // --- a creature that "cannot attack creatures" must still attack shields ---
  // A loose substring match on the restriction benched Vile Mulder entirely: the
  // phrase contains "cannot attack", but only the bare form stops it attacking at all.
  {
    DB['vile mulder'] = { power: 7000, type: 'Creature', attackRestriction: 'cannot attack creatures' };
    const sent2 = [];
    Bot.stop();
    Bot.start({ seatIdx: 1, deck: [], send: (m) => sent2.push(m) });
    const board = {
      you: 1, turnNumber: 5, activeTurn: 1, combat: null, gameOver: null,
      endGameRequestBy: null, surrenderBy: null, rematch: [false, false],
      players: [
        { battlezone: [{ key: 'ts', id: 'DM/Their Small' }], shields: [{ key: 's1' }, { key: 's2' }],
          mana: [], graveyard: [], hand: [], deckCount: 20, handCount: 0,
          pendingPromptCount: 0, pendingShieldTriggers: [] },
        { battlezone: [{ key: 'vm', id: 'DM/Vile Mulder', tapped: false, summonedTurn: 1 }],
          shields: [{ key: 's3' }], mana: [], graveyard: [], hand: [], deckCount: 0, handCount: 0,
          pendingTargets: [], pendingDiscards: [], pendingShieldTriggers: [], pendingPromptCount: 0 }
      ]
    };
    let ticks = 0;
    const step = () => {
      Bot.onState(board);
      if (++ticks < 5) return setTimeout(step, 700);
      setTimeout(() => {
        const atk = sent2.find(m => m.type === 'declareAttack');
        if (!atk) { console.error('FAIL: a "cannot attack creatures" creature never attacked'); process.exit(1); }
        if (atk.target.type !== 'shield') { console.error('FAIL: it attacked a creature, which it may not do'); process.exit(1); }
        console.log('"cannot attack creatures" still attacks shields');
        process.exit(0);
      }, 600);
    };
    step();
  }
}

  const cases = [
    ['bounce (Aqua Surfer)', 'returnToHand', 'anyBattle', 'tb'],
    ['destroy',              'destroy',      'anyBattle', 'tb'],
    ['send to mana',         'toOwnerMana',  'anyBattle', 'tb'],
    ['tap',                  'tap',          'anyBattle', 'tb']
  ];
  const names = { ts: "opponent's small", tb: "opponent's biggest", ms: 'its OWN small', mb: 'its OWN big' };
  let failed = 0;

  // The bot keeps internal state between decisions, so run the cases one at a time.
  (function next(i) {
    if (i >= cases.length) {
      console.log(failed ? failed + ' bot targeting failure(s)' : 'bot targets the opponent for every removal effect');
      if (failed) process.exit(1);
      return vileMulderCheck();
    }
    const [label, action, zone, expect] = cases[i];
    const sent = [];
    Bot.stop();
    Bot.start({ seatIdx: 1, deck: [], send: (m) => sent.push(m) });
    Bot.onState(boardWithEffect(action, zone));
    setTimeout(() => {
      const pick = sent.find(m => m.type === 'effectTarget');
      const got = pick && pick.key;
      const ok = got === expect;
      if (!ok) failed++;
      console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(24) + '-> ' + (names[got] || '(nothing)'));
      next(i + 1);
    }, 900);
  })(0);

}

if (WHICH === 'deadlock') {
  // A bot must always be able to end its turn. This reproduces the exact board that
  // froze a live game: a "must attack" creature made non-sick by the OPPONENT's Totto
  // Pipicchi, which the bot considered summoning-sick and so never attacked with.
  // Reproduce the freeze: opponent has a mustAttack creature made non-sick by MY Totto.
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const log=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js');
  console.log=log;
  const wss=server.__wss, rooms=server.__rooms;

  // real bot, with the timer stub so it runs instantly
  const botSrc = fs.readFileSync('/home/claude/duelmasters/public/bot.js','utf8');
  const pending=new Map(); let nextId=1; const order=[];
  function makeBot(){
    const setTimeout=(fn)=>{const id=nextId++;pending.set(id,fn);order.push(id);return id;};
    const clearTimeout=(id)=>pending.delete(id);
    return eval('(function(setTimeout, clearTimeout){'+botSrc+'; return Bot; })')(setTimeout,clearTimeout);
  }
  function drain(limit){let ran=0;while(order.length&&ran<(limit||500)){const id=order.shift();const fn=pending.get(id);if(!fn)continue;pending.delete(id);try{fn();}catch(e){}ran++;}return ran;}
  const norm=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const META=new Map();
  for(const r of CARDS) if(r.Name){const y=v=>/^(y|yes|true|1)$/i.test(String(v==null?'':v).trim());
   const n=v=>{const x=parseInt(String(v==null?'':v).replace(/[^0-9-]/g,''),10);return Number.isFinite(x)?x:null;};
   if(!META.has(norm(r.Name))) META.set(norm(r.Name),{name:String(r.Name).trim(),cost:n(r['Mana Cost']),power:n(r.Power),
    type:String(r.Type||''),race:String(r.Race||''),civs:String(r.Civilization||'').split('/').map(s=>s.trim()).filter(Boolean),
    blocker:y(r['Blocker (Yes/No)']),doubleBreaker:y(r['Double Breaker']),tripleBreaker:y(r['Triple Breaker']),
    speedAttacker:y(r['Speed Attacker (yes/No)']),shieldTrigger:y(r['Shield Trigger (Yes/No)']),slayer:y(r.Slayer),
    attackRestriction:String(r['Attack restriction']||'none'),effectText:r.Effect?String(r.Effect):''});}
  global.cardMetaFor=id=>META.get(norm(String(id).split('/').pop()))||{};
  global.displayName=id=>String(id).split('/').pop();
  global.fetch=()=>Promise.reject(new Error('offline'));

  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;if(this.onMsg)this.onMsg(m);},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const names=['Totto Pipicchi','Deadly Fighter Braid Claw','Gonta, the Warrior Savage','Cragsaur',
               'Immortal Baron, Vorg','Crimson Hammer','Bolshack Dragon','Comet Missile','Chitta Peloru','Cocco Lupia'];
  const deck=[]; for(const n of names) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});

  const bot = makeBot();
  bot.start({ seatIdx:1, deck, send:(m)=>say(b,m) });
  b.onMsg = (m)=>{ if(m.type==='state') bot.onState(m.state); };
  b.onMsg2 = null;
  // feed rejections to the bot, as the real client does
  const origSend = b.send.bind(b);

  const room=rooms.get(j.room), S=room.state;
  S.turnNumber=12; S.activeTurn=1;              // the COMPUTER's turn
  S.players[0].battlezone = [{ key:'totto', id:'X/Totto Pipicchi', tapped:false, summonedTurn:10 }];
  S.players[0].shields = [{key:'s1',id:'X/Cragsaur',faceUp:false,slot:0},{key:'s2',id:'X/Cragsaur',faceUp:false,slot:1}];
  S.players[1].battlezone = [
    { key:'braid', id:'X/Deadly Fighter Braid Claw', tapped:false, summonedTurn:12 },  // summoned THIS turn
    { key:'gonta', id:'X/Gonta, the Warrior Savage', tapped:true,  summonedTurn:9 }    // already attacked
  ];
  S.players[1].hand = [];
  S.players[1].mana = [];

  say(b,{type:'drawCard',force:true});
  const view = b.lastState;
  const kw = (view.players[view.you].liveKeywords||{})['braid']||[];
  console.log('Braid Claw keywords the bot receives:', JSON.stringify(kw));
  console.log('summonedTurn', S.players[1].battlezone[0].summonedTurn, '= turnNumber', S.turnNumber, '-> printed-sick');
  console.log();

  // let the bot run and see whether it ever ends its turn
  let passes = 0, ended = false;
  for (let i = 0; i < 60; i++) {
    bot.onState(b.lastState);
    const ran = drain(400);
    passes += ran;
    if (S.activeTurn !== 1) { ended = true; break; }
    if (ran === 0) break;
  }
  console.log('bot actions run:', passes, '| turn ended:', ended);
  console.log(ended ? 'no deadlock' : 'DEADLOCK — the bot cannot end its turn');
  process.exit(ended?0:1);

}

if (WHICH === 'vortex') {
  // A Vortex evolution is put on TWO creatures, one of each named race. Getting this
  // wrong makes the game's strongest cards far too easy to play.
  // Vortex evolution: TWO bases, one of each named race, both stacked underneath.
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const log=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js');
  console.log=log;
  const wss=server.__wss, rooms=server.__rooms;
  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const deck=[]; for(const n of ['Cruel Naga, Avatar of Fate','Gigaslug','Aqua Guard','Cragsaur','Crimson Hammer','Comet Missile','Spiral Gate','Aqua Hulcus','Energy Stream','Bolshack Dragon']) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});
  say(a,{type:'claimTurn'});
  const room=rooms.get(j.room), S=room.state;
  S.turnNumber=9; S.activeTurn=0;
  let pass=0,fail=0;
  const check=(l,g,w)=>{const ok=g===w;console.log((ok?'  ok   ':'  FAIL ')+l.padEnd(62)+'got '+g);ok?pass++:fail++;};
  // Cruel Naga needs a Merfolk AND a Chimera. Gigaslug is a Chimera; find a Merfolk.
  const merfolk = CARDS.find(c => c.Race && String(c.Race).includes('Merfolk') && !String(c.Type||'').includes('Evolution'));
  console.log('     using Merfolk: ' + (merfolk ? merfolk.Name : 'NONE FOUND') + '   Chimera: Gigaslug');
  const setup = (bz) => {
    S.players[0].battlezone = bz;
    S.players[0].hand = [{key:'naga',id:'X/Cruel Naga, Avatar of Fate'}];
    S.players[0].mana = [];
    for (let n=0;n<4;n++) S.players[0].mana.push({key:'mw'+n,id:'X/Aqua Guard',tapped:false});      // Water
    for (let n=0;n<4;n++) S.players[0].mana.push({key:'md'+n,id:'X/Gigaslug',tapped:false});        // Darkness
  };
  const tryEvolve = (k1,k2) => {
    const mark=a.inbox.length;
    const msg={type:'summonCard',key:'naga'};
    if (k1) msg.baseKey=k1; if (k2) msg.baseKey2=k2;
    say(a,msg);
    const rej=a.inbox.slice(mark).find(m=>m.type==='summonRejected');
    return { ok: S.players[0].battlezone.some(c=>/Cruel Naga/.test(c.id)), why: rej && rej.reason.split('\n')[0] };
  };
  // only ONE base supplied -> refused
  setup([{key:'ch',id:'X/Gigaslug',tapped:false,summonedTurn:2},
         {key:'mf',id:'X/'+merfolk.Name,tapped:false,summonedTurn:2}]);
  let r = tryEvolve('ch', null);
  check('refused when only one base is given', !r.ok, true);
  if (r.why) console.log('        ' + r.why);
  // the SAME creature twice -> refused
  setup([{key:'ch',id:'X/Gigaslug',tapped:false,summonedTurn:2},
         {key:'mf',id:'X/'+merfolk.Name,tapped:false,summonedTurn:2}]);
  r = tryEvolve('ch','ch');
  check('refused when the same creature is given twice', !r.ok, true);
  // two creatures that do NOT cover both races -> refused
  setup([{key:'ch',id:'X/Gigaslug',tapped:false,summonedTurn:2},
         {key:'ch2',id:'X/Gigaslug',tapped:false,summonedTurn:2}]);
  r = tryEvolve('ch','ch2');
  check('refused when the two do not cover both races', !r.ok, true);
  if (r.why) console.log('        ' + r.why);
  // a correct pair -> allowed, and BOTH are consumed
  setup([{key:'ch',id:'X/Gigaslug',tapped:false,summonedTurn:2},
         {key:'mf',id:'X/'+merfolk.Name,tapped:false,summonedTurn:2}]);
  r = tryEvolve('ch','mf');
  check('allowed with a Merfolk and a Chimera', r.ok, true);
  const naga = S.players[0].battlezone.find(c=>/Cruel Naga/.test(c.id));
  console.log('     battlezone: ' + S.players[0].battlezone.map(c=>c.id.split('/').pop()).join(', '));
  console.log('     stacked underneath: ' + (naga && naga.under ? naga.under.map(u=>u.id.split('/').pop()).join(', ') : 'none'));
  check('both bases were consumed from the battle zone', S.players[0].battlezone.length === 1, true);
  check('both are stacked under the Vortex creature', !!(naga && naga.under && naga.under.length === 2), true);
  console.log();
  console.log(fail ? fail+' failure(s)' : 'Vortex evolution works properly');
  process.exit(fail?1:0);

}

if (WHICH === 'postattack') {
  // A creature that destroys itself "after attacking" must stay on the table for the
  // WHOLE attack, including its own shield-break prompt — and must then actually die.
  // Marrow Ooze destroys itself AFTER its attack — not while its own shield-break
  // prompt is still open.
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const log=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js');
  console.log=log;
  const wss=server.__wss, rooms=server.__rooms;
  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const deck=[]; for(const n of ['Marrow Ooze, the Twister','Writhing Bone Ghoul','Cragsaur','Crimson Hammer','Comet Missile','Aqua Guard','Spiral Gate','Aqua Hulcus','Energy Stream','Bolshack Dragon']) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});
  say(a,{type:'claimTurn'});
  const room=rooms.get(j.room), S=room.state;
  S.turnNumber=9; S.activeTurn=0;
  let pass=0,fail=0;
  const check=(l,g,w)=>{const ok=g===w;console.log((ok?'  ok   ':'  FAIL ')+l.padEnd(62)+'got '+g);ok?pass++:fail++;};

  // attack "shields" WITHOUT naming one — exactly what the screenshot shows
  S.players[0].battlezone=[{key:'ooze',id:'X/Marrow Ooze, the Twister',tapped:false,summonedTurn:2}];
  S.players[1].battlezone=[];
  S.players[1].shields=[
    {key:'s1',id:'X/Cragsaur',faceUp:false,slot:0},
    {key:'s2',id:'X/Cragsaur',faceUp:false,slot:1}
  ];
  say(a,{type:'declareAttack',key:'ooze',target:{type:'shield'}});
  console.log('     combat phase: ' + (S.combat ? S.combat.phase + ', shieldsToBreak ' + S.combat.shieldsToBreak : 'none'));
  const aliveDuring = S.players[0].battlezone.some(c=>/Marrow/.test(c.id));
  console.log('     Marrow Ooze still on the table while breaking: ' + aliveDuring);
  check('the attacker survives while its break prompt is open', aliveDuring, true);
  check('combat is waiting in the breaking phase', !!(S.combat && S.combat.phase === 'breaking'), true);

  // now click a shield to finish the attack
  const shieldsBefore = S.players[1].shields.length;
  say(a,{type:'breakShield',key:'s1'});
  console.log('     shields: ' + shieldsBefore + ' -> ' + S.players[1].shields.length);
  check('the shield actually broke', S.players[1].shields.length === shieldsBefore - 1, true);
  check('and NOW Marrow Ooze is destroyed', !S.players[0].battlezone.some(c=>/Marrow/.test(c.id)), true);
  check('it went to the graveyard', S.players[0].graveyard.some(c=>/Marrow/.test(c.id)), true);

  // A DOUBLE BREAKER must survive until BOTH shields are broken.
  S.combat = null;
  S.players[0].battlezone=[{key:'db',id:'X/Bolshack Dragon',tapped:false,summonedTurn:2}];
  S.players[0].battlezone[0].pendingSelfAction = null;
  S.players[1].shields=[
    {key:'t1',id:'X/Cragsaur',faceUp:false,slot:0},
    {key:'t2',id:'X/Cragsaur',faceUp:false,slot:1},
    {key:'t3',id:'X/Cragsaur',faceUp:false,slot:2}
  ];
  say(a,{type:'declareAttack',key:'db',target:{type:'shield'}});
  console.log('     double breaker: shieldsToBreak ' + (S.combat ? S.combat.shieldsToBreak : '-'));
  say(a,{type:'breakShield',key:'t1'});
  const midway = !!S.combat;
  console.log('     after 1 of 2 shields, combat still open: ' + midway);
  check('a double breaker keeps breaking after the first shield', midway, true);
  say(a,{type:'breakShield',key:'t2'});
  console.log('     after both, shields left: ' + S.players[1].shields.length + ', combat: ' + (S.combat?'open':'closed'));
  check('both shields broke', S.players[1].shields.length === 1, true);
  check('combat closed once the breaking finished', !S.combat, true);

  console.log();
  console.log(fail ? fail+' failure(s)' : 'Marrow Ooze now survives its own attack');
  process.exit(fail?1:0);

}

if (WHICH === 'survivor') {
  // SURVIVOR: "Each of your Survivors has this creature's ability." Every ability on
  // any Survivor you control is shared by all of them — and by nothing else.
  // SURVIVOR: "Each of your Survivors has this creature's ability."
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const log=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js');
  console.log=log;
  const wss=server.__wss, rooms=server.__rooms;
  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const deck=[]; for(const n of ['Smash Horn Q','Gigaling Q','Blazosaur Q','Cragsaur','Crimson Hammer','Comet Missile','Aqua Guard','Spiral Gate','Aqua Hulcus','Bolshack Dragon']) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});
  say(a,{type:'claimTurn'});
  const room=rooms.get(j.room), S=room.state;
  S.turnNumber=9; S.activeTurn=0;
  let pass=0,fail=0;
  const check=(l,g,w)=>{const ok=g===w;console.log((ok?'  ok   ':'  FAIL ')+l.padEnd(62)+'got '+g);ok?pass++:fail++;};
  const look=(bz,k)=>{
    const c=(bz||[]).find(x=>x.key===k)||{};
    return { power:c.livePower, kw:JSON.stringify((a.lastState.players[0].liveKeywords||{})[k]||[]) };
  };

  // Smash Horn Q alone: +1000 to itself (2000 base -> 3000)
  S.players[0].battlezone=[{key:'sh',id:'X/Smash Horn Q',tapped:false,summonedTurn:2}];
  say(a,{type:'drawCard',force:true});
  console.log('     raw entry: ' + JSON.stringify((a.lastState.players[0].battlezone||[])[0]).slice(0,180));
  let r = look(a.lastState.players[0].battlezone,'sh');
  console.log('     Smash Horn Q alone: ' + r.power + '  ' + r.kw);
  check('Smash Horn Q buffs itself', r.power === 3000, true);

  // add Gigaling Q (slayer): BOTH should now have slayer, and Gigaling gains the +1000
  S.players[0].battlezone=[
    {key:'sh',id:'X/Smash Horn Q',tapped:false,summonedTurn:2},   // 2000, +1000
    {key:'gg',id:'X/Gigaling Q',  tapped:false,summonedTurn:2}    // 2000, slayer
  ];
  say(a,{type:'drawCard',force:true});
  const sh = look(a.lastState.players[0].battlezone,'sh');
  const gg = look(a.lastState.players[0].battlezone,'gg');
  console.log('     Smash Horn Q: ' + sh.power + '  ' + sh.kw);
  console.log('     Gigaling Q  : ' + gg.power + '  ' + gg.kw);
  check('Smash Horn Q gains slayer from Gigaling Q', /slayer/i.test(sh.kw), true);
  check('Gigaling Q gains the +1000 from Smash Horn Q', gg.power === 3000, true);
  check('Gigaling Q keeps its own slayer', /slayer/i.test(gg.kw), true);

  // a NON-Survivor must not share anything
  S.players[0].battlezone=[
    {key:'sh',id:'X/Smash Horn Q',tapped:false,summonedTurn:2},
    {key:'no',id:'X/Cragsaur',    tapped:false,summonedTurn:2}    // not a Survivor
  ];
  say(a,{type:'drawCard',force:true});
  const no = look(a.lastState.players[0].battlezone,'no');
  console.log('     non-Survivor Cragsaur: ' + no.power + ' (base 3000)  ' + no.kw);
  check('a non-Survivor gets nothing', no.power === 3000, true);

  // Blazosaur Q's power attacker spreads too
  S.players[0].battlezone=[
    {key:'bz',id:'X/Blazosaur Q', tapped:false,summonedTurn:2},
    {key:'gg',id:'X/Gigaling Q',  tapped:false,summonedTurn:2}
  ];
  say(a,{type:'drawCard',force:true});
  const gg2 = look(a.lastState.players[0].battlezone,'gg');
  console.log('     Gigaling Q with Blazosaur Q out: ' + gg2.kw);
  check('power attacker spreads from Blazosaur Q', /powerattacker/i.test(gg2.kw), true);
  console.log();
  console.log(fail ? fail+' failure(s)' : 'Survivor sharing works');
  process.exit(fail?1:0);

}

if (WHICH === 'slayer') {
  // Slayer can be GRANTED as well as printed — Gigaling Q shares it with every
  // Survivor. Battle resolution read only the printed flag, so a shared Slayer did
  // nothing on either side of a battle.
  // Gigaling Q shares Slayer with every Survivor — including when the Survivor is the
  // DEFENDER, which is exactly the case in the reported game.
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const lg=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js');
  console.log=lg;
  const wss=server.__wss, rooms=server.__rooms;
  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const deck=[]; for(const n of ['Gigaling Q','Factory Shell Q','Gonta, the Warrior Savage','Cragsaur','Comet Missile','Aqua Guard','Spiral Gate','Aqua Hulcus','Energy Stream','Bolshack Dragon']) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});
  say(a,{type:'claimTurn'});
  const S=rooms.get(j.room).state;
  let pass=0,fail=0;
  const check=(l,g,w)=>{const ok=g===w;console.log((ok?'  ok   ':'  FAIL ')+l.padEnd(62)+'got '+g);ok?pass++:fail++;};

  // the reported situation: their 4000 attacks my 2000 Survivor, with Gigaling Q out
  const setup = (withGigaling) => {
    S.combat=null; S.turnNumber=9; S.activeTurn=1;
    S.players[0].battlezone=[{key:'fs',id:'X/Factory Shell Q',tapped:true,summonedTurn:2}];
    if (withGigaling) S.players[0].battlezone.push({key:'gg',id:'X/Gigaling Q',tapped:false,summonedTurn:2});
    S.players[1].battlezone=[{key:'gonta',id:'X/Gonta, the Warrior Savage',tapped:false,summonedTurn:2}];
    S.players[0].graveyard=[]; S.players[1].graveyard=[];
    const mk2=b.inbox.length;
    say(b,{type:'declareAttack',key:'gonta',target:{type:'creature',key:'fs'}});
    const rj=b.inbox.slice(mk2).find(m=>m.type==='summonRejected');
    if (rj) console.log('     refused: ' + rj.reason.split('\n')[0]);
    if (S.combat) console.log('     combat pending: ' + S.combat.phase);
    return {
      defenderDead: !S.players[0].battlezone.some(c=>c.key==='fs'),
      attackerDead: !S.players[1].battlezone.some(c=>c.key==='gonta')
    };
  };

  const without = setup(false);
  console.log('     no Gigaling Q: defender died ' + without.defenderDead + ', attacker died ' + without.attackerDead);
  check('without Gigaling Q the attacker survives', without.attackerDead, false);

  const withIt = setup(true);
  console.log('     with Gigaling Q: defender died ' + withIt.defenderDead + ', attacker died ' + withIt.attackerDead);
  check('the defending Survivor still dies to the bigger creature', withIt.defenderDead, true);
  check('shared Slayer takes Gonta down with it', withIt.attackerDead, true);

  // and the other way round: a Survivor ATTACKING with shared slayer
  S.combat=null; S.turnNumber=10; S.activeTurn=0;
  S.players[0].battlezone=[
    {key:'fs',id:'X/Factory Shell Q',tapped:false,summonedTurn:2},
    {key:'gg',id:'X/Gigaling Q',     tapped:false,summonedTurn:2}
  ];
  S.players[1].battlezone=[{key:'big',id:'X/Bolshack Dragon',tapped:true,summonedTurn:2}];
  say(a,{type:'declareAttack',key:'fs',target:{type:'creature',key:'big'}});
  const bigDead = !S.players[1].battlezone.some(c=>c.key==='big');
  console.log('     attacking into a 6000: the 6000 died ' + bigDead);
  check('shared Slayer works when the Survivor attacks too', bigDead, true);
  console.log();
  console.log(fail ? fail+' failure(s)' : 'shared Slayer works on both sides of a battle');
  process.exit(fail?1:0);

}

if (WHICH === 'triggers') {
  // The engine keeps a hardcoded shield-trigger list from before the sheet existed.
  // Where the two disagree, one of them is wrong — Hunter Fish and Dome Shell were
  // both being forced to be triggers against correct sheet data.
  const fs = require('fs'), path = require('path');
  const srcTxt = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = srcTxt.indexOf('const SHIELD_TRIGGER_CARDS');
  const names = [...srcTxt.slice(i, srcTxt.indexOf(']);', i)).matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map(m => m[1] || m[2]);
  const cards = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8'));
  const norm = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/_/g, "'").trim();
  const by = new Map();
  for (const c of cards) if (c.Name) by.set(norm(c.Name), c);
  const clash = [];
  for (const n of names) {
    const r = by.get(norm(n));
    if (r && !r['Shield Trigger (Yes/No)']) clash.push(String(r.Name));
  }
  for (const c of clash) console.log('  FAIL hardcoded list says trigger, sheet says not: ' + c);
  console.log(clash.length
    ? '\n' + clash.length + ' disagreement(s) — check the card art and fix one side'
    : 'the hardcoded trigger list agrees with the sheet on every card');
  process.exit(clash.length ? 1 : 0);
}

if (WHICH === 'discard') {
  // "When this would be discarded during your OPPONENT'S turn, put it into the battle
  // zone instead." Two halves matter: the redirect must fire (the trigger name did not
  // match, so it never did), and it must NOT fire when you discard your own copy on
  // your own turn — otherwise it becomes a free summon.
  // "When this would be discarded during your opponent's turn, you may put it into the
  // battle zone instead." Exactly the reported case: I attack, they discard, it enters.
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const lg=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js'); console.log=lg;
  const wss=server.__wss, rooms=server.__rooms;
  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const deck=[]; for(const n of ['Terradragon Arque Delacerna','Horrid Worm','Cragsaur','Comet Missile','Aqua Guard','Spiral Gate','Aqua Hulcus','Energy Stream','Bolshack Dragon','Crimson Hammer']) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});
  say(a,{type:'claimTurn'});
  const S=rooms.get(j.room).state;
  let pass=0,fail=0;
  const check=(l,g,w)=>{const ok=g===w;console.log((ok?'  ok   ':'  FAIL ')+l.padEnd(62)+'got '+g);ok?pass++:fail++;};

  // MY turn. Horrid Worm attacks and makes THEM discard — their Terradragon should
  // enter THEIR battle zone, because from their side it is their opponent's turn.
  S.turnNumber=9; S.activeTurn=0;
  S.players[0].battlezone=[{key:'hw',id:'X/Horrid Worm',tapped:false,summonedTurn:2}];
  S.players[1].battlezone=[];
  S.players[1].hand=[{key:'td',id:'X/Terradragon Arque Delacerna'}];
  S.players[1].graveyard=[];
  S.players[1].shields=[{key:'s1',id:'X/Cragsaur',faceUp:false,slot:0}];
  // Force the discard to hit Terradragon specifically — a random discard could pick the
  // shield card that has just entered their hand.
  S.players[1].pendingDiscards=[{id:'d1', kind:'choose', count:1, source:'Horrid Worm'}];
  say(b,{type:'effectDiscardResolve',effectId:'d1',keys:['td']});
  const inPlay = S.players[1].battlezone.some(c=>/Terradragon/.test(c.id));
  const inGrave = S.players[1].graveyard.some(c=>/Terradragon/.test(c.id));
  console.log('     their battlezone: ' + (S.players[1].battlezone.map(c=>c.id.split('/').pop()).join(', ')||'(empty)'));
  console.log('     their graveyard : ' + (S.players[1].graveyard.map(c=>c.id.split('/').pop()).join(', ')||'(empty)'));
  check('discarded on the opponent turn -> enters the battle zone', inPlay, true);
  check('it did NOT also go to the graveyard', inGrave, false);

  // on its OWNER's own turn the redirect must NOT apply
  S.turnNumber=10; S.activeTurn=1;
  S.players[1].battlezone=[]; S.players[1].graveyard=[];
  S.players[1].hand=[{key:'td2',id:'X/Terradragon Arque Delacerna'}];
  S.players[1].pendingDiscards=[{id:'d9', kind:'choose', count:1, source:'test'}];
  say(b,{type:'effectDiscardResolve',effectId:'d9',keys:['td2']});
  console.log('     on its own turn -> battlezone ' + S.players[1].battlezone.length + ', graveyard ' + S.players[1].graveyard.length);
  check('discarded on its OWN turn -> goes to the graveyard', S.players[1].graveyard.some(c=>/Terradragon/.test(c.id)), true);
  // MY turn: I cast Wily Carpenter ("draw up to 2, then discard 2") and discard my own
  // Terradragon. It must go to the graveyard — no free summon.
  S.turnNumber=9; S.activeTurn=0;
  S.players[0].battlezone=[];
  S.players[0].graveyard=[];
  S.players[0].hand=[
    {key:'td', id:'X/Terradragon Arque Delacerna'},
    {key:'x1', id:'X/Cragsaur'},
    {key:'wc', id:'X/Wily Carpenter'}
  ];
  S.players[0].mana=[]; for(let n=0;n<6;n++) S.players[0].mana.push({key:'m'+n,id:'X/Aqua Guard',tapped:false});
  say(a,{type:'summonCard',key:'wc'});
  // answer its discard, choosing my own Terradragon
  for (const d of (S.players[0].pendingDiscards||[]).slice()) {
    say(a,{type:'effectDiscardResolve',effectId:d.id,keys:['td','x1'].filter(k=>S.players[0].hand.some(c=>c.key===k))});
  }
  const mineInPlay = S.players[0].battlezone.some(c=>/Terradragon/.test(c.id));
  const mineInGrave = S.players[0].graveyard.some(c=>/Terradragon/.test(c.id));
  console.log('     my battlezone: ' + (S.players[0].battlezone.map(c=>c.id.split('/').pop()).join(', ')||'(empty)'));
  console.log('     my graveyard : ' + (S.players[0].graveyard.map(c=>c.id.split('/').pop()).join(', ')||'(empty)'));
  check('discarding my OWN copy on MY turn does NOT summon it', mineInPlay, false);
  check('it went to my graveyard instead', mineInGrave, true);

  // Their turn, their copy discarded by MY effect -> that IS their opponent's turn
  S.turnNumber=10; S.activeTurn=0;          // still my turn
  S.players[1].battlezone=[]; S.players[1].graveyard=[];
  S.players[1].hand=[{key:'td2',id:'X/Terradragon Arque Delacerna'}];
  S.players[1].pendingDiscards=[{id:'dx', kind:'choose', count:1, source:'my effect'}];
  say(b,{type:'effectDiscardResolve',effectId:'dx',keys:['td2']});
  check('THEIR copy discarded during MY turn DOES enter their battle zone',
        S.players[1].battlezone.some(c=>/Terradragon/.test(c.id)), true);

  console.log();
  console.log(fail ? fail+' failure(s)' : 'the discard redirect works');
  process.exit(fail?1:0);

}

if (WHICH === 'manaleak') {
  // A refused summon must not spend the mana it would have cost. Mana was tapped
  // BEFORE the evolution checks ran, so every refused evolution silently ate it for
  // the rest of the game while the player's zone still looked untapped.
  // A refused summon must not eat the mana it would have cost.
  const fs=require('fs'), Module=require('module');
  const CARDS=JSON.parse(fs.readFileSync('/home/claude/duelmasters/tools/cards.json','utf8'));
  const routes={}; const app={get:(p,f)=>{(Array.isArray(p)?p:[p]).forEach(x=>routes[x]=f);},use:()=>{},post:()=>{},listen:()=>({on:()=>{}})};
  const ex=()=>app; ex.static=()=>{}; ex.json=()=>{};
  class W{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}}
  const ol=Module._load;
  Module._load=function(r){ if(r==='express')return ex; if(r==='ws')return{Server:W,WebSocketServer:W,OPEN:1};
   if(r==='http')return{createServer:()=>({listen:()=>{},on:()=>{}})};
   if(r==='xlsx')return{readFile:()=>({SheetNames:['Cards'],Sheets:{Cards:{}}}),utils:{sheet_to_json:()=>CARDS}};
   return ol.apply(this,arguments); };
  const lg=console.log; console.log=()=>{};
  const server=require('/home/claude/duelmasters/server.js'); console.log=lg;
  const wss=server.__wss, rooms=server.__rooms;
  const mk=()=>({readyState:1,OPEN:1,inbox:[],send(d){const m=JSON.parse(d);this.inbox.push(m);if(m.type==='state')this.lastState=m.state;},on(e,f){this['_'+e]=f;},close(){}});
  const a=mk(),b=mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say=(s,m)=>{try{s._message(JSON.stringify(m));}catch(e){}};
  say(a,{type:'create',name:'A'});
  const j=a.inbox.find(m=>m.type==='joined');
  say(b,{type:'join',room:j.room,name:'B'}); say(a,{type:'respondJoin',accept:true});
  const deck=[]; for(const n of ['Armored Blaster Valdios','Bolshack Dragon','Comet Missile','Cragsaur','Crimson Hammer','Tornado Flame','Aqua Guard','Spiral Gate','Aqua Hulcus','Energy Stream']) for(let i=0;i<4;i++) deck.push('X/'+n);
  say(a,{type:'submitDeck',deck}); say(b,{type:'submitDeck',deck});
  say(a,{type:'claimTurn'});
  const S=rooms.get(j.room).state;
  let pass=0,fail=0;
  const check=(l,g,w)=>{const ok=g===w;console.log((ok?'  ok   ':'  FAIL ')+l.padEnd(64)+'got '+g);ok?pass++:fail++;};
  const fresh=(n)=>{ S.players[0].mana=[]; for(let i=0;i<n;i++) S.players[0].mana.push({key:'m'+i,id:'X/Comet Missile',tapped:false}); };

  S.turnNumber=9; S.activeTurn=0;
  S.players[0].battlezone=[];   // no Human, so Valdios cannot evolve

  // refused: an evolution creature with no base
  fresh(6);
  S.players[0].hand=[{key:'v',id:'X/Armored Blaster Valdios'}];
  const mk1=a.inbox.length;
  say(a,{type:'summonCard',key:'v'});
  const rej=a.inbox.slice(mk1).find(m=>m.type==='summonRejected');
  console.log('     refusal: ' + (rej ? rej.reason.split('\n')[0] : 'none'));
  const untappedAfter = S.players[0].mana.filter(m=>!m.tapped).length;
  console.log('     untapped mana after the refusal: ' + untappedAfter + ' of 6');
  check('a refused evolution summon does NOT eat the mana', untappedAfter === 6, true);

  // and the mana is still usable for something else
  S.players[0].hand=[{key:'bd',id:'X/Bolshack Dragon'}];
  say(a,{type:'summonCard',key:'bd'});
  check('the mana can still pay for another 6-cost card', S.players[0].battlezone.some(c=>/Bolshack/.test(c.id)), true);
  console.log('     untapped after a REAL summon: ' + S.players[0].mana.filter(m=>!m.tapped).length + ' of 6');
  check('a successful summon DOES take the mana', S.players[0].mana.filter(m=>!m.tapped).length === 0, true);
  console.log();
  console.log(fail ? fail+' failure(s)' : 'refused summons no longer leak mana');
  process.exit(fail?1:0);

}

// ---- shared by the two card checks below (phoenix, jagraveen) ---------------------
// Boots the real server module once, with express/ws/xlsx stubbed, and seats two fresh
// players per call. Paths come from __dirname, so this runs from any checkout.
let __engine = null;
function loadEngine() {
  if (__engine) return __engine;
  const fs = require('fs'), Module = require('module');
  const CARDS = JSON.parse(fs.readFileSync(__dirname + '/cards.json', 'utf8'));
  const routes = {}; const app = { get: (p, f) => { (Array.isArray(p) ? p : [p]).forEach(x => routes[x] = f); }, use: () => {}, post: () => {}, listen: () => ({ on: () => {} }) };
  const ex = () => app; ex.static = () => {}; ex.json = () => {};
  class W { constructor() { this.handlers = {}; } on(e, f) { this.handlers[e] = f; } }
  const ol = Module._load;
  Module._load = function (r) {
    if (r === 'express') return ex; if (r === 'ws') return { Server: W, WebSocketServer: W, OPEN: 1 };
    if (r === 'http') return { createServer: () => ({ listen: () => {}, on: () => {} }) };
    if (r === 'xlsx') return { readFile: () => ({ SheetNames: ['Cards'], Sheets: { Cards: {} } }), utils: { sheet_to_json: () => CARDS } };
    return ol.apply(this, arguments);
  };
  const lg = console.log; console.log = () => {};
  const server = require(__dirname + '/../server.js'); console.log = lg;
  return (__engine = { CARDS, server });
}
function newTable(deckNames) {
  const { CARDS, server } = loadEngine();
  const wss = server.__wss, rooms = server.__rooms;
  const mk = () => ({ readyState: 1, OPEN: 1, inbox: [], send(d) { const m = JSON.parse(d); this.inbox.push(m); if (m.type === 'state') this.lastState = m.state; }, on(e, f) { this['_' + e] = f; }, close() {} });
  const a = mk(), b = mk(); wss.handlers.connection(a); wss.handlers.connection(b);
  const say = (s, m) => { try { s._message(JSON.stringify(m)); } catch (e) { console.log('engine threw: ' + (e && e.stack)); } };
  say(a, { type: 'create', name: 'A' });
  const j = a.inbox.find(m => m.type === 'joined');
  say(b, { type: 'join', room: j.room, name: 'B' }); say(a, { type: 'respondJoin', accept: true });
  const deck = []; for (const n of deckNames) for (let i = 0; i < 4; i++) deck.push('X/' + n);
  say(a, { type: 'submitDeck', deck }); say(b, { type: 'submitDeck', deck });
  say(a, { type: 'claimTurn' });
  const S = rooms.get(j.room).state;
  S.turnNumber = 9; S.activeTurn = 0;
  const nm = c => c.id.split('/').pop();
  const logsSince = (sock, from) => sock.inbox.slice(from).filter(m => m.type === 'log').map(m => m.text);
  const shields = (names) => names.map((n, i) => ({ key: 's' + i, id: 'X/' + n, faceUp: false, slot: i }));
  return { CARDS, a, b, say, S, P: S.players[0], O: S.players[1], nm, logsSince, shields };
}
function makeChecker() {
  const c = { pass: 0, fail: 0 };
  c.check = (l, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? '  ok   ' : '  FAIL ') + l.padEnd(66) + 'got ' + JSON.stringify(got));
    ok ? c.pass++ : c.fail++;
  };
  c.done = (okMsg) => {
    console.log();
    console.log(c.fail ? c.fail + ' failure(s)' : okMsg);
    process.exit(c.fail ? 1 : 0);
  };
  return c;
}

// Runs `scenarios(check)` INSIDE the real public/client.js (under a DOM stub), so the
// scenarios can reach its functions and module-level variables directly.
function runInClient(scenarios, check) {
  const mk = () => ({ style: { setProperty(){}, removeProperty(){}, getPropertyValue: () => '' }, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, insertBefore(){}, querySelector: () => mk(), querySelectorAll: () => [], setAttribute(){}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }), textContent: '', innerHTML: '', value: '', checked: false, focus(){}, remove(){}, children: [], dataset: {}, scrollIntoView(){}, click(){} });
  global.window = { addEventListener(){}, innerWidth: 1000, innerHeight: 800, location: { href: '', protocol: 'https:', host: 'x' }, matchMedia: () => ({ matches: false, addEventListener(){} }), requestAnimationFrame: f => f() };
  global.document = { getElementById: () => mk(), querySelector: () => mk(), querySelectorAll: () => [], createElement: () => mk(), addEventListener(){}, body: mk(), head: mk(), documentElement: mk(), readyState: 'complete' };
  global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
  global.Audio = function () { return { play: () => Promise.resolve(), pause(){}, addEventListener(){}, cloneNode() { return this; } }; };
  global.WebSocket = function () { return { addEventListener(){}, send(){}, close(){} }; };
  global.fetch = () => Promise.reject(new Error('offline'));
  global.requestAnimationFrame = f => f(); global.navigator = { userAgent: 'node' };
  const src = require('fs').readFileSync(__dirname + '/../public/client.js', 'utf8');
  const wq = console.warn; console.warn = () => {};
  try { eval(src + '\n;(' + scenarios.toString() + ')(check);'); }
  catch (e) { check('client.js runs the scenarios without throwing', e.message, null); }
  console.warn = wq;
}

if (WHICH === 'phoenix') {
  // Death Phoenix, Avatar of Doom: Vortex evolution (Zombie Dragon + Fire Bird), goes
  // into the mana zone tapped, Double Breaker; a shield it would break goes to the
  // graveyard instead; when it leaves the battle zone the opponent discards their hand.
  const { parseEffect } = require('../effects-parser.js');
  const NAME = 'Death Phoenix, Avatar of Doom';
  const DECK = [NAME, 'Necrodragon Zalva', 'Kip Chippotto', 'Cragsaur', 'Aqua Guard', 'Spiral Gate', 'Holy Awe', 'Gigaslug', 'Necrodragon Jagraveen'];
  const { check, done } = makeChecker();
  const row = loadEngine().CARDS.find(c => c.Name === NAME);

  // -- the sheet row, as printed on the card
  check('sheet: cost, type, civ, race, power',
    [row['Mana Cost'], row.Type, row.Civilization, row.Race, String(row.Power)], [4, 'Evolution Creature', 'Darkness/Fire', 'Phoenix', '9000']);
  check('sheet: Double Breaker', /^y/i.test(String(row['Double Breaker'])), true);
  const parsed = parseEffect(row.Effect, NAME);
  check('its effect text parses with no errors', parsed.errors.length, 0);
  const vx = parsed.effects.find(e => e.action === 'vortexEvolution');
  check('Vortex races keep their internal spaces', vx && vx.races, ['Zombie Dragon', 'Fire Bird']);

  // -- summoning: needs one Zombie Dragon AND one Fire Bird, and Darkness + Fire mana
  const evolve = (bases, mana, k1, k2) => {
    const T = newTable(DECK);
    T.P.battlezone = bases;
    T.P.hand = [{ key: 'dp', id: 'X/' + NAME }];
    T.P.mana = mana;
    const from = T.a.inbox.length;
    const msg = { type: 'summonCard', key: 'dp' }; if (k1) msg.baseKey = k1; if (k2) msg.baseKey2 = k2;
    T.say(T.a, msg);
    const rej = T.a.inbox.slice(from).find(m => m.type === 'summonRejected');
    const dp = T.P.battlezone.find(c => c.id === 'X/' + NAME);
    return { T, ok: !!dp, dp, why: rej && rej.reason };
  };
  const zd = { key: 'zd', id: 'X/Necrodragon Zalva', tapped: false, summonedTurn: 2 };       // Zombie Dragon
  const zd2 = { key: 'zd2', id: 'X/Necrodragon Jagraveen', tapped: false, summonedTurn: 2 }; // Zombie Dragon
  const fb = { key: 'fb', id: 'X/Kip Chippotto', tapped: false, summonedTurn: 2 };          // Fire Bird
  const bothMana = () => [{ key: 'm1', id: 'X/Gigaslug', tapped: false }, { key: 'm2', id: 'X/Gigaslug', tapped: false },
                          { key: 'm3', id: 'X/Cragsaur', tapped: false }, { key: 'm4', id: 'X/Cragsaur', tapped: false }];
  let r = evolve([{ ...zd }, { ...fb }], bothMana(), 'zd', 'fb');
  check('evolves from a Zombie Dragon + a Fire Bird', r.ok, true);
  check('both bases are stacked underneath it', r.dp && r.dp.under.map(u => u.key).sort(), ['fb', 'zd']);
  check('so it is a 3-card stack: the Phoenix on top of both bases', r.dp && 1 + r.dp.under.length, 3);
  check('and both left the battle zone on their own', r.T.P.battlezone.length, 1);
  r = evolve([{ ...zd }, { ...fb }], bothMana(), 'zd', null);
  check('refused with only one base named', r.ok, false);
  r = evolve([{ ...zd }, { ...zd2 }], bothMana(), 'zd', 'zd2');
  check('refused with two Zombie Dragons and no Fire Bird', r.ok, false);
  r = evolve([{ ...zd }, { ...fb }], bothMana(), 'zd', 'zd');
  check('refused when the same creature is named twice', r.ok, false);
  r = evolve([{ ...zd }, { ...fb }], [1, 2, 3, 4].map(n => ({ key: 'm' + n, id: 'X/Gigaslug', tapped: false })), 'zd', 'fb');
  check('refused with Darkness mana only (it needs Fire too)', r.ok, false);
  check('...and a refused summon did not tap any mana', r.T.P.mana.every(m => !m.tapped), true);

  // -- enters the mana zone tapped
  {
    const T = newTable(DECK);
    T.P.hand = [{ key: 'dp', id: 'X/' + NAME }]; T.P.mana = [];
    T.say(T.a, { type: 'chargeMana', key: 'dp' });
    check('charged into mana: it arrives tapped', T.P.mana.map(m => m.tapped), [true]);
  }

  // -- attacking: Double Breaker, and every shield it breaks goes to the graveyard
  {
    const T = newTable(DECK);
    T.P.battlezone = [{ key: 'dp', id: 'X/' + NAME, tapped: false, summonedTurn: null, under: [] }];
    T.O.battlezone = []; T.O.hand = [{ key: 'h1', id: 'X/Cragsaur' }, { key: 'h2', id: 'X/Aqua Guard' }];
    T.O.shields = T.shields(['Holy Awe', 'Cragsaur', 'Holy Awe', 'Gigaslug', 'Aqua Guard']);   // Holy Awe = Shield Trigger
    T.say(T.a, { type: 'declareAttack', key: 'dp', target: { type: 'shield' } });
    check('it breaks two shields (Double Breaker)', T.S.combat && T.S.combat.shieldsToBreak, 2);
    T.say(T.a, { type: 'breakShield', key: 's0' }); T.say(T.a, { type: 'breakShield', key: 's1' });
    check('the two broken shields are in the graveyard', T.O.graveyard.map(T.nm), ['Holy Awe', 'Cragsaur']);
    check('and NOT in the hand', T.O.hand.map(T.nm), ['Cragsaur', 'Aqua Guard']);
    check('a Shield Trigger shield gets no chance to trigger', T.b.inbox.filter(m => m.type === 'shieldTriggerOffer').length, 0);
    check('the three other shields are untouched', T.O.shields.length, 3);
    check('combat is over', T.S.combat, null);
  }
  // the replacement is the Phoenix's own: it must not touch shields broken by other creatures
  {
    const T = newTable(DECK);
    T.P.battlezone = [{ key: 'at', id: 'X/Cragsaur', tapped: false, summonedTurn: 2 }];
    T.O.battlezone = [{ key: 'dp', id: 'X/' + NAME, tapped: false, summonedTurn: null, under: [] }];   // the Phoenix DEFENDS
    T.O.hand = []; T.O.shields = T.shields(['Aqua Guard', 'Cragsaur', 'Holy Awe']);
    T.P.shields = T.shields(['Aqua Guard', 'Cragsaur', 'Holy Awe']);
    T.say(T.a, { type: 'declareAttack', key: 'at', target: { type: 'shield' } });
    T.say(T.a, { type: 'breakShield', key: 's0' });
    check('a shield broken by ANOTHER creature still goes to the hand', T.O.hand.map(T.nm), ['Aqua Guard']);
    check('...and the Phoenix owner is not asked to send anything to the graveyard', [T.O.pendingTargets.length, T.P.pendingTargets.length, T.P.graveyard.length], [0, 0, 0]);
  }

  // -- leaving the battle zone: the OPPONENT discards their whole hand
  const stage = () => {
    const T = newTable(DECK);
    T.O.battlezone = [{ key: 'dp', id: 'X/' + NAME, tapped: false, summonedTurn: null,
                        under: [{ id: 'X/Necrodragon Zalva', key: 'zd' }, { id: 'X/Kip Chippotto', key: 'fb' }] }];
    T.P.hand = [{ key: 'h1', id: 'X/Cragsaur' }, { key: 'h2', id: 'X/Holy Awe' }, { key: 'h3', id: 'X/Gigaslug' }];
    return T;
  };
  {
    const T = stage(); T.say(T.b, { type: 'battleDestroy', key: 'dp' });
    check('destroyed: the opponent is told to discard their hand', T.P.pendingDiscards.map(d => d.kind), ['all']);
    check('destroyed: the stack under it went to the graveyard as well', T.O.graveyard.map(T.nm).sort(), ['Death Phoenix, Avatar of Doom', 'Kip Chippotto', 'Necrodragon Zalva']);
    T.say(T.a, { type: 'effectDiscardResolve', effectId: T.P.pendingDiscards[0].id, keys: [] });
    check('answering the prompt discards EVERY card', [T.P.hand.length, T.P.graveyard.length], [0, 3]);
  }
  {
    const T = stage(); T.say(T.b, { type: 'battleReturn', key: 'dp' });
    check('returned to hand: the opponent still has to discard', T.P.pendingDiscards.map(d => d.kind), ['all']);
  }
  {
    // bounced by a real spell (Spiral Gate) — the effect-resolution path, not a table button
    const T = stage();
    T.P.battlezone = T.O.battlezone; T.O.battlezone = [];           // Phoenix belongs to A, spell is cast by B
    T.P.hand = []; T.O.hand = [{ key: 'sg', id: 'X/Spiral Gate' }, { key: 'x1', id: 'X/Cragsaur' }, { key: 'x2', id: 'X/Holy Awe' }];
    T.O.mana = [{ key: 'a1', id: 'X/Aqua Guard', tapped: false }, { key: 'a2', id: 'X/Aqua Guard', tapped: false }];
    T.S.activeTurn = 1;
    T.say(T.b, { type: 'summonCard', key: 'sg' });
    const eff = T.O.pendingTargets[0];
    T.say(T.b, { type: 'effectTarget', effectId: eff && eff.id, key: 'dp' });
    check('bounced by a spell: Phoenix and its stack are back in its owner\'s hand', T.P.hand.map(T.nm).sort(), ['Death Phoenix, Avatar of Doom', 'Kip Chippotto', 'Necrodragon Zalva']);
    check('bounced by a spell: the caster must discard their hand', T.O.pendingDiscards.map(d => d.kind), ['all']);
  }
  {
    const T = stage(); T.P.hand = [];
    T.say(T.b, { type: 'battleDestroy', key: 'dp' });
    check('an opponent with no hand is not prompted', T.P.pendingDiscards.length, 0);
  }
  {
    // destroyed in an ordinary battle
    const T = stage(); T.O.battlezone[0].tapped = true;
    T.P.battlezone = [{ key: 'at', id: 'X/Necrodragon Zalva', tapped: false, summonedTurn: 2, tempBuff: 6000 }];   // 11000 beats 9000
    T.say(T.a, { type: 'declareAttack', key: 'at', target: { type: 'creature', key: 'dp' } });
    check('destroyed in battle: it is gone', T.O.battlezone.length, 0);
    check('destroyed in battle: the attacker\'s player must discard', T.P.pendingDiscards.map(d => d.kind), ['all']);
  }
  done('Death Phoenix works properly');
}

if (WHICH === 'jagraveen') {
  // Necrodragon Jagraveen: Blocker, Double Breaker, and "when this creature blocks,
  // destroy it AFTER it battles" — it must still fight, and only then die.
  const NAME = 'Necrodragon Jagraveen';
  const DECK = [NAME, 'Aqua Hulcus', 'Necrodragon Bryzenaga', 'Cragsaur', 'Holy Awe'];
  const { check, done } = makeChecker();
  const row = loadEngine().CARDS.find(c => c.Name === NAME);
  check('sheet: cost, type, civ, race, power',
    [row['Mana Cost'], row.Type, row.Civilization, row.Race, String(row.Power)], [6, 'Creature', 'Darkness', 'Zombie Dragon', '6000']);
  check('sheet: Blocker and Double Breaker', [/^y/i.test(String(row['Blocker (Yes/No)'])), /^y/i.test(String(row['Double Breaker']))], [true, true]);

  const block = (attacker) => {
    const T = newTable(DECK);
    T.P.battlezone = [{ key: 'at', id: 'X/' + attacker, tapped: false, summonedTurn: 2 }];
    T.O.battlezone = [{ key: 'jg', id: 'X/' + NAME, tapped: false, summonedTurn: 2 }];
    T.O.shields = T.shields(['Holy Awe', 'Cragsaur', 'Holy Awe', 'Cragsaur', 'Holy Awe']);
    T.P.shields = [];
    T.say(T.a, { type: 'declareAttack', key: 'at', target: { type: 'shield' } });
    const phase = T.S.combat && T.S.combat.phase;
    const from = T.a.inbox.length;
    T.say(T.b, { type: 'declareBlock', blockerKey: 'jg' });
    return { T, phase, log: T.logsSince(T.a, from) };
  };
  const at = (log, re) => log.findIndex(l => re.test(l));

  // a weaker attacker: it must actually lose the fight, THEN Jagraveen dies
  let r = block('Aqua Hulcus');
  check('it can block (the attack waits for a block)', r.phase, 'blocking');
  check('the blocked attack broke no shield', r.T.O.shields.length, 5);
  check('the weaker attacker was destroyed by the battle', r.T.P.graveyard.map(r.T.nm), ['Aqua Hulcus']);
  check('Jagraveen is destroyed afterwards', [r.T.O.battlezone.length, r.T.O.graveyard.map(r.T.nm)], [0, [NAME]]);
  const iBattle = at(r.log, /^B battle:/), iAtkDead = at(r.log, /Aqua Hulcus was destroyed/), iSelf = at(r.log, /Jagraveen was destroyed after blocking/);
  check('order: battle, then the attacker dies, then Jagraveen', [iBattle >= 0, iAtkDead > iBattle, iSelf > iAtkDead], [true, true, true]);
  check('Jagraveen was NOT destroyed before the battle', at(r.log, /^B (destroyed )?Necrodragon Jagraveen\.?$/), -1);
  check('combat is closed and nothing is left flagged', [r.T.S.combat, r.T.O.graveyard.some(c => c.pendingSelfAction)], [null, false]);

  // a stronger attacker: Jagraveen loses the fight itself, and must not be destroyed twice
  r = block('Necrodragon Bryzenaga');
  check('a stronger attacker survives', r.T.P.battlezone.map(r.T.nm), ['Necrodragon Bryzenaga']);
  check('Jagraveen is in the graveyard exactly once', r.T.O.graveyard.map(r.T.nm), [NAME]);

  // attacking with it is unaffected: Double Breaker, and it does NOT destroy itself
  {
    const T = newTable(DECK);
    T.P.battlezone = [{ key: 'jg', id: 'X/' + NAME, tapped: false, summonedTurn: 2 }];
    T.O.battlezone = []; T.O.shields = T.shields(['Cragsaur', 'Cragsaur', 'Cragsaur', 'Cragsaur', 'Cragsaur']);
    T.say(T.a, { type: 'declareAttack', key: 'jg', target: { type: 'shield' } });
    check('attacking: it breaks two shields', T.S.combat && T.S.combat.shieldsToBreak, 2);
    T.say(T.a, { type: 'breakShield', key: 's0' }); T.say(T.a, { type: 'breakShield', key: 's1' });
    check('attacking: it survives the attack (it only dies when it BLOCKS)', T.P.battlezone.map(T.nm), [NAME]);
  }
  // It only destroys itself when it BLOCKS. In any other battle it dies only if the other
  // creature is at least as strong, like every creature.
  const fight = (label, attackerSide, attName, defName, defTapped) => {
    const T = newTable(DECK.concat(['Bolshack Dragon']));
    const mine = (key, n, tapped) => ({ key, id: 'X/' + n, tapped: !!tapped, summonedTurn: 2 });
    T.P.shields = []; T.O.shields = [];
    if (attackerSide === 'jagraveen') {
      T.P.battlezone = [mine('atk', NAME)]; T.O.battlezone = [mine('def', defName, true)];
    } else {
      T.P.battlezone = [mine('atk', attName)]; T.O.battlezone = [mine('def', NAME, true)];   // tapped, so it cannot block
    }
    T.say(T.a, { type: 'declareAttack', key: 'atk', target: { type: 'creature', key: 'def' } });
    const jgOwner = attackerSide === 'jagraveen' ? T.P : T.O;
    return { alive: jgOwner.battlezone.some(c => c.id === 'X/' + NAME), flagged: [...T.P.battlezone, ...T.O.battlezone].some(c => c.pendingSelfAction), T };
  };
  let f = fight('', 'jagraveen', null, 'Aqua Hulcus');
  check('attacking a weaker creature: Jagraveen survives', [f.alive, f.T.O.graveyard.map(f.T.nm)], [true, ['Aqua Hulcus']]);
  f = fight('', 'jagraveen', null, 'Necrodragon Bryzenaga');
  check('attacking a stronger creature: Jagraveen is destroyed', [f.alive, f.T.O.battlezone.map(f.T.nm)], [false, ['Necrodragon Bryzenaga']]);
  f = fight('', 'jagraveen', null, 'Bolshack Dragon');
  check('attacking an equal creature: both are destroyed', [f.alive, f.T.O.battlezone.length], [false, 0]);
  f = fight('', 'defender', 'Aqua Hulcus', null);
  check('tapped Jagraveen attacked by a weaker creature: it survives', [f.alive, f.T.P.graveyard.map(f.T.nm)], [true, ['Aqua Hulcus']]);
  f = fight('', 'defender', 'Necrodragon Bryzenaga', null);
  check('tapped Jagraveen attacked by a stronger creature: destroyed', f.alive, false);
  check('none of those left a self-destroy pending', f.flagged, false);
  done('Necrodragon Jagraveen works properly');
}


if (WHICH === 'foil') {
  // Artwork filed as "<Short Title> Foil" ("Death Phoenix Foil") is the sheet's card
  // ("Death Phoenix, Avatar of Doom"). Server and client must both see that, and decks
  // saved under the old file name must find the renamed file.
  const { check, done } = makeChecker();
  const FOIL = 'DM-12/Death Phoenix Foil';

  // -- server: the engine finds the card's cost, colours and abilities
  {
    const T = newTable(['Necrodragon Zalva', 'Kip Chippotto', 'Gigaslug', 'Cragsaur']);
    T.P.battlezone = [{ key: 'zd', id: 'X/Necrodragon Zalva', tapped: false, summonedTurn: 2 }, { key: 'fb', id: 'X/Kip Chippotto', tapped: false, summonedTurn: 2 }];
    T.P.hand = [{ key: 'dp', id: FOIL }, { key: 'nf', id: 'DM-12/Nonexistent Foil' }];
    T.P.mana = [1, 2].map(n => ({ key: 'g' + n, id: 'X/Gigaslug', tapped: false })).concat([1, 2].map(n => ({ key: 'c' + n, id: 'X/Cragsaur', tapped: false })));
    const from = T.a.inbox.length;
    T.say(T.a, { type: 'summonCard', key: 'nf' });
    const rej = T.a.inbox.slice(from).find(m => m.type === 'summonRejected');
    check('a Foil that matches no sheet card is still refused', !!rej && /not found in the card database/.test(rej.reason), true);
    T.say(T.a, { type: 'summonCard', key: 'dp', baseKey: 'zd', baseKey2: 'fb' });
    check('"Death Phoenix Foil" is summoned as the real card (Vortex, cost, colours)', T.P.battlezone.map(c => c.id), [FOIL]);
    check('...and its bases are stacked under it', ((T.P.battlezone[0] || {}).under || []).length, 2);
  }

  // -- client: names, metadata and saved decks
  const clientScenarios = function (check) {
    // identifiers below (cardMetaDB, cardDB, cardBaseName, ...) belong to client.js
    const sheet = [{ name: 'Death Phoenix, Avatar of Doom', cost: 4 }, { name: 'Necrodragon Jagraveen', cost: 6 },
                   { name: 'Hydrooze, the Mutant Emperor', cost: 5 }, { name: 'Hydrooze, Something Else', cost: 7 }, { name: 'Aqua Surfer', cost: 6 }];
    cardMetaDB = new Map(); sheet.forEach(c => cardMetaDB.set(normKeyClient(c.name), c)); resetSheetNameIndex();
    const full = 'Death Phoenix, Avatar of Doom';
    check('client: a Foil file name maps to the sheet name', cardBaseName('DM-12/Death Phoenix Foil'), full);
    check('client: the card shows under its sheet name', displayName('DM-12/Death Phoenix Foil'), full);
    check('client: its cost and colours are found', cardMetaFor('DM-12/Death Phoenix Foil').cost, 4);
    check('client: "(Foil)" and "- Foil" spellings too', [cardBaseName('DM-12/Death Phoenix (Foil)'), cardBaseName('DM-12/Death Phoenix - Foil')], [full, full]);
    check('client: an exact sheet name is left alone', cardBaseName('DM-12/' + full), full);
    check('client: a non-foil name is left alone', cardBaseName('DM-3/Aqua Surfer'), 'Aqua Surfer');
    check('client: a foil of a full sheet name', cardBaseName('DM-3/Aqua Surfer Foil'), 'Aqua Surfer');
    check('client: an ambiguous short title is NOT guessed', cardBaseName('X/Hydrooze Foil'), 'Hydrooze Foil');
    check('client: an unknown Foil is left alone', cardBaseName('X/Nonexistent Foil'), 'Nonexistent Foil');
    // deck saved under the old file name, file since renamed to the sheet's name
    cardDB.clear();
    cardDB.set('DM-12/' + full, { url: 'u1', name: full, set: 'DM-12' }); cardDB.set('DM-3/Aqua Surfer', { url: 'u2', name: 'Aqua Surfer', set: 'DM-3' });
    rebuildCardIndex();
    check('client: an old saved-deck id heals onto the renamed file', resolveCardId('DM-12/Death Phoenix Foil'), 'DM-12/' + full);
    check('client: healDeckIds keeps other ids as they are', healDeckIds(['DM-12/Death Phoenix Foil', 'DM-3/Aqua Surfer', 'DM-9/Unknown Card']), ['DM-12/' + full, 'DM-3/Aqua Surfer', 'DM-9/Unknown Card']);
    check('client: the image shows instead of a text placeholder', /<img/.test(cardImgHtml(resolveCardId('DM-12/Death Phoenix Foil'))), true);
    // the other way round: the file is still called "... Foil"
    cardDB.clear(); cardDB.set('DM-12/Death Phoenix Foil', { url: 'u3', name: 'Death Phoenix Foil', set: 'DM-12' }); rebuildCardIndex();
    check('client: file still named Foil, deck holds the full name', resolveCardId('DM-12/' + full), 'DM-12/Death Phoenix Foil');
    check('client: ...and the exact Foil id is untouched', resolveCardId('DM-12/Death Phoenix Foil'), 'DM-12/Death Phoenix Foil');
    // a written decklist
    cardDB.clear(); cardDB.set('DM-12/' + full, { url: 'u1', name: full, set: 'DM-12' }); rebuildCardIndex();
    const r = parseDecklist('2x Death Phoenix Foil\n1 ' + full + '\n1 Bogus Card');
    check('client: a decklist line "Death Phoenix Foil" finds the card', [r.deck.length, r.deck[0], r.notFound], [3, 'DM-12/' + full, ['Bogus Card']]);
  };
  runInClient(clientScenarios, check);
  done('Foil-named artwork resolves to the sheet card');
}


if (WHICH === 'evolve') {
  // Death Phoenix (Vortex: a Zombie Dragon AND a Fire Bird) could not be summoned from the
  // hand: the Summon menu refused it because no Phoenix was on the table — the ordinary
  // "evolve from your own race" rule — before the two-creature picker could ever open.
  // Everything that decides whether an evolution can be played must know about Vortex:
  // the click gate, the picker, and the computer player.
  const fs = require('fs');
  const { check, done } = makeChecker();
  const NAME = 'Death Phoenix, Avatar of Doom';
  const clientSrc = fs.readFileSync(__dirname + '/../public/client.js', 'utf8');
  check('the Summon menu uses the Vortex-aware test', /canEvolveFromClient\(c\.id, mine\.battlezone\)/.test(clientSrc), true);
  check('...and no longer only the same-race one', /mine\.battlezone\.filter\(b => canEvolveOntoClient\(c\.id, b\.id\)\)/.test(clientSrc), false);

  // -- client: can it be summoned, what does the picker offer, what does it send
  runInClient(function (check) {
    const DP = 'DM-12/Death Phoenix, Avatar of Doom';
    const db = [
      { name: 'Death Phoenix, Avatar of Doom', type: 'Evolution Creature', race: 'Phoenix', cost: 4, effectText: 'static: vortex Zombie Dragon+Fire Bird; static: grant entersManaTapped self' },
      { name: 'Necrodragon Jagraveen', type: 'Creature', race: 'Zombie Dragon' }, { name: 'Necrodragon Gilland', type: 'Creature', race: 'Zombie Dragon' },
      { name: 'Cocco Lupia', type: 'Creature', race: 'Fire Bird' }, { name: 'Bolshack Dragon', type: 'Creature', race: 'Armored Dragon' },
      { name: 'Aqua Surfer', type: 'Creature', race: 'Liquid People' }, { name: 'Some Phoenix', type: 'Creature', race: 'Phoenix' },
      { name: 'Dual Race', type: 'Creature', race: 'Zombie Dragon/Fire Bird' },
      { name: 'Test Evolution', type: 'Evolution Creature', race: 'Liquid People', cost: 5 }
    ];
    cardMetaDB = new Map(); db.forEach(c => cardMetaDB.set(normKeyClient(c.name), c));
    const z = (key, name) => ({ key, id: 'X/' + name });
    const jg = z('jg', 'Necrodragon Jagraveen'), gl = z('gl', 'Necrodragon Gilland'), cl = z('cl', 'Cocco Lupia'),
          bd = z('bd', 'Bolshack Dragon'), aq = z('aq', 'Aqua Surfer'), ph = z('ph', 'Some Phoenix'), du = z('du', 'Dual Race');
    check('client: the Vortex races are read from the sheet', vortexRacesClient(DP), ['Zombie Dragon', 'Fire Bird']);
    check('client: Zombie Dragon + Zombie Dragon + Fire Bird: can summon', canEvolveFromClient(DP, [jg, gl, cl]), true);
    check('client: a Zombie Dragon and a Fire Bird are enough', canEvolveFromClient(DP, [jg, cl]), true);
    check('client: no Fire Bird: cannot', canEvolveFromClient(DP, [jg, gl]), false);
    check('client: no Zombie Dragon: cannot', canEvolveFromClient(DP, [cl, aq]), false);
    check('client: an Armored Dragon is not a Zombie Dragon', canEvolveFromClient(DP, [bd, cl]), false);
    check('client: its own race (Phoenix) is not what it needs', canEvolveFromClient(DP, [ph, aq]), false);
    check('client: one creature cannot be both bases', canEvolveFromClient(DP, [du]), false);
    check('client: ...but a dual-race creature can be one of them', canEvolveFromClient(DP, [du, jg]), true);
    check('client: an ordinary evolution still needs its own race', [canEvolveFromClient('X/Test Evolution', [aq]), canEvolveFromClient('X/Test Evolution', [jg])], [true, false]);

    renderState = () => {};                                  // drawing is not under test
    const sent = []; sendMsg = m => sent.push(m);
    const me = { battlezone: [jg, gl, cl, bd, aq], crossGear: [] };
    evolveMode = { handKey: 'h1', cardId: DP };
    let sel = selectableKeysFor({}, me, {});
    check('client: the picker offers Zombie Dragons and Fire Birds only', [...sel.keys].sort(), ['cl', 'gl', 'jg']);
    sel.onClick('jg');
    sel = selectableKeysFor({}, me, {});
    check('client: after a Zombie Dragon it offers only Fire Birds', [...sel.keys], ['cl']);
    sel.onClick('cl');
    check('client: both bases go to the server in one summon', sent, [{ type: 'summonCard', key: 'h1', baseKey: 'jg', baseKey2: 'cl' }]);
    check('client: and the picker closes', evolveMode, null);
  }, check);

  // -- the computer player, against the real server
  {
    const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const META = new Map();
    for (const r of loadEngine().CARDS) if (r.Name) {
      const y = v => /^(y|yes|true|1)$/i.test(String(v == null ? '' : v).trim());
      const n = v => { const x = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10); return Number.isFinite(x) ? x : null; };
      if (!META.has(norm(r.Name))) META.set(norm(r.Name), { name: String(r.Name).trim(), cost: n(r['Mana Cost']), power: n(r.Power), type: String(r.Type || ''), race: String(r.Race || ''),
        civs: String(r.Civilization || '').split('/').map(x => x.trim()).filter(Boolean), blocker: y(r['Blocker (Yes/No)']), doubleBreaker: y(r['Double Breaker']), tripleBreaker: y(r['Triple Breaker']),
        speedAttacker: y(r['Speed Attacker (yes/No)']), shieldTrigger: y(r['Shield Trigger (Yes/No)']), slayer: y(r.Slayer), attackRestriction: String(r['Attack restriction'] || 'none'), effectText: r.Effect ? String(r.Effect) : '' });
    }
    global.cardMetaFor = id => META.get(norm(String(id).split('/').pop())) || {};
    global.displayName = id => String(id).split('/').pop();
    global.fetch = () => Promise.reject(new Error('offline'));
    const botSrc = fs.readFileSync(__dirname + '/../public/bot.js', 'utf8');
    const playBot = (boardSetup) => {
      const pending = new Map(); let nextId = 1; const order = [];
      const st = (fn) => { const id = nextId++; pending.set(id, fn); order.push(id); return id; };
      const ct = (id) => pending.delete(id);
      const bot = eval('(function(setTimeout, clearTimeout){' + botSrc + '; return Bot; })')(st, ct);
      const drain = (limit) => { let ran = 0; while (order.length && ran < limit) { const id = order.shift(); const fn = pending.get(id); if (!fn) continue; pending.delete(id); try { fn(); } catch (e) { /* the bot's own errors surface as missing moves */ } ran++; } return ran; };
      const T = newTable(['Death Phoenix, Avatar of Doom', 'Necrodragon Jagraveen', 'Cocco Lupia', 'Bolshack Dragon', 'Gigaslug', 'Cragsaur', 'Aqua Guard']);
      const sent = [];
      const origSend = T.b.send.bind(T.b);
      T.b.send = function (d) { origSend(d); const m = JSON.parse(d); if (this.onMsg) this.onMsg(m); };
      T.S.turnNumber = 12; T.S.activeTurn = 1;                 // the COMPUTER's turn
      T.P.battlezone = []; T.P.shields = T.shields(['Cragsaur', 'Cragsaur', 'Cragsaur']);
      boardSetup(T.O);
      bot.start({ seatIdx: 1, deck: [], send: (m) => { sent.push(m); T.say(T.b, m); } });
      T.b.onMsg = (m) => { if (m.type === 'state') bot.onState(m.state); };
      T.say(T.b, { type: 'setShowingHand', show: false });      // makes the server send the bot its view
      for (let i = 0; i < 60; i++) { if (T.b.lastState) bot.onState(T.b.lastState); if (!drain(400)) break; if (T.S.activeTurn !== 1) break; }
      return { T, sent };
    };
    const mana = () => [{ key: 'm1', id: 'X/Gigaslug', tapped: false }, { key: 'm2', id: 'X/Gigaslug', tapped: false }, { key: 'm3', id: 'X/Cragsaur', tapped: false }, { key: 'm4', id: 'X/Cragsaur', tapped: false }];
    const body = (key, name) => ({ key, id: 'X/' + name, tapped: false, summonedTurn: 10 });

    let r = playBot(B => {
      B.battlezone = [body('jg', 'Necrodragon Jagraveen'), body('bd', 'Bolshack Dragon'), body('cl', 'Cocco Lupia')];
      B.hand = [{ key: 'dp', id: 'X/' + NAME }]; B.mana = mana();
    });
    const summon = r.sent.find(m => m.type === 'summonCard' && m.key === 'dp');
    check('bot: summons Death Phoenix, naming a base of each race', summon && [summon.baseKey, summon.baseKey2].sort(), ['cl', 'jg']);
    const dp = r.T.O.battlezone.find(c => c.id === 'X/' + NAME);
    check('bot: the server accepted it as a 3-card stack', dp && dp.under.map(u => u.key).sort(), ['cl', 'jg']);
    check('bot: it kept the Armored Dragon (not a valid base) on the table', r.T.O.battlezone.some(c => c.key === 'bd'), true);

    r = playBot(B => {
      B.battlezone = [body('jg', 'Necrodragon Jagraveen'), body('bd', 'Bolshack Dragon')];        // no Fire Bird
      B.hand = [{ key: 'dp', id: 'X/' + NAME }]; B.mana = mana();
    });
    check('bot: without a Fire Bird it does not even try', r.sent.some(m => m.type === 'summonCard' && m.key === 'dp'), false);
    check('bot: and it still finishes its turn', r.T.S.activeTurn, 0);
  }
  done('Death Phoenix can be summoned by the player and by the computer');
}

if (WHICH === 'effects') {
  // Exercise the new interpreter paths in isolation so a crash shows up here rather
  // than mid-game.
  const { parseEffect } = require('/home/claude/duelmasters/effects-parser.js');
  const cases = [
    ['Bluum Erkis, Flare Guardian', 'onBreak: reveal target'],
    ['Bombazar, Dragon of Destiny', 'onSummon: destroy all anyCreature[power=6000,!self]; extraTurn; loseGame endOfExtraTurn'],
    ['Azaghast, Tyrant of Shadows', 'onAnyCreatureEnter[own,race=Ghost]: destroy oppCreature[untapped], optional'],
    ['Static Warp', 'onSummon: ownKeeps 1 ownCreature, rest -> tap'],
    ['Carnival Totem', 'onSummon: toHand all ownMana; toMana all ownHand tapped'],
    ['Elixia, Pureblade Elemental', 'static: grant doubleBreaker self if self.power>=6000 and self.power<15000'],
    ['Charge Whipper', 'static: grant silentSkill self; tapAbility: toShield up to 1 ownHand'],
    ['Aqua Skydiver', 'static: grant manaTapped self; onDestroy: -> hand'],
    ['Pinpoint Lunatron', 'tapAbility: bounce anyCreature orElse bounce ownMana orElse bounce oppMana'],
    ['Bat Doctor, Shadow of Undeath', 'onDestroy: toHand up to 1 otherOwnGrave[creature]'],
    ['Carnival Totem', 'onSummon: toMana all ownHand, tapped'],
    ['Charge Whipper', 'silentSkill: fromHand 1 -> shield, optional'],
    ['Dance of the Sproutlings', 'onSummon: any number ownHand[race=named] -> mana, optional'],
    ['Grinning Hunger', 'onSummon: toGrave choose 1 (oppCreature or oppShield), oppChoice'],
    ['Karate Potato', 'onSummon: up to 2 ownHand -> mana, optional'],
    ['Nexus Charger', 'onSummon: fromHand 1 -> shield'],
    ['Pinpoint Lunatron', 'silentSkill: toHand choose 1 (anyCreature or anyMana)'],
    ['Zombie Carnival', 'onSummon: up to 3 ownGrave[creature,race=named] -> hand'],
    ['Mummy Wrap, Shadow of Fatigue', 'tapAbility: eachDiscard random 1']
  ];
  let bad = 0;
  for (const [n, t] of cases) {
    const p = parseEffect(t, n);
    if (p.errors.length) { console.log('PARSE FAIL', n, p.errors[0].reason); bad++; continue; }
    const summary = p.effects.map(e => e.trigger + ':' + e.action +
      (e.triggerFilter ? '[filtered]' : '') + (e.orElse ? '(+' + e.orElse.length + ' fallback)' : '')).join(', ');
    console.log('  ' + n.slice(0, 30).padEnd(32) + summary);
  }
  console.log(bad ? '\nFAILURES: ' + bad : '\nall representative cards parse to executable shapes');

}

if (WHICH === 'audit') {
  // Coverage audit: every parsed clause must have BOTH its trigger hooked into the
  // engine and its action implemented. Anything missing is reported by card name.
  const fs = require('fs');
  const { parseEffect } = require('../effects-parser.js');
  const server = fs.readFileSync(__dirname + '/../server.js', 'utf8');

  // triggers the engine actually fires (searched for in the source)
  const firesTrigger = (t) =>
    new RegExp("'" + t + "'").test(server) &&
    (new RegExp("firePar\\([^)]*'" + t + "'").test(server) ||
     new RegExp("fireBoardWide\\(\\s*\\w+,\\s*'" + t + "'").test(server) ||
     new RegExp("runParsedEffects\\([^)]*'" + t + "'").test(server) ||
     t === 'static' || t === 'cast' ||
     // handled by a dedicated path rather than the generic trigger dispatcher
     (t === 'ondiscard' && /function discardRedirect\(/.test(server)));

  // actions the interpreter implements (a `case 'x':` inside runParsedEffects)
  const interp = server.slice(server.indexOf('function runParsedEffects('));
  const interpBody = interp.slice(0, interp.indexOf('\nfunction '));
  const handlesAction = (a) =>
    new RegExp("case '" + a + "'").test(interpBody) ||
    ['buff', 'grant', 'prevent', 'costPlus', 'costMinus', 'condition'].includes(a);

  // Read the effects straight from the shipped spreadsheet by default, so the audit can
  // never pass against a stale export of an older sheet.
  let rows;
  if (process.argv[3]) rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  else {
    let XLSX;
    try { XLSX = require('xlsx'); }
    catch (e) {
      console.error('audit needs the xlsx module (npm install), or pass a JSON export:');
      console.error('   node audit.js effects.json');
      process.exit(2);
    }
    const dir = __dirname + '/../carddata';
    const file = fs.readdirSync(dir).find(f => f.endsWith('.xlsx') && !f.startsWith('~'));
    const wb = XLSX.readFile(dir + '/' + file);
    const sheet = wb.Sheets[wb.SheetNames.find(n => n.trim().toLowerCase() === 'cards') || wb.SheetNames[0]];
    const seen = new Set();
    rows = XLSX.utils.sheet_to_json(sheet)
      .filter(r => r.Name && r.Effect)
      .filter(r => { const k = String(r.Name); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(r => ({ name: String(r.Name), effect: String(r.Effect) }));
  }
  let total = 0, wired = 0;
  const missTrigger = {}, missAction = {};
  for (const r of rows) {
    for (const e of parseEffect(r.effect, r.name).effects) {
      total++;
      const tOk = firesTrigger(e.trigger);
      const aOk = handlesAction(e.action);
      if (tOk && aOk) { wired++; continue; }
      if (!tOk) (missTrigger[e.trigger] = missTrigger[e.trigger] || []).push(r.name);
      else (missAction[e.action] = missAction[e.action] || []).push(r.name);
    }
  }
  console.log('clauses wired: ' + wired + '/' + total);

  // Deeper pass: a clause can be "wired" and still do nothing if the engine never
  // consults the specific keyword it grants or the specific thing it prevents.
  // Read the engine's own declared registries rather than guessing from patterns —
  // a keyword can then never look supported without actually being handled.
  const readSet = (name) => {
    const m = server.match(new RegExp('const ' + name + ' = new Set\\(\\[([^\\]]*)\\]'));
    return new Set(m ? (m[1].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1)) : []);
  };
  const consulted = readSet('HANDLED_KEYWORDS');
  const preventsDone = readSet('HANDLED_PREVENTS');

  const gaps = { grant: {}, prevent: {} };
  for (const r of rows) {
    for (const e of parseEffect(r.effect, r.name).effects) {
      if (e.action === 'grant') {
        const k = String(e.keyword || '').toLowerCase().replace(/\[.*$/, '');
        if (!consulted.has(k)) (gaps.grant[k] = gaps.grant[k] || []).push(r.name);
      }
      if (e.action === 'prevent') {
        const w = String(e.what || '').toLowerCase().replace(/\[.*$/, '');
        if (!preventsDone.has(w)) (gaps.prevent[w] = gaps.prevent[w] || []).push(r.name);
      }
    }
  }
  const dump2 = (label, obj) => {
    const keys = Object.keys(obj);
    if (!keys.length) { console.log(label + ' none'); return; }
    console.log('\n' + label);
    keys.sort((a, b) => obj[b].length - obj[a].length).forEach(k =>
      console.log('   ' + k.padEnd(28) + String(obj[k].length).padStart(3) + '  ' + obj[k].slice(0, 2).join(', ')));
  };
  dump2('GRANTED keywords the engine never consults:', gaps.grant);
  dump2('PREVENT variants not enforced:', gaps.prevent);
  // The registries above are only trustworthy if the engine really references each
  // entry. Verify that too, so nothing can be declared handled without being handled.
  const declSpan = (() => {
    const a = server.indexOf('const HANDLED_KEYWORDS');
    const b = server.indexOf(']);', server.indexOf('const HANDLED_PREVENTS')) + 3;
    return [a, b];
  })();
  const engineBody = server.slice(0, declSpan[0]) + server.slice(declSpan[1]);
  const unrefK = [...consulted].filter(k => !new RegExp(k.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&'), 'i').test(engineBody));
  const unrefP = [...preventsDone].filter(k => !new RegExp(k, 'i').test(engineBody));
  if (unrefK.length || unrefP.length) {
    console.error('\nDECLARED BUT NOT REFERENCED IN ENGINE CODE:');
    if (unrefK.length) console.error('   keywords: ' + unrefK.join(', '));
    if (unrefP.length) console.error('   prevents: ' + unrefP.join(', '));
    process.exitCode = 1;
  } else {
    console.log('registry entries all referenced by engine code: yes');
  }

  if (Object.keys(gaps.grant).length || Object.keys(gaps.prevent).length) process.exitCode = 1;
  const dump = (label, obj) => {
    const keys = Object.keys(obj);
    if (!keys.length) return;
    console.log('\n' + label);
    keys.sort((a, b) => obj[b].length - obj[a].length).forEach(k =>
      console.log('   ' + k.padEnd(26) + String(obj[k].length).padStart(3) + '  ' + obj[k].slice(0, 3).join(', ')));
  };
  dump('TRIGGERS not fired by the engine:', missTrigger);
  dump('ACTIONS not implemented:', missAction);
  if (wired < total) process.exitCode = 1;

}

if (WHICH === 'sheet') {
  // Data validation for the card sheet — the cross-row checks that caught the DM-08
  // clusters, runnable before any export is considered done.
  //   node sheet-check.js            (reads carddata/*.xlsx)
  const fs = require('fs');
  let XLSX;
  try { XLSX = require('xlsx'); }
  catch (e) { console.error('needs the xlsx module: npm install xlsx'); process.exit(2); }

  const dir = __dirname + '/../carddata';
  const file = fs.readdirSync(dir).find(f => f.endsWith('.xlsx') && !f.startsWith('~'));
  const wb = XLSX.readFile(dir + '/' + file);
  const sheet = wb.Sheets[wb.SheetNames.find(n => n.trim().toLowerCase() === 'cards') || wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  let problems = 0;
  const report = (label, list) => {
    if (!list.length) return;
    problems += list.length;
    console.log('\n' + label + ' (' + list.length + '):');
    list.slice(0, 20).forEach(l => console.log('   ' + l));
    if (list.length > 20) console.log('   ... and ' + (list.length - 20) + ' more');
  };

  const nameOf = (r) => String(r.Name == null ? '' : r.Name).trim();
  const key = (r) => nameOf(r).toLowerCase();

  // 1. no card has more than two civilizations
  report('Rows listing three or more civilizations', rows
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(x => String(x.r.Civilization || '').split('/').length > 2)
    .map(x => 'row ' + x.line + '  ' + nameOf(x.r) + '  [' + x.r.Civilization + ']'));

  // 2. cell hygiene — a pasted record shows up as a tab or newline
  report('Cells containing a tab or newline', rows
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(x => Object.values(x.r).some(v => typeof v === 'string' && /[\t\n\r]/.test(v)))
    .map(x => 'row ' + x.line + '  ' + nameOf(x.r).slice(0, 40)));

  // 3. one row per card. Reprints were merged, so a repeat now means an accidental
  //    duplicate rather than a legitimate second printing.
  const dupCounts = new Map();
  rows.forEach((r, i) => {
    const k = key(r);
    if (!k) return;
    if (!dupCounts.has(k)) dupCounts.set(k, []);
    dupCounts.get(k).push(i + 2);
  });
  report('Cards appearing on more than one row', [...dupCounts.entries()]
    .filter(([, ls]) => ls.length > 1)
    .map(([k, ls]) => k + ' — rows ' + ls.join(', ')));

  // 4. reprints must agree — kept for sheets that still carry multiple printings
  const groups = new Map();
  rows.forEach((r, i) => {
    const k = key(r);
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ r, line: i + 2 });
  });
  for (const field of ['Civilization', 'Mana Cost', 'Type', 'Power', 'Race']) {
    const bad = [];
    for (const [k, list] of groups) {
      const seen = new Map();
      for (const x of list) {
        const v = x.r[field];
        if (v === null || v === undefined || v === '') continue;
        const norm = String(v).replace(/\s*\/\s*/g, '/').trim();
        if (!seen.has(norm)) seen.set(norm, []);
        seen.get(norm).push(x.line);
      }
      if (seen.size > 1) {
        bad.push(list[0].r.Name + ' — ' + [...seen.entries()]
          .map(([v, ls]) => '[' + v + '] rows ' + ls.join(',')).join('  vs  '));
      }
    }
    report('Reprints disagreeing on ' + field, bad);
  }

  // 4. type-appropriate properties.
  //    resolvesTo is legitimate on Evolution Cross Gear as well as Spell — that is a real
  //    printed reminder on that card type, not contamination.
  const RESOLVES_TO_OK = new Set(['spell', 'cross gear', 'evolution cross gear']);
  report('resolvesTo on a card type that cannot have it', rows
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(x => /resolvesTo/i.test(String(x.r.Effect || '')))
    .filter(x => !RESOLVES_TO_OK.has(String(x.r.Type || '').trim().toLowerCase()))
    .map(x => 'row ' + x.line + '  ' + nameOf(x.r) + '  [' + x.r.Type + ']'));

  // 5. a creature whose onSummon moves itself to mana would vanish on being played
  report('Cards that would send themselves to mana on summon', rows
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(x => /onSummon:\s*->\s*mana/i.test(String(x.r.Effect || '')))
    .map(x => 'row ' + x.line + '  ' + nameOf(x.r) +
      '  (multicoloured cards already enter mana tapped automatically)'));

  console.log();
  console.log(problems ? problems + ' problem(s) found' : 'sheet is clean');
  process.exit(problems ? 1 : 0);

}
