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
