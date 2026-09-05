'use strict';

/*
 * AniStream - Single File Stremio Addon Aggregator
 *
 * Everything is contained in this one file:
 *   - Stremio manifest discovery
 *   - Capability filtering
 *   - Cinemeta metadata/search
 *   - Episode selection
 *   - Stream aggregation
 *   - Stream normalization
 *   - Deduplication/ranking
 *   - HTTP/HLS playback proxy
 *   - HLS playlist rewriting
 *   - Torrent/magnet display
 *   - Addon status API
 *   - Complete frontend
 *
 * Requirements:
 *   Node.js 20+
 *   npm install express
 *
 * Start:
 *   node server.js
 */

const express = require('express');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { Readable } = require('node:stream');

const app = express();

app.disable('x-powered-by');

const PORT = clampInt(process.env.PORT, 1, 65535, 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MAX_ADDONS = clampInt(
  process.env.MAX_ADDONS,
  1,
  40,
  24
);

const FETCH_CONCURRENCY = clampInt(
  process.env.FETCH_CONCURRENCY,
  1,
  20,
  10
);

const MANIFEST_TIMEOUT = clampInt(
  process.env.MANIFEST_TIMEOUT_MS,
  1500,
  20000,
  7000
);

const STREAM_TIMEOUT = clampInt(
  process.env.STREAM_TIMEOUT_MS,
  1500,
  20000,
  8000
);

const META_TIMEOUT = clampInt(
  process.env.META_TIMEOUT_MS,
  1500,
  20000,
  8000
);

const PROXY_TIMEOUT = clampInt(
  process.env.PROXY_TIMEOUT_MS,
  5000,
  60000,
  20000
);

const MAX_JSON_BYTES = 8 * 1024 * 1024;

const ADDON_CACHE_MS =
  30 * 60 * 1000;

const META_CACHE_MS =
  10 * 60 * 1000;

const STREAM_CACHE_MS =
  30 * 1000;

const CATALOG_CACHE_MS =
  5 * 60 * 1000;

const TOKEN_TTL_MS =
  20 * 60 * 1000;


/* =========================================================
   ADDONS
   ========================================================= */

const DEFAULT_ADDONS = [
  {
    name: 'Torrentio',
    url: 'https://torrentio.strem.fun/manifest.json',
    priority: 100
  },

  {
    name: 'MediaFusion',
    url: 'https://mediafusion.elfhosted.com/manifest.json',
    priority: 95
  },

  {
    name: 'Comet',
    url: 'https://comet.elfhosted.com/manifest.json',
    priority: 90
  },

  {
    name: 'Nyaa Anime',
    url: 'https://nyaa.strem.fun/manifest.json',
    priority: 80
  },

  {
    name: 'AnimeTosho',
    url: 'https://animetosho.strem.fun/manifest.json',
    priority: 80
  },

  {
    name: 'Peerflix',
    url: 'https://peerflix-addon.strem.io/manifest.json',
    priority: 70
  },

  {
    name: 'AnimeFlix',
    url: 'https://animeflix.io/stremio/manifest.json',
    priority: 65
  },

  {
    name: 'ThePirateBay',
    url: 'https://tpb-addon.strem.io/manifest.json',
    priority: 60
  },

  {
    name: '1337x',
    url: 'https://1337x-addon.strem.io/manifest.json',
    priority: 60
  },

  {
    name: 'YTS',
    url: 'https://yts-addon.strem.io/manifest.json',
    priority: 55
  },

  {
    name: 'Jackett',
    url: 'https://jackett.strem.fun/manifest.json',
    priority: 50
  },

  {
    name: 'YouTube',
    url: 'https://youtube-addon.strem.io/manifest.json',
    priority: 40
  },

  {
    name: 'WatchHub',
    url: 'https://watchhub-addon.strem.io/manifest.json',
    priority: 30
  }
];

const CINEMETA =
  'https://v3-cinemeta.strem.io/manifest.json';


/* =========================================================
   UTILITIES
   ========================================================= */

function clampInt(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(max, Math.floor(n))
  );
}


function asArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}


function safeQuery(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }

  const valueTrimmed = value.trim();

  if (!valueTrimmed) {
    return null;
  }

  if (valueTrimmed.length > maxLength) {
    return null;
  }

  if (/[\u0000-\u001F\u007F]/.test(valueTrimmed)) {
    return null;
  }

  return valueTrimmed;
}


function validType(type) {
  return [
    'movie',
    'series',
    'anime',
    'tv',
    'other'
  ].includes(type);
}


/* =========================================================
   TTL CACHE
   ========================================================= */

class TTLCache {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    const item = this.map.get(key);

    if (!item) {
      return null;
    }

    if (Date.now() >= item.expires) {
      this.map.delete(key);
      return null;
    }

    /*
     * LRU behavior.
     */
    this.map.delete(key);
    this.map.set(key, item);

    return item.value;
  }

  set(key, value, ttl) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    while (this.map.size >= this.limit) {
      const oldest =
        this.map.keys().next().value;

      this.map.delete(oldest);
    }

    this.map.set(key, {
      value,
      expires: Date.now() + ttl
    });
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}


const cache = new TTLCache(800);
const tokenCache = new TTLCache(3000);


/* =========================================================
   CONCURRENCY
   ========================================================= */

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        output[index] =
          await fn(items[index], index);
      } catch (error) {
        output[index] = null;
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < Math.min(limit, items.length);
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return output;
}


/* =========================================================
   FETCH JSON
   ========================================================= */

async function fetchJson(url, timeoutMs) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(
      url,
      {
        signal: controller.signal,
        redirect: 'follow',

        headers: {
          accept:
            'application/json, text/plain;q=0.9, */*;q=0.8',

          'user-agent':
            'AniStream/4.0 Stremio-Compatible Client'
        }
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null
      };
    }

    const text =
      await response.text();

    if (
      Buffer.byteLength(text) >
      MAX_JSON_BYTES
    ) {
      return {
        ok: false,
        status: 413,
        data: null
      };
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: 502,
        data: null
      };
    }

    return {
      ok: true,
      status: response.status,
      data
    };
  } catch {
    return {
      ok: false,
      status: 599,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   STREMIO MANIFEST CAPABILITY HANDLING
   ========================================================= */

function normalizeResources(manifest) {
  const globalTypes =
    asArray(manifest?.types);

  const globalPrefixes =
    manifest?.idPrefixes == null
      ? null
      : asArray(manifest.idPrefixes);

  return asArray(
    manifest?.resources
  )
    .map(resource => {
      /*
       * Stremio permits:
       *
       * "stream"
       *
       * as well as:
       *
       * {
       *   name: "stream",
       *   types: [...],
       *   idPrefixes: [...]
       * }
       */

      if (typeof resource === 'string') {
        return {
          name: resource,
          types: globalTypes,
          idPrefixes: globalPrefixes
        };
      }

      if (
        !resource ||
        typeof resource !== 'object' ||
        typeof resource.name !== 'string'
      ) {
        return null;
      }

      return {
        name: resource.name,

        types:
          resource.types == null
            ? globalTypes
            : asArray(resource.types),

        idPrefixes:
          resource.idPrefixes == null
            ? globalPrefixes
            : asArray(resource.idPrefixes)
      };
    })
    .filter(Boolean);
}


function resourceSupports(
  manifest,
  resourceName,
  type,
  id
) {
  if (
    !manifest ||
    typeof id !== 'string'
  ) {
    return false;
  }

  const resources =
    normalizeResources(manifest);

  return resources.some(resource => {
    if (
      resource.name !== resourceName
    ) {
      return false;
    }

    if (
      resource.types.length > 0 &&
      !resource.types.includes(type)
    ) {
      return false;
    }

    if (
      resource.idPrefixes &&
      resource.idPrefixes.length > 0
    ) {
      const matchingPrefix =
        resource.idPrefixes.some(
          prefix =>
            typeof prefix === 'string' &&
            id.startsWith(prefix)
        );

      if (!matchingPrefix) {
        return false;
      }
    }

    return true;
  });
}


/* =========================================================
   STREMIO URL CONSTRUCTION
   ========================================================= */

function buildResourceUrl(
  manifestUrl,
  resource,
  type,
  id,
  extra = ''
) {
  const url =
    new URL(manifestUrl);

  const slash =
    url.pathname.lastIndexOf('/');

  const directory =
    slash >= 0
      ? url.pathname.slice(
          0,
          slash + 1
        )
      : '/';

  let pathname =
    directory +
    encodeURIComponent(resource) +
    '/' +
    encodeURIComponent(type) +
    '/' +
    encodeURIComponent(id);

  if (extra) {
    pathname += '/' + extra;
  }

  pathname += '.json';

  url.pathname = pathname;
  url.search = '';
  url.hash = '';

  return url.toString();
}


/* =========================================================
   CINEMETA CATALOG URL
   ========================================================= */

function buildCatalogUrl(
  type,
  query = ''
) {
  const url =
    new URL(CINEMETA);

  const suffix =
    query
      ? '/search=' +
        encodeURIComponent(query)
      : '';

  url.pathname =
    '/catalog/' +
    encodeURIComponent(type) +
    '/top' +
    suffix +
    '.json';

  url.search = '';
  url.hash = '';

  return url.toString();
}


/* =========================================================
   ADDON CONFIG
   ========================================================= */

function parseAddonConfig() {
  const raw =
    process.env.STREMIO_ADDONS;

  if (!raw) {
    return DEFAULT_ADDONS
      .slice(0, MAX_ADDONS);
  }

  try {
    const parsed =
      JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error(
        'STREMIO_ADDONS must be a JSON array'
      );
    }

    const result =
      parsed
        .map((item, index) => {
          if (
            typeof item === 'string'
          ) {
            return {
              name:
                `Addon ${index + 1}`,
              url: item,
              priority: 0
            };
          }

          return {
            name:
              String(
                item?.name ||
                `Addon ${index + 1}`
              ),

            url:
              String(
                item?.url || ''
              ),

            priority:
              Number(
                item?.priority || 0
              )
          };
        })
        .filter(
          item =>
            /^https?:\/\//i.test(
              item.url
            )
        )
        .slice(0, MAX_ADDONS);

    return result.length
      ? result
      : DEFAULT_ADDONS
          .slice(0, MAX_ADDONS);
  } catch (error) {
    console.error(
      'Invalid STREMIO_ADDONS:',
      error.message
    );

    return DEFAULT_ADDONS
      .slice(0, MAX_ADDONS);
  }
}


/* =========================================================
   ADDON REGISTRY
   ========================================================= */

class AddonRegistry {
  constructor(definitions) {
    this.definitions =
      definitions;

    this.addons = [];

    this.refreshPromise =
      null;

    this.lastRefresh = 0;
  }

  async refresh(force = false) {
    if (
      !force &&
      this.addons.length > 0 &&
      Date.now() -
        this.lastRefresh <
        ADDON_CACHE_MS
    ) {
      return this.addons;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise =
      (async () => {
        const results =
          await mapLimit(
            this.definitions,
            FETCH_CONCURRENCY,
            async definition => {
              const result =
                await fetchJson(
                  definition.url,
                  MANIFEST_TIMEOUT
                );

              if (
                !result.ok ||
                !result.data ||
                typeof result.data !==
                  'object'
              ) {
                return {
                  ...definition,

                  online: false,

                  manifest: null,

                  resources: [],

                  error:
                    `HTTP ${result.status}`
                };
              }

              return {
                ...definition,

                online: true,

                manifest:
                  result.data,

                resources:
                  normalizeResources(
                    result.data
                  ),

                error: null
              };
            }
          );

        this.addons =
          results.filter(Boolean);

        this.lastRefresh =
          Date.now();

        this.refreshPromise =
          null;

        return this.addons;
      })();

    return this.refreshPromise;
  }

  relevant(
    resource,
    type,
    id
  ) {
    return this.addons.filter(
      addon => {
        if (
          !addon.online ||
          !addon.manifest
        ) {
          return false;
        }

        return resourceSupports(
          addon.manifest,
          resource,
          type,
          id
        );
      }
    );
  }
}


const registry =
  new AddonRegistry(
    parseAddonConfig()
  );


/* =========================================================
   METADATA
   ========================================================= */

function normalizeMeta(meta) {
  if (
    !meta ||
    typeof meta !== 'object' ||
    typeof meta.id !== 'string' ||
    typeof meta.name !== 'string' ||
    typeof meta.type !== 'string'
  ) {
    return null;
  }

  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,

    poster:
      meta.poster || null,

    background:
      meta.background || null,

    logo:
      meta.logo || null,

    description:
      meta.description || '',

    year:
      meta.year ||
      meta.releaseInfo ||
      null,

    genres:
      asArray(meta.genres),

    runtime:
      meta.runtime || null,

    videos:
      asArray(meta.videos)
        .filter(
          video =>
            video &&
            typeof video.id === 'string'
        )
        .map(video => ({
          ...video,
          id: video.id,

          season:
            Number.isFinite(
              Number(video.season)
            )
              ? Number(video.season)
              : null,

          episode:
            Number.isFinite(
              Number(video.episode)
            )
              ? Number(video.episode)
              : null,

          title:
            video.title ||
            video.name ||
            ''
        }))
  };
}


function extractMetas(payload) {
  if (!payload) {
    return [];
  }

  const value =
    payload.meta;

  if (Array.isArray(value)) {
    return value
      .map(normalizeMeta)
      .filter(Boolean);
  }

  if (value) {
    const normalized =
      normalizeMeta(value);

    return normalized
      ? [normalized]
      : [];
  }

  return [];
}


function chooseMeta(metas) {
  const normalized =
    metas
      .map(normalizeMeta)
      .filter(Boolean);

  if (!normalized.length) {
    return null;
  }

  normalized.sort(
    (a, b) =>
      b.videos.length -
      a.videos.length
  );

  return normalized[0];
}


/* =========================================================
   CINEMETA
   ========================================================= */

async function cinemetaCatalog(
  type,
  query = ''
) {
  const url =
    buildCatalogUrl(
      type,
      query
    );

  return fetchJson(
    url,
    META_TIMEOUT
  );
}


async function getLibrary() {
  const cached =
    cache.get('library');

  if (cached) {
    return cached;
  }

  const [
    movies,
    series
  ] = await Promise.all([
    cinemetaCatalog('movie'),
    cinemetaCatalog('series')
  ]);

  const all = [
    ...asArray(
      movies?.data?.metas
    ),
    ...asArray(
      series?.data?.metas
    )
  ]
    .map(normalizeMeta)
    .filter(Boolean);

  const seen =
    new Set();

  const result = [];

  for (const meta of all) {
    const key =
      `${meta.type}:${meta.id}`;

    if (seen.has(key)) {
      continue;
    }

    if (!meta.poster) {
      continue;
    }

    seen.add(key);
    result.push(meta);

    if (result.length >= 120) {
      break;
    }
  }

  cache.set(
    'library',
    result,
    CATALOG_CACHE_MS
  );

  return result;
}


async function searchLibrary(query) {
  const cacheKey =
    'search:' +
    query.toLowerCase();

  const cached =
    cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const [
    movies,
    series
  ] = await Promise.all([
    cinemetaCatalog(
      'movie',
      query
    ),
    cinemetaCatalog(
      'series',
      query
    )
  ]);

  const all = [
    ...asArray(
      movies?.data?.metas
    ),
    ...asArray(
      series?.data?.metas
    )
  ]
    .map(normalizeMeta)
    .filter(Boolean);

  const seen =
    new Set();

  const result = [];

  for (const meta of all) {
    const key =
      `${meta.type}:${meta.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(meta);

    if (result.length >= 80) {
      break;
    }
  }

  cache.set(
    cacheKey,
    result,
    CATALOG_CACHE_MS
  );

  return result;
}


async function getMeta(
  type,
  id
) {
  const key =
    `meta:${type}:${id}`;

  const cached =
    cache.get(key);

  if (cached) {
    return cached;
  }

  /*
   * First try Cinemeta.
   *
   * This gives us a consistent
   * metadata/episode source.
   */

  const url =
    buildResourceUrl(
      CINEMETA,
      'meta',
      type,
      id
    );

  const result =
    await fetchJson(
      url,
      META_TIMEOUT
    );

  if (
    result.ok &&
    result.data
  ) {
    const meta =
      chooseMeta(
        extractMetas(
          result.data
        )
      );

    if (meta) {
      cache.set(
        key,
        meta,
        META_CACHE_MS
      );

      return meta;
    }
  }

  /*
   * Fallback:
   * use another addon that
   * advertises meta support.
   */

  await registry.refresh();

  const candidates =
    registry.relevant(
      'meta',
      type,
      id
    );

  const responses =
    await mapLimit(
      candidates,
      FETCH_CONCURRENCY,
      async addon => {
        const metaUrl =
          buildResourceUrl(
            addon.url,
            'meta',
            type,
            id
          );

        const response =
          await fetchJson(
            metaUrl,
            META_TIMEOUT
          );

        if (
          !response.ok
        ) {
          return [];
        }

        return extractMetas(
          response.data
        );
      }
    );

  const meta =
    chooseMeta(
      responses
        .flat()
    );

  if (meta) {
    cache.set(
      key,
      meta,
      META_CACHE_MS
    );
  }

  return meta;
}


/* =========================================================
   STREAM NORMALIZATION
   ========================================================= */

function parseQuality(text) {
  const value =
    String(text || '')
      .toLowerCase();

  if (
    /2160p|4k/.test(value)
  ) {
    return 400;
  }

  if (
    /1440p/.test(value)
  ) {
    return 350;
  }

  if (
    /1080p/.test(value)
  ) {
    return 300;
  }

  if (
    /720p/.test(value)
  ) {
    return 200;
  }

  if (
    /576p/.test(value)
  ) {
    return 150;
  }

  if (
    /480p/.test(value)
  ) {
    return 100;
  }

  if (
    /360p/.test(value)
  ) {
    return 50;
  }

  return 0;
}


function classifyUrl(url) {
  if (
    !url ||
    typeof url !== 'string'
  ) {
    return 'unknown';
  }

  const value =
    url.toLowerCase();

  if (
    value.startsWith(
      'magnet:'
    )
  ) {
    return 'torrent';
  }

  if (
    /\.m3u8(?:$|[?#])/.test(
      value
    )
  ) {
    return 'hls';
  }

  return 'http';
}


function normalizeStream(
  stream,
  source,
  priority
) {
  if (
    !stream ||
    typeof stream !== 'object'
  ) {
    return null;
  }

  const hints =
    stream.behaviorHints &&
    typeof stream.behaviorHints ===
      'object'
      ? stream.behaviorHints
      : {};

  const rawUrl =
    typeof stream.url === 'string'
      ? stream.url
      : '';

  const infoHash =
    typeof stream.infoHash === 'string'
      ? stream.infoHash
      : typeof stream.infohash === 'string'
        ? stream.infohash
        : null;

  const ytId =
    typeof stream.ytId === 'string'
      ? stream.ytId
      : typeof stream.yt_id === 'string'
        ? stream.yt_id
        : null;

  const externalUrl =
    typeof stream.externalUrl === 'string'
      ? stream.externalUrl
      : null;

  let kind =
    'unknown';

  let url =
    null;

  /*
   * Direct HTTP/HTTPS stream.
   */

  if (
    /^https?:\/\//i.test(
      rawUrl
    )
  ) {
    url = rawUrl;
    kind =
      classifyUrl(
        rawUrl
      );
  }

  /*
   * Magnet or infoHash.
   */

  else if (
    /^magnet:/i.test(
      rawUrl
    ) ||
    infoHash
  ) {
    kind =
      'torrent';
  }

  /*
   * YouTube.
   */

  else if (ytId) {
    kind =
      'youtube';
  }

  /*
   * External player.
   */

  else if (externalUrl) {
    kind =
      'external';
  }

  /*
   * Stremio can return other
   * structures. Ignore unsupported
   * structures rather than exposing
   * broken buttons.
   */

  else {
    return null;
  }

  const filename =
    typeof hints.filename ===
      'string'
      ? hints.filename
      : null;

  const title =
    String(
      stream.title ||
      stream.name ||
      filename ||
      'Stream'
    );

  const quality =
    parseQuality(
      [
        title,
        stream.description,
        filename
      ]
        .filter(Boolean)
        .join(' ')
    );

  /*
   * Build magnet URL when the
   * addon gives us an infoHash.
   */

  let magnetUrl =
    null;

  if (
    /^magnet:/i.test(
      rawUrl
    )
  ) {
    magnetUrl =
      rawUrl;
  }

  else if (infoHash) {
    const params =
      new URLSearchParams();

    if (filename) {
      params.set(
        'dn',
        filename
      );
    }

    for (
      const tracker of
      asArray(stream.announce)
    ) {
      if (
        typeof tracker ===
        'string' &&
        tracker
      ) {
        params.append(
          'tr',
          tracker
        );
      }
    }

    magnetUrl =
      `magnet:?xt=urn:btih:${encodeURIComponent(infoHash)}`;

    const query =
      params.toString();

    if (query) {
      magnetUrl +=
        '&' + query;
    }
  }

  const proxyHeaders =
    hints.proxyHeaders?.request &&
    typeof hints.proxyHeaders.request ===
      'object'
      ? hints.proxyHeaders.request
      : {};

  const subtitles =
    asArray(
      stream.subtitles
    )
      .filter(
        subtitle =>
          subtitle &&
          typeof subtitle.url ===
            'string'
      )
      .slice(0, 30);

  return {
    source,

    priority:
      Number(priority || 0),

    kind,

    title,

    description:
      stream.description ||
      '',

    url,

    ytId,

    externalUrl,

    infoHash,

    fileIdx:
      Number.isInteger(
        stream.fileIdx
      )
        ? stream.fileIdx
        : null,

    magnetUrl,

    filename,

    quality,

    videoSize:
      Number.isFinite(
        Number(
          hints.videoSize
        )
      )
        ? Number(
            hints.videoSize
          )
        : null,

    videoHash:
      hints.videoHash ||
      null,

    notWebReady:
      Boolean(
        hints.notWebReady
      ),

    bingeGroup:
      hints.bingeGroup ||
      null,

    subtitles,

    proxyHeaders
  };
}


/* =========================================================
   STREAM RANKING
   ========================================================= */

function rankStream(stream) {
  const priority =
    Number(
      stream.priority || 0
    );

  const quality =
    Number(
      stream.quality || 0
    );

  const webReady =
    stream.notWebReady
      ? 0
      : 100;

  const sizeBonus =
    stream.videoSize
      ? Math.min(
          stream.videoSize /
            1e9,
          10
        )
      : 0;

  return (
    priority * 1000 +
    quality * 10 +
    webReady +
    sizeBonus
  );
}


function streamKey(stream) {
  if (stream.url) {
    return (
      'url:' +
      stream.url
    );
  }

  if (stream.infoHash) {
    return (
      'torrent:' +
      String(
        stream.infoHash
      ).toLowerCase() +
      ':' +
      String(
        stream.fileIdx ?? ''
      )
    );
  }

  if (stream.ytId) {
    return (
      'youtube:' +
      stream.ytId
    );
  }

  if (stream.externalUrl) {
    return (
      'external:' +
      stream.externalUrl
    );
  }

  return (
    'other:' +
    stream.source +
    ':' +
    stream.title
  );
}


function dedupeStreams(
  streams
) {
  const best =
    new Map();

  for (
    const stream of streams
  ) {
    const key =
      streamKey(stream);

    const existing =
      best.get(key);

    if (
      !existing ||
      rankStream(stream) >
        rankStream(existing)
    ) {
      best.set(
        key,
        stream
      );
    }
  }

  return [
    ...best.values()
  ]
    .sort(
      (a, b) =>
        rankStream(b) -
        rankStream(a)
    )
    .slice(0, 100);
}


/* =========================================================
   PLAYBACK TOKENS
   ========================================================= */

function issuePlaybackToken(
  target
) {
  const token =
    crypto.randomBytes(
      24
    ).toString(
      'base64url'
    );

  tokenCache.set(
    token,
    target,
    TOKEN_TTL_MS
  );

  return token;
}


/* =========================================================
   SSRF PROTECTION
   ========================================================= */

function isPrivateIp(
  address
) {
  const version =
    net.isIP(address);

  if (version === 4) {
    const [
      a,
      b
    ] =
      address
        .split('.')
        .map(Number);

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (
        a === 169 &&
        b === 254
      ) ||
      (
        a === 172 &&
        b >= 16 &&
        b <= 31
      ) ||
      (
        a === 192 &&
        b === 168
      )
    );
  }

  if (version === 6) {
    const value =
      address.toLowerCase();

    return (
      value === '::' ||
      value === '::1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe80:')
    );
  }

  return true;
}


async function isPublicUrl(
  rawUrl
) {
  try {
    const url =
      new URL(rawUrl);

    if (
      ![
        'http:',
        'https:'
      ].includes(
        url.protocol
      )
    ) {
      return false;
    }

    const hostname =
      url.hostname.toLowerCase();

    if (
      hostname ===
        'localhost' ||
      hostname.endsWith(
        '.localhost'
      ) ||
      hostname.endsWith(
        '.local'
      )
    ) {
      return false;
    }

    if (
      net.isIP(hostname)
    ) {
      return !isPrivateIp(
        hostname
      );
    }

    const addresses =
      await dns.lookup(
        hostname,
        {
          all: true
        }
      );

    if (!addresses.length) {
      return false;
    }

    return addresses.every(
      item =>
        !isPrivateIp(
          item.address
        )
    );
  } catch {
    return false;
  }
}


/* =========================================================
   UPSTREAM FETCH
   ========================================================= */

function absoluteUrl(
  base,
  value
) {
  try {
    return new URL(
      value,
      base
    ).toString();
  } catch {
    return null;
  }
}


async function fetchUpstream(
  url,
  headers = {}
) {
  let current =
    url;

  for (
    let redirect = 0;
    redirect <= 6;
    redirect++
  ) {
    if (
      !(await isPublicUrl(
        current
      ))
    ) {
      throw new Error(
        'Blocked upstream address'
      );
    }

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        PROXY_TIMEOUT
      );

    let response;

    try {
      response =
        await fetch(
          current,
          {
            method: 'GET',
            headers,
            redirect: 'manual',
            signal:
              controller.signal
          }
        );
    } finally {
      clearTimeout(timer);
    }

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      const location =
        response.headers.get(
          'location'
        );

      const next =
        location
          ? absoluteUrl(
              current,
              location
            )
          : null;

      if (!next) {
        throw new Error(
          'Invalid redirect'
        );
      }

      current =
        next;

      continue;
    }

    return response;
  }

  throw new Error(
    'Too many redirects'
  );
}


/* =========================================================
   HLS REWRITING
   ========================================================= */

function rewriteHls(
  text,
  baseUrl,
  headers
) {
  const lines =
    String(text)
      .split(/\r?\n/);

  return lines
    .map(line => {
      /*
       * URI="..." occurs on HLS
       * key/map/media-tag lines.
       */

      const uriMatch =
        line.match(
          /URI="([^"]+)"/i
        );

      if (uriMatch) {
        const absolute =
          absoluteUrl(
            baseUrl,
            uriMatch[1]
          );

        if (
          absolute &&
          /^https?:\/\//i.test(
            absolute
          )
        ) {
          const token =
            issuePlaybackToken({
              url: absolute,
              headers
            });

          return line.replace(
            uriMatch[1],
            `/api/play/${token}`
          );
        }

        return line;
      }

      const trimmed =
        line.trim();

      /*
       * Normal playlist segment/
       * child playlist URL.
       */

      if (
        trimmed &&
        !trimmed.startsWith('#')
      ) {
        const absolute =
          absoluteUrl(
            baseUrl,
            trimmed
          );

        if (
          absolute &&
          /^https?:\/\//i.test(
            absolute
          )
        ) {
          const token =
            issuePlaybackToken({
              url: absolute,
              headers
            });

          return (
            `/api/play/${token}`
          );
        }
      }

      return line;
    })
    .join('\n');
}


/* =========================================================
   PLAYBACK PROXY
   ========================================================= */

async function proxyPlay(
  req,
  res
) {
  const token =
    safeQuery(
      req.params.token,
      200
    );

  if (!token) {
    return res
      .status(400)
      .send(
        'Invalid playback token'
      );
  }

  const target =
    tokenCache.get(
      token
    );

  if (
    !target ||
    !target.url
  ) {
    return res
      .status(404)
      .send(
        'Playback token expired or invalid'
      );
  }

  const headers = {
    'user-agent':
      'AniStream/4.0'
  };

  /*
   * Forward addon-requested headers
   * such as Referer/Origin when supplied
   * through Stremio behaviorHints.
   */

  for (
    const [
      key,
      value
    ] of Object.entries(
      target.headers || {}
    )
  ) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(
        key
      )
    ) {
      continue;
    }

    if (
      typeof value !== 'string'
    ) {
      continue;
    }

    if (
      value.length > 4096
    ) {
      continue;
    }

    headers[key] =
      value;
  }

  /*
   * Browser range requests are essential
   * for seeking in MP4/video files.
   */

  for (
    const key of [
      'range',
      'if-range',
      'if-none-match',
      'if-modified-since'
    ]
  ) {
    if (
      typeof req.headers[key] ===
      'string'
    ) {
      headers[key] =
        req.headers[key];
    }
  }

  try {
    const upstream =
      await fetchUpstream(
        target.url,
        headers
      );

    if (
      !upstream.ok &&
      upstream.status !== 206 &&
      upstream.status !== 304
    ) {
      return res
        .status(
          upstream.status
        )
        .send(
          `Upstream returned ${upstream.status}`
        );
    }

    const contentType =
      (
        upstream.headers.get(
          'content-type'
        ) || ''
      ).toLowerCase();

    const isHls =
      contentType.includes(
        'mpegurl'
      ) ||
      /\.m3u8(?:$|[?#])/i.test(
        target.url
      );

    /*
     * CORS headers.
     */

    res.setHeader(
      'access-control-allow-origin',
      '*'
    );

    res.setHeader(
      'access-control-allow-headers',
      '*'
    );

    res.setHeader(
      'access-control-expose-headers',
      [
        'Content-Length',
        'Content-Range',
        'Accept-Ranges',
        'Content-Type',
        'ETag'
      ].join(', ')
    );

    /*
     * HLS must be rewritten because
     * segments/sub-playlists would otherwise
     * point directly at the upstream server.
     */

    if (isHls) {
      const text =
        await upstream.text();

      const body =
        rewriteHls(
          text,
          upstream.url ||
            target.url,
          headers
        );

      res.status(
        upstream.status
      );

      res.setHeader(
        'content-type',
        'application/vnd.apple.mpegurl'
      );

      res.setHeader(
        'cache-control',
        'no-store'
      );

      return res.send(
        body
      );
    }

    /*
     * Forward normal media headers.
     */

    for (
      const key of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
        'cache-control',
        'expires',
        'vary'
      ]
    ) {
      const value =
        upstream.headers.get(
          key
        );

      if (value) {
        res.setHeader(
          key,
          value
        );
      }
    }

    res.status(
      upstream.status
    );

    if (
      upstream.body
    ) {
      Readable
        .fromWeb(
          upstream.body
        )
        .pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) {
      res
        .status(502)
        .send(
          error.message ||
          'Playback failed'
        );
    } else {
      res.end();
    }
  }
}


/* =========================================================
   STREAM API
   ========================================================= */

async function getStreams(
  type,
  id
) {
  const cacheKey =
    `streams:${type}:${id}`;

  const cached =
    cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  await registry.refresh();

  /*
   * THIS IS THE IMPORTANT PART:
   *
   * We only ask addons whose manifests
   * actually advertise:
   *
   * resource = stream
   * type = requested type
   * id prefix = compatible with requested ID
   */

  const candidates =
    registry.relevant(
      'stream',
      type,
      id
    );

  const responses =
    await mapLimit(
      candidates,
      FETCH_CONCURRENCY,
      async addon => {
        const streamUrl =
          buildResourceUrl(
            addon.url,
            'stream',
            type,
            id
          );

        const result =
          await fetchJson(
            streamUrl,
            STREAM_TIMEOUT
          );

        if (
          !result.ok ||
          !Array.isArray(
            result.data?.streams
          )
        ) {
          return [];
        }

        return result.data.streams
          .map(
            stream =>
              normalizeStream(
                stream,

                addon.manifest
                  ?.name ||
                  addon.name,

                addon.priority
              )
          )
          .filter(Boolean);
      }
    );

  const normalized =
    responses
      .flat()
      .filter(Boolean);

  const deduped =
    dedupeStreams(
      normalized
    );

  /*
   * Turn direct HTTP/HLS URLs into
   * short-lived server-side playback tokens.
   *
   * The actual upstream URL is not exposed
   * directly to the browser.
   */

  const output =
    deduped
      .slice(0, 100)
      .map(stream => {
        const item =
          {
            ...stream
          };

        delete item.proxyHeaders;

        if (
          stream.url
        ) {
          const token =
            issuePlaybackToken({
              url:
                stream.url,

              headers:
                stream.proxyHeaders
            });

          item.playToken =
            token;

          item.playUrl =
            `/api/play/${token}`;
        }

        /*
         * Don't expose internal Stremio
         * response structures.
         */

        return item;
      });

  cache.set(
    cacheKey,
    output,
    STREAM_CACHE_MS
  );

  return output;
}


/* =========================================================
   SUBTITLE EXTRACTION
   ========================================================= */

function normalizeSubtitle(
  subtitle,
  source
) {
  if (
    !subtitle ||
    typeof subtitle !==
      'object'
  ) {
    return null;
  }

  if (
    typeof subtitle.url !==
      'string'
  ) {
    return null;
  }

  return {
    id:
      subtitle.id ||
      null,

    url:
      subtitle.url,

    lang:
      subtitle.lang ||
      subtitle.language ||
      'Unknown',

    label:
      subtitle.label ||
      subtitle.lang ||
      'Subtitle',

    source
  };
}


async function getSubtitles(
  type,
  id
) {
  await registry.refresh();

  const candidates =
    registry.relevant(
      'subtitles',
      type,
      id
    );

  const responses =
    await mapLimit(
      candidates,
      FETCH_CONCURRENCY,
      async addon => {
        const url =
          buildResourceUrl(
            addon.url,
            'subtitles',
            type,
            id
          );

        const result =
          await fetchJson(
            url,
            STREAM_TIMEOUT
          );

        if (
          !result.ok ||
          !Array.isArray(
            result.data?.subtitles
          )
        ) {
          return [];
        }

        const source =
          addon.manifest
            ?.name ||
          addon.name;

        return result.data
          .subtitles
          .map(
            subtitle =>
              normalizeSubtitle(
                subtitle,
                source
              )
          )
          .filter(Boolean);
      }
    );

  const seen =
    new Set();

  const output = [];

  for (
    const subtitle of
    responses.flat()
  ) {
    const key =
      subtitle.url;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    output.push(
      subtitle
    );

    if (
      output.length >= 100
    ) {
      break;
    }
  }

  return output;
}


/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(
  (req, res, next) => {
    res.setHeader(
      'x-content-type-options',
      'nosniff'
    );

    res.setHeader(
      'referrer-policy',
      'no-referrer'
    );

    next();
  }
);


/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  '/healthz',
  async (req, res) => {
    try {
      await registry.refresh();

      const online =
        registry.addons.filter(
          addon =>
            addon.online
        ).length;

      res.json({
        ok: true,

        onlineAddons:
          online,

        totalAddons:
          registry.addons.length,

        timestamp:
          new Date().toISOString()
      });
    } catch (error) {
      res
        .status(503)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);


/* =========================================================
   ADDON STATUS
   ========================================================= */

app.get(
  '/api/addons',
  async (req, res) => {
    await registry.refresh();

    res.json({
      refreshedAt:
        registry.lastRefresh,

      addons:
        registry.addons.map(
          addon => ({
            configuredName:
              addon.name,

            name:
              addon.manifest
                ?.name ||
              addon.name,

            id:
              addon.manifest
                ?.id ||
              null,

            version:
              addon.manifest
                ?.version ||
              null,

            description:
              addon.manifest
                ?.description ||
              null,

            online:
              addon.online,

            manifestUrl:
              addon.url,

            resources:
              addon.resources,

            types:
              asArray(
                addon.manifest
                  ?.types
              ),

            idPrefixes:
              addon.manifest
                ?.idPrefixes ||
              null,

            configurable:
              Boolean(
                addon.manifest
                  ?.behaviorHints
                  ?.configurable
              ),

            configurationRequired:
              Boolean(
                addon.manifest
                  ?.behaviorHints
                  ?.configurationRequired
              ),

            error:
              addon.error
          })
        )
    });
  }
);


/* =========================================================
   LIBRARY
   ========================================================= */

app.get(
  '/api/library',
  async (req, res) => {
    try {
      const library =
        await getLibrary();

      res.json(
        library
      );
    } catch (error) {
      console.error(
        '/api/library:',
        error
      );

      res
        .status(502)
        .json({
          error:
            'Failed to load library'
        });
    }
  }
);


/* =========================================================
   SEARCH
   ========================================================= */

app.get(
  '/api/search',
  async (req, res) => {
    const query =
      safeQuery(
        req.query.q,
        100
      );

    if (!query) {
      return res
        .status(400)
        .json({
          error:
            'Invalid search query'
        });
    }

    try {
      const results =
        await searchLibrary(
          query
        );

      res.json(
        results
      );
    } catch (error) {
      console.error(
        '/api/search:',
        error
      );

      res
        .status(502)
        .json({
          error:
            'Search failed'
        });
    }
  }
);


/* =========================================================
   METADATA
   ========================================================= */

app.get(
  '/api/meta',
  async (req, res) => {
    const type =
      safeQuery(
        req.query.type,
        20
      );

    const id =
      safeQuery(
        req.query.id,
        500
      );

    if (
      !type ||
      !validType(type) ||
      !id
    ) {
      return res
        .status(400)
        .json({
          error:
            'Invalid type or id'
        });
    }

    try {
      const meta =
        await getMeta(
          type,
          id
        );

      if (!meta) {
        return res
          .status(404)
          .json({
            error:
              'Metadata not found'
          });
      }

      res.json(
        meta
      );
    } catch (error) {
      console.error(
        '/api/meta:',
        error
      );

      res
        .status(502)
        .json({
          error:
            'Metadata request failed'
        });
    }
  }
);


/* =========================================================
   STREAMS
   ========================================================= */

app.get(
  '/api/streams',
  async (req, res) => {
    const type =
      safeQuery(
        req.query.type,
        20
      );

    const id =
      safeQuery(
        req.query.id,
        500
      );

    if (
      !type ||
      !validType(type) ||
      !id
    ) {
      return res
        .status(400)
        .json({
          error:
            'Invalid type or id'
        });
    }

    try {
      const streams =
        await getStreams(
          type,
          id
        );

      res.json(
        streams
      );
    } catch (error) {
      console.error(
        '/api/streams:',
        error
      );

      res
        .status(502)
        .json({
          error:
            'Stream aggregation failed'
        });
    }
  }
);


/* =========================================================
   SUBTITLES
   ========================================================= */

app.get(
  '/api/subtitles',
  async (req, res) => {
    const type =
      safeQuery(
        req.query.type,
        20
      );

    const id =
      safeQuery(
        req.query.id,
        500
      );

    if (
      !type ||
      !validType(type) ||
      !id
    ) {
      return res
        .status(400)
        .json({
          error:
            'Invalid type or id'
        });
    }

    try {
      const subtitles =
        await getSubtitles(
          type,
          id
        );

      res.json(
        subtitles
      );
    } catch (error) {
      console.error(
        '/api/subtitles:',
        error
      );

      res
        .status(502)
        .json({
          error:
            'Subtitle request failed'
        });
    }
  }
);


/* =========================================================
   PLAYBACK
   ========================================================= */

app.options(
  '/api/play/:token',
  (req, res) => {
    res.setHeader(
      'access-control-allow-origin',
      '*'
    );

    res.setHeader(
      'access-control-allow-headers',
      '*'
    );

    res.setHeader(
      'access-control-allow-methods',
      'GET,OPTIONS'
    );

    res.status(204).end();
  }
);


app.get(
  '/api/play/:token',
  proxyPlay
);


/*
 * Deliberately do NOT provide an arbitrary
 * URL proxy endpoint.
 *
 * Playback is only possible through tokens
 * generated from addon stream results.
 */

app.get(
  '/api/proxy',
  (req, res) => {
    res
      .status(410)
      .json({
        error:
          'Removed',

        message:
          'Arbitrary URL proxying is disabled.'
      });
  }
);


/* =========================================================
   FRONTEND
   ========================================================= */

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<meta
  name="color-scheme"
  content="dark"
>

<title>AniStream</title>

<script src="https://cdn.tailwindcss.com"></script>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<style>

html,
body {
  margin: 0;
  padding: 0;
  background: #07070b;
  color: #eeeeee;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

body {
  min-height: 100vh;
}

.card {
  transition:
    transform .18s ease,
    border-color .18s ease,
    box-shadow .18s ease;
}

.card:hover {
  transform: translateY(-4px);
  border-color: rgba(239,68,68,.35);
  box-shadow:
    0 15px 40px
    rgba(0,0,0,.35);
}

.fade {
  background:
    linear-gradient(
      180deg,
      transparent 15%,
      rgba(7,7,11,.3) 45%,
      #07070b 100%
    );
}

.scroll {
  scrollbar-width: none;
}

.scroll::-webkit-scrollbar {
  display: none;
}

.badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  font-size: 10px;
  font-weight: 800;

  padding:
    3px 7px;

  border-radius:
    999px;
}

.skel {
  background:
    linear-gradient(
      90deg,
      #14141d,
      #242432,
      #14141d
    );

  background-size:
    200% 100%;

  animation:
    skeleton 1.4s linear infinite;
}

@keyframes skeleton {
  0% {
    background-position:
      200% 0;
  }

  100% {
    background-position:
      -200% 0;
  }
}

.modal-backdrop {
  background:
    rgba(0,0,0,.82);

  backdrop-filter:
    blur(12px);
}

</style>

</head>

<body>

<header
  class="
    sticky
    top-0
    z-40
    border-b
    border-white/10
    bg-[#07070b]/90
    backdrop-blur-xl
  "
>

<div
  class="
    mx-auto
    flex
    max-w-7xl
    items-center
    gap-3
    px-4
    py-3
    md:px-8
  "
>

<div class="shrink-0 font-black text-lg">
  Ani<span class="text-red-500">Stream</span>
</div>

<input
  id="search"
  type="search"
  autocomplete="off"
  class="
    mx-auto
    w-full
    max-w-xl
    rounded-full
    border
    border-white/10
    bg-white/5
    px-4
    py-2
    text-sm
    outline-none
    focus:border-red-500
  "
  placeholder="Search anime, series or movies..."
>

<button
  id="addons"
  class="
    hidden
    rounded-full
    border
    border-white/10
    bg-white/5
    px-3
    py-2
    text-xs
    sm:block
  "
>
  Addons
</button>

<span
  id="status"
  class="
    hidden
    text-xs
    text-gray-500
    md:block
  "
>
  Starting...
</span>

</div>

</header>


<main
  class="
    mx-auto
    max-w-7xl
    px-4
    py-5
    md:px-8
  "
>

<section
  id="hero"
  class="
    relative
    mb-8
    h-[38vh]
    min-h-[280px]
    overflow-hidden
    rounded-2xl
    skel
  "
>
</section>


<div class="mb-5">

<div
  class="
    text-xs
    uppercase
    tracking-[.2em]
    text-red-400
  "
>
  AniStream
</div>

<h1
  id="heading"
  class="
    mt-1
    text-2xl
    font-black
  "
>
  Trending
</h1>

</div>


<section
  id="grid"
  class="
    grid
    grid-cols-2
    gap-4
    sm:grid-cols-3
    md:grid-cols-4
    lg:grid-cols-5
    xl:grid-cols-6
  "
>
</section>

</main>


<!-- ITEM MODAL -->

<div
  id="modal"
  class="
    modal-backdrop
    fixed
    inset-0
    z-50
    hidden
    items-center
    justify-center
    overflow-y-auto
    p-3
  "
>

<div
  class="
    my-4
    w-full
    max-w-6xl
    overflow-hidden
    rounded-2xl
    border
    border-white/10
    bg-[#0d0d13]
    shadow-2xl
  "
>

<div
  class="
    flex
    items-center
    justify-between
    border-b
    border-white/10
    p-4
  "
>

<div>

<div
  id="mt"
  class="font-semibold"
>
</div>

<div
  id="ms"
  class="text-xs text-gray-500"
>
</div>

</div>

<button
  id="close"
  class="
    h-9
    w-9
    rounded-full
    bg-white/10
    text-lg
  "
>
  ×
</button>

</div>


<div
  class="
    grid
    md:grid-cols-[260px,1fr]
  "
>

<aside
  class="
    border-b
    border-white/10
    p-4
    md:border-b-0
    md:border-r
  "
>

<img
  id="poster"
  class="
    aspect-[2/3]
    w-full
    rounded-xl
    object-cover
  "
  alt=""
>

<h2
  id="title"
  class="
    mt-4
    text-2xl
    font-black
  "
>
</h2>

<div
  id="badges"
  class="
    mt-3
    flex
    flex-wrap
    gap-2
  "
>
</div>

<p
  id="desc"
  class="
    mt-3
    text-sm
    leading-6
    text-gray-400
  "
>
</p>

</aside>


<section
  class="
    min-w-0
    p-4
  "
>


<div
  id="playerWrap"
  class="
    mb-4
    hidden
    overflow-hidden
    rounded-xl
    border
    border-white/10
    bg-black
  "
>

<video
  id="player"
  class="
    aspect-video
    w-full
  "
  controls
  playsinline
  preload="metadata"
></video>

<div
  id="playerInfo"
  class="
    border-t
    border-white/10
    px-3
    py-2
    text-xs
    text-gray-400
  "
>
</div>

</div>


<!-- EPISODES -->

<div
  id="episodesWrap"
  class="mb-4 hidden"
>

<div
  class="
    mb-2
    flex
    items-center
    justify-between
  "
>

<h3 class="font-bold">
  Episodes
</h3>

<span
  id="episodeCount"
  class="text-xs text-gray-500"
>
</span>

</div>


<div
  id="episodes"
  class="
    scroll
    grid
    max-h-72
    grid-cols-2
    gap-2
    overflow-y-auto
    sm:grid-cols-3
    md:grid-cols-4
  "
>
</div>

</div>


<!-- STREAMS -->

<div
  class="
    flex
    items-center
    justify-between
  "
>

<div>

<h3 class="font-bold">
  Streams
</h3>

<div
  id="streamStatus"
  class="text-xs text-gray-500"
>
</div>

</div>


<button
  id="refresh"
  class="
    rounded-full
    border
    border-white/10
    bg-white/5
    px-3
    py-2
    text-xs
  "
>
  Refresh
</button>

</div>


<div
  id="streams"
  class="mt-3 space-y-2"
>
</div>

</section>

</div>

</div>

</div>


<!-- ADDON MODAL -->

<div
  id="addonsModal"
  class="
    modal-backdrop
    fixed
    inset-0
    z-[60]
    hidden
    items-center
    justify-center
    p-4
  "
>

<div
  class="
    w-full
    max-w-5xl
    overflow-hidden
    rounded-2xl
    border
    border-white/10
    bg-[#0d0d13]
  "
>

<div
  class="
    flex
    items-center
    justify-between
    border-b
    border-white/10
    p-4
  "
>

<h2 class="font-bold">
  Stremio Addons
</h2>

<button
  id="addonsClose"
  class="
    h-9
    w-9
    rounded-full
    bg-white/10
  "
>
  ×
</button>

</div>

<div
  id="addonList"
  class="
    scroll
    max-h-[75vh]
    overflow-y-auto
  "
>
</div>

</div>

</div>


<script>

(() => {

  const $ =
    selector =>
      document.querySelector(
        selector
      );


  const esc =
    value =>
      String(
        value ?? ''
      ).replace(
        /[&<>'"]/g,
        character =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
          }[
            character
          ])
      );


  const grid =
    $('#grid');

  const hero =
    $('#hero');

  const modal =
    $('#modal');

  const player =
    $('#player');


  let hls =
    null;

  let meta =
    null;

  let selectedVideo =
    null;

  let currentItem =
    null;

  let searchTimer =
    null;


  /* =====================================================
     API
     ===================================================== */

  async function json(
    url
  ) {
    const response =
      await fetch(
        url,
        {
          headers: {
            accept:
              'application/json'
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        'HTTP ' +
        response.status
      );
    }

    return response.json();
  }


  /* =====================================================
     BADGES
     ===================================================== */

  function badge(
    text,
    classes =
      'bg-white/10 text-gray-300'
  ) {
    return (
      '<span class="badge ' +
      classes +
      '">' +
      esc(text) +
      '</span>'
    );
  }


  /* =====================================================
     IMAGE FALLBACK
     ===================================================== */

  function fallback(
    image
  ) {
    image.onerror =
      null;

    image.src =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">' +
        '<rect width="100%" height="100%" fill="#171721"/>' +
        '<text x="50%" y="50%" fill="#777" text-anchor="middle" ' +
        'font-family="sans-serif" font-size="24">No Image</text>' +
        '</svg>'
      );
  }


  /* =====================================================
     RENDER CARDS
     ===================================================== */

  function render(
    items
  ) {
    grid.innerHTML =
      '';

    if (
      !items.length
    ) {
      grid.innerHTML =
        '<div class="col-span-full py-20 text-center text-gray-500">' +
        'No results.' +
        '</div>';

      return;
    }

    const fragment =
      document.createDocumentFragment();

    for (
      const item of items
    ) {
      const button =
        document.createElement(
          'button'
        );

      button.className =
        'card overflow-hidden rounded-xl border border-white/5 bg-white/[.03] text-left';

      button.innerHTML =
        '<img class="h-64 w-full object-cover" src="' +
        esc(
          item.poster ||
          ''
        ) +
        '" alt="" loading="lazy">' +

        '<div class="p-3">' +

        '<div class="truncate text-sm font-bold">' +
        esc(
          item.name
        ) +
        '</div>' +

        '<div class="mt-1 text-xs text-gray-500">' +
        esc(
          item.year ||
          ''
        ) +
        ' · ' +
        esc(
          item.type ||
          ''
        ) +
        '</div>' +

        '</div>';

      const image =
        button.querySelector(
          'img'
        );

      image.onerror =
        () =>
          fallback(
            image
          );

      button.onclick =
        () =>
          openItem(
            item
          );

      fragment.appendChild(
        button
      );
    }

    grid.appendChild(
      fragment
    );
  }


  /* =====================================================
     PLAYER CLEANUP
     ===================================================== */

  function cleanupPlayer() {

    if (hls) {
      try {
        hls.destroy();
      } catch (_) {}

      hls =
        null;
    }

    try {
      player.pause();
    } catch (_) {}

    player.removeAttribute(
      'src'
    );

    player.load();

    $('#playerWrap')
      .classList
      .add(
        'hidden'
      );

    $('#playerInfo')
      .textContent =
      '';

    player
      .querySelectorAll(
        'track'
      )
      .forEach(
        track =>
          track.remove()
      );
  }


  /* =====================================================
     PLAY STREAM
     ===================================================== */

  async function playStream(
    stream
  ) {
    cleanupPlayer();

    $('#playerWrap')
      .classList
      .remove(
        'hidden'
      );

    $('#playerInfo')
      .textContent =
      stream.source +
      ' · ' +
      (
        stream.title ||
        'Stream'
      );

    if (
      !stream.playUrl
    ) {
      return;
    }

    /*
     * HLS.
     */

    if (
      stream.kind ===
      'hls'
    ) {

      if (
        window.Hls &&
        Hls.isSupported()
      ) {

        hls =
          new Hls({
            enableWorker: true,

            lowLatencyMode:
              false,

            backBufferLength:
              90
          });

        hls.loadSource(
          stream.playUrl
        );

        hls.attachMedia(
          player
        );

        hls.on(
          Hls.Events.MANIFEST_PARSED,
          () => {
            player
              .play()
              .catch(
                () => {}
              );
          }
        );

        hls.on(
          Hls.Events.ERROR,
          (
            event,
            data
          ) => {
            if (
              data?.fatal
            ) {
              $('#playerInfo')
                .textContent =
                stream.source +
                ' · HLS playback error';
            }
          }
        );

      }

      /*
       * Safari/native HLS.
       */

      else if (
        player.canPlayType(
          'application/vnd.apple.mpegurl'
        )
      ) {

        player.src =
          stream.playUrl;

        player
          .play()
          .catch(
            () => {}
          );
      }

    }

    /*
     * Normal HTTP video.
     */

    else {

      player.src =
        stream.playUrl;

      player
        .play()
        .catch(
          () => {}
        );
    }

    $('#playerWrap')
      .scrollIntoView({
        behavior:
          'smooth',

        block:
          'center'
      });
  }


  /* =====================================================
     LOAD STREAMS
     ===================================================== */

  async function loadStreams() {

    if (
      !selectedVideo ||
      !meta
    ) {
      return;
    }

    $('#streamStatus')
      .textContent =
      'Querying compatible Stremio stream addons...';

    $('#streams')
      .innerHTML =
      '<div class="p-6 text-center text-gray-500">' +
      'Searching compatible addons...' +
      '</div>';

    try {

      const streams =
        await json(
          '/api/streams?type=' +
          encodeURIComponent(
            meta.type
          ) +
          '&id=' +
          encodeURIComponent(
            selectedVideo
          )
        );

      $('#streams')
        .innerHTML =
        '';

      $('#streamStatus')
        .textContent =
        streams.length +
        ' streams returned';

      if (
        !streams.length
      ) {
        $('#streams')
          .innerHTML =
          '<div class="p-6 text-center text-gray-500">' +
          'No stream was returned by the compatible addons for this episode.' +
          '</div>';

        return;
      }

      for (
        const stream of streams
      ) {

        const row =
          document.createElement(
            'div'
          );

        row.className =
          'rounded-xl border border-white/10 bg-white/[.025] p-3';

        const quality =
          stream.quality >= 400
            ? '4K'
            : stream.quality >= 300
              ? '1080p'
              : stream.quality >= 200
                ? '720p'
                : stream.kind.toUpperCase();

        row.innerHTML =
          '<div class="flex items-start gap-3">' +

          '<div class="min-w-0 flex-1">' +

          '<div class="truncate font-semibold text-sm">' +
          esc(
            stream.title
          ) +
          '</div>' +

          '<div class="mt-2 flex flex-wrap gap-2">' +

          badge(
            stream.source
          ) +

          badge(
            quality,
            'bg-blue-500/15 text-blue-200'
          ) +

          badge(
            stream.kind,
            'bg-white/5 text-gray-500'
          ) +

          (
            stream.filename
              ? badge(
                  stream.filename,
                  'bg-white/5 text-gray-500'
                )
              : ''
          ) +

          (
            stream.notWebReady
              ? badge(
                  'Not browser ready',
                  'bg-yellow-500/15 text-yellow-200'
                )
              : ''
          ) +

          '</div>' +

          '</div>' +

          '<div class="shrink-0"></div>' +

          '</div>';

        const actions =
          row.querySelector(
            '.shrink-0'
          );


        /*
         * Direct browser playback.
         */

        if (
          stream.playUrl
        ) {

          const button =
            document.createElement(
              'button'
            );

          button.className =
            'rounded-lg bg-red-600 px-3 py-2 text-xs font-black hover:bg-red-500';

          button.textContent =
            'PLAY';

          button.onclick =
            () =>
              playStream(
                stream
              );

          actions.appendChild(
            button
          );
        }


        /*
         * Magnet.
         */

        else if (
          stream.magnetUrl
        ) {

          const button =
            document.createElement(
              'button'
            );

          button.className =
            'rounded-lg bg-green-700 px-3 py-2 text-xs font-black';

          button.textContent =
            'MAGNET';

          button.onclick =
            async () => {
              try {
                await navigator
                  .clipboard
                  .writeText(
                    stream.magnetUrl
                  );

                button.textContent =
                  'COPIED';

                setTimeout(
                  () =>
                    button.textContent =
                      'MAGNET',
                  1200
                );
              } catch (_) {
                window.prompt(
                  'Magnet link:',
                  stream.magnetUrl
                );
              }
            };

          actions.appendChild(
            button
          );
        }


        /*
         * External player.
         */

        else if (
          stream.externalUrl
        ) {

          const link =
            document.createElement(
              'a'
            );

          link.className =
            'rounded-lg bg-white/10 px-3 py-2 text-xs font-black';

          link.textContent =
            'OPEN';

          link.href =
            stream.externalUrl;

          link.target =
            '_blank';

          link.rel =
            'noopener noreferrer';

          actions.appendChild(
            link
          );
        }


        $('#streams')
          .appendChild(
            row
          );
      }

    } catch (error) {

      $('#streamStatus')
        .textContent =
        'Stream request failed';

      $('#streams')
        .innerHTML =
        '<div class="p-6 text-center text-red-300">' +
        esc(
          error.message
        ) +
        '</div>';
    }
  }


  /* =====================================================
     OPEN ITEM
     ===================================================== */

  async function openItem(
    item
  ) {

    currentItem =
      item;

    cleanupPlayer();

    modal.classList
      .remove(
        'hidden'
      );

    modal.classList
      .add(
        'flex'
      );

    document.body.style.overflow =
      'hidden';

    $('#mt')
      .textContent =
      item.name;

    $('#ms')
      .textContent =
      'Loading metadata...';

    $('#poster')
      .src =
      item.poster ||
      '';

    $('#poster')
      .onerror =
      () =>
        fallback(
          $('#poster')
        );

    $('#title')
      .textContent =
      item.name;

    $('#desc')
      .textContent =
      item.description ||
      '';

    $('#streams')
      .innerHTML =
      '';

    try {

      meta =
        await json(
          '/api/meta?type=' +
          encodeURIComponent(
            item.type
          ) +
          '&id=' +
          encodeURIComponent(
            item.id
          )
        );

      $('#ms')
        .textContent =
        meta.source ||
        'Metadata';

      $('#title')
        .textContent =
        meta.name;

      $('#desc')
        .textContent =
        meta.description ||
        'No description available.';

      $('#badges')
        .innerHTML =
        (
          meta.year
            ? badge(
                meta.year
              )
            : ''
        ) +

        badge(
          meta.type === 'series'
            ? 'Series'
            : meta.type
        ) +

        (
          meta.genres ||
          []
        )
          .slice(
            0,
            5
          )
          .map(
            genre =>
              badge(
                genre,
                'bg-red-500/15 text-red-200'
              )
          )
          .join('');


      /*
       * Series:
       * render episodes and use the
       * episode's video ID for stream
       * lookup.
       */

      renderEpisodes();


      /*
       * Movies do not have an episode
       * selector, so the metadata ID is
       * used directly.
       */

      if (
        meta.type !==
        'series'
      ) {

        selectedVideo =
          meta.id;

        await loadStreams();
      }

    } catch (error) {

      $('#ms')
        .textContent =
        'Metadata failed';

      $('#streams')
        .innerHTML =
        '<div class="p-6 text-center text-red-300">' +
        esc(
          error.message
        ) +
        '</div>';
    }
  }


  /* =====================================================
     EPISODES
     ===================================================== */

  function renderEpisodes() {

    const wrapper =
      $('#episodesWrap');

    const container =
      $('#episodes');

    if (
      meta.type !==
        'series' ||
      !meta.videos ||
      !meta.videos.length
    ) {

      wrapper.classList
        .add(
          'hidden'
        );

      return;
    }

    wrapper.classList
      .remove(
        'hidden'
      );

    $('#episodeCount')
      .textContent =
      meta.videos.length +
      ' episodes';

    container.innerHTML =
      '';

    const videos =
      [...meta.videos]
        .sort(
          (a, b) => {

            const seasonA =
              Number(
                a.season || 0
              );

            const seasonB =
              Number(
                b.season || 0
              );

            if (
              seasonA !==
              seasonB
            ) {
              return (
                seasonA -
                seasonB
              );
            }

            return (
              Number(
                a.episode || 0
              ) -
              Number(
                b.episode || 0
              )
            );
          }
        );


    videos.forEach(
      (video, index) => {

        const button =
          document.createElement(
            'button'
          );

        button.className =
          'rounded-lg border border-white/10 bg-white/[.03] p-2 text-left text-xs hover:border-red-500/40';

        const season =
          Number(
            video.season || 0
          );

        const episode =
          Number(
            video.episode ||
            index + 1
          );

        button.innerHTML =
          '<div class="font-bold">' +

          'S' +
          String(
            season
          ).padStart(
            2,
            '0'
          ) +

          'E' +

          String(
            episode
          ).padStart(
            2,
            '0'
          ) +

          '</div>' +

          '<div class="mt-1 truncate text-gray-500">' +

          esc(
            video.title ||
            'Episode ' +
            episode
          ) +

          '</div>';

        button.onclick =
          async () => {

            selectedVideo =
              video.id;

            $('#streamStatus')
              .textContent =
              'Selected S' +
              String(
                season
              ).padStart(
                2,
                '0'
              ) +
              'E' +
              String(
                episode
              ).padStart(
                2,
                '0'
              );

            await loadStreams();
          };

        container.appendChild(
          button
        );
      }
    );


    /*
     * Automatically select first episode.
     */

    if (
      videos.length
    ) {
      selectedVideo =
        videos[0].id;

      loadStreams();
    }
  }


  /* =====================================================
     CLOSE
     ===================================================== */

  function closeModal() {

    modal.classList
      .add(
        'hidden'
      );

    modal.classList
      .remove(
        'flex'
      );

    document.body.style.overflow =
      '';

    cleanupPlayer();

    meta =
      null;

    selectedVideo =
      null;

    currentItem =
      null;
  }


  /* =====================================================
     LIBRARY
     ===================================================== */

  async function loadLibrary() {

    grid.innerHTML =
      '<div class="col-span-full grid grid-cols-2 gap-4 sm:grid-cols-4">' +

      Array.from(
        {
          length: 12
        },
        () =>
          '<div class="skel h-72 rounded-xl"></div>'
      ).join('') +

      '</div>';

    try {

      const items =
        await json(
          '/api/library'
        );

      $('#status')
        .textContent =
        items.length +
        ' titles';

      if (
        items.length
      ) {

        const first =
          items[0];

        hero.className =
          'relative mb-8 h-[38vh] min-h-[280px] overflow-hidden rounded-2xl bg-cover bg-center';

        hero.style.backgroundImage =
          'url("' +
          String(
            first.background ||
            first.poster ||
            ''
          )
            .replace(
              /"/g,
              '\\"'
            ) +
          '")';

        hero.innerHTML =
          '<div class="fade absolute inset-0"></div>' +

          '<div class="absolute bottom-0 p-6 md:p-8">' +

          '<div class="text-xs uppercase tracking-[.2em] text-red-400">' +
          'AniStream' +
          '</div>' +

          '<div class="mt-2 max-w-3xl text-3xl font-black md:text-5xl">' +
          esc(
            first.name
          ) +
          '</div>' +

          '<p class="mt-2 max-w-2xl text-sm text-gray-300 line-clamp-2">' +
          esc(
            first.description ||
            ''
          ) +
          '</p>' +

          '<button id="heroOpen" class="mt-4 rounded-full bg-red-600 px-5 py-2 text-sm font-black hover:bg-red-500">' +
          'Open' +
          '</button>' +

          '</div>';

        $('#heroOpen')
          .onclick =
          () =>
            openItem(
              first
            );

      } else {

        hero.innerHTML =
          '<div class="flex h-full items-center justify-center text-gray-500">' +
          'No catalog results.' +
          '</div>';
      }

      render(
        items
      );

    } catch (error) {

      hero.innerHTML =
        '<div class="flex h-full items-center justify-center p-6 text-center text-red-300">' +
        'Failed to load library: ' +
        esc(
          error.message
        ) +
        '</div>';

      grid.innerHTML =
        '';
    }
  }


  /* =====================================================
     SEARCH
     ===================================================== */

  $('#search')
    .addEventListener(
      'input',
      () => {

        clearTimeout(
          searchTimer
        );

        searchTimer =
          setTimeout(
            async () => {

              const query =
                $('#search')
                  .value
                  .trim();

              if (!query) {

                $('#heading')
                  .textContent =
                  'Trending';

                await loadLibrary();

                return;
              }

              $('#heading')
                .textContent =
                'Search: ' +
                query;

              grid.innerHTML =
                '<div class="col-span-full py-16 text-center text-gray-500">' +
                'Searching...' +
                '</div>';

              try {

                const results =
                  await json(
                    '/api/search?q=' +
                    encodeURIComponent(
                      query
                    )
                  );

                render(
                  results
                );

              } catch (error) {

                grid.innerHTML =
                  '<div class="col-span-full py-16 text-center text-red-300">' +
                  esc(
                    error.message
                  ) +
                  '</div>';
              }

            },
            300
          );
      }
    );


  /* =====================================================
     EVENTS
     ===================================================== */

  $('#close')
    .onclick =
    closeModal;


  $('#modal')
    .addEventListener(
      'click',
      event => {

        if (
          event.target ===
          $('#modal')
        ) {
          closeModal();
        }
      }
    );


  $('#refresh')
    .onclick =
    () =>
      loadStreams();


  window.addEventListener(
    'keydown',
    event => {

      if (
        event.key ===
        'Escape'
      ) {

        closeModal();

        $('#addonsModal')
          .classList
          .add(
            'hidden'
          );

        $('#addonsModal')
          .classList
          .remove(
            'flex'
          );
      }
    }
  );


  /* =====================================================
     ADDON STATUS UI
     ===================================================== */

  $('#addons')
    .onclick =
    async () => {

      const modal =
        $('#addonsModal');

      modal.classList
        .remove(
          'hidden'
        );

      modal.classList
        .add(
          'flex'
        );

      $('#addonList')
        .innerHTML =
        '<div class="p-6 text-gray-500">' +
        'Loading addon manifests...' +
        '</div>';

      try {

        const data =
          await json(
            '/api/addons'
          );

        const html =
          data.addons
            .map(
              addon => {

                const resources =
                  (
                    addon.resources ||
                    []
                  )
                    .map(
                      resource =>
                        badge(
                          resource.name +
                          (
                            resource.types &&
                            resource.types.length
                              ? ':' +
                                resource.types.join(',')
                              : ''
                          ),
                          'bg-white/5 text-gray-500'
                        )
                    )
                    .join('');

                return (

                  '<div class="border-b border-white/5 p-4">' +

                  '<div class="flex items-start justify-between gap-4">' +

                  '<div class="min-w-0">' +

                  '<div class="truncate font-semibold">' +
                  esc(
                    addon.name
                  ) +
                  '</div>' +

                  '<div class="mt-1 text-xs text-gray-500">' +
                  esc(
                    addon.version ||
                    addon.id ||
                    ''
                  ) +
                  '</div>' +

                  '</div>' +

                  badge(
                    addon.online
                      ? 'ONLINE'
                      : 'OFFLINE',
                    addon.online
                      ? 'bg-green-500/15 text-green-300'
                      : 'bg-red-500/15 text-red-300'
                  ) +

                  '</div>' +

                  '<div class="mt-3 flex flex-wrap gap-2">' +
                  resources +
                  '</div>' +

                  (
                    addon.idPrefixes &&
                    addon.idPrefixes.length
                      ? '<div class="mt-2 text-[11px] text-gray-600">ID prefixes: ' +
                        esc(
                          addon.idPrefixes.join(
                            ', '
                          )
                        ) +
                        '</div>'
                      : ''
                  ) +

                  '</div>'
                );
              }
            )
            .join('');

        $('#addonList')
          .innerHTML =
          html ||
          '<div class="p-6 text-gray-500">No addons configured.</div>';

      } catch (error) {

        $('#addonList')
          .innerHTML =
          '<div class="p-6 text-red-300">' +
          esc(
            error.message
          ) +
          '</div>';
      }
    };


  $('#addonsClose')
    .onclick =
    () => {

      $('#addonsModal')
        .classList
        .add(
          'hidden'
        );

      $('#addonsModal')
        .classList
        .remove(
          'flex'
        );
    };


  $('#addonsModal')
    .addEventListener(
      'click',
      event => {

        if (
          event.target ===
          $('#addonsModal')
        ) {

          $('#addonsModal')
            .classList
            .add(
              'hidden'
            );

          $('#addonsModal')
            .classList
            .remove(
              'flex'
            );
        }
      }
    );


  /* =====================================================
     START
     ===================================================== */

  loadLibrary();

})();

</script>

</body>
</html>`;


/* =========================================================
   ROOT
   ========================================================= */

app.get(
  '/',
  (req, res) => {
    res
      .type('html')
      .send(
        INDEX_HTML
      );
  }
);


/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      'Unhandled error:',
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res
      .status(500)
      .json({
        error:
          'Internal server error'
      });
  }
);


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  HOST,
  async () => {

    console.log(
      `AniStream running at http://${HOST}:${PORT}`
    );

    console.log(
      `Configured addons: ${registry.definitions.length}`
    );

    try {

      await registry.refresh(
        true
      );

      const online =
        registry.addons.filter(
          addon =>
            addon.online
        ).length;

      console.log(
        `Addon manifests: ${online}/${registry.addons.length} online`
      );

      for (
        const addon of
        registry.addons
      ) {

        const name =
          addon.manifest
            ?.name ||
          addon.name;

        const resources =
          addon.resources
            .map(
              resource =>
                resource.name
            )
            .join(', ');

        console.log(
          ` - ${name}: ${
            addon.online
              ? resources ||
                'manifest loaded'
              : 'OFFLINE'
          }`
        );
      }

    } catch (error) {

      console.error(
        'Initial addon discovery failed:',
        error.message
      );
    }
  }
);
