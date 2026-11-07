// Proof that the pure-JS signer in providers/vivarium.js reproduces x-sig values captured from the REAL browser
// (the page's own WebAssembly signer, hkf9.bin, hooked while the site made its normal /api requests).
//   samples.json : request method, path+query, x-ts, x-nonce, x-sig, and the exact message the wasm hashed
//   node test/proof.js
const fs = require('fs'), path = require('path');
const provider = require('../providers/vivarium.js');
const { hmacSha256Hex, utf8Bytes } = provider._internals;

const samples = JSON.parse(fs.readFileSync(path.join(__dirname, 'samples.json'), 'utf8'));
const early = [ // hand-captured earlier in the same session (page fetch wrapper, x-sig header value)
  ['GET', '/api/hq?id=550', '1794028747', '', '032d61f7a7f9405cd23f2a5b862cd7e8bba03bbdb92cc56c0afb6fa44365a267'],
  ['GET', '/api/es?id=550&type=movie', '1794028770', '92f006a1308ad744a3cbde4678abaede.1794028837.a37d210a7c732d8931937646732edfab', '36dde2f729328a70c6a7c57e66e04066214c7b10643bfca8d7aff03875662a17'],
  ['GET', '/api/es?id=1396&type=tv&s=1&e=1', '1794028772', '50007c2fc24276c1b852912a50ed7734.1794028837.dc1ca66a48d96b1df76cebf94a391ca4', 'd768b20e849e87acb908d917e07c5112c031736af3e1248340d6b1df60304157'],
  ['POST', '/api/views', '1794028773', '', '5cba9092acea9ed9f675fa273ff0b4c211354e6ab8e75099e3326cb6290c16a7'],
  ['GET', '/api/os?id=550&type=movie', '1794028773', '29c7b740df56ad18d24de5e5a8d7eac4.1794028837.27139f63d34a7a8f9afd9fd829e4750f', '6a563ebf0b1668b76d850213a2b2c8b947c6871cc538b86a355da71274f68ebd'],
].map(([method, p, ts, nonce, sig]) => ({ method, path: p, ts, nonce: nonce || null, sig }));

let ok = 0, total = 0, bad = [];
for (const s of samples.concat(early)) {
  total++;
  if (provider.sign(s.method, s.path, s.ts, s.nonce || '') === s.sig) ok++; else bad.push(s.method + ' ' + s.path);
}
let msgOk = 0, msgTotal = 0;
for (const s of samples) { // also check the raw wasm input message byte for byte
  msgTotal++;
  const key = require('../providers/vivarium.js')._internals.utf8Bytes(fs.readFileSync(path.join(__dirname, '..', 'providers', 'vivarium.js'), 'utf8').match(/var VIV_SIG_KEY = '([^']*)'/)[1]);
  if (hmacSha256Hex(key, utf8Bytes(s.msg)) === s.sig) msgOk++;
}
console.log('captured real-browser requests            :', total, '(' + samples.length + ' recorded with the wasm input message, ' + early.length + ' header-only)');
console.log('sign(method, path, ts, nonce) == x-sig    :', ok + '/' + total, bad.length ? 'MISMATCH: ' + bad.join(', ') : '');
console.log('HMAC(wasm input message bytes) == x-sig   :', msgOk + '/' + msgTotal);
process.exit(ok === total && msgOk === msgTotal ? 0 : 1);
