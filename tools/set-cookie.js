#!/usr/bin/env node
// Usage: node tools/set-cookie.js "<value of the vg cookie>" "<exact User-Agent of that browser>"
// Writes VG_COOKIE and USER_AGENT into providers/vivarium.js. Then bump "version" in manifest.json, commit and push.
const { readProvider, setConst, write } = require('./lib');
const [vg, ua] = process.argv.slice(2);
if (!vg || !ua) {
  console.error('usage: node tools/set-cookie.js "<vg cookie value>" "<navigator.userAgent of the same browser>"');
  process.exit(1);
}
let src = readProvider();
src = setConst(src, 'VG_COOKIE', vg.trim());
src = setConst(src, 'USER_AGENT', ua.trim());
write(src);
console.log('providers/vivarium.js updated (cookie length ' + vg.trim().length + ', user agent length ' + ua.trim().length + ').');
