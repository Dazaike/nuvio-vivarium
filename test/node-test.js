// Runs the provider in a restricted vm context that looks like Nuvio's QuickJS runtime (no Buffer / TextEncoder / crypto / URL /
// WebAssembly / process), with only fetch, console and timers from the host. Then downloads master -> variant -> first segment
// of the returned stream.   node test/node-test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const { verifyHls } = require('./verify-hls');
const code = fs.readFileSync(process.env.PROVIDER_FILE || path.join(__dirname, '..', 'providers', 'vivarium.js'), 'utf8');
if (/__(VG_COOKIE|USER_AGENT|VIV_CV|VIV_CVKEY|VIV_SIG_KEY)__/.test(code)) { console.error('provider constants are not filled in'); process.exit(1); }

const logs = [];
const sandbox = {
  console: { log: (...a) => logs.push(a.join(' ')) },
  fetch: (u, o) => fetch(u, o), setTimeout, clearTimeout,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const getStreams = sandbox.getStreams;
if (typeof getStreams !== 'function') throw new Error('provider did not define global getStreams');

const cases = [
  ['movie 550 (Fight Club)', ['550', 'movie']],
  ['tv 1396 S1E1 (Breaking Bad)', ['1396', 'tv', 1, 1]],
  ['tv 296756 S1E6', ['296756', 'tv', 1, 6]],
];
(async () => {
  const rows = [];
  let pass = 0;
  for (const [name, args] of cases) {
    logs.length = 0;
    const t0 = Date.now();
    const out = await getStreams.apply(null, args);
    const ms = Date.now() - t0;
    if (!out.length) { rows.push([name, '-', '-', 'NO STREAM', ms]); console.log(logs.join('\n')); continue; }
    const s = out[0];
    const r = await verifyHls(s.url, s.headers);
    const best = logs.filter(l => /best /.test(l)).pop() || '';
    rows.push([name, out.length + ' stream(s): ' + s.name, s.title, (r.ok ? 'PASS ' : 'FAIL ') + r.steps.join(' | ') + (r.why ? ' ' + r.why : ''), ms, (s.subtitles || []).length]);
    if (r.ok) pass++;
    console.log('\n---', name, '\n' + logs.join('\n'));
  }
  console.log('\n| title | result | chosen server | master -> variant -> segment | getStreams ms | subs |');
  console.log('|---|---|---|---|---|---|');
  rows.forEach(r => console.log('| ' + r[0] + ' | ' + r[1] + ' | ' + r[2] + ' | ' + r[3] + ' | ' + r[4] + ' | ' + (r[5] || 0) + ' |'));
  console.log('\n' + pass + '/' + cases.length + ' titles returned one stream whose master, variant and first segment all downloaded.');
  process.exit(pass === cases.length ? 0 : 1);
})();
