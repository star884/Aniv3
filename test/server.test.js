'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

async function startMockAddon() {
  const server = http.createServer(
    (req, res) => {
      res.setHeader(
        'Content-Type',
        'application/json'
      );

      const p =
        decodeURIComponent(
          new URL(
            req.url,
            'http://localhost'
          ).pathname
        );

      const body = (() => {

        if (p === '/manifest.json') {
          return {
            id: 'local.test',
            name: 'Local',
            resources: [
              'catalog',
              'meta',
              'stream',
              'subtitles'
            ],
            types: ['anime']
          };
        }

        if (
          p ===
          '/catalog/anime/kitsu-anime-list.json'
        ) {
          return {
            metas: [
              {
                id: 'demo-1',
                type: 'anime',
                name: 'Demo Anime',
                poster:
                  'https://example.com/demo.jpg'
              }
            ]
          };
        }

        if (
          p ===
          '/catalog/anime/kitsu-anime-list/search=demo.json'
        ) {
          return {
            metas: [
              {
                id: 'demo-1',
                type: 'anime',
                name: 'Demo Anime'
              }
            ]
          };
        }

        if (
          p ===
          '/meta/anime/demo-1.json'
        ) {
          return {
            meta: {
              id: 'demo-1',
              type: 'anime',
              name: 'Demo Anime',
              description:
                'Test description',

              videos: [
                {
                  id: 'demo-1:1',
                  title: 'Episode 1'
                },

                {
                  id: 'demo-1:2',
                  title: 'Episode 2'
                }
              ]
            }
          };
        }

        if (
          p ===
          '/stream/anime/demo-1:1.json'
        ) {
          return {
            streams: [
              {
                title: 'Test MP4',
                url:
                  'https://example.com/video.mp4'
              },

              {
                title: 'Non HTTP',
                infoHash: 'abc'
              }
            ]
          };
        }

        if (
          p ===
          '/subtitles/anime/demo-1:1.json'
        ) {
          return {
            subtitles: [
              {
                id: 's1',
                url:
                  'https://example.com/sub.vtt',
                lang: 'en',
                label: 'English'
              }
            ]
          };
        }

        res.statusCode = 404;

        return {
          error: 'not found'
        };
      })();

      res.end(
        JSON.stringify(body)
      );
    }
  );

  await new Promise(
    resolve =>
      server.listen(
        0,
        '127.0.0.1',
        resolve
      )
  );

  return {
    server,
    url:
      `http://127.0.0.1:${
        server.address().port
      }`
  };
}

async function startApp(env) {
  const old = process.env;

  Object.assign(
    process.env,
    env
  );

  for (const key of [
    'METADATA_ADDONS',
    'STREAM_ADDONS',
    'SUBTITLE_ADDONS',
    'METADATA_TYPE',
    'METADATA_CATALOG_ID'
  ]) {
    if (env[key] === undefined) {
      delete process.env[key];
    }
  }

  delete require.cache[
    require.resolve(
      '../server.js'
    )
  ];

  const app =
    require('../server.js');

  const server =
    app.createServer();

  await new Promise(
    resolve =>
      server.listen(
        0,
        '127.0.0.1',
        resolve
      )
  );

  process.env = old;

  return {
    server,
    url:
      `http://127.0.0.1:${
        server.address().port
      }`
  };
}

async function get(url) {
  const r =
    await fetch(url);

  const text =
    await r.text();

  return {
    r,
    text,
    json: () =>
      JSON.parse(text)
  };
}

test(
  'helper functions produce correct Stremio paths',
  async () => {

    const {
      routeUrl,
      isLikelyHls,
      mergeUnique
    } =
      require('../server.js');

    assert.equal(
      routeUrl(
        'http://localhost:1234',
        'catalog',
        'series',
        'kitsu-anime-list'
      ),

      'http://localhost:1234/catalog/series/kitsu-anime-list.json'
    );

    assert.equal(
      routeUrl(
        'http://localhost:1234',
        'catalog',
        'series',
        'kitsu-anime-list',
        {
          key: 'search',
          value: 'one piece'
        }
      ),

      'http://localhost:1234/catalog/series/kitsu-anime-list/search=one%20piece.json'
    );

    assert.equal(
      isLikelyHls(
        'https://example.com/a.m3u8?x=1'
      ),
      true
    );

    assert.equal(
      isLikelyHls(
        'https://example.com/a.mp4'
      ),
      false
    );

    assert.deepEqual(
      mergeUnique(
        [
          { id: 'a' },
          { id: 'a' },
          { id: 'b' }
        ],
        x => x.id
      ),

      [
        { id: 'a' },
        { id: 'b' }
      ]
    );
  }
);

test(
  'end-to-end catalog/search/meta/streams/subtitles/health',
  async t => {

    const addon =
      await startMockAddon();

    t.after(
      () =>
        addon.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          addon.url,

        STREAM_ADDONS:
          addon.url,

        SUBTITLE_ADDONS:
          addon.url,

        METADATA_TYPE:
          'anime',

        METADATA_CATALOG_ID:
          'kitsu-anime-list'
      });

    t.after(
      () =>
        app.server.close()
    );

    let x =
      await get(
        `${app.url}/healthz`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.equal(
      x.json().status,
      'ok'
    );

    x =
      await get(
        `${app.url}/api/catalog`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.equal(
      x.json().metas[0].id,
      'demo-1'
    );

    x =
      await get(
        `${app.url}/api/search?q=demo`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.equal(
      x.json().metas[0].name,
      'Demo Anime'
    );

    x =
      await get(
        `${app.url}/api/meta/anime/demo-1`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.equal(
      x.json().meta.videos.length,
      2
    );

    x =
      await get(
        `${app.url}/api/streams/anime/demo-1%3A1`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.equal(
      x.json().streams.length,
      2
    );

    assert.equal(
      x.json().streams[0].url,
      'https://example.com/video.mp4'
    );

    x =
      await get(
        `${app.url}/api/subtitles/anime/demo-1%3A1`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.equal(
      x.json().subtitles[0].lang,
      'en'
    );

    x =
      await get(
        `${app.url}/`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.match(
      x.text,
      /Demo Anime/
    );

    x =
      await get(
        `${app.url}/show/demo-1?ep=0`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.match(
      x.text,
      /Test MP4/
    );

    assert.match(
      x.text,
      /hls\.js@1\.7\.2/
    );
  }
);

test(
  'HTTP behavior is hardened',
  async t => {

    const addon =
      await startMockAddon();

    t.after(
      () =>
        addon.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          addon.url,

        STREAM_ADDONS: '',
        SUBTITLE_ADDONS: ''
      });

    t.after(
      () =>
        app.server.close()
    );

    let r =
      await fetch(
        `${app.url}/api/search`
      );

    assert.equal(
      r.status,
      400
    );

    assert.equal(
      r.headers.get(
        'access-control-allow-origin'
      ),
      '*'
    );

    r =
      await fetch(
        `${app.url}/does-not-exist`
      );

    assert.equal(
      r.status,
      404
    );

    assert.equal(
      (await r.json()).error,
      'Not found'
    );

    r =
      await fetch(
        `${app.url}/healthz`,
        {
          method: 'POST'
        }
      );

    assert.equal(
      r.status,
      405
    );

    assert.equal(
      r.headers.get('allow'),
      'GET, OPTIONS'
    );

    r =
      await fetch(
        `${app.url}/healthz`,
        {
          method: 'OPTIONS'
        }
      );

    assert.equal(
      r.status,
      204
    );
  }
);

test(
  'website reports missing stream configuration cleanly',
  async t => {

    const addon =
      await startMockAddon();

    t.after(
      () =>
        addon.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          addon.url,

        STREAM_ADDONS: '',
        SUBTITLE_ADDONS: '',

        METADATA_TYPE:
          'anime'
      });

    t.after(
      () =>
        app.server.close()
    );

    const x =
      await get(
        `${app.url}/show/demo-1?ep=0`
      );

    assert.equal(
      x.r.status,
      200
    );

    assert.match(
      x.text,
      /No stream sources were returned/
    );
  }
);
