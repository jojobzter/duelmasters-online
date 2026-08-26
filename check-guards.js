// Guards against the recurring "effect applies twice" bug: any hardcoded card
// behaviour must stand down when the spreadsheet describes that card.
// Run with: node check-guards.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/server.js', 'utf8');

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
