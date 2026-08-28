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

// Read the effects straight from the shipped spreadsheet by default, so the audit can
// never pass against a stale export of an older sheet.
let rows;
if (process.argv[2]) rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
else {
  const XLSX = require('xlsx');
  const dir = __dirname + '/carddata';
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
