// Coverage audit: every parsed clause must have BOTH its trigger hooked into the
// engine and its action implemented. Anything missing is reported by card name.
const fs = require('fs');
const { parseEffect } = require('./effects-parser.js');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');

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

const rows = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/e8.json', 'utf8'));
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
