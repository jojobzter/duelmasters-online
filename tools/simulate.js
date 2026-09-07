#!/usr/bin/env node
// Plays complete games between two decks, bot against bot, on the real server.
//
//   node tools/simulate.js deckA.txt deckB.txt [games]
//
// The point is to measure a deck rather than argue about it. Both seats are driven by
// the same bot, so the only variable is the decklists — and seats are swapped every
// other game so going first cannot flatter one side.
const fs = require('fs');
const path = require('path');
const Module = require('module');

// The card rows, exported from the spreadsheet so the simulator works without the
// xlsx module. Regenerate with:  node tools/simulate.js --export
const CARDS_FILE = path.join(__dirname, 'cards.json');
if (!fs.existsSync(CARDS_FILE)) {
  console.error('tools/cards.json is missing — it holds the card rows the simulator needs.');
  console.error('Regenerate it from the spreadsheet with:');
  console.error('   node -e "const X=require(\'xlsx\'),f=X.readFile(\'carddata/Duel_Masters_Card_Database.xlsx\');' +
                'require(\'fs\').writeFileSync(\'tools/cards.json\',JSON.stringify(X.utils.sheet_to_json(f.Sheets.Cards)))"');
  process.exit(2);
}
const CARDS = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));

// ---- load the real server with its network dependencies stubbed out ----
const routes = {};
const fakeApp = { get: (p, f) => { routes[p] = f; }, use: () => {}, post: () => {}, listen: () => ({ on: () => {} }) };
const fakeExpress = () => fakeApp;
fakeExpress.static = () => {}; fakeExpress.json = () => {};
class FakeWSS { constructor() { this.handlers = {}; } on(e, f) { this.handlers[e] = f; } }

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'express') return fakeExpress;
  if (request === 'ws') return { Server: FakeWSS, WebSocketServer: FakeWSS, OPEN: 1 };
  if (request === 'http') return { createServer: () => ({ listen: () => {}, on: () => {} }) };
  if (request === 'xlsx') return {
    readFile: () => ({ SheetNames: ['Cards'], Sheets: { Cards: {} } }),
    utils: { sheet_to_json: () => CARDS }
  };
  return origLoad.apply(this, arguments);
};

const quiet = console.log;
console.log = () => {};                       // the server is chatty at load
const server = require(path.join(__dirname, '..', 'server.js'));
console.log = quiet;
const wss = server.__wss;

// ---- card lookup, so decklists can be written by name ----
const byName = new Map();
for (const row of CARDS) {
  const key = String(row.Name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!byName.has(key)) byName.set(key, String(row.Set || 'DM') + '/' + String(row.Name));
}
function loadDeck(file) {
  const out = [];
  const missing = [];
  for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\d+)\s*[xX*]?\s*(.+)$/);
    const n = m ? parseInt(m[1], 10) : 1;
    const name = (m ? m[2] : line).trim();
    const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const id = byName.get(key);
    if (!id) { missing.push(name); continue; }
    for (let i = 0; i < n; i++) out.push(id);
  }
  if (missing.length) { console.error('cards not found: ' + missing.join(', ')); process.exit(1); }
  return out;
}

// ---- the bot, loaded once and instantiated per seat ----
const botSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'bot.js'), 'utf8');
// Seat B can run a different bot build, so an AI change can be measured against the
// current one with the SAME deck on both sides: anything above 50% is a real gain.
//   SIM_BOT_B=/tmp/bot-baseline.js node tools/simulate.js deck.txt deck.txt 24
const botSrcB = process.env.SIM_BOT_B
  ? fs.readFileSync(process.env.SIM_BOT_B, 'utf8')
  : botSrc;
const META = new Map();
for (const row of CARDS) {
  const key = String(row.Name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (META.has(key)) continue;
  META.set(key, {
    cost: Number(row['Mana Cost']) || 0,
    power: parseInt(String(row.Power || '').replace(/[^0-9]/g, ''), 10) || null,
    type: String(row.Type || ''),
    civs: String(row.Civilization || '').split('/').map(s => s.trim()).filter(Boolean),
    race: String(row.Race || ''),
    blocker: !!row['Blocker (Yes/No)'],
    shieldTrigger: !!row['Shield Trigger (Yes/No)'],
    speedAttacker: !!row['Speed Attacker (yes/No)'],
    doubleBreaker: !!row['Double Breaker'],
    tripleBreaker: !!row['Triple Breaker'],
    slayer: !!row.Slayer,
    attackRestriction: String(row['Attack restriction'] || 'none')
  });
}
global.fetch = () => Promise.reject(new Error('offline'));
global.cardMetaFor = (id) => META.get(String(id).split('/').pop()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()) || {};
global.displayName = (id) => String(id).split('/').pop();

// The bot paces itself with setTimeout so a human can follow along. For simulation we
// want it to act immediately, so each bot is evaluated with a scheduler that runs its
// callback on a queue we drain ourselves — no timers, fully deterministic ordering.
// Ids must stay stable as the queue drains. An array with index-based ids does not:
// after one shift() every id points at the wrong slot, so a clearTimeout cancels an
// unrelated callback and the bot's "an action is already queued" guard never clears —
// it then sits frozen for the rest of the game.
const pending = new Map();
let nextTimerId = 1;
const order = [];
function makeBot(which) {
  const setTimeout = (fn) => { const id = nextTimerId++; pending.set(id, fn); order.push(id); return id; };
  const clearTimeout = (id) => { pending.delete(id); };
  return eval('(function(setTimeout, clearTimeout){' + (which === 1 ? botSrcB : botSrc) + '; return Bot; })')(setTimeout, clearTimeout);
}
function drainQueue(limit) {
  let ran = 0;
  while (order.length && ran < (limit || 200)) {
    const id = order.shift();
    const fn = pending.get(id);
    if (!fn) continue;                       // cancelled before it ran
    pending.delete(id);
    try { fn(); } catch (e) { /* the server refused it */ }
    ran++;
  }
  return ran;
}

// ---- one game ----
function playGame(deck0, deck1, seed) {
  const sockets = [];
  const mk = () => {
    const s = {
      readyState: 1, OPEN: 1, inbox: [],
      send(d) { const m = JSON.parse(d); this.inbox.push(m); if (this.onMsg) this.onMsg(m); },
      on(ev, fn) { this['_' + ev] = fn; }, close() {}
    };
    sockets.push(s);
    return s;
  };
  const a = mk(), b = mk();
  wss.handlers.connection(a);
  wss.handlers.connection(b);
  const say = (sock, msg) => { try { sock._message(JSON.stringify(msg)); } catch (e) { /* rejected */ } };

  const latest = (sock) => { const m = sock.inbox.filter(x => x.type === 'state').pop(); return m && m.state; };
  const firstResult = (sock) => {
    for (const m of sock.inbox) {
      if (m.type === 'state' && m.state && m.state.gameOver) return m.state;
    }
    return null;
  };

  say(a, { type: 'create', name: 'A' });
  const joined = a.inbox.find(m => m.type === 'joined');
  if (!joined) return { error: 'no room' };
  say(b, { type: 'join', room: joined.room, name: 'B' });
  say(a, { type: 'respondJoin', accept: true });
  say(a, { type: 'submitDeck', deck: deck0 });
  say(b, { type: 'submitDeck', deck: deck1 });

  // wire a bot to each seat
  const bots = [makeBot(0), makeBot(1)];
  bots[0].start({ seatIdx: 0, deck: deck0, send: (m) => say(a, m) });
  bots[1].start({ seatIdx: 1, deck: deck1, send: (m) => say(b, m) });
  a.onMsg = (m) => { if (m.type === 'state') bots[0].onState(m.state); };
  b.onMsg = (m) => { if (m.type === 'state') bots[1].onState(m.state); };

  if (process.env.SIM_DEBUG) {
    console.log('  after deal: a sees ' + (latest(a) ? 'state' : 'NOTHING') +
                ', b sees ' + (latest(b) ? 'state' : 'NOTHING'));
    const s0 = latest(a);
    if (s0) console.log('  hand ' + s0.players[s0.you].hand.length +
                        ', shields ' + s0.players[s0.you].shields.length +
                        ', activeTurn ' + s0.activeTurn);
  }
  // kick the first turn off
  const markT = a.inbox.length;
  say(a, { type: 'claimTurn' });
  if (process.env.SIM_DEBUG) {
    const rej = a.inbox.slice(markT).find(m => m.type === 'summonRejected');
    console.log('  claimTurn -> activeTurn ' + (latest(a) || {}).activeTurn +
                (rej ? ' | rejected: ' + rej.reason.slice(0, 50) : ''));
  }
  let st = latest(a);
  if (st) { bots[0].onState(st); bots[1].onState(latest(b)); }

  // The bots act on timers in the browser; here we pump them synchronously by
  // replaying the current state until the game ends or the turn cap is hit.
  // Drain the bots' action queues repeatedly. Each pass feeds both bots the current
  // state, runs whatever they decided, then re-reads — a game can advance many turns
  // inside a single pass, so the result is checked after every drain, not before.
  const MAX_PASSES = 600;
  let lastSig = '', stuckFor = 0;
  const finish = (state, reason) => {
    // a win recorded anywhere in the stream beats the current board, which the bots
    // may already have reset by voting for a rematch
    const won = firstResult(a);
    if (won) {
      const g = won.gameOver;
      const winner = (g.by === 0 || g.by === 1) ? g.by : (g.winner === 0 || g.winner === 1 ? g.winner : null);
      return { winner, turns: won.turnNumber || 0, reason: g.reason || 'won' };
    }
    return { winner: null, turns: (state && state.turnNumber) || 0, reason };
  };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let cur = latest(a);
    if (!cur) return finish(null, 'no state');
    if (firstResult(a)) return finish(cur, 'won');
    if ((cur.turnNumber || 0) > 80) return finish(cur, 'turn cap');

    // hand the bots any refusal they've just received, so they stop repeating it
    for (const [i, sk] of [[0, a], [1, b]]) {
      const seen = sk.__seenRejects || (sk.__seenRejects = 0);
      const rejects = sk.inbox.filter(m => m.type === 'summonRejected');
      for (let k = seen; k < rejects.length; k++) {
        if (bots[i].onRejected) bots[i].onRejected(rejects[k].reason);
      }
      sk.__seenRejects = rejects.length;
    }
    bots[0].onState(latest(a));
    bots[1].onState(latest(b));
    const ran = drainQueue(500);

    cur = latest(a);
    // The bot's own watchdog is wall-clock based, so it never fires here. If the board
    // stops changing, force the active player to end their turn — the same escape the
    // real bot uses when it gets stuck.
    const sig = cur ? [cur.turnNumber, cur.activeTurn, cur.players[0].shields.length,
                       cur.players[1].shields.length, cur.players[0].battlezone.length,
                       cur.players[1].battlezone.length, cur.players[0].hand.length,
                       cur.players[1].hand.length].join(',') : 'none';
    if (sig === lastSig) { stuckFor++; } else { stuckFor = 0; lastSig = sig; }
    if (stuckFor >= 4 && cur) {
      const seat = cur.activeTurn;
      if (seat === 0 || seat === 1) {
        // clear any prompt that might be holding the turn, then pass
        for (const s2 of [a, b]) {
          const v = latest(s2);
          if (!v) continue;
          const meP = v.players[v.you];
          for (const k of (meP.pendingShieldTriggers || [])) say(s2, { type: 'shieldTriggerDecline', key: k });
        }
        say(seat === 0 ? a : b, { type: 'endTurn', force: true });
      }
      stuckFor = 0;
    }
    if (process.env.SIM_DEBUG && pass < 4) {
      const rej = [];
      for (const [nm, sk] of [['a', a], ['b', b]]) {
        const r = sk.inbox.filter(m => m.type === 'summonRejected').slice(-1)[0];
        if (r) rej.push(nm + ': ' + r.reason.split('\n')[0].slice(0, 60));
      }
      if (rej.length) console.log('     last refusals -> ' + rej.join(' | '));
      if (cur && cur.combat) console.log('     combat open: ' + cur.combat.phase + ' attacker seat ' + cur.combat.attackerIdx);
      if (cur) console.log('     prompts: seat0=' + cur.players[0].pendingPromptCount + ' seat1=' + cur.players[1].pendingPromptCount);
      console.log('  pass ' + pass + ': ran ' + ran + ' | turn ' + (cur && cur.turnNumber) +
                  ' active ' + (cur && cur.activeTurn) + ' | shields ' +
                  (cur ? cur.players[0].shields.length + '/' + cur.players[1].shields.length : '?') +
                  ' | over ' + !!(cur && cur.gameOver));
      if (cur) for (let i = 0; i < 2; i++) {
        const pl = cur.players[i];
        const pend = [];
        if ((pl.pendingTargets || []).length) pend.push('targets:' + pl.pendingTargets.map(t => t.action + '@' + t.zone).join(','));
        if ((pl.pendingDiscards || []).length) pend.push('discards:' + pl.pendingDiscards.length);
        if (pl.pendingMulti) pend.push('multi:' + pl.pendingMulti.action + '@' + pl.pendingMulti.zone);
        if ((pl.pendingShieldTriggers || []).length) pend.push('triggers:' + pl.pendingShieldTriggers.length);
        if (pl.pendingSearch) pend.push('search');
        if (pl.pendingRaceChoice || (pl.pendingRaceChoices || []).length) pend.push('race');
        if (pend.length) console.log('     seat ' + i + ' waiting on -> ' + pend.join(' | '));
      }
    }
    if (firstResult(a)) return finish(cur, 'won');
    if (ran === 0) return finish(cur, 'stalled');
  }
  return finish(latest(a), 'pass cap');
}

// ---- run the match ----
const [fileA, fileB, gamesArg] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error('usage: node tools/simulate.js deckA.txt deckB.txt [games]');
  process.exit(2);
}
const games = parseInt(gamesArg, 10) || 50;
const deckA = loadDeck(fileA), deckB = loadDeck(fileB);
const nameA = path.basename(fileA, '.txt'), nameB = path.basename(fileB, '.txt');
console.log(nameA + ' (' + deckA.length + ') vs ' + nameB + ' (' + deckB.length + '), ' + games + ' games');

let winA = 0, winB = 0, draws = 0, turnsTotal = 0, errors = 0;
for (let g = 0; g < games; g++) {
  // swap seats each game so first-turn advantage cancels out
  const swap = g % 2 === 1;
  const r = playGame(swap ? deckB : deckA, swap ? deckA : deckB, g);
  if (r.error) { errors++; continue; }
  turnsTotal += r.turns || 0;
  if (r.winner === null || r.winner === undefined) draws++;
  else {
    const aWon = swap ? r.winner === 1 : r.winner === 0;
    if (aWon) winA++; else winB++;
  }
}
const decided = winA + winB;
console.log();
console.log('  ' + nameA.padEnd(16) + String(winA).padStart(4) + '  ' + (decided ? (100 * winA / decided).toFixed(0) + '%' : '-'));
console.log('  ' + nameB.padEnd(16) + String(winB).padStart(4) + '  ' + (decided ? (100 * winB / decided).toFixed(0) + '%' : '-'));
console.log('  unresolved      ' + String(draws).padStart(4));
if (errors) console.log('  errored         ' + String(errors).padStart(4));
console.log('  average length  ' + (games ? (turnsTotal / games).toFixed(1) : '-') + ' turns');
