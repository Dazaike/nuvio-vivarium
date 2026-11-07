// Verify an HLS URL end to end: master -> variant -> first segment returns real media bytes.
// The segment is read only partially (first 96 KB); AES-128 playlists are decrypted with their key to confirm real TS / fMP4.
const crypto = require('crypto');
const abs = (base, rel) => new URL(rel, base).toString();

async function getPartial(url, headers, max) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let status = 0, got = [], n = 0, finalUrl = url;
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
    status = r.status; finalUrl = r.url;
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      got.push(Buffer.from(value)); n += value.length;
      if (n >= max) { ctl.abort(); break; }
    }
  } catch (e) { if (!(n >= max)) throw e; } finally { clearTimeout(timer); }
  return { status, buf: Buffer.concat(got), finalUrl };
}

function looksMedia(buf) {
  if (!buf || buf.length < 188) return 'too small (' + (buf ? buf.length : 0) + ')';
  if (/^\s*<(!doctype|html)/i.test(buf.subarray(0, 64).toString('latin1'))) return 'HTML';
  if (buf[0] === 0x47 && buf[188] === 0x47) return 'mpegts';
  const t = buf.subarray(4, 8).toString('latin1');
  if (t === 'ftyp' || t === 'moof' || t === 'styp') return 'fmp4';
  if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) return 'aac';
  return 'unknown:' + buf.subarray(0, 8).toString('hex');
}

async function verifyHls(url, headers) {
  const steps = [];
  try {
    const m = await getPartial(url, headers, 4 * 1024 * 1024);
    const mt = m.buf.toString('utf8');
    steps.push('master ' + m.status + ' ' + m.buf.length + 'B');
    if (m.status !== 200 || !/^#EXTM3U/.test(mt.trim())) return { ok: false, steps, why: 'master not m3u8 (' + m.status + ')' };
    let varUrl = m.finalUrl, vt = mt;
    if (/#EXT-X-STREAM-INF/.test(mt)) {
      const lines = mt.split(/\r?\n/);
      let best = null, bh = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]); const h = res ? +res[2] : 0;
        const u = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1].trim() : null;
        if (u && h >= bh) { bh = h; best = u; }
      }
      if (!best) return { ok: false, steps, why: 'no variant' };
      varUrl = abs(m.finalUrl, best);
      const v = await getPartial(varUrl, headers, 6 * 1024 * 1024);
      vt = v.buf.toString('utf8');
      steps.push('variant(' + bh + 'p) ' + v.status + ' ' + v.buf.length + 'B');
      if (v.status !== 200 || !/^#EXTM3U/.test(vt.trim())) return { ok: false, steps, why: 'variant not m3u8 (' + v.status + ')' };
      varUrl = v.finalUrl;
    }
    const lines = vt.split(/\r?\n/);
    const segLine = lines.filter(l => l && !l.startsWith('#'))[0];
    if (!segLine) return { ok: false, steps, why: 'no segments' };
    const s = await getPartial(abs(varUrl, segLine.trim()), headers, 96 * 1024);
    let buf = s.buf, tag = '';
    const keyLine = lines.find(l => /^#EXT-X-KEY:/.test(l) && /METHOD=AES-128/.test(l));
    if (keyLine && s.status === 200) {
      const kr = await getPartial(abs(varUrl, /URI="([^"]+)"/.exec(keyLine)[1]), headers, 64);
      steps.push('key ' + kr.status + ' ' + kr.buf.length + 'B');
      if (kr.status !== 200 || kr.buf.length !== 16) return { ok: false, steps, why: 'aes key bad ' + kr.status };
      const ivAttr = /IV=0x([0-9a-fA-F]+)/.exec(keyLine);
      const seqm = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(vt);
      const iv = ivAttr ? Buffer.from(ivAttr[1].padStart(32, '0'), 'hex') : (() => { const b = Buffer.alloc(16); b.writeUInt32BE((seqm ? +seqm[1] : 0) >>> 0, 12); return b; })();
      const d = crypto.createDecipheriv('aes-128-cbc', kr.buf, iv); d.setAutoPadding(false);
      buf = Buffer.concat([d.update(buf.subarray(0, buf.length - (buf.length % 16))), d.final()]); tag = ' (aes-128 decrypted)';
    }
    const kind = looksMedia(buf);
    steps.push('segment ' + s.status + ' ' + s.buf.length + 'B ' + kind + tag);
    const ok = s.status === 200 && /^(mpegts|fmp4|aac)$/.test(kind);
    return { ok, steps, why: ok ? '' : 'segment bad: ' + s.status + ' ' + kind, kind };
  } catch (e) { return { ok: false, steps, why: 'exception ' + String(e && e.message || e) }; }
}
module.exports = { verifyHls };
