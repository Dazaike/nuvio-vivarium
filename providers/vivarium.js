// Vivarium (vivarium.su) provider for Nuvio. Promise-based on purpose (no async/await), plain ES5, no WebAssembly / crypto / Buffer /
// TextEncoder: the site's x-sig signer (SHA-256 + HMAC) is ported to plain JS below.
//
// Returns ONE "Vivarium - Auto (Best)" stream, picked from everything the site offers.
//
// ============================================================================================================================
//  USER CONFIG  --  the ONLY block you ever need to edit  (or run:  node tools/set-cookie.js "<vg value>" "<user agent>")
//
//  VG_COOKIE   : value of the `vg` cookie of https://vivarium.su  (it is a Cloudflare Turnstile / CAPTCHA pass token, NOT a login).
//                It is HttpOnly and lasts ~30 days. To refresh it:
//                  1. open https://vivarium.su in a normal browser and pass the CAPTCHA if it asks,
//                  2. DevTools -> Application -> Cookies -> https://vivarium.su -> copy the value of `vg`
//                     (or from a console: cookieStore can't see HttpOnly cookies, so use the Application tab),
//                  3. paste it below, bump "version" in manifest.json, commit + push.
//  USER_AGENT  : the EXACT User-Agent of the browser you got the cookie from (the cookie is bound to the User-Agent).
//                Copy it from the browser console:  navigator.userAgent
//  WARNING     : this repository is public. Anyone who reads this file can use your CAPTCHA pass until it expires.
// ============================================================================================================================
var VG_COOKIE = '1796619627.5d0fa99b07807c546e94d0748272ad6141ee9c2482c4cd2ba702eda4e4eac351';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
// ============================================================================================================================

var SITE = 'https://vivarium.su';
// Build constants of the current vivarium.su front end (x-cv header + the 64-hex value appended to every signed message).
// They change when the site ships a new build; `node tools/refresh-constants.js` re-extracts them from the live site.
var VIV_CV = 'dcfa7a1ee84d';
var VIV_CVKEY = '6e6d98ec8a7d741a20f242fd8a233ddb09227ebf72f213a16e53096abf6c3572';
// 64 ASCII bytes used as the HMAC-SHA256 key (recovered from the site's hkf9.bin signer: data[0..64] ^ data[64 + (i & 7)]).
var VIV_SIG_KEY = '6af5200a03de9a234734d3ef385c84490dc4164881e408450b6c35973803bded';

var SHOW_ALL = true;         // list every source after the Auto pick
var WANT_SUBTITLES = true;   // fetch English subtitles (/api/os) and attach them to the stream as data: URIs
var MAX_SUBTITLES = 2;
var MAX_SUBTITLE_BYTES = 400000;
var REQUEST_TIMEOUT_MS = 12000;
var DEBUG = true;
var T0 = Date.now();
function log() { if (DEBUG) console.log.apply(console, ['[Vivarium +' + (Date.now() - T0) + 'ms]'].concat([].slice.call(arguments))); }

// Provider reliability / preference, measured by downloading master -> variant -> first segment (see README).
// Added on top of the server's own `rank` (about the video height). Big negatives = verified dead or unusably slow.
var PROVIDER_ADJUST = {
  Poseidon: 30, Zeus: 25, Hermes: 25, Aura: 10, Orion: 5, Theia: 3, Boreas: 0,
  Hyperion: -20, // good segments, but a 1.5 MB master and it answered 429 on the third request of one burst
  Kratos: -1000  // playlist request never answers on most titles (3 of 4 timed out in testing)
};
// Display order (and Auto pick): first provider that returned streams wins; unlisted providers (Orion, Theia, Hyperion) go last.
var PROVIDER_ORDER = ['Poseidon', 'Hermes', 'Boreas', 'Kratos', 'Zeus', 'Aura'];
function orderIdx(p) { var i = PROVIDER_ORDER.indexOf(p); return i < 0 ? PROVIDER_ORDER.length : i; }
var OPT_PENALTY = 1200;      // `opt` streams are the 4K "only for capable devices" ladder: do not pick by default
var HEVC_PENALTY = 150;
var HDR_PENALTY = 100;

// ---------------------------------------------------------------------------------------------------------------------------
// x-sig signer: HMAC-SHA256 in plain JS
// ---------------------------------------------------------------------------------------------------------------------------
var K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function sha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var len = bytes.length, bitHi = Math.floor(len / 0x20000000), bitLo = (len << 3) >>> 0;
  var m = bytes.slice();
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  m.push((bitHi >>> 24) & 255, (bitHi >>> 16) & 255, (bitHi >>> 8) & 255, bitHi & 255,
    (bitLo >>> 24) & 255, (bitLo >>> 16) & 255, (bitLo >>> 8) & 255, bitLo & 255);
  var w = new Array(64);
  for (var o = 0; o < m.length; o += 64) {
    var i;
    for (i = 0; i < 16; i++) w[i] = ((m[o + i * 4] << 24) | (m[o + i * 4 + 1] << 16) | (m[o + i * 4 + 2] << 8) | m[o + i * 4 + 3]) | 0;
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  var out = [];
  for (var j = 0; j < 8; j++) out.push((h[j] >>> 24) & 255, (h[j] >>> 16) & 255, (h[j] >>> 8) & 255, h[j] & 255);
  return out;
}

function hmacSha256Hex(keyBytes, msgBytes) {
  if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
  var ipad = [], opad = [], i;
  for (i = 0; i < 64; i++) {
    var kb = i < keyBytes.length ? keyBytes[i] : 0;
    ipad.push(kb ^ 0x36);
    opad.push(kb ^ 0x5c);
  }
  var mac = sha256(opad.concat(sha256(ipad.concat(msgBytes))));
  var hex = '';
  for (i = 0; i < 32; i++) hex += (mac[i] < 16 ? '0' : '') + mac[i].toString(16);
  return hex;
}

// x-sig = hex(HMAC-SHA256(VIV_SIG_KEY, METHOD \n pathname+search \n ts [\n nonce] \n VIV_CVKEY))
function sign(method, pathAndQuery, ts, nonce) {
  var msg = method.toUpperCase() + '\n' + pathAndQuery + '\n' + ts + (nonce ? '\n' + nonce : '') + '\n' + VIV_CVKEY;
  return hmacSha256Hex(utf8Bytes(VIV_SIG_KEY), utf8Bytes(msg));
}

// ---------------------------------------------------------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------------------------------------------------------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4)) +
      (i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=') +
      (i + 2 < bytes.length ? B64.charAt(c & 63) : '=');
  }
  return out;
}

function baseHeaders() {
  return { 'User-Agent': USER_AGENT, 'Referer': SITE + '/', 'Accept': '*/*', 'Cookie': 'vg=' + VG_COOKIE };
}

function withTimeout(p, ms, what) {
  if (typeof setTimeout !== 'function') return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout ' + what)); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

var clockOffsetMs = 0;
function noteServerDate(r) {
  try {
    var d = r && r.headers && r.headers.get && r.headers.get('date');
    if (d) { var t = Date.parse(d); if (!isNaN(t)) clockOffsetMs = t - Date.now(); }
  } catch (e) { }
}

function plainGet(path, what) {
  return withTimeout(fetch(SITE + path, { headers: baseHeaders() }), REQUEST_TIMEOUT_MS, what || path).then(function (r) {
    noteServerDate(r);
    log('HTTP', r.status, what || path);
    return r;
  });
}

// GET with x-ts / x-nonce / x-cv / x-sig headers. `nonce` is '' for endpoints that do not need one.
function signedGet(path, nonce, what) {
  var ts = String(Math.floor((Date.now() + clockOffsetMs) / 1000));
  var h = baseHeaders();
  h['x-ts'] = ts;
  h['x-cv'] = VIV_CV;
  if (nonce) h['x-nonce'] = nonce;
  h['x-sig'] = sign('GET', path, ts, nonce || '');
  return withTimeout(fetch(SITE + path, { headers: h }), REQUEST_TIMEOUT_MS, what || path).then(function (r) {
    log('HTTP', r.status, what || path);
    return r;
  });
}

function getNonces() {
  return plainGet('/api/n', '/api/n').then(function (r) {
    if (r.status === 403) { log('403 from vivarium.su: VG_COOKIE expired / wrong USER_AGENT / Cookie header not sent (see top of providers/vivarium.js)'); return []; }
    return r.ok ? r.json() : [];
  }).then(function (a) { return a && a.length ? a : []; })
    .catch(function (e) { log('ERROR /api/n', String(e && e.message || e)); return []; });
}

// ---------------------------------------------------------------------------------------------------------------------------
// /api/es (server-sent events) -> candidates
// ---------------------------------------------------------------------------------------------------------------------------
function parseSse(text) {
  var events = [], blocks = String(text || '').split(/\r?\n\r?\n/);
  for (var i = 0; i < blocks.length; i++) {
    if (!blocks[i]) continue;
    var ev = { event: 'message', data: '' }, lines = blocks[i].split(/\r?\n/);
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j], k = l.indexOf(':');
      if (k <= 0) continue;
      var name = l.slice(0, k), val = l.slice(k + 1).replace(/^ /, '');
      if (name === 'event') ev.event = val;
      else if (name === 'data') ev.data += (ev.data ? '\n' : '') + val;
    }
    events.push(ev);
  }
  return events;
}

function toCandidates(events) {
  var out = [];
  for (var i = 0; i < events.length; i++) {
    if (events[i].event !== 'source') continue;
    var d;
    try { d = JSON.parse(events[i].data); } catch (e) { continue; }
    var list = (d && d.streams) || [];
    for (var j = 0; j < list.length; j++) {
      var s = list[j];
      if (!s || !s.url) continue;
      out.push({ url: s.url, quality: String(s.quality || 'Auto'), provider: s.provider || d.provider || '?', rank: +s.rank || 0,
        type: s.type || 'hls', hevc: !!s.hevc, hdr: !!s.hdr, opt: !!s.opt, pin: !!s.pin });
    }
  }
  return out;
}

function score(c, hasSubs) {
  var s = c.rank || 720;
  s += PROVIDER_ADJUST.hasOwnProperty(c.provider) ? PROVIDER_ADJUST[c.provider] : 0;
  if (c.opt) s -= OPT_PENALTY;
  if (c.hevc) s -= HEVC_PENALTY;
  if (c.hdr) s -= HDR_PENALTY;
  if (c.pin) s += 500;
  if (c.type !== 'hls') s -= 100;
  if (hasSubs) s += 0; // subtitles are the same for every candidate; kept for symmetry with the other providers
  return s;
}

function heightText(c) {
  var m = /(\d{3,4})\s*p/i.exec(c.quality);
  if (m) return m[1] + 'p';
  return c.rank >= 1000 ? c.rank + 'p' : 'Auto';
}

function toStream(c, label, subs) {
  return {
    name: label || ('Vivarium - ' + c.provider),
    title: c.provider + ' - ' + c.quality + (subs && subs.length ? ' | ' + subs.length + ' subs' : ''),
    description: 'Provider: ' + c.provider + ' | ' + c.quality + ' | rank ' + c.rank + ' | ' + c.type,
    url: c.url,
    quality: heightText(c),
    headers: { 'Referer': SITE + '/' },
    subtitles: subs || []
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// subtitles: /api/os lists them, each download is another signed (+nonce) request; the player cannot sign, so inline as data: URIs
// ---------------------------------------------------------------------------------------------------------------------------
function fetchSubtitles(query, nonces) {
  if (!WANT_SUBTITLES) return Promise.resolve([]);
  var listPath = '/api/os?' + query;
  return signedGet(listPath, nonces[1] || '', '/api/os list').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    var list = (d && d.subtitles) || [], en = [];
    for (var i = 0; i < list.length && en.length < MAX_SUBTITLES; i++) if (list[i].lang === 'en' && list[i].url) en.push(list[i]);
    return Promise.all(en.map(function (s, idx) {
      return signedGet(s.url, nonces[2 + idx] || '', 'subtitle ' + s.label).then(function (r) { return r.ok ? r.text() : ''; }).then(function (txt) {
        if (!txt || txt.indexOf('WEBVTT') !== 0 || txt.length > MAX_SUBTITLE_BYTES) return null;
        return { url: 'data:text/vtt;base64,' + base64(utf8Bytes(txt)), label: s.label || 'English', lang: 'en' };
      }).catch(function (e) { log('subtitle ERROR', String(e && e.message || e)); return null; });
    }));
  }).then(function (arr) { return (arr || []).filter(function (x) { return x; }); })
    .catch(function (e) { log('subtitles ERROR', String(e && e.message || e)); return []; });
}

// ---------------------------------------------------------------------------------------------------------------------------
var CACHE_MS = 10 * 60 * 1000;  // reopening the same title inside this window returns instantly
var cache = {};

function getStreams(tmdbId, mediaType, season, episode) {
  var key = [tmdbId, mediaType, season || '', episode || ''].join(':');
  var hit = cache[key];
  if (hit && Date.now() - hit.t < CACHE_MS) { log('cache hit', key); return Promise.resolve(hit.v); }
  return fetchStreams(tmdbId, mediaType, season, episode).then(function (v) {
    if (v && v.length) cache[key] = { t: Date.now(), v: v };
    return v;
  });
}

function fetchStreams(tmdbId, mediaType, season, episode) {
  T0 = Date.now();
  log('getStreams', tmdbId, mediaType, season, episode);
  if (!VG_COOKIE || VG_COOKIE.indexOf('__') === 0) { log('VG_COOKIE is not set: see the top of providers/vivarium.js'); return Promise.resolve([]); }
  var isTv = mediaType === 'tv';
  var query = 'id=' + encodeURIComponent(tmdbId) + '&type=' + (isTv ? 'tv' : 'movie') + (isTv ? '&s=' + (season || 1) + '&e=' + (episode || 1) : '');

  return getNonces().then(function (nonces) {
    log('nonces', nonces.length);
    var subsP = fetchSubtitles(query, nonces);
    return signedGet('/api/es?' + query, nonces[0] || '', '/api/es').then(function (r) {
      if (!r.ok) { log('ES failed', r.status); return ''; }
      return r.text();
    }).then(function (text) {
      var events = parseSse(text), all = toCandidates(events);
      log('events', events.length, 'candidates', all.length);
      if (!all.length) { log('no sources (empty reply usually means a stale VIV_CV/VIV_CVKEY pair: run tools/refresh-constants.js)'); return []; }
      return subsP.then(function (subs) {
        all.sort(function (a, b) { return (orderIdx(a.provider) - orderIdx(b.provider)) || (score(b, subs.length) - score(a, subs.length)); });
        var best = all[0];
        log('best', best.provider, best.quality, 'rank', best.rank, 'subs', subs.length);
        var out = [toStream(best, 'Vivarium - Auto (Best)', subs)];
        if (SHOW_ALL) all.forEach(function (c) { out.push(toStream(c, null, subs)); }); // best is listed again under its own name
        return out;
      });
    });
  }).catch(function (e) { log('FATAL', String(e && e.message || e)); return []; });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams, sign: sign, _internals: { parseSse: parseSse, toCandidates: toCandidates, score: score, hmacSha256Hex: hmacSha256Hex, utf8Bytes: utf8Bytes, base64: base64 } };
else global.getStreams = getStreams;
