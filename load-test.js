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

const path = __dirname + '/public/client.js';
try {
  eval(require('fs').readFileSync(process.argv[2] || path, 'utf8'));
  console.log('client.js: loads clean, all handlers register');
} catch (e) {
  console.error('client.js THROWS AT LOAD:', e.message);
  console.error((e.stack || '').split('\n')[1]);
  process.exit(1);
}
