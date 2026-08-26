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
