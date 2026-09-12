#!/usr/bin/env node
// Flags card rows whose data is likely WRONG, so they can be checked against the card
// art or the wiki. Two classes of problem, found the hard way:
//
//   1. Stats too good for the cost — every instance so far has been an Evolution
//      Creature typed as a plain Creature, making it summonable with no base.
//      (Blaze the Super Soul, Crystal Spinslicer, Glais Mejicula, 6 Phoenixes.)
//   2. A spell with no ability text — it resolves and does literally nothing.
//
//   node tools/data-audit.js
const fs = require('fs');
const path = require('path');
const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8'));

const num = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const seen = new Set();
const rows = CARDS.filter(r => {
  const n = String(r.Name || '').trim();
  if (!n || seen.has(n)) return false;
  seen.add(n); return true;
});

// ---- 1. implausible stat lines ------------------------------------------
const creatures = rows.filter(r =>
  num(r.Power) != null && num(r['Mana Cost']) > 0 &&
  !/evolution/i.test(String(r.Type || '')));
const ratio = (r) => num(r.Power) / num(r['Mana Cost']);
const sorted = creatures.map(ratio).sort((a, b) => a - b);
const pct99 = sorted[Math.floor(sorted.length * 0.99)];

// A card that genuinely PAYS for its stats is not suspicious: it cannot attack, or it
// destroys itself, or it costs you mana or cards.
const paysForIt = (r) => {
  const restr = String(r['Attack restriction'] || '').toLowerCase();
  const eff = String(r.Effect || '');
  return /cannot attack/.test(restr) ||
         /destroy self|destroy ownCreature|toGrave ownMana|ownDiscard|-> *hand/i.test(eff);
};
const suspicious = creatures
  .filter(r => ratio(r) > pct99 && !paysForIt(r))
  .sort((a, b) => ratio(b) - ratio(a));

console.log('Power per mana: median ' + sorted[Math.floor(sorted.length / 2)].toFixed(0) +
            ', 99th percentile ' + pct99.toFixed(0));
console.log();
if (suspicious.length) {
  console.log('STAT LINES TOO GOOD FOR THE COST (' + suspicious.length + ') — check the card art:');
  for (const r of suspicious) {
    console.log('   ' + String(r.Name).slice(0, 32).padEnd(34) +
      num(r['Mana Cost']) + ' mana ' + String(num(r.Power)).padStart(6) +
      '   ' + String(r.Effect || '(no text)').slice(0, 40));
  }
} else {
  console.log('no implausible stat lines');
}

// ---- 2. spells that do nothing ------------------------------------------
const deadSpells = rows.filter(r =>
  String(r.Type || '').trim().toLowerCase() === 'spell' && !r.Effect);
console.log();
console.log('SPELLS WITH NO ABILITY TEXT: ' + deadSpells.length + ' (these resolve and do nothing)');
const bySet = {};
for (const r of deadSpells) {
  const s = String(r.Set || 'unknown');
  (bySet[s] = bySet[s] || []).push(String(r.Name));
}
for (const s of Object.keys(bySet).sort()) {
  console.log('   ' + s.padEnd(10) + bySet[s].length);
}
console.log();
console.log(suspicious.length || deadSpells.length
  ? 'review the rows above against the card art'
  : 'card data looks consistent');
