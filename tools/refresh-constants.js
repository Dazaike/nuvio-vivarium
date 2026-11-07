#!/usr/bin/env node
// Re-extracts the three build constants of the live vivarium.su front end and writes them into providers/vivarium.js:
//   VIV_SIG_KEY  HMAC key           (hidden in the site's WebAssembly signer hkf9.bin)
//   VIV_CV       x-cv header value  (build id, the ?v= of hkf9.bin)
//   VIV_CVKEY    64-hex constant appended to every signed message (lives inside an AES-GCM encrypted app chunk)
// Run this when /api/es starts answering with no sources after a site deploy:  node tools/refresh-constants.js
// Needs VG_COOKIE + USER_AGENT already set in providers/vivarium.js.
const crypto = require('crypto'), zlib = require('zlib');
const { readProvider, setConst, getConst, write } = require('./lib');

const SITE = 'https://vivarium.su';
const src0 = readProvider();
const VG = getConst(src0, 'VG_COOKIE'), UA = getConst(src0, 'USER_AGENT');
if (!VG || VG.indexOf('__') === 0) { console.error('set VG_COOKIE / USER_AGENT first (tools/set-cookie.js)'); process.exit(1); }
const H = { 'User-Agent': UA, Referer: SITE + '/', Cookie: 'vg=' + VG };
const get = async p => { const r = await fetch(p.startsWith('http') ? p : SITE + p, { headers: H }); if (!r.ok) throw new Error(p + ' -> ' + r.status); return r; };

// --- the site's string-table obfuscation: "$name(i)" calls resolved by a decoder defined at the top of every protected chunk
function decoderOf(code) {
  const m = /function (\$[A-Za-z0-9_]+)\(i\)\{if\(i in (\$[A-Za-z0-9_]+)\)return/.exec(code);
  if (!m) return null;
  let d = 0, i = code.indexOf('{', m.index);
  for (; i < code.length; i++) { if (code[i] === '{') d++; else if (code[i] === '}') { d--; if (d === 0) break; } }
  const head = code.slice(code.indexOf('(function(){') + '(function(){'.length, i + 1);
  return { name: m[1], fn: new Function(head + '; return ' + m[1] + ';')() };
}
function deobf(code) {
  const dec = decoderOf(code);
  if (!dec) return code;
  return code.replace(new RegExp('\\' + dec.name + '\\((\\d+)\\)', 'g'), (_, n) => JSON.stringify(dec.fn(+n)));
}
function hmacHex(keyBuf, msg) { return crypto.createHmac('sha256', keyBuf).update(msg, 'latin1').digest('hex'); }
function aesGcm(b64, keyHex) {
  const raw = Buffer.from(b64.trim(), 'base64');
  const iv = raw.subarray(0, 12), ct = raw.subarray(12);
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(keyHex, 'hex'), iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return zlib.gunzipSync(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])).toString('utf8');
}
// first active data segment of a wasm binary
function wasmData(buf) {
  let p = 8;
  const leb = () => { let r = 0, s = 0, x; do { x = buf[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  while (p < buf.length) {
    const id = buf[p++], len = leb(), end = p + len;
    if (id === 11) { leb(); /* count */ leb(); /* flags */ while (buf[p] !== 0x0b) p++; p++; const n = leb(); return buf.subarray(p, p + n); }
    p = end;
  }
  throw new Error('no data section');
}

(async () => {
  const html = await (await get('/')).text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map(m => m[1]);
  // the entry script URL is hidden in an inline snippet: atob("...") with every char XOR-ed by a constant
  for (const m of html.matchAll(/atob\("([A-Za-z0-9+\/=]+)"\)\.replace\([\s\S]{0,160}?charCodeAt\(0\)\^(\d+)/g)) {
    const url = Buffer.from(m[1], 'base64').toString('latin1').split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ +m[2])).join('');
    if (/^\/_next\/static\/chunks\/.+\.js/.test(url)) scripts.push(url);
  }
  let boot = null, strings = null;
  for (const s of scripts) {
    const code = await (await get(s)).text();
    const dec = decoderOf(code);
    if (!dec) continue;
    const found = [];
    for (let i = 0; i < 400; i++) { try { found.push(dec.fn(i)); } catch (e) { break; } }
    if (found.some(x => /hkf9\.bin/.test(x))) { boot = s; strings = found; break; }
  }
  if (!boot) throw new Error('boot chunk (the one that loads hkf9.bin) not found in ' + scripts.join(','));
  const wasmPath = strings.find(x => /hkf9\.bin/.test(x));
  const cv = /[?&]v=([0-9a-f]+)/.exec(wasmPath)[1];
  console.log('boot chunk', boot, '| x-cv', cv);

  const wasm = Buffer.from(await (await get(wasmPath)).arrayBuffer());
  const d = wasmData(wasm);
  const keyBuf = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) keyBuf[i] = d[i] ^ d[64 + (i & 7)];
  const sigKey = keyBuf.toString('latin1');
  console.log('HMAC key recovered from', wasmPath, '(' + sigKey.length + ' bytes)');

  const kText = await (await get('/api/k')).text();
  const aesKey = hmacHex(keyBuf, kText).slice(0, 32);

  // stage 2: first chunk named in the boot strings that decrypts with the key
  let stage2 = null, stage2Code = null;
  for (const s of strings.filter(x => /^\/_next\/static\/chunks\/[0-9a-f]+\.js$/.test(x))) {
    try { stage2Code = aesGcm(await (await get(s)).text(), aesKey); stage2 = s; break; } catch (e) { /* not it */ }
  }
  if (!stage2) throw new Error('no stage-2 chunk decrypted: the key derivation changed');
  console.log('stage-2 chunk', stage2);
  const urls = new Set();
  for (const m of (deobf(stage2Code) + strings.join('\n')).matchAll(/\/_next\/static\/[A-Za-z0-9_\-\/]+\.js/g)) urls.add(m[0]);
  const list = [...urls];
  let hit = null;
  for (let i = 0; i < list.length && !hit; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async u => {
      if (hit) return;
      try {
        const r = await fetch(SITE + u, { headers: H }); if (!r.ok) return;
        let code; try { code = aesGcm(await r.text(), aesKey); } catch (e) { return; }
        const text = deobf(code);
        if (!/x-sig/.test(text)) return;
        const m = /"([0-9a-f]{64})"\s*,\s*[A-Za-z_$][\w$]*\s*=\s*"([0-9a-f]{12})"/.exec(text);
        if (m) hit = { u, cvKey: m[1], cv: m[2] };
      } catch (e) { /* ignore */ }
    }));
  }
  if (!hit) throw new Error('signer chunk not found among ' + list.length + ' chunks');
  console.log('signer chunk', hit.u);
  if (hit.cv !== cv) console.warn('warning: x-cv in signer chunk (' + hit.cv + ') differs from hkf9.bin ?v= (' + cv + '); using the signer chunk value');

  let src = readProvider();
  src = setConst(src, 'VIV_SIG_KEY', sigKey);
  src = setConst(src, 'VIV_CV', hit.cv);
  src = setConst(src, 'VIV_CVKEY', hit.cvKey);
  write(src);
  console.log('providers/vivarium.js updated: VIV_CV=' + hit.cv + ' VIV_CVKEY=' + hit.cvKey.slice(0, 8) + '… VIV_SIG_KEY=' + sigKey.slice(0, 8) + '…');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
