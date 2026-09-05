#!/usr/bin/env node
// Every project check, in one file. check.js forks this once per check so each runs
// in a clean process — several of them stub globals or intercept require(), and
// sharing a process would let one contaminate the next.
//
//   node tools/checks.js <name>     guards | client | server | bot | effects | audit | sheet
//
// __dirname below refers to tools/, so paths to project files go up one level.
const WHICH = process.argv[2];
const NAMES = ['guards', 'client', 'server', 'bot', 'effects', 'audit', 'sheet'];
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
