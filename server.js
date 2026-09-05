'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PORT = toPositiveInt(process.env.PORT, 3000);
const HOST = process.env.HOST || '0.0.0.0';

const APP_NAME = env('APP_NAME', 'AniV3');
const ADDON_ID = env('ADDON_ID', 'com.aniv3.bridge');
const ADDON_NAME = env('ADDON_NAME', 'AniV3 Anime Bridge');
const ADDON_VERSION = env('ADDON_VERSION', '3.0.0');
const ADDON_DESCRIPTION = env(
  'ADDON_DESCRIPTION',
  'Anime catalog and playback bridge for configured Stremio-compatible add-ons.'
);

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const LOGO_URL = process.env.LOGO_URL || '';

const METADATA_TYPE = env('METADATA_TYPE', 'anime');

const METADATA_ADDONS = parseEndpoints(
  env('METADATA_ADDONS', 'https://anime-kitsu.strem.fun')
);

const STREAM_ADDONS = parseEndpoints(
  process.env.STREAM_ADDONS || ''
);

const SUBTITLE_ADDONS = parseEndpoints(
  process.env.SUBTITLE_ADDONS ||
    'https://anime-kitsu.strem.fun'
);

const REQUEST_TIMEOUT_MS = toPositiveInt(
  process.env.REQUEST_TIMEOUT_MS,
  8000
);

const CACHE_TTL_MS = toPositiveInt(
  process.env.CACHE_TTL_MS,
  120000
);

const CACHE_MAX = toPositiveInt(
  process.env.CACHE_MAX,
  250
);

const HLS_JS_VERSION =
  process.env.HLS_JS_VERSION || '1.7.2';

const CACHE = new Map();

const CATALOGS = [
  {
    id: 'anime-trending',
    name: 'Anime Trending',
    upstreamId: 'kitsu-anime-trending',
    extra: [
      {
        name: 'skip',
        isRequired: false
      }
    ]
  },

  {
    id: 'anime-airing',
    name: 'Anime Airing',
    upstreamId: 'kitsu-anime-airing',

    extra: [
      {
        name: 'genre',
        isRequired: false,

        options: [
          'Action',
          'Adventure',
          'Comedy',
          'Drama',
          'Sci-Fi',
          'Fantasy',
          'Romance',
          'Horror',
          'Psychological',
          'Mystery',
          'School',
          'Sports',
          'Supernatural',
          'Thriller'
        ]
      },

      {
        name: 'skip',
        isRequired: false
      }
    ]
  },

  {
    id: 'anime-popular',
    name: 'Anime Most Popular',
    upstreamId: 'kitsu-anime-popular',

    extra: [
      {
        name: 'genre',
        isRequired: false,

        options: [
          'Action',
          'Adventure',
          'Comedy',
          'Drama',
          'Sci-Fi',
          'Fantasy',
          'Romance',
          'Horror',
          'Sports',
          'Supernatural'
        ]
      },

      {
        name: 'skip',
        isRequired: false
      }
    ]
  },

  {
    id: 'anime-rated',
    name: 'Anime Highest Rated',
    upstreamId: 'kitsu-anime-rating',

    extra: [
      {
        name: 'genre',
        isRequired: false,

        options: [
          'Action',
          'Adventure',
          'Comedy',
          'Drama',
          'Sci-Fi',
          'Fantasy',
          'Romance',
          'Mystery',
          'Psychological',
          'Sports'
        ]
      },

      {
        name: 'skip',
        isRequired: false
      }
    ]
  },

  {
    id: 'anime-search',
    name: 'Search Anime',
    upstreamId: 'kitsu-anime-list',

    extra: [
      {
        name: 'search',
        isRequired: true
      },

      {
        name: 'lastVideosIds',
        isRequired: false,
        optionsLimit: 20
      },

      {
        name: 'skip',
        isRequired: false
      }
    ]
  }
];

function env(name, fallback) {
  return process.env[name] || fallback;
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(
    String(value ?? ''),
    10
  );

  return Number.isFinite(n) && n > 0
    ? n
    : fallback;
}

function parseEndpoints(value) {
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(normalizeEndpoint);
}

function normalizeEndpoint(value) {
  const url = new URL(value);

  if (
    !['http:', 'https:'].includes(
      url.protocol
    )
  ) {
    throw new Error(
      `Unsupported add-on protocol: ${value}`
    );
  }

  url.hash = '';
  url.search = '';
  url.pathname =
    url.pathname.replace(/\/+$/, '');

  return url
    .toString()
    .replace(/\/$/, '');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll(
      "'",
      '&#039;'
    );
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function setCommonHeaders(res) {
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
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );

  res.setHeader(
    'Permissions-Policy',
    'camera=(),microphone=(),geolocation=()'
  );
}

function sendJson(
  res,
  status,
  body,
  extraHeaders = {}
) {
  setCommonHeaders(res);

  res.writeHead(status, {
    'Content-Type':
      'application/json; charset=utf-8',

    'Cache-Control':
      'no-store',

    ...extraHeaders
  });

  res.end(
    JSON.stringify(body)
  );
}

function sendHtml(
  res,
  status,
  body
) {
  setCommonHeaders(res);

  res.writeHead(status, {
    'Content-Type':
      'text/html; charset=utf-8',

    'Cache-Control':
      'no-store',

    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "media-src 'self' blob: data: https:",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  });

  res.end(body);
}

function cacheGet(key) {
  const item = CACHE.get(key);

  if (!item) {
    return undefined;
  }

  if (
    Date.now() - item.createdAt >
    CACHE_TTL_MS
  ) {
    CACHE.delete(key);

    return undefined;
  }

  return item.value;
}

function cacheSet(
  key,
  value
) {
  CACHE.set(key, {
    createdAt: Date.now(),
    value
  });

  while (
    CACHE.size >
    CACHE_MAX
  ) {
    const oldest =
      CACHE.keys().next().value;

    if (
      oldest === undefined
    ) {
      break;
    }

    CACHE.delete(oldest);
  }

  return value;
}

async function fetchJson(
  url,
  cacheKey = ''
) {
  if (cacheKey) {
    const cached =
      cacheGet(cacheKey);

    if (
      cached !== undefined
    ) {
      return cached;
    }
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
    () =>
      controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response =
      await fetch(url, {
        method: 'GET',

        redirect: 'follow',

        signal:
          controller.signal,

        headers: {
          Accept:
            'application/json',

          'User-Agent':
            `${APP_NAME}/${ADDON_VERSION}`
        }
      });

    if (!response.ok) {
      throw new Error(
        `Upstream HTTP ${response.status}`
      );
    }

    const contentType =
      response.headers.get(
        'content-type'
      ) || '';

    if (
      !contentType
        .toLowerCase()
        .includes('json')
    ) {
      throw new Error(
        `Upstream did not return JSON (${contentType || 'unknown'})`
      );
    }

    const data =
      await response.json();

    return cacheKey
      ? cacheSet(
          cacheKey,
          data
        )
      : data;
  } finally {
    clearTimeout(timer);
  }
}

function resourceUrl(
  endpoint,
  resource,
  type,
  id,
  extras = []
) {
  const url =
    new URL(endpoint);

  const prefix =
    url.pathname.replace(
      /\/+$/,
      ''
    );

  url.pathname =
    `${prefix}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;

  if (extras.length) {
    url.pathname +=
      '/' +
      extras
        .map(
          ([key, value]) =>
            `${encodeURIComponent(
              key
            )}=${encodeURIComponent(
              value
            )}`
        )
        .join('&');
  }

  url.pathname +=
    '.json';

  return url.toString();
}

function parseExtras(
  rawSegments
) {
  const result = [];

  for (
    const rawSegment of rawSegments
  ) {
    for (
      const rawPart of rawSegment.split('&')
    ) {
      if (!rawPart) {
        continue;
      }

      const equals =
        rawPart.indexOf('=');

      const rawKey =
        equals === -1
          ? rawPart
          : rawPart.slice(
              0,
              equals
            );

      const rawValue =
        equals === -1
          ? ''
          : rawPart.slice(
              equals + 1
            );

      const key =
        safeDecode(rawKey);

      const value =
        safeDecode(rawValue);

      if (
        key === null ||
        value === null
      ) {
        continue;
      }

      result.push([
        key,
        value
      ]);
    }
  }

  return result;
}

function uniqueBy(
  items,
  keyFn
) {
  const seen =
    new Set();

  const result = [];

  for (
    const item of items
  ) {
    const key =
      keyFn(item);

    if (
      !key ||
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function cleanProviderFields(
  value
) {
  if (
    Array.isArray(value)
  ) {
    return value.map(
      cleanProviderFields
    );
  }

  if (
    !value ||
    typeof value !== 'object'
  ) {
    return value;
  }

  const output = {};

  for (
    const [key, val] of
    Object.entries(value)
  ) {
    if (
      key.startsWith(
        '_aniv3'
      )
    ) {
      continue;
    }

    output[key] =
      cleanProviderFields(
        val
      );
  }

  return output;
}

async function fromAddons(
  addons,
  buildUrl,
  extract,
  cachePrefix
) {
  const results =
    await Promise.allSettled(
      addons.map(
        async endpoint => {
          const url =
            buildUrl(endpoint);

          const data =
            await fetchJson(
              url,
              `${cachePrefix}:${endpoint}:${url}`
            );

          return extract(
            data,
            endpoint
          );
        }
      )
    );

  return results.flatMap(
    result =>
      result.status ===
        'fulfilled' &&
      Array.isArray(
        result.value
      )
        ? result.value
        : []
  );
}

function manifest() {
  const resources = [
    'catalog',
    'meta'
  ];

  if (
    STREAM_ADDONS.length
  ) {
    resources.push(
      'stream'
    );
  }

  if (
    SUBTITLE_ADDONS.length
  ) {
    resources.push(
      'subtitles'
    );
  }

  return {
    id: ADDON_ID,

    version:
      ADDON_VERSION,

    name:
      ADDON_NAME,

    description:
      ADDON_DESCRIPTION,

    idProperty:
      'id',

    types: [
      'anime'
    ],

    idPrefixes: [
      'kitsu',
      'mal',
      'anilist',
      'anidb'
    ],

    resources,

    catalogs:
      CATALOGS.map(
        catalog => ({
          id:
            catalog.id,

          type:
            METADATA_TYPE,

          name:
            catalog.name,

          ...(catalog.extra
            ? {
                extra:
                  catalog.extra
              }
            : {})
        })
      ),

    isFree:
      true,

    listedOn:
      [],

    dontAnnounce:
      true,

    ...(PUBLIC_URL
      ? {
          endpoint:
            `${PUBLIC_URL.replace(/\/$/, '')}/stremio/v1`
        }
      : {}),

    ...(LOGO_URL
      ? {
          logo: LOGO_URL
        }
      : {}),

    ...(CONTACT_EMAIL
      ? {
          contactEmail:
            CONTACT_EMAIL
        }
      : {})
  };
}

function catalogConfig(
  id
) {
  return CATALOGS.find(
    catalog =>
      catalog.id === id
  ) || null;
}

async function catalogHandler(
  type,
  id,
  extras
) {
  if (
    type !==
    METADATA_TYPE
  ) {
    return {
      metas: []
    };
  }

  const config =
    catalogConfig(id);

  if (!config) {
    return {
      metas: []
    };
  }

  const allowedKeys =
    new Set(
      (config.extra || [])
        .map(x => x.name)
    );

  const upstreamExtras =
    extras.filter(
      ([key]) =>
        allowedKeys.has(key)
    );

  const metas =
    await fromAddons(
      METADATA_ADDONS,

      endpoint =>
        resourceUrl(
          endpoint,
          'catalog',
          METADATA_TYPE,
          config.upstreamId,
          upstreamExtras
        ),

      data =>
        Array.isArray(
          data?.metas
        )
          ? data.metas
          : [],

      `catalog:${type}:${id}:${JSON.stringify(
        upstreamExtras
      )}`
    );

  return {
    metas: uniqueBy(
      metas,
      item =>
        item?.id ||
        item?.name
    ).map(
      cleanProviderFields
    )
  };
}

async function metaHandler(
  type,
  id
) {
  if (
    type !==
    METADATA_TYPE
  ) {
    return {
      meta: null
    };
  }

  for (
    const endpoint of
    METADATA_ADDONS
  ) {
    try {
      const data =
        await fetchJson(
          resourceUrl(
            endpoint,
            'meta',
            type,
            id
          ),
          `meta:${endpoint}:${type}:${id}`
        );

      if (
        data?.meta
      ) {
        return {
          meta:
            cleanProviderFields(
              data.meta
            )
        };
      }
    } catch (
      error
    ) {
      console.warn(
        `metadata provider ${endpoint}: ${error.message}`
      );
    }
  }

  return {
    meta: null
  };
}

async function streamHandler(
  type,
  id
) {
  if (
    type !==
      METADATA_TYPE ||
    !STREAM_ADDONS.length
  ) {
    return {
      streams: []
    };
  }

  const streams =
    await fromAddons(
      STREAM_ADDONS,

      endpoint =>
        resourceUrl(
          endpoint,
          'stream',
          type,
          id
        ),

      (
        data,
        endpoint
      ) =>
        (
          Array.isArray(
            data?.streams
          )
            ? data.streams
            : []
        ).map(
          stream => ({
            ...stream,
            _aniv3Provider:
              endpoint
          })
        ),

      `stream:${type}:${id}`
    );

  return {
    streams:
      uniqueBy(
        streams,
        stream =>
          JSON.stringify([
            stream?.url,
            stream?.externalUrl,
            stream?.ytId,
            stream?.infoHash,
            stream?.fileIdx,
            stream?.title,
            stream?.name
          ])
      ).map(
        cleanProviderFields
      )
  };
}

async function subtitleHandler(
  type,
  id
) {
  if (
    type !==
      METADATA_TYPE ||
    !SUBTITLE_ADDONS.length
  ) {
    return {
      subtitles: []
    };
  }

  const subtitles =
    await fromAddons(
      SUBTITLE_ADDONS,

      endpoint =>
        resourceUrl(
          endpoint,
          'subtitles',
          type,
          id
        ),

      (
        data,
        endpoint
      ) =>
        (
          Array.isArray(
            data?.subtitles
          )
            ? data.subtitles
            : []
        ).map(
          subtitle => ({
            ...subtitle,
            _aniv3Provider:
              endpoint
          })
        ),

      `subtitle:${type}:${id}`
    );

  return {
    subtitles:
      uniqueBy(
        subtitles,
        subtitle =>
          JSON.stringify([
            subtitle?.id,
            subtitle?.url,
            subtitle?.lang,
            subtitle?.label
          ])
      ).map(
        cleanProviderFields
      )
  };
}

function playableStreamUrl(
  stream
) {
  if (
    typeof stream?.url ===
      'string' &&
    /^https?:\/\//i.test(
      stream.url
    )
  ) {
    return stream.url;
  }

  return null;
}

function isHls(url) {
  return /\.m3u8(?:$|[?#])/i.test(
    url
  );
}

function websiteShell(
  title,
  body,
  script = ''
) {
  return `<!doctype html>
<html lang="en">
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<meta
  name="theme-color"
  content="#0b0d14"
>

<meta
  name="description"
  content="${escapeHtml(
    ADDON_DESCRIPTION
  )}"
>

<title>
  ${escapeHtml(title)}
  ·
  ${escapeHtml(APP_NAME)}
</title>

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
}

*{
  box-sizing:border-box
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
  font:
    15px/1.55
    system-ui,
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
  width:
    min(
      1280px,
      calc(100% - 30px)
    );
  margin:auto
}

.nav{
  position:sticky;
  top:0;
  z-index:20;
  min-height:66px;
  background:
    rgba(8,10,15,.88);
  backdrop-filter:
    blur(14px);
  border-bottom:
    1px solid var(--border)
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
  gap:8px
}

.search input{
  width:
    min(360px,46vw);
  background:var(--panel);
  border:
    1px solid var(--border);
  border-radius:10px;
  color:var(--text);
  padding:
    10px 12px;
  outline:none
}

.btn{
  border:
    1px solid var(--border);
  background:var(--panel2);
  color:var(--text);
  padding:
    9px 13px;
  border-radius:10px;
  font-weight:750;
  cursor:pointer
}

.btn.primary{
  background:var(--accent);
  border-color:var(--accent)
}

main{
  padding:
    28px 0 52px
}

.hero{
  padding:
    14px 0 28px
}

.kicker{
  color:var(--muted);
  font-size:12px;
  letter-spacing:.11em;
  font-weight:800
}

.hero h1{
  font-size:
    clamp(30px,5vw,50px);
  line-height:1.05;
  margin:
    8px 0
}

.muted{
  color:var(--muted)
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(
      auto-fill,
      minmax(165px,1fr)
    );
  gap:16px
}

.card{
  display:block;
  overflow:hidden;
  background:var(--panel);
  border:
    1px solid var(--border);
  border-radius:14px;
  transition:
    transform .16s,
    border-color .16s
}

.card:hover{
  transform:
    translateY(-3px);
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
  border:
    1px solid var(--border);
  background:
    rgba(17,21,33,.85);
  padding:16px;
  border-radius:14px
}

.show{
  display:grid;
  grid-template-columns:
    230px minmax(0,1fr);
  gap:24px
}

.show-poster{
  width:100%;
  border-radius:14px;
  border:
    1px solid var(--border)
}

.panel{
  background:
    rgba(17,21,33,.88);
  border:
    1px solid var(--border);
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
  border:
    1px solid var(--border);
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
    repeat(
      auto-fill,
      minmax(95px,1fr)
    );
  gap:9px;
  margin-top:16px
}

.ep{
  padding:
    10px 8px;
  background:var(--panel2);
  border:
    1px solid var(--border);
  border-radius:9px;
  text-align:center
}

.ep.active{
  background:var(--accent);
  border-color:var(--accent)
}

.status{
  font-size:13px;
  color:var(--muted)
}

.error{
  color:var(--danger)
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

    <a
      class="brand"
      href="/"
    >
      ${escapeHtml(APP_NAME)}
      <i>.</i>
    </a>

    <form
      class="search"
      action="/search"
    >

      <input
        name="q"
        placeholder="Search anime…"
        autocomplete="off"
        required
      >

      <button
        class="btn primary"
      >
        Search
      </button>

    </form>

  </div>
</nav>

<main class="wrap">
  ${body}
</main>

<footer class="wrap">
  Metadata and playback information
  are supplied by configured
  Stremio-compatible add-ons.
  This application does not host
  media files.
</footer>

${script}

</body>
</html>`;
}

function renderCards(
  items
) {
  if (!items.length) {
    return `
<div class="notice">
  No anime was returned by
  the metadata provider.
</div>`;
  }

  return `
<div class="grid">

${items
  .map(item => {
    const id =
      item?.id || '';

    const name =
      item?.name ||
      id ||
      'Untitled';

    if (!id) {
      return '';
    }

    return `
<a
  class="card"
  href="/show/${encodeURIComponent(
    id
  )}"
>

  <img
    class="poster"
    src="${escapeHtml(
      item?.poster || ''
    )}"
    alt="${escapeHtml(name)}"
    loading="lazy"
    referrerpolicy="no-referrer"
  >

  <div class="card-body">

    <div class="title">
      ${escapeHtml(name)}
    </div>

    <div class="tag">
      ${escapeHtml(
        item?.type ||
        METADATA_TYPE
      )}
    </div>

  </div>

</a>`;
  })
  .join('')}

</div>`;
}

async function homepage(
  res
) {
  try {
    const data =
      await catalogHandler(
        METADATA_TYPE,
        'anime-trending',
        []
      );

    return sendHtml(
      res,
      200,

      websiteShell(
        APP_NAME,

        `
<section class="hero">

  <div class="kicker">
    STREMIO-COMPATIBLE
    ANIME HUB
  </div>

  <h1>
    Discover anime.
  </h1>

  <p class="muted">
    Catalog, metadata, episodes,
    streams and subtitles flow
    through the Stremio-compatible
    integration layer.
  </p>

</section>

<h2>
  Trending
</h2>

${renderCards(
  data.metas
)}
`
      )
    );
  } catch (error) {
    return sendHtml(
      res,
      502,

      websiteShell(
        'Metadata unavailable',

        `
<div class="notice">

  <h2>
    Metadata service unavailable
  </h2>

  <p class="error">
    ${escapeHtml(
      error.message
    )}
  </p>

</div>
`
      )
    );
  }
}

async function searchPage(
  res,
  q
) {
  try {
    const data =
      await catalogHandler(
        METADATA_TYPE,
        'anime-search',
        [['search', q]]
      );

    return sendHtml(
      res,
      200,

      websiteShell(
        `Search: ${q}`,

        `
<section class="hero">

  <div class="kicker">
    SEARCH
  </div>

  <h1>
    ${escapeHtml(q)}
  </h1>

</section>

${renderCards(
  data.metas
)}
`
      )
    );
  } catch (error) {
    return sendHtml(
      res,
      502,

      websiteShell(
        'Search unavailable',

        `
<div class="notice">

  <h2>
    Search failed
  </h2>

  <p class="error">
    ${escapeHtml(
      error.message
    )}
  </p>

</div>
`
      )
    );
  }
}

async function showPage(
  res,
  id,
  requestedEpisode
) {
  try {
    const metaResponse =
      await metaHandler(
        METADATA_TYPE,
        id
      );

    const meta =
      metaResponse.meta;

    if (!meta) {
      return sendHtml(
        res,
        404,

        websiteShell(
          'Not found',

          `
<div class="notice">

  <h2>
    Anime not found
  </h2>

</div>
`
        )
      );
    }

    const videos =
      Array.isArray(
        meta.videos
      )
        ? meta.videos
        : [];

    const episodeIndex =
      Math.min(
        Math.max(
          requestedEpisode,
          0
        ),
        Math.max(
          videos.length - 1,
          0
        )
      );

    const selected =
      videos[
        episodeIndex
      ] || null;

    const streams =
      selected?.id
        ? (
            await streamHandler(
              METADATA_TYPE,
              selected.id
            )
          ).streams
        : [];

    const subtitles =
      selected?.id
        ? (
            await subtitleHandler(
              METADATA_TYPE,
              selected.id
            )
          ).subtitles
        : [];

    const streamList =
      streams.length
        ? streams
            .map(
              (
                stream,
                index
              ) => {
                const url =
                  playableStreamUrl(
                    stream
                  );

                const title =
                  stream.title ||
                  stream.name ||
                  `Stream ${
                    index + 1
                  }`;

                if (!url) {
                  const external =
                    typeof stream.externalUrl ===
                      'string' &&
                    /^https?:\/\//i.test(
                      stream.externalUrl
                    )
                      ? stream.externalUrl
                      : '';

                  return `
<div class="stream">

  <div
    class="stream-name"
  >

    <strong>
      ${escapeHtml(
        title
      )}
    </strong>

    <div
      class="stream-meta"
    >
      No direct browser URL returned
    </div>

  </div>

  ${
    external
      ? `
<a
  class="btn"
  href="${escapeHtml(
    external
  )}"
  target="_blank"
  rel="noopener noreferrer"
>
  Open
</a>
`
      : `
<span class="status">
  Unavailable
</span>
`
  }

</div>`;
                }

                return `
<button
  type="button"
  class="stream"
  data-url="${escapeHtml(
    url
  )}"
  data-title="${escapeHtml(
    title
  )}"
  onclick="
    playSource(
      this.dataset.url,
      this.dataset.title
    )
  "
>

  <div
    class="stream-name"
  >

    <strong>
      ${escapeHtml(
        title
      )}
    </strong>

    <div
      class="stream-meta"
    >
      ${
        isHls(url)
          ? 'HLS'
          : 'HTTP media'
      }

      ${
        stream.behaviorHints
          ?.bingeGroup
          ? ` · ${escapeHtml(
              stream
                .behaviorHints
                .bingeGroup
            )}`
          : ''
      }
    </div>

  </div>

  <span class="btn primary">
    Play
  </span>

</button>`;
              }
            )
            .join('')
        : `
<div class="notice">

  No playback source is
  currently configured for
  this episode.

  Set
  <code>STREAM_ADDONS</code>
  to one or more
  Stremio-compatible stream
  add-on endpoints you are
  authorized to use.

</div>
`;

    const episodeList =
      videos.length
        ? videos
            .map(
              (
                video,
                index
              ) => `
<a
  class="ep ${
    index === episodeIndex
      ? 'active'
      : ''
  }"
  href="/show/${encodeURIComponent(
    id
  )}?ep=${index}"
>
  ${escapeHtml(
    video.title ||
      `Episode ${
        index + 1
      }`
  )}
</a>`
            )
            .join('')
        : `
<div class="notice">
  No episodes were returned
  by the metadata provider.
</div>
`;

    const tracks =
      subtitles
        .filter(
          sub =>
            typeof sub?.url ===
              'string' &&
            /^https?:\/\//i.test(
              sub.url
            )
        )
        .map(
          sub => `
<track
  kind="subtitles"
  src="${escapeHtml(
    sub.url
  )}"
  srclang="${escapeHtml(
    sub.lang || 'und'
  )}"
  label="${escapeHtml(
    sub.label ||
      sub.lang ||
      'Subtitle'
  )}"
>
`
        )
        .join('');

    const body = `
<a
  class="muted"
  href="/"
>
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
  src="${escapeHtml(
    meta.poster
  )}"
  alt="${escapeHtml(
    meta.name || id
  )}"
  referrerpolicy="no-referrer"
>
`
        : ''
    }

  </aside>

  <div>

    <h1>
      ${escapeHtml(
        meta.name || id
      )}
    </h1>

    ${
      meta.description
        ? `
<p class="muted">
  ${escapeHtml(
    meta.description
  )}
</p>
`
        : ''
    }

    <div
      class="panel player"
    >

      <video
        id="player"
        controls
        playsinline
        preload="metadata"
      >

        ${tracks}

      </video>

      <div
        id="status"
        class="status"
        style="margin-top:10px"
      >
        ${
          selected
            ? `Episode: ${escapeHtml(
                selected.title ||
                  `Episode ${
                    episodeIndex + 1
                  }`
              )}`
            : 'No episode selected.'
        }
      </div>

    </div>

    <div
      class="stream-list"
    >

      ${streamList}

    </div>

    <div
      class="episodes"
    >

      ${episodeList}

    </div>

  </div>

</section>
`;

    const script = `
<script
  src="https://cdn.jsdelivr.net/npm/hls.js@${escapeHtml(
    HLS_JS_VERSION
  )}/dist/hls.min.js"
></script>

<script>

const player =
  document.getElementById(
    'player'
  );

const statusEl =
  document.getElementById(
    'status'
  );

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
  title
) {
  if (!url) {
    return;
  }

  if (hls) {
    hls.destroy();
    hls = null;
  }

  player.pause();

  player.removeAttribute(
    'src'
  );

  player.load();

  setStatus(
    'Loading ' +
      title +
      '…'
  );

  const nativeHls =
    player.canPlayType(
      'application/vnd.apple.mpegurl'
    );

  if (
    /\\\\.m3u8(?:$|[?#])/i.test(
      url
    ) &&
    !nativeHls &&
    window.Hls &&
    Hls.isSupported()
  ) {
    hls =
      new Hls({
        enableWorker: true,
        lowLatencyMode: false
      });

    hls.loadSource(
      url
    );

    hls.attachMedia(
      player
    );

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {
        setStatus(
          'Ready'
        );

        player
          .play()
          .catch(
            () => {}
          );
      }
    );

    hls.on(
      Hls.Events.ERROR,
      (_, data) => {
        if (
          data.fatal
        ) {
          setStatus(
            'The selected HLS source could not be played by this browser.',
            'error'
          );
        }
      }
    );

  } else {

    player.src =
      url;

    player.load();

    setStatus(
      'Ready'
    );

    player
      .play()
      .catch(
        () => {}
      );
  }
}

</script>
`;

    return sendHtml(
      res,
      200,

      websiteShell(
        meta.name ||
          APP_NAME,

        body,

        script
      )
    );

  } catch (error) {

    return sendHtml(
      res,
      502,

      websiteShell(
        'Playback unavailable',

        `
<div class="notice">

  <h2>
    Playback data unavailable
  </h2>

  <p class="error">
    ${escapeHtml(
      error.message
    )}
  </p>

</div>
`
      )
    );
  }
}

async function handle(
  req,
  res
) {
  setCommonHeaders(
    res
  );

  if (
    req.method ===
    'OPTIONS'
  ) {
    res.writeHead(
      204
    );

    return res.end();
  }

  if (
    req.method !==
    'GET'
  ) {
    return sendJson(
      res,
      405,
      {
        error:
          'Method not allowed'
      },
      {
        Allow:
          'GET, OPTIONS'
      }
    );
  }

  const requestUrl =
    new URL(
      req.url,
      `http://${
        req.headers.host ||
        'localhost'
      }`
    );

  const pathname =
    requestUrl.pathname;

  if (
    pathname ===
    '/healthz' ||
    pathname ===
    '/health'
  ) {
    return sendJson(
      res,
      200,
      {
        status: 'ok',

        service:
          APP_NAME,

        addon:
          ADDON_ID,

        time:
          new Date()
            .toISOString(),

        metadataProviders:
          METADATA_ADDONS.length,

        streamProviders:
          STREAM_ADDONS.length,

        subtitleProviders:
          SUBTITLE_ADDONS.length
      }
    );
  }

  if (
    pathname ===
      '/manifest.json' ||
    pathname ===
      '/stremio/v1/manifest.json'
  ) {
    return sendJson(
      res,
      200,
      manifest()
    );
  }

  if (
    pathname ===
    '/stremio/v1'
  ) {
    return sendHtml(
      res,
      200,

      websiteShell(
        ADDON_NAME,

        `
<section class="hero">

  <div class="kicker">
    STREMIO ADD-ON
  </div>

  <h1>
    ${escapeHtml(
      ADDON_NAME
    )}
  </h1>

  <p class="muted">
    Install this add-on
    in Stremio using:
  </p>

  <div class="panel">
    <code>
      /stremio/v1/manifest.json
    </code>
  </div>

</section>
`
      )
    );
  }

  if (
    pathname ===
    '/api/config'
  ) {
    return sendJson(
      res,
      200,
      {
        app:
          APP_NAME,

        addonId:
          ADDON_ID,

        metadataType:
          METADATA_TYPE,

        metadataProviders:
          METADATA_ADDONS.length,

        streamProviders:
          STREAM_ADDONS.length,

        subtitleProviders:
          SUBTITLE_ADDONS.length,

        stremioManifest:
          '/stremio/v1/manifest.json'
      }
    );
  }

  const cleanPath =
    pathname.replace(
      /\.json$/,
      ''
    );

  const parts =
    cleanPath
      .split('/')
      .filter(Boolean);

  if (
    parts[0] === 'api' &&
    parts[1] === 'catalog'
  ) {
    const catalogId =
      requestUrl.searchParams.get(
        'catalog'
      ) ||
      'anime-trending';

    return sendJson(
      res,
      200,

      await catalogHandler(
        METADATA_TYPE,
        catalogId,
        []
      )
    );
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'search'
  ) {
    const q =
      (
        requestUrl.searchParams.get(
          'q'
        ) || ''
      ).trim();

    if (!q) {
      return sendJson(
        res,
        400,
        {
          error:
            'q is required'
        }
      );
    }

    return sendJson(
      res,
      200,

      await catalogHandler(
        METADATA_TYPE,
        'anime-search',
        [
          [
            'search',
            q
          ]
        ]
      )
    );
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'meta' &&
    parts.length >= 4
  ) {
    const type =
      safeDecode(
        parts[2]
      );

    const id =
      safeDecode(
        parts
          .slice(3)
          .join('/')
      );

    if (
      type === null ||
      id === null
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid encoded path'
        }
      );
    }

    return sendJson(
      res,
      200,

      await metaHandler(
        type,
        id
      )
    );
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'streams' &&
    parts.length >= 4
  ) {
    const type =
      safeDecode(
        parts[2]
      );

    const id =
      safeDecode(
        parts
          .slice(3)
          .join('/')
      );

    if (
      type === null ||
      id === null
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid encoded path'
        }
      );
    }

    return sendJson(
      res,
      200,

      await streamHandler(
        type,
        id
      )
    );
  }

  if (
    parts[0] === 'api' &&
    parts[1] ===
      'subtitles' &&
    parts.length >= 4
  ) {
    const type =
      safeDecode(
        parts[2]
      );

    const id =
      safeDecode(
        parts
          .slice(3)
          .join('/')
      );

    if (
      type === null ||
      id === null
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid encoded path'
        }
      );
    }

    return sendJson(
      res,
      200,

      await subtitleHandler(
        type,
        id
      )
    );
  }

  if (
    parts[0] ===
      'stremio' &&
    parts[1] ===
      'v1' &&
    parts.length >= 4
  ) {
    const resource =
      parts[2];

    const type =
      safeDecode(
        parts[3]
      );

    const id =
      parts.length >= 5
        ? safeDecode(
            parts[4]
          )
        : null;

    const extras =
      parts.length > 5
        ? parseExtras(
            parts.slice(5)
          )
        : [];

    if (
      type === null ||
      (
        parts.length >= 5 &&
        id === null
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid encoded path'
        }
      );
    }

    if (
      resource ===
      'catalog'
    ) {
      return sendJson(
        res,
        200,

        await catalogHandler(
          type,
          id,
          extras
        )
      );
    }

    if (
      resource ===
      'meta'
    ) {
      return sendJson(
        res,
        200,

        await metaHandler(
          type,
          id
        )
      );
    }

    if (
      resource ===
      'stream'
    ) {
      return sendJson(
        res,
        200,

        await streamHandler(
          type,
          id
        )
      );
    }

    if (
      resource ===
      'subtitles'
    ) {
      return sendJson(
        res,
        200,

        await subtitleHandler(
          type,
          id
        )
      );
    }

    return sendJson(
      res,
      404,
      {
        error:
          'Unknown resource'
      }
    );
  }

  if (
    pathname === '/'
  ) {
    return homepage(
      res
    );
  }

  if (
    pathname ===
    '/search'
  ) {
    const q =
      (
        requestUrl.searchParams.get(
          'q'
        ) || ''
      ).trim();

    if (!q) {
      return homepage(
        res
      );
    }

    return searchPage(
      res,
      q
    );
  }

  if (
    pathname.startsWith(
      '/show/'
    )
  ) {
    const rawId =
      pathname.slice(
        '/show/'.length
      );

    const id =
      safeDecode(
        rawId
      );

    if (
      id === null ||
      !id
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid show ID'
        }
      );
    }

    const rawEpisode =
      Number.parseInt(
        requestUrl.searchParams.get(
          'ep'
        ) || '0',
        10
      );

    const episode =
      Number.isFinite(
        rawEpisode
      )
        ? Math.max(
            rawEpisode,
            0
          )
        : 0;

    return showPage(
      res,
      id,
      episode
    );
  }

  return sendJson(
    res,
    404,
    {
      error:
        'Not found'
    }
  );
}

function createServer() {
  return http.createServer(
    (
      req,
      res
    ) => {
      handle(
        req,
        res
      ).catch(
        error => {
          console.error(
            error
          );

          if (
            !res.headersSent
          ) {
            sendJson(
              res,
              500,
              {
                error:
                  'Internal server error'
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

if (
  require.main ===
  module
) {
  const server =
    createServer();

  server.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `${APP_NAME} listening on ${HOST}:${PORT}`
      );

      console.log(
        'Stremio manifest available at /stremio/v1/manifest.json'
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
    () =>
      shutdown(
        'SIGTERM'
      )
  );

  process.on(
    'SIGINT',
    () =>
      shutdown(
        'SIGINT'
      )
  );
}

module.exports = {
  manifest,
  createServer,
  handle,
  parseExtras,
  resourceUrl,
  normalizeEndpoint,
  catalogHandler,
  metaHandler,
  streamHandler,
  subtitleHandler
};
