#!/usr/bin/env node
// One entry point for every project check.
//
//   node check.js            run everything
//   node check.js audit      run a single check by name
//
// Each check runs in its own process: several of them stub globals or intercept
// require(), so sharing a process would let one contaminate the next.
const { fork } = require('child_process');
const path = require('path');

const CHECKS = [
  ['guards',  [],                      'hardcoded effects stand down for sheet-described cards'],
  ['client',  ['../public/client.js'], 'client.js loads without throwing'],
  ['server',  [],                      'server handlers run a real game end to end'],
  ['bot',     [],                      'the bot targets the opponent, not itself'],
  ['effects', [],                      'the trickiest cards parse to executable shapes'],
  ['audit',   [],                      'every sheet clause is wired to the engine'],
  ['sheet',   [],                      'card data has no duplicates or contradictions']
];

const only = process.argv[2];
const list = only ? CHECKS.filter(c => c[0] === only) : CHECKS;
if (!list.length) {
  console.error('unknown check "' + only + '" — try: ' + CHECKS.map(c => c[0]).join(', '));
  process.exit(2);
}

let failed = 0;
(function run(i) {
  if (i >= list.length) {
    console.log();
    console.log(failed ? failed + ' check(s) FAILED' : 'all checks passed');
    process.exit(failed ? 1 : 0);
  }
  const [name, args, blurb] = list[i];
  const child = fork(path.join(__dirname, 'tools', 'checks.js'), [name, ...args], { silent: true });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('exit', (code) => {
    // exit 2 means the check could not run (a missing optional dependency)
    const status = code === 0 ? 'ok  ' : code === 2 ? 'skip' : 'FAIL';
    if (code && code !== 2) failed++;
    console.log(status + '  ' + name.padEnd(8) + blurb);
    if (code) out.trim().split('\n').slice(-4).forEach(l => console.log('        ' + l));
    run(i + 1);
  });
})(0);
