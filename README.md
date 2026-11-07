# nuvio-vivarium

Nuvio local-scraper repository for [vivarium.su](https://vivarium.su). One provider, `vivarium`, movies + TV, HLS (`m3u8`).
It returns a single **Vivarium - Auto (Best)** stream (highest `rank`, minus penalties for providers that failed my segment checks),
with up to two English subtitles attached as `data:` URIs.

Add this in Nuvio as a repository (use the commit-pinned URL from the release notes, or `main` once GitHub's raw cache catches up):

    https://raw.githubusercontent.com/Dazaike/nuvio-vivarium/main/manifest.json

## The cookie (read this)

vivarium.su sits behind a Cloudflare Turnstile gate. Passing it sets an HttpOnly `vg` cookie that is bound to your browser's
User-Agent and lasts about 30 days. It is a CAPTCHA pass token, **not** an account login, but this repository is public:
the value in `providers/vivarium.js` (`VG_COOKIE`) is readable by anyone, and anyone can use that pass until it expires.

Refresh (roughly monthly, or whenever the log says `403 from vivarium.su`):

1. Open https://vivarium.su in your browser, pass the CAPTCHA if asked.
2. DevTools -> Application -> Cookies -> `https://vivarium.su` -> copy the value of `vg`. Copy the browser's UA from the console: `navigator.userAgent`.
3. `node tools/set-cookie.js "<vg value>" "<user agent>"`  (or edit the two constants at the top of `providers/vivarium.js`).
4. Bump `version` in `manifest.json` (both places), commit, push.

If the site ships a new build and `/api/es` suddenly returns no sources (log: `no sources`), run `node tools/refresh-constants.js`: it
re-extracts `VIV_CV`, `VIV_CVKEY` and `VIV_SIG_KEY` from the live site (it decrypts the same chunks the browser does).

## How the signature works

Every `/api/*` call carries `x-ts`, `x-cv`, `x-sig` (+ `x-nonce` for `/api/es`, `/api/os`, `/api/e`, `/api/hk`; nonces come from `GET /api/n`, valid ~90 s):

    x-sig = hex( HMAC-SHA256( key, METHOD "\n" pathname+search "\n" x-ts [ "\n" x-nonce ] "\n" VIV_CVKEY ) )

`key` is a 64-byte string hidden in the site's WebAssembly module `hkf9.bin` (`data[0..64] ^ data[64 + (i & 7)]`), `VIV_CVKEY` is a
build constant inside an encrypted app chunk. The WebAssembly is just SHA-256/HMAC, so the provider carries a plain-JS port.
`node test/proof.js` replays 24 signatures captured from the real browser and checks they are reproduced exactly.

## Checks

    node test/proof.js       # signature reproduction vs captured browser requests
    node test/node-test.js   # movie 550, tv 1396 S1E1, tv 296756 S1E6: provider in a QuickJS-like sandbox, then master -> variant -> segment download

## Known limits

* Nuvio's runtime must pass the `Cookie` header on `fetch` (a browser would drop it; Node and most native clients do not). Not verified inside Nuvio.
* Audio language is not exposed by the site's API; the ranking cannot prefer English.
* Subtitles are inlined as `data:text/vtt` because each download needs a fresh signed nonce the player cannot produce. Set `WANT_SUBTITLES = false` if your player dislikes that.
