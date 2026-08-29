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
const Bot = eval(require('fs').readFileSync(__dirname + '/public/bot.js', 'utf8') + '; Bot;');

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
    process.exit(failed ? 1 : 0);
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
