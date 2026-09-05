'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

async function startMockProvider() {
  const server = http.createServer(
    (req, res) => {

      const path =
        decodeURIComponent(
          new URL(
            req.url,
            'http://mock'
          ).pathname
        );

      res.setHeader(
        'Content-Type',
        'application/json'
      );

      let body;

      if (
        path ===
        '/catalog/anime/kitsu-anime-trending.json'
      ) {
        body = {
          metas: [
            {
              id: 'kitsu:1',
              type: 'anime',
              name: 'Demo Anime',
              poster:
                'https://example.com/demo.jpg'
            }
          ]
        };

      } else if (
        path ===
        '/catalog/anime/kitsu-anime-list/search=demo.json'
      ) {
        body = {
          metas: [
            {
              id: 'kitsu:1',
              type: 'anime',
              name: 'Demo Anime'
            }
          ]
        };

      } else if (
        path ===
        '/meta/anime/kitsu:1.json'
      ) {
        body = {
          meta: {
            id: 'kitsu:1',
            type: 'anime',
            name: 'Demo Anime',
            description:
              'A deterministic test title.',

            videos: [
              {
                id: 'kitsu:1:1',
                title: 'Episode 1'
              },

              {
                id: 'kitsu:1:2',
                title: 'Episode 2'
              }
            ]
          }
        };

      } else if (
        path ===
        '/stream/anime/kitsu:1:1.json'
      ) {
        body = {
          streams: [
            {
              name:
                'Authorized Test Stream',
              url:
                'https://example.com/video.mp4'
            },

            {
              name:
                'Authorized Test Stream',
              url:
                'https://example.com/video.mp4'
            }
          ]
        };

      } else if (
        path ===
        '/subtitles/anime/kitsu:1:1.json'
      ) {
        body = {
          subtitles: [
            {
              id: 'sub1',
              url:
                'https://example.com/sub.vtt',
              lang: 'eng',
              label: 'English'
            }
          ]
        };

      } else {
        res.statusCode = 404;

        body = {
          error:
            'not found'
        };
      }

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

    endpoint:
      `http://127.0.0.1:${
        server.address().port
      }`
  };
}

async function startApp(
  environment
) {
  const keys = [
    'METADATA_ADDONS',
    'STREAM_ADDONS',
    'SUBTITLE_ADDONS',
    'ADDON_ID',
    'ADDON_NAME',
    'CONTACT_EMAIL',
    'PUBLIC_URL'
  ];

  const old =
    Object.fromEntries(
      keys.map(
        key => [
          key,
          process.env[key]
        ]
      )
    );

  for (
    const key of keys
  ) {
    if (
      environment[key] ===
      undefined
    ) {
      delete process.env[key];
    } else {
      process.env[key] =
        environment[key];
    }
  }

  delete require.cache[
    require.resolve(
      '../server.js'
    )
  ];

  const app =
    require(
      '../server.js'
    );

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

  for (
    const key of keys
  ) {
    if (
      old[key] ===
      undefined
    ) {
      delete process.env[key];
    } else {
      process.env[key] =
        old[key];
    }
  }

  return {
    server,

    base:
      `http://127.0.0.1:${
        server.address().port
      }`,

    app
  };
}

async function fetchText(
  url,
  init
) {
  const response =
    await fetch(
      url,
      init
    );

  const text =
    await response.text();

  return {
    response,
    text
  };
}

async function fetchJson(
  url,
  init
) {
  const result =
    await fetchText(
      url,
      init
    );

  return {
    ...result,

    json:
      JSON.parse(
        result.text
      )
  };
}

test(
  'resource URL and extra parsing are correct',
  () => {

    const app =
      require(
        '../server.js'
      );

    assert.equal(
      app.resourceUrl(
        'https://example.com',
        'meta',
        'anime',
        'kitsu:1'
      ),

      'https://example.com/meta/anime/kitsu%3A1.json'
    );

    assert.equal(
      app.resourceUrl(
        'https://example.com',
        'catalog',
        'anime',
        'kitsu-anime-list',
        [
          [
            'search',
            'one piece'
          ],

          [
            'skip',
            '10'
          ]
        ]
      ),

      'https://example.com/catalog/anime/kitsu-anime-list/search=one%20piece&skip=10.json'
    );

    assert.deepEqual(
      app.parseExtras(
        [
          'search=demo&skip=10'
        ]
      ),

      [
        [
          'search',
          'demo'
        ],

        [
          'skip',
          '10'
        ]
      ]
    );

    assert.deepEqual(
      app.parseExtras(
        [
          'search=hello%26world'
        ]
      ),

      [
        [
          'search',
          'hello&world'
        ]
      ]
    );
  }
);

test(
  'manifest exposes the expected Stremio anime resources',
  () => {

    const app =
      require(
        '../server.js'
      );

    const manifest =
      app.manifest();

    assert.equal(
      manifest.id,
      'com.aniv3.bridge'
    );

    assert.equal(
      manifest.idProperty,
      'id'
    );

    assert.ok(
      manifest.types.includes(
        'anime'
      )
    );

    assert.ok(
      manifest.resources.includes(
        'catalog'
      )
    );

    assert.ok(
      manifest.resources.includes(
        'meta'
      )
    );

    assert.ok(
      Array.isArray(
        manifest.catalogs
      )
    );

    assert.ok(
      manifest.catalogs.some(
        catalog =>
          catalog.id ===
          'anime-trending'
      )
    );

    assert.ok(
      manifest.catalogs.some(
        catalog =>
          catalog.id ===
          'anime-search'
      )
    );
  }
);

test(
  'end-to-end add-on protocol with a mock provider',
  async t => {

    const mock =
      await startMockProvider();

    t.after(
      () =>
        mock.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          mock.endpoint,

        STREAM_ADDONS:
          mock.endpoint,

        SUBTITLE_ADDONS:
          mock.endpoint
      });

    t.after(
      () =>
        app.server.close()
    );

    let result =
      await fetchJson(
        `${app.base}/stremio/v1/manifest.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.id,
      'com.aniv3.bridge'
    );

    assert.ok(
      result.json.resources.includes(
        'stream'
      )
    );

    assert.ok(
      result.json.resources.includes(
        'subtitles'
      )
    );

    result =
      await fetchJson(
        `${app.base}/stremio/v1/catalog/anime/anime-trending.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.metas[0].id,
      'kitsu:1'
    );

    result =
      await fetchJson(
        `${app.base}/stremio/v1/catalog/anime/anime-search/search=demo.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.metas[0].name,
      'Demo Anime'
    );

    result =
      await fetchJson(
        `${app.base}/stremio/v1/meta/anime/kitsu%3A1.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.meta.videos.length,
      2
    );

    result =
      await fetchJson(
        `${app.base}/stremio/v1/stream/anime/kitsu%3A1%3A1.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.streams.length,
      1
    );

    assert.equal(
      result.json.streams[0].url,
      'https://example.com/video.mp4'
    );

    assert.equal(
      result.json.streams[0]
        ._aniv3Provider,
      undefined
    );

    result =
      await fetchJson(
        `${app.base}/stremio/v1/subtitles/anime/kitsu%3A1%3A1.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.subtitles[0].lang,
      'eng'
    );

    assert.equal(
      result.json.subtitles[0]
        ._aniv3Provider,
      undefined
    );
  }
);

test(
  'website routes consume the same integration layer',
  async t => {

    const mock =
      await startMockProvider();

    t.after(
      () =>
        mock.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          mock.endpoint,

        STREAM_ADDONS:
          mock.endpoint,

        SUBTITLE_ADDONS:
          mock.endpoint
      });

    t.after(
      () =>
        app.server.close()
    );

    let result =
      await fetchText(
        `${app.base}/`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.match(
      result.text,
      /Demo Anime/
    );

    result =
      await fetchText(
        `${app.base}/search?q=demo`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.match(
      result.text,
      /Demo Anime/
    );

    result =
      await fetchText(
        `${app.base}/show/kitsu%3A1?ep=0`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.match(
      result.text,
      /Authorized Test Stream/
    );

    assert.match(
      result.text,
      /hls\.js@1\.7\.2/
    );

    result =
      await fetchJson(
        `${app.base}/healthz`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.equal(
      result.json.status,
      'ok'
    );
  }
);

test(
  'empty stream configuration is valid and does not expose a proxy',
  async t => {

    const mock =
      await startMockProvider();

    t.after(
      () =>
        mock.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          mock.endpoint,

        STREAM_ADDONS:
          '',

        SUBTITLE_ADDONS:
          ''
      });

    t.after(
      () =>
        app.server.close()
    );

    const manifest =
      await fetchJson(
        `${app.base}/manifest.json`
      );

    assert.equal(
      manifest.json.resources.includes(
        'stream'
      ),
      false
    );

    let result =
      await fetchJson(
        `${app.base}/stremio/v1/stream/anime/kitsu%3A1%3A1.json`
      );

    assert.equal(
      result.response.status,
      200
    );

    assert.deepEqual(
      result.json,
      {
        streams: []
      }
    );

    result =
      await fetchJson(
        `${app.base}/proxy?origin=https://example.com`
      );

    assert.equal(
      result.response.status,
      404
    );
  }
);

test(
  'HTTP hardening behaves correctly',
  async t => {

    const mock =
      await startMockProvider();

    t.after(
      () =>
        mock.server.close()
    );

    const app =
      await startApp({
        METADATA_ADDONS:
          mock.endpoint
      });

    t.after(
      () =>
        app.server.close()
    );

    let result =
      await fetchText(
        `${app.base}/healthz`,
        {
          method:
            'POST'
        }
      );

    assert.equal(
      result.response.status,
      405
    );

    assert.equal(
      result.response.headers.get(
        'allow'
      ),
      'GET, OPTIONS'
    );

    result =
      await fetchText(
        `${app.base}/healthz`,
        {
          method:
            'OPTIONS'
        }
      );

    assert.equal(
      result.response.status,
      204
    );

    result =
      await fetchJson(
        `${app.base}/does-not-exist`
      );

    assert.equal(
      result.response.status,
      404
    );

    assert.equal(
      result.json.error,
      'Not found'
    );

    assert.equal(
      result.response.headers.get(
        'access-control-allow-origin'
      ),
      '*'
    );
  }
);
