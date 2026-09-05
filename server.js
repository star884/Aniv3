'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 250);
const APP_NAME = process.env.APP_NAME || 'AniV3';
const APP_DESCRIPTION =
  process.env.APP_DESCRIPTION ||
  'Anime discovery and playback UI powered by configured Stremio-compatible add-ons.';
const HLS_JS_VERSION = process.env.HLS_JS_VERSION || '1.7.2';

const METADATA_ADDONS = parseAddonList(
  process.env.METADATA_ADDONS || 'https://anime-kitsu.strem.fun'
);

const STREAM_ADDONS = parseAddonList(process.env.STREAM_ADDONS || '');
const SUBTITLE_ADDONS = parseAddonList(process.env.SUBTITLE_ADDONS || '');

const METADATA_TYPE = process.env.METADATA_TYPE || 'anime';
const METADATA_CATALOG_ID =
  process.env.METADATA_CATALOG_ID || 'kitsu-anime-list';

const CACHE = new Map();

function parseAddonList(value) {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeEndpoint);
}

function normalizeEndpoint(value) {
  const u = new URL(value);

  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error(`Only HTTP(S) add-ons are supported: ${value}`);
  }

  return u.toString().replace(/\/$/, '');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });

  res.end(payload);
}

function html(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });

  res.end(body);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });

  res.end();
}

function routeUrl(endpoint, resource, type, id, extra = null) {
  const u = new URL(
    endpoint +
      `/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  );

  if (resource === 'catalog' && extra) {
    u.pathname +=
      `/${encodeURIComponent(extra.key)}=${encodeURIComponent(extra.value)}`;
  }

  u.pathname += '.json';

  return u.toString();
}

function cacheGet(key) {
  const entry = CACHE.get(key);

  if (!entry) {
    return undefined;
  }

  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    CACHE.delete(key);
    return undefined;
  }

  return entry.value;
}

function cacheSet(key, value) {
  CACHE.set(key, {
    createdAt: Date.now(),
    value,
  });

  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldestKey = CACHE.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    CACHE.delete(oldestKey);
  }

  return value;
}

async function fetchJson(url, cacheKey = null) {
  if (cacheKey) {
    const cached = cacheGet(cacheKey);

    if (cached !== undefined) {
      return cached;
    }
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,

      headers: {
        accept: 'application/json',
        'user-agent': `${APP_NAME}/1.0`,
      },
    });

    if (!response.ok) {
      throw new Error(`Upstream HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('json')) {
      throw new Error(
        `Expected JSON but received ${
          contentType || 'unknown content type'
        }`
      );
    }

    const data = await response.json();

    return cacheKey ? cacheSet(cacheKey, data) : data;
  } finally {
    clearTimeout(timer);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mergeUnique(items, keyFn) {
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const key = keyFn(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(item);
  }

  return out;
}

function getMetas(data) {
  return asArray(data?.metas);
}

function extractStreams(data) {
  return asArray(data?.streams).filter(Boolean);
}

function extractSubtitles(data) {
  return asArray(data?.subtitles).filter(Boolean);
}

function playableUrl(stream) {
  if (
    typeof stream?.url === 'string' &&
    /^https?:\/\//i.test(stream.url)
  ) {
    return stream.url;
  }

  if (typeof stream?.ytId === 'string' && stream.ytId) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(
      stream.ytId
    )}`;
  }

  return null;
}

function isLikelyHls(url) {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

function makeCsp() {
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "media-src 'self' blob: data: https:",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function shell(title, body, script = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d14">
<meta name="description" content="${escapeHtml(APP_DESCRIPTION)}">
<title>${escapeHtml(title)} · ${escapeHtml(APP_NAME)}</title>

<style>
:root{
  color-scheme:dark;
  --bg:#080a0f;
  --panel:#111521;
  --panel2:#181e2b;
  --text:#f6f7fb;
  --muted:#9da6b7;
  --accent:#775cff;
  --border:#252c3d;
  --danger:#ef6b73;
  --ok:#64d39b
}

*{
  box-sizing:border-box
}

html{
  scroll-behavior:smooth
}

body{
  margin:0;
  background:
    radial-gradient(
      circle at 50% -10%,
      #1a2030 0,
      #080a0f 42%
    );
  color:var(--text);
  font:15px/1.55 system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif
}

a{
  color:inherit;
  text-decoration:none
}

button,
input{
  font:inherit
}

.wrap{
  width:min(1280px,calc(100% - 30px));
  margin:auto
}

.nav{
  position:sticky;
  top:0;
  z-index:20;
  min-height:66px;
  background:rgba(8,10,15,.88);
  backdrop-filter:blur(14px);
  border-bottom:1px solid var(--border)
}

.nav-inner{
  display:flex;
  align-items:center;
  gap:16px;
  min-height:66px
}

.brand{
  font-size:21px;
  font-weight:850;
  white-space:nowrap
}

.brand i{
  font-style:normal;
  color:var(--accent)
}

.search{
  margin-left:auto;
  display:flex;
  gap:8px;
  min-width:0
}

.search input{
  width:min(360px,46vw);
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:10px;
  color:var(--text);
  padding:10px 12px;
  outline:none
}

.btn{
  border:1px solid var(--border);
  background:var(--panel2);
  color:var(--text);
  padding:9px 13px;
  border-radius:10px;
  font-weight:750;
  cursor:pointer
}

.btn.primary{
  background:var(--accent);
  border-color:var(--accent)
}

main{
  padding:28px 0 52px
}

.hero{
  padding:14px 0 28px
}

.kicker{
  color:var(--muted);
  font-size:12px;
  letter-spacing:.11em;
  font-weight:800
}

.hero h1{
  font-size:clamp(30px,5vw,50px);
  line-height:1.05;
  margin:8px 0
}

.muted{
  color:var(--muted)
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(auto-fill,minmax(165px,1fr));
  gap:16px
}

.card{
  display:block;
  overflow:hidden;
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:14px;
  transition:
    transform .16s,
    border-color .16s
}

.card:hover{
  transform:translateY(-3px);
  border-color:#4b5572
}

.poster{
  display:block;
  width:100%;
  aspect-ratio:2/3;
  object-fit:cover;
  background:#202633
}

.card-body{
  padding:12px
}

.title{
  font-weight:780;
  line-height:1.3;
  display:-webkit-box;
  -webkit-line-clamp:2;
  -webkit-box-orient:vertical;
  overflow:hidden
}

.tag{
  font-size:12px;
  color:var(--muted);
  margin-top:5px
}

.notice{
  border:1px solid var(--border);
  background:rgba(17,21,33,.85);
  padding:16px;
  border-radius:14px
}

.show{
  display:grid;
  grid-template-columns:230px minmax(0,1fr);
  gap:24px
}

.show-poster{
  width:100%;
  border-radius:14px;
  border:1px solid var(--border)
}

.panel{
  background:rgba(17,21,33,.88);
  border:1px solid var(--border);
  border-radius:16px;
  padding:18px
}

.player{
  margin-top:18px
}

.player video{
  width:100%;
  max-height:74vh;
  display:block;
  background:#000;
  border-radius:12px
}

.stream-list{
  display:grid;
  gap:10px;
  margin-top:14px
}

.stream{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  width:100%;
  padding:12px;
  background:var(--panel2);
  border:1px solid var(--border);
  border-radius:11px;
  color:var(--text);
  text-align:left
}

.stream-name{
  min-width:0
}

.stream-name strong{
  display:block;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap
}

.stream-meta{
  font-size:12px;
  color:var(--muted);
  margin-top:2px
}

.episodes{
  display:grid;
  grid-template-columns:
    repeat(auto-fill,minmax(95px,1fr));
  gap:9px;
  margin-top:16px
}

.ep{
  padding:10px 8px;
  background:var(--panel2);
  border:1px solid var(--border);
  border-radius:9px;
  text-align:center
}

.ep.active{
  background:var(--accent);
  border-color:var(--accent)
}

.subtitles{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin-top:12px
}

.status{
  font-size:13px;
  color:var(--muted)
}

.error{
  color:var(--danger)
}

.ok{
  color:var(--ok)
}

.empty{
  grid-column:1/-1
}

footer{
  color:var(--muted);
  padding:30px 0;
  font-size:13px
}

@media(max-width:760px){

  .show{
    grid-template-columns:1fr
  }

  .show-poster{
    max-width:230px
  }

  .search input{
    width:38vw
  }

  .nav-inner{
    gap:10px
  }
}
</style>
</head>

<body>

<nav class="nav">
  <div class="wrap nav-inner">

    <a class="brand" href="/">
      ${escapeHtml(APP_NAME)}<i>.</i>
    </a>

    <form class="search" action="/search">
      <input
        name="q"
        placeholder="Search anime…"
        autocomplete="off"
        required
      >
      <button class="btn primary">Search</button>
    </form>

  </div>
</nav>

<main class="wrap">
  ${body}
</main>

<footer class="wrap">
  Metadata, streams, and subtitles come from configured
  Stremio-compatible add-ons.
  This application does not host media.
</footer>

${script}

</body>
</html>`;
}

function renderCards(items) {
  if (!items.length) {
    return '<div class="notice empty">No anime was returned.</div>';
  }

  return `<div class="grid">${items
    .map(item => {
      const id = item?.id || '';
      const name = item?.name || id || 'Untitled';

      return `
<a class="card"
   href="/show/${encodeURIComponent(id)}">

  <img
    class="poster"
    src="${escapeHtml(item?.poster || '')}"
    alt="${escapeHtml(name)}"
    loading="lazy"
    referrerpolicy="no-referrer"
  >

  <div class="card-body">
    <div class="title">
      ${escapeHtml(name)}
    </div>

    <div class="tag">
      ${escapeHtml(item?.type || METADATA_TYPE)}
    </div>
  </div>

</a>`;
    })
    .join('')}</div>`;
}

async function fetchFromAddons(
  addons,
  urlFactory,
  mapper,
  cachePrefix
) {
  const settled = await Promise.allSettled(
    addons.map(async (addon, index) => {
      const url = urlFactory(addon, index);

      const data = await fetchJson(
        url,
        `${cachePrefix}:${addon}:${url}`
      );

      return mapper(data, addon);
    })
  );

  return settled.flatMap(result =>
    result.status === 'fulfilled'
      ? result.value
      : []
  );
}

async function getCatalog(
  catalogId = METADATA_CATALOG_ID
) {
  const items = await fetchFromAddons(
    METADATA_ADDONS,

    addon =>
      routeUrl(
        addon,
        'catalog',
        METADATA_TYPE,
        catalogId
      ),

    getMetas,

    'catalog'
  );

  return mergeUnique(
    items,
    item => item?.id || item?.name
  );
}

async function searchAnime(q) {
  const items = await fetchFromAddons(
    METADATA_ADDONS,

    addon =>
      routeUrl(
        addon,
        'catalog',
        METADATA_TYPE,
        METADATA_CATALOG_ID,
        {
          key: 'search',
          value: q,
        }
      ),

    getMetas,

    'search'
  );

  return mergeUnique(
    items,
    item => item?.id || item?.name
  );
}

async function getMeta(type, id) {
  for (const addon of METADATA_ADDONS) {
    try {
      const data = await fetchJson(
        routeUrl(
          addon,
          'meta',
          type,
          id
        ),
        `meta:${addon}:${type}:${id}`
      );

      if (data?.meta) {
        return data.meta;
      }
    } catch (error) {
      console.warn(
        `Metadata addon failed (${addon}): ${error.message}`
      );
    }
  }

  return null;
}

async function getStreams(type, id) {
  return mergeUnique(
    await fetchFromAddons(
      STREAM_ADDONS,

      addon =>
        routeUrl(
          addon,
          'stream',
          type,
          id
        ),

      (data, addon) =>
        getStreamsWithProvider(
          data,
          addon
        ),

      'streams'
    ),

    stream =>
      JSON.stringify([
        stream?.url,
        stream?.ytId,
        stream?.infoHash,
        stream?.title,
        stream?.name,
      ])
  );
}

function getStreamsWithProvider(data, addon) {
  return extractStreams(data).map(
    stream => ({
      ...stream,
      provider: addon,
    })
  );
}

async function getSubtitles(type, id) {
  return mergeUnique(
    await fetchFromAddons(
      SUBTITLE_ADDONS,

      addon =>
        routeUrl(
          addon,
          'subtitles',
          type,
          id
        ),

      (data, addon) =>
        extractSubtitles(data).map(
          sub => ({
            ...sub,
            provider: addon,
          })
        ),

      'subtitles'
    ),

    sub =>
      JSON.stringify([
        sub?.url,
        sub?.lang,
        sub?.label,
      ])
  );
}

async function homePage(res) {
  try {
    const items = await getCatalog();

    html(
      res,
      200,

      shell(
        APP_NAME,

        `<section class="hero">

          <div class="kicker">
            STREMIO-COMPATIBLE ANIME HUB
          </div>

          <h1>
            Discover anime.
          </h1>

          <p class="muted">
            A lightweight interface that consumes
            metadata, episode information, streams,
            and subtitles from add-ons you configure.
          </p>

        </section>

        <h2>Trending</h2>

        ${renderCards(items)}

        ${
          items.length === 0
            ? `
<p class="muted">
  Check
  <code>METADATA_ADDONS</code>
  and
  <code>METADATA_CATALOG_ID</code>.
</p>`
            : ''
        }`
      )
    );
  } catch (error) {
    html(
      res,
      502,

      shell(
        'Metadata unavailable',

        `<div class="notice">

          <h2>
            Metadata service unavailable
          </h2>

          <p class="error">
            ${escapeHtml(error.message)}
          </p>

          <p class="muted">
            Configure a working Stremio metadata
            add-on and try again.
          </p>

        </div>`
      )
    );
  }
}

async function searchPage(res, q) {
  try {
    const items = await searchAnime(q);

    html(
      res,
      200,

      shell(
        `Search: ${q}`,

        `<section class="hero">

          <div class="kicker">
            SEARCH
          </div>

          <h1>
            ${escapeHtml(q)}
          </h1>

        </section>

        ${renderCards(items)}`
      )
    );
  } catch (error) {
    html(
      res,
      502,

      shell(
        'Search unavailable',

        `<div class="notice">

          <h2>
            Search failed
          </h2>

          <p class="error">
            ${escapeHtml(error.message)}
          </p>

        </div>`
      )
    );
  }
}

async function showPage(
  res,
  id,
  episodeIndex
) {
  try {
    const meta = await getMeta(
      METADATA_TYPE,
      id
    );

    if (!meta) {
      return html(
        res,
        404,

        shell(
          'Not found',

          `<div class="notice">

            <h2>
              Anime not found
            </h2>

          </div>`
        )
      );
    }

    const videos = asArray(meta.videos);

    const selected =
      videos[episodeIndex] ||
      videos[0] ||
      null;

    const selectedIndex = selected
      ? Math.max(
          0,
          videos.indexOf(selected)
        )
      : 0;

    const streams =
      selected?.id
        ? await getStreams(
            METADATA_TYPE,
            selected.id
          )
        : [];

    const subtitles =
      selected?.id
        ? await getSubtitles(
            METADATA_TYPE,
            selected.id
          )
        : [];

    const streamList = streams.length
      ? streams
          .map((stream, index) => {
            const url = playableUrl(stream);

            const label =
              stream.title ||
              stream.name ||
              `Stream ${index + 1}`;

            if (!url) {
              return `
<div class="stream">

  <div class="stream-name">

    <strong>
      ${escapeHtml(label)}
    </strong>

    <div class="stream-meta">
      Provider:
      ${escapeHtml(
        stream.provider || 'add-on'
      )}
      · non-HTTP source
    </div>

  </div>

  <span class="status">
    Not browser-playable directly
  </span>

</div>`;
            }

            return `
<button
  type="button"
  class="stream"
  data-url="${escapeHtml(url)}"
  data-label="${escapeHtml(label)}"
  onclick="playSource(
    this.dataset.url,
    this.dataset.label
  )"
>

  <div class="stream-name">

    <strong>
      ${escapeHtml(label)}
    </strong>

    <div class="stream-meta">
      ${
        isLikelyHls(url)
          ? 'HLS'
          : 'HTTP media'
      }

      ·

      ${escapeHtml(
        stream.provider || 'add-on'
      )}
    </div>

  </div>

  <span class="btn primary">
    Play
  </span>

</button>`;
          })
          .join('')
      : `
<div class="notice">

  No stream sources were returned.

  Configure
  <code>STREAM_ADDONS</code>
  with one or more
  Stremio-compatible stream add-ons.

</div>`;

    const episodeList = videos.length
      ? videos
          .map(
            (video, index) =>
              `<a
                class="ep ${
                  index === selectedIndex
                    ? 'active'
                    : ''
                }"
                href="/show/${encodeURIComponent(
                  id
                )}?ep=${index}"
              >
                ${escapeHtml(
                  video.title ||
                    `Episode ${index + 1}`
                )}
              </a>`
          )
          .join('')
      : `
<div class="notice">

  The metadata add-on did not return
  episodes for this title.

</div>`;

    const subtitleTracks = subtitles
      .filter(
        sub =>
          /^https?:\/\//i.test(
            sub?.url || ''
          )
      )
      .map(
        sub =>
          `<track
            kind="subtitles"
            src="${escapeHtml(sub.url)}"
            srclang="${escapeHtml(
              sub.lang || 'und'
            )}"
            label="${escapeHtml(
              sub.label ||
                sub.lang ||
                'Subtitle'
            )}"
          >`
      )
      .join('');

    const body = `
<a class="muted" href="/">
  ← Home
</a>

<section
  class="show"
  style="margin-top:18px"
>

  <aside>

    ${
      meta.poster
        ? `
<img
  class="show-poster"
  src="${escapeHtml(meta.poster)}"
  alt="${escapeHtml(
    meta.name || id
  )}"
  referrerpolicy="no-referrer"
>`
        : ''
    }

  </aside>

  <div>

    <h1>
      ${escapeHtml(meta.name || id)}
    </h1>

    ${
      meta.description
        ? `
<p class="muted">
  ${escapeHtml(meta.description)}
</p>`
        : ''
    }

    <div class="panel player">

      <video
        id="player"
        controls
        playsinline
        preload="metadata"
      >
        ${subtitleTracks}
      </video>

      <div
        id="status"
        class="status"
        style="margin-top:10px"
      >
        Select a source to start playback.
      </div>

    </div>

    <div class="stream-list">
      ${streamList}
    </div>

    <div class="subtitles">
      ${
        subtitles.length
          ? `
<span class="status">
  ${subtitles.length}
  subtitle source(s)
</span>`
          : ''
      }
    </div>

    <div class="episodes">
      ${episodeList}
    </div>

  </div>

</section>`;

    const js = `
<script
  src="https://cdn.jsdelivr.net/npm/hls.js@${escapeHtml(
    HLS_JS_VERSION
  )}/dist/hls.min.js"
></script>

<script>
const player =
  document.getElementById('player');

const statusEl =
  document.getElementById('status');

let hls = null;

function setStatus(
  text,
  kind = ''
) {
  statusEl.className =
    'status ' + kind;

  statusEl.textContent =
    text;
}

function playSource(
  url,
  label
) {
  if (!url) {
    return;
  }

  if (hls) {
    hls.destroy();
    hls = null;
  }

  setStatus(
    'Loading ' + label + '…'
  );

  player.pause();
  player.removeAttribute('src');
  player.load();

  const nativeHls =
    player.canPlayType(
      'application/vnd.apple.mpegurl'
    );

  if (
    /\\\\.m3u8(?:$|[?#])/i.test(url) &&
    !nativeHls &&
    window.Hls &&
    Hls.isSupported()
  ) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false
    });

    hls.loadSource(url);
    hls.attachMedia(player);

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {
        setStatus('Ready');

        player
          .play()
          .catch(() => {});
      }
    );

    hls.on(
      Hls.Events.ERROR,
      (_, data) => {
        if (data.fatal) {
          setStatus(
            'The selected HLS source could not be played in this browser.',
            'error'
          );
        }
      }
    );

  } else {

    player.src = url;
    player.load();

    setStatus('Ready');

    player
      .play()
      .catch(() => {});
  }
}
</script>`;

    html(
      res,
      200,
      shell(
        meta.name || APP_NAME,
        body,
        js
      )
    );
  } catch (error) {
    html(
      res,
      502,

      shell(
        'Playback unavailable',

        `<div class="notice">

          <h2>
            Could not load playback data
          </h2>

          <p class="error">
            ${escapeHtml(error.message)}
          </p>

        </div>`
      )
    );
  }
}

async function handle(req, res) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );

  res.setHeader(
    'Permissions-Policy',
    'camera=(),microphone=(),geolocation=()'
  );

  res.setHeader(
    'Content-Security-Policy',
    makeCsp()
  );

  if (req.method === 'OPTIONS') {
    return sendEmpty(res);
  }

  if (req.method !== 'GET') {
    return json(
      res,
      405,
      {
        error: 'Method not allowed',
      },
      {
        Allow: 'GET, OPTIONS',
      }
    );
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const pathname = url.pathname;

  if (pathname === '/favicon.ico') {
    return sendEmpty(res, 204);
  }

  if (
    pathname === '/healthz' ||
    pathname === '/health'
  ) {
    return json(res, 200, {
      status: 'ok',
      service: APP_NAME,
      time: new Date().toISOString(),
    });
  }

  if (pathname === '/api/config') {
    return json(res, 200, {
      app: APP_NAME,
      metadataType: METADATA_TYPE,
      metadataCatalog:
        METADATA_CATALOG_ID,
      metadataAddons:
        METADATA_ADDONS.length,
      streamAddons:
        STREAM_ADDONS.length,
      subtitleAddons:
        SUBTITLE_ADDONS.length,
    });
  }

  try {
    if (pathname === '/api/catalog') {
      return json(
        res,
        200,
        {
          metas: await getCatalog(
            url.searchParams.get(
              'catalog'
            ) ||
              METADATA_CATALOG_ID
          ),
        }
      );
    }

    if (pathname === '/api/search') {
      const q =
        (
          url.searchParams.get('q') ||
          ''
        ).trim();

      if (!q) {
        return json(
          res,
          400,
          {
            error: 'q is required',
          }
        );
      }

      return json(
        res,
        200,
        {
          metas:
            await searchAnime(q),
        }
      );
    }

    const metaMatch =
      pathname.match(
        /^\/api\/meta\/([^/]+)\/(.+)$/
      );

    if (metaMatch) {
      return json(
        res,
        200,
        {
          meta: await getMeta(
            decodeURIComponent(
              metaMatch[1]
            ),
            decodeURIComponent(
              metaMatch[2]
            )
          ),
        }
      );
    }

    const streamMatch =
      pathname.match(
        /^\/api\/streams\/([^/]+)\/(.+)$/
      );

    if (streamMatch) {
      return json(
        res,
        200,
        {
          streams: await getStreams(
            decodeURIComponent(
              streamMatch[1]
            ),
            decodeURIComponent(
              streamMatch[2]
            )
          ),

          configured:
            STREAM_ADDONS.length >
            0,
        }
      );
    }

    const subtitleMatch =
      pathname.match(
        /^\/api\/subtitles\/([^/]+)\/(.+)$/
      );

    if (subtitleMatch) {
      return json(
        res,
        200,
        {
          subtitles:
            await getSubtitles(
              decodeURIComponent(
                subtitleMatch[1]
              ),
              decodeURIComponent(
                subtitleMatch[2]
              )
            ),

          configured:
            SUBTITLE_ADDONS.length >
            0,
        }
      );
    }

    if (pathname === '/') {
      return homePage(res);
    }

    if (pathname === '/search') {
      return searchPage(
        res,
        (
          url.searchParams.get('q') ||
          ''
        ).trim()
      );
    }

    const showMatch =
      pathname.match(
        /^\/show\/(.+)$/
      );

    if (showMatch) {
      const id =
        decodeURIComponent(
          showMatch[1]
        );

      const epRaw =
        Number.parseInt(
          url.searchParams.get(
            'ep'
          ) || '0',
          10
        );

      const ep =
        Number.isFinite(epRaw) &&
        epRaw >= 0
          ? epRaw
          : 0;

      return showPage(
        res,
        id,
        ep
      );
    }

    return json(
      res,
      404,
      {
        error: 'Not found',
      }
    );
  } catch (error) {
    console.error(error);

    return json(
      res,
      500,
      {
        error:
          'Internal server error',
      }
    );
  }
}

function createServer() {
  return http.createServer(
    (req, res) => {
      handle(req, res).catch(
        error => {
          console.error(error);

          if (!res.headersSent) {
            json(
              res,
              500,
              {
                error:
                  'Internal server error',
              }
            );
          } else {
            res.destroy();
          }
        }
      );
    }
  );
}

if (require.main === module) {
  const server =
    createServer();

  server.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `${APP_NAME} listening on ${HOST}:${PORT}`
      );
    }
  );

  const shutdown =
    signal => {
      console.log(
        `${signal} received; shutting down`
      );

      server.close(
        () =>
          process.exit(0)
      );

      setTimeout(
        () =>
          process.exit(1),
        8000
      ).unref();
    };

  process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
  );

  process.on(
    'SIGINT',
    () => shutdown('SIGINT')
  );
}

module.exports = {
  handle,
  createServer,
  normalizeEndpoint,
  routeUrl,
  mergeUnique,
  isLikelyHls,
};
