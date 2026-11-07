// Shared helpers for the maintenance tools (Node >= 18).
const fs = require('fs');
const path = require('path');
const PROVIDER = path.join(__dirname, '..', 'providers', 'vivarium.js');

function readProvider() { return fs.readFileSync(PROVIDER, 'utf8'); }

// Replace the value of `var NAME = '...';` in the provider file.
function setConst(src, name, value) {
  const re = new RegExp("(var " + name + " = ')[^']*(';)");
  if (!re.test(src)) throw new Error('constant ' + name + ' not found in providers/vivarium.js');
  return src.replace(re, (_, a, b) => a + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + b);
}
function getConst(src, name) {
  const m = new RegExp("var " + name + " = '([^']*)';").exec(src);
  return m ? m[1] : '';
}
module.exports = { PROVIDER, readProvider, setConst, getConst, write: s => fs.writeFileSync(PROVIDER, s) };
