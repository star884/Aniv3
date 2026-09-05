var express = require('express');
var app = express();
var PORT = process.env.PORT || 3000;

var ADDONS = [
  { name: "Torrentio", url: "https://torrentio.strem.fun/manifest.json" },
  { name: "Cinemeta", url: "https://v3-cinemeta.strem.io/manifest.json" },
  { name: "Kitsu Anime", url: "https://anime.kitsu.app/manifest.json" },
  { name: "OpenSubtitles", url: "https://opensubtitles-v3.strem.io/manifest.json" },
  { name: "MediaFusion", url: "https://mediafusion.elfhosted.com/manifest.json" },
  { name: "AIOStreams", url: "https://aiostreams.elfhosted.com/manifest.json" },
  { name: "Comet", url: "https://comet.elfhosted.com/manifest.json" },
  { name: "Jackett", url: "https://jackett.elfhosted.com/manifest.json" },
  { name: "Prowlarr", url: "https://prowlarr.elfhosted.com/manifest.json" },
  { name: "TMDB", url: "https://61ab9211a1a1-tmdb.baby-beamup.club/manifest.json" },
  { name: "AnimeCatalog", url: "https://61ab9211a1a1-anime.baby-beamup.club/manifest.json" },
  { name: "PeerTube", url: "https://peertube.strem.io/manifest.json" },
  { name: "YouTube", url: "https://youtube.strem.io/manifest.json" },
  { name: "Dailymotion", url: "https://dailymotion.strem.io/manifest.json" },
  { name: "Twitch", url: "https://twitch.strem.io/manifest.json" },
  { name: "Stremio Catalog", url: "https://catalogs.strem.io/manifest.json" },
  { name: "IMDB Lists", url: "https://imdb-lists.strem.io/manifest.json" },
  { name: "Trakt TV", url: "https://trakt.strem.io/manifest.json" },
  { name: "WatchHub", url: "https://watchhub.strem.io/manifest.json" },
  { name: "DebridSearch", url: "https://debrid-search.strem.io/manifest.json" }
];

var cache = new Map();
var CACHE_MAX = 300;

function cacheGet(key) {
  var item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) { cache.delete(key); return null; }
  return item.data;
}

function cacheSet(key, data, ttl) {
  if (cache.size >= CACHE_MAX) {
    var first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, { data: data, exp: Date.now() + (ttl || 3600000) });
}

function fetchJSON(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs || 5000);
  return fetch(url, {
    signal: controller.signal,
    headers: { 'User-Agent': 'Stremio/4.0.0', 'Accept': 'application/json' }
  }).then(function(res) {
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).catch(function(err) {
    clearTimeout(timer);
    throw err;
  });
}

app.get('/api/proxy', function(req, res) {
  var url = req.query.url;
  if (!url || url.indexOf('http') !== 0) {
    return res.status(400).json({ error: 'Bad URL' });
  }
  var cached = cacheGet(url);
  if (cached) return res.json(cached);

  fetchJSON(url, 6000).then(function(data) {
    cacheSet(url, data, 1800000);
    res.json(data);
  }).catch(function() {
    res.status(502).json({ error: 'Timeout or unreachable' });
  });
});

app.get('/api/trending', function(req, res) {
  var cached = cacheGet('trending');
  if (cached) return res.json(cached);

  fetchJSON('https://v3-cinemeta.strem.io/catalog/series/top.json', 6000)
    .then(function(data) {
      var metas = (data.metas || []).filter(function(m) {
        return m.name && m.poster;
      }).slice(0, 80);
      cacheSet('trending', metas, 7200000);
      res.json(metas);
    }).catch(function() {
      res.json([]);
    });
});

app.get('/api/search', function(req, res) {
  var q = req.query.q;
  if (!q) return res.json([]);
  var key = 'search_' + q;
  var cached = cacheGet(key);
  if (cached) return res.json(cached);

  var url = 'https://v3-cinemeta.strem.io/catalog/series/top/search=' + encodeURIComponent(q) + '.json';
  fetchJSON(url, 6000).then(function(data) {
    var metas = (data.metas || []).slice(0, 40);
    cacheSet(key, metas, 600000);
    res.json(metas);
  }).catch(function() {
    res.json([]);
  });
});

app.get('/api/streams', function(req, res) {
  var type = req.query.type || 'series';
  var id = req.query.id;
  if (!id) return res.json([]);

  var key = 'streams_' + type + '_' + id;
  var cached = cacheGet(key);
  if (cached) return res.json(cached);

  var promises = ADDONS.map(function(addon) {
    var base = addon.url.replace('/manifest.json', '');
    var url = base + '/stream/' + type + '/' + id + '.json';
    return fetchJSON(url, 4000).then(function(data) {
      return (data.streams || []).map(function(s) {
        s._provider = addon.name;
        return s;
      });
    }).catch(function() {
      return [];
    });
  });

  Promise.all(promises).then(function(results) {
    var all = [];
    for (var i = 0; i < results.length; i++) {
      for (var j = 0; j < results[i].length; j++) {
        all.push(results[i][j]);
      }
    }
    all.sort(function(a, b) {
      if (a._provider === 'Torrentio' && b._provider !== 'Torrentio') return -1;
      if (b._provider === 'Torrentio' && a._provider !== 'Torrentio') return 1;
      return 0;
    });
    cacheSet(key, all, 1800000);
    res.json(all);
  });
});

app.get('/api/status', function(req, res) {
  var promises = ADDONS.map(function(addon) {
    return fetchJSON(addon.url, 3000).then(function() {
      return { name: addon.name, ok: true };
    }).catch(function() {
      return { name: addon.name, ok: false };
    });
  });
  Promise.all(promises).then(function(results) {
    res.json(results);
  });
});

app.get('/', function(req, res) {
  var html = [];
  html.push('<!DOCTYPE html>');
  html.push('<html lang="en">');
  html.push('<head>');
  html.push('<meta charset="UTF-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  html.push('<title>AniStream</title>');
  html.push('<script src="https://cdn.tailwindcss.com"><\/script>');
  html.push('<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>');
  html.push('<script src="https://cdn.jsdelivr.net/npm/webtorrent@2/webtorrent.min.js"><\/script>');
  html.push('<style>');
  html.push('body{background:#0a0e17;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;margin:0}');
  html.push('.glass{background:rgba(10,14,23,0.92);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.06)}');
  html.push('.card{transition:all 0.3s cubic-bezier(0.4,0,0.2,1);cursor:pointer}');
  html.push('.card:hover{transform:scale(1.06);z-index:10;box-shadow:0 25px 50px -12px rgba(0,0,0,0.8)}');
  html.push('.skel{background:linear-gradient(90deg,#1e293b 25%,#334155 50%,#1e293b 75%);background-size:200% 100%;animation:sk 1.5s infinite}');
  html.push('@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}');
  html.push('.scroll-hide::-webkit-scrollbar{display:none}');
  html.push('.scroll-hide{-ms-overflow-style:none;scrollbar-width:none}');
  html.push('.badge{font-size:0.6rem;padding:2px 6px;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em}');
  html.push('.modal-bg{backdrop-filter:blur(10px);background:rgba(0,0,0,0.88)}');
  html.push('.wt-progress{height:4px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:8px}');
  html.push('.wt-bar{height:100%;background:linear-gradient(90deg,#ef4444,#f97316);transition:width 0.3s}');
  html.push('</style>');
  html.push('</head>');
  html.push('<body>');

  // Header
  html.push('<header class="glass fixed top-0 w-full z-50 px-4 md:px-8 py-3 flex flex-col md:flex-row justify-between items-center gap-3">');
  html.push('<div class="flex items-center gap-3 w-full md:w-auto justify-between">');
  html.push('<div class="flex items-center gap-3">');
  html.push('<div class="w-9 h-9 bg-red-600 rounded-lg flex items-center justify-center font-black text-white text-lg">A</div>');
  html.push('<h1 class="text-xl md:text-2xl font-black tracking-tight">Ani<span class="text-red-500">Stream</span></h1>');
  html.push('</div>');
  html.push('<span id="addonBadge" class="text-xs bg-slate-800 px-3 py-1 rounded-full text-slate-400">Loading...</span>');
  html.push('</div>');
  html.push('<div class="w-full md:w-96">');
  html.push('<div class="relative">');
  html.push('<input id="searchBox" type="text" placeholder="Search anime (Naruto, One Piece, Jujutsu...)" class="w-full bg-slate-800/80 border border-slate-700 rounded-full py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">');
  html.push('<svg class="absolute left-3 top-3 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>');
  html.push('</div>');
  html.push('</div>');
  html.push('</header>');

  // Main
  html.push('<main class="pt-24 pb-10 px-4 md:px-8 max-w-7xl mx-auto">');
  html.push('<div id="hero" class="mb-10 rounded-2xl overflow-hidden relative h-[40vh] md:h-[55vh] skel"></div>');
  html.push('<div class="flex items-center justify-between mb-6">');
  html.push('<h2 id="sectionTitle" class="text-2xl md:text-3xl font-black">Trending Now</h2>');
  html.push('<span id="statusMsg" class="text-xs text-slate-500"></span>');
  html.push('</div>');
  html.push('<div id="grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-5">');
  for (var i = 0; i < 12; i++) {
    html.push('<div class="skel h-64 md:h-72 rounded-xl"></div>');
  }
  html.push('</div>');
  html.push('</main>');

  // Modal
  html.push('<div id="modal" class="fixed inset-0 modal-bg hidden z-50 flex items-start justify-center p-4 overflow-y-auto">');
  html.push('<div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-5xl w-full my-8 shadow-2xl relative overflow-hidden">');
  html.push('<button onclick="closeModal()" class="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-slate-800/90 hover:bg-red-600 transition text-white z-20 text-xl font-bold">&times;</button>');
  html.push('<div class="flex flex-col md:flex-row">');

  // Left panel
  html.push('<div class="md:w-1/3 p-6 bg-slate-950/60">');
  html.push('<img id="mPoster" src="" class="w-full rounded-xl shadow-lg mb-4 aspect-[2/3] object-cover skel">');
  html.push('<h2 id="mTitle" class="text-2xl font-black mb-2 leading-tight"></h2>');
  html.push('<div id="mMeta" class="flex flex-wrap gap-2 mb-3 text-xs"></div>');
  html.push('<p id="mDesc" class="text-sm text-slate-300 leading-relaxed"></p>');
  html.push('</div>');

  // Right panel
  html.push('<div class="md:w-2/3 p-6 flex flex-col">');

  // Player area
  html.push('<div id="playerWrap" class="hidden mb-5 bg-black rounded-xl overflow-hidden shadow-2xl relative">');
  html.push('<video id="vidPlayer" controls autoplay class="w-full aspect-video bg-black"></video>');
  html.push('<div id="wtStatus" class="hidden absolute bottom-0 left-0 right-0 bg-black/80 p-3 text-xs text-white">');
  html.push('<span id="wtText">Connecting to peers...</span>');
  html.push('<div class="wt-progress"><div id="wtBar" class="wt-bar" style="width:0%"></div></div>');
  html.push('</div>');
  html.push('</div>');

  // Stream list
  html.push('<div class="flex items-center justify-between mb-4">');
  html.push('<h3 class="text-lg font-black text-red-400 flex items-center gap-2">');
  html.push('<svg id="spinIcon" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>');
  html.push('<span id="streamLabel">Finding streams...</span>');
  html.push('</h3>');
  html.push('</div>');
  html.push('<div id="streamList" class="space-y-2 overflow-y-auto max-h-[45vh] pr-1 scroll-hide"></div>');
  html.push('</div>');

  html.push('</div>');
  html.push('</div>');
  html.push('</div>');

  // JavaScript
  html.push('<script>');
  html.push('var wtClient = null;');
  html.push('var hlsInst = null;');
  html.push('var activeTorrent = null;');

  // Init
  html.push('async function init() {');
  html.push('  try {');
  html.push('    var r = await fetch("/api/trending");');
  html.push('    var metas = await r.json();');
  html.push('    document.getElementById("statusMsg").textContent = metas.length + " titles loaded";');
  html.push('    if (metas.length > 0) {');
  html.push('      var feat = metas[Math.floor(Math.random() * Math.min(15, metas.length))];');
  html.push('      var hero = document.getElementById("hero");');
  html.push('      hero.className = "mb-10 rounded-2xl overflow-hidden relative h-[40vh] md:h-[55vh] bg-cover bg-center";');
  html.push('      hero.style.backgroundImage = "url(" + (feat.background || feat.poster) + ")";');
  html.push('      hero.innerHTML = \'<div class="absolute inset-0 bg-gradient-to-t from-[#0a0e17] via-transparent to-transparent"></div>\' +');
  html.push('        \'<div class="absolute bottom-0 left-0 p-6 md:p-10 max-w-2xl">\' +');
  html.push('        \'<h2 class="text-3xl md:text-5xl font-black mb-2 drop-shadow-lg">\' + feat.name + \'</h2>\' +');
  html.push('        \'<p class="text-slate-300 text-sm md:text-base mb-4 line-clamp-3">\' + (feat.description || "") + \'</p>\' +');
  html.push('        \'<button onclick="openModal(\' + JSON.stringify(feat).replace(/"/g, "&quot;") + \')" class="px-6 py-2.5 bg-red-600 hover:bg-red-700 rounded-full font-bold transition flex items-center gap-2 text-sm">\' +');
  html.push('        \'<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg>\' +');
  html.push('        \'Play Now</button></div>\';');
  html.push('    }');
  html.push('    renderGrid(metas);');
  html.push('  } catch(e) {');
  html.push('    document.getElementById("grid").innerHTML = \'<div class="col-span-full text-center text-red-500 py-10">Failed to load. Refresh page.</div>\';');
  html.push('  }');
  html.push('  checkAddons();');
  html.push('}');

  // Check addons
  html.push('async function checkAddons() {');
  html.push('  try {');
  html.push('    var r = await fetch("/api/status");');
  html.push('    var results = await r.json();');
  html.push('    var online = results.filter(function(a){return a.ok}).length;');
  html.push('    document.getElementById("addonBadge").textContent = online + "/" + results.length + " Addons Online";');
  html.push('    document.getElementById("addonBadge").className = "text-xs px-3 py-1 rounded-full " + (online > 0 ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400");');
  html.push('  } catch(e) {}');
  html.push('}');

  // Render grid
  html.push('function renderGrid(metas) {');
  html.push('  var g = document.getElementById("grid");');
  html.push('  if (!metas || metas.length === 0) {');
  html.push('    g.innerHTML = \'<div class="col-span-full text-center text-slate-500 py-10">No results found.</div>\';');
  html.push('    return;');
  html.push('  }');
  html.push('  g.innerHTML = metas.map(function(m) {');
  html.push('    var poster = m.poster || "https://via.placeholder.com/300x450/1e293b/64748b?text=No+Image";');
  html.push('    var esc = JSON.stringify(m).replace(/"/g, "&quot;");');
  html.push('    return \'<div class="card bg-slate-800/80 rounded-xl overflow-hidden shadow-lg" onclick="openModal(\' + esc + \')">\' +');
  html.push('      \'<img src="\' + poster + \'" class="w-full h-56 md:h-72 object-cover" loading="lazy" onerror="this.src=\\\'https://via.placeholder.com/300x450/1e293b/64748b?text=No+Image\\\'">\' +');
  html.push('      \'<div class="p-3"><h3 class="font-bold text-sm truncate">\' + m.name + \'</h3>\' +');
  html.push('      \'<p class="text-xs text-slate-400 mt-1">\' + (m.year || "N/A") + \'</p></div></div>\';');
  html.push('  }).join("");');
  html.push('}');

  // Open modal
  html.push('async function openModal(meta) {');
  html.push('  var modal = document.getElementById("modal");');
  html.push('  modal.classList.remove("hidden");');
  html.push('  document.body.style.overflow = "hidden";');
  html.push('  stopPlayback();');
  html.push('  document.getElementById("mPoster").src = meta.poster || "";');
  html.push('  document.getElementById("mTitle").textContent = meta.name || "Unknown";');
  html.push('  document.getElementById("mDesc").textContent = meta.description || "No description available for this title.";');
  html.push('  var typeLabel = (meta.type === "movie") ? "Movie" : "TV Series";');
  html.push('  document.getElementById("mMeta").innerHTML = ');
  html.push('    \'<span class="bg-slate-800 px-2 py-1 rounded text-slate-300">\' + typeLabel + \'</span>\' +');
  html.push('    \'<span class="bg-slate-800 px-2 py-1 rounded text-slate-300">\' + (meta.year || "N/A") + \'</span>\' +');
  html.push('    \'<span class="bg-red-900/40 text-red-300 px-2 py-1 rounded border border-red-800/50">Stremio</span>\';');
  html.push('  document.getElementById("playerWrap").classList.add("hidden");');
  html.push('  document.getElementById("streamList").innerHTML = \'<div class="text-center text-slate-500 py-8 text-sm">Querying 20 addons for streams...</div>\';');
  html.push('  document.getElementById("spinIcon").classList.remove("hidden");');
  html.push('  document.getElementById("streamLabel").textContent = "Finding streams...";');

  html.push('  try {');
  html.push('    var type = meta.type || "series";');
  html.push('    var id = meta.imdb_id || meta.id;');
  html.push('    var r = await fetch("/api/streams?type=" + type + "&id=" + encodeURIComponent(id));');
  html.push('    var streams = await r.json();');
  html.push('    document.getElementById("spinIcon").classList.add("hidden");');
  html.push('    document.getElementById("streamLabel").textContent = streams.length + " Streams Found";');
  html.push('    if (streams.length === 0) {');
  html.push('      document.getElementById("streamList").innerHTML = \'<div class="text-center text-red-400 py-8 text-sm">No streams found. Try a different title or search term.</div>\';');
  html.push('      return;');
  html.push('    }');
  html.push('    renderStreams(streams);');
  html.push('  } catch(e) {');
  html.push('    document.getElementById("spinIcon").classList.add("hidden");');
  html.push('    document.getElementById("streamLabel").textContent = "Error";');
  html.push('    document.getElementById("streamList").innerHTML = \'<div class="text-center text-red-400 py-8 text-sm">Failed to fetch streams.</div>\';');
  html.push('  }');
  html.push('}');

  // Render streams
  html.push('function renderStreams(streams) {');
  html.push('  var list = document.getElementById("streamList");');
  html.push('  list.innerHTML = streams.slice(0, 40).map(function(s, i) {');
  html.push('    var url = s.url || "";');
  html.push('    var isHttp = url.indexOf("http") === 0 && (url.indexOf(".mp4") > -1 || url.indexOf(".m3u8") > -1 || url.indexOf(".mkv") > -1 || url.indexOf(".webm") > -1);');
  html.push('    var isMagnet = url.indexOf("magnet:") === 0;');
  html.push('    var isInfoHash = s.infoHash && s.infoHash.length > 0;');
  html.push('    var badges = parseBadges(s.title || s.name || "");');
  html.push('    var btn = "";');
  html.push('    if (isHttp) {');
  html.push('      btn = \'<button onclick="playHttp(\\\'\' + url.replace(/\'/g, "\\\\\'") + \'\\\')" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap"><svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg>Play</button>\';');
  html.push('    } else if (isMagnet) {');
  html.push('      btn = \'<button onclick="playMagnet(\\\'\' + url.replace(/\'/g, "\\\\\'") + \'\\\')" class="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-white text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path></svg>Stream</button>\';');
  html.push('    } else if (isInfoHash) {');
  html.push('      var magnet = "magnet:?xt=urn:btih:" + s.infoHash;');
  html.push('      btn = \'<button onclick="playMagnet(\\\'\' + magnet + \'\\\')" class="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-white text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path></svg>Stream</button>\';');
  html.push('    } else if (url) {');
  html.push('      btn = \'<a href="\' + url + \'" target="_blank" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white text-xs font-bold transition whitespace-nowrap">Open</a>\';');
  html.push('    } else {');
  html.push('      btn = \'<span class="text-xs text-slate-600">No link</span>\';');
  html.push('    }');
  html.push('    return \'<div class="bg-slate-800/50 border border-slate-700/50 p-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:border-red-500/40 transition group">\' +');
  html.push('      \'<div class="flex-1 min-w-0">\' +');
  html.push('      \'<p class="font-semibold text-sm text-slate-200 truncate group-hover:text-white">\' + (s.title || s.name || "Stream " + (i+1)) + \'</p>\' +');
  html.push('      \'<div class="flex items-center gap-1.5 mt-1 flex-wrap">\' +');
  html.push('      \'<span class="text-[10px] font-bold text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded">\' + (s._provider || "Unknown") + \'</span>\' +');
  html.push('      badges +');
  html.push('      (isInfoHash ? \'<span class="badge bg-purple-900 text-purple-300">Torrent</span>\' : "") +');
  html.push('      (isHttp ? \'<span class="badge bg-emerald-900 text-emerald-300">Direct</span>\' : "") +');
  html.push('      \'</div></div>\' + btn + \'</div>\';');
  html.push('  }).join("");');
  html.push('}');

  // Parse quality badges
  html.push('function parseBadges(title) {');
  html.push('  if (!title) return "";');
  html.push('  var b = "";');
  html.push('  if (/\\b(4k|2160p)\\b/i.test(title)) b += \'<span class="badge bg-purple-600 text-white">4K</span>\';');
  html.push('  if (/\\b1080p\\b/i.test(title)) b += \'<span class="badge bg-blue-600 text-white">1080p</span>\';');
  html.push('  if (/\\b720p\\b/i.test(title)) b += \'<span class="badge bg-green-600 text-white">720p</span>\';');
  html.push('  if (/\\b480p\\b/i.test(title)) b += \'<span class="badge bg-yellow-600 text-black">480p</span>\';');
  html.push('  if (/\\b(h265|hevc|x265)\\b/i.test(title)) b += \'<span class="badge bg-pink-600 text-white">HEVC</span>\';');
  html.push('  if (/\\bdual.?audio\\b/i.test(title)) b += \'<span class="badge bg-indigo-600 text-white">Dual</span>\';');
  html.push('  return b;');
  html.push('}');

  // Play HTTP stream
  html.push('function playHttp(url) {');
  html.push('  stopPlayback();');
  html.push('  var wrap = document.getElementById("playerWrap");');
  html.push('  var vid = document.getElementById("vidPlayer");');
  html.push('  wrap.classList.remove("hidden");');
  html.push('  document.getElementById("wtStatus").classList.add("hidden");');
  html.push('  if (url.indexOf(".m3u8") > -1) {');
  html.push('    if (Hls.isSupported()) {');
  html.push('      hlsInst = new Hls();');
  html.push('      hlsInst.loadSource(url);');
  html.push('      hlsInst.attachMedia(vid);');
  html.push('      hlsInst.on(Hls.Events.MANIFEST_PARSED, function() { vid.play(); });');
  html.push('    } else if (vid.canPlayType("application/vnd.apple.mpegurl")) {');
  html.push('      vid.src = url; vid.play();');
  html.push('    }');
  html.push('  } else {');
  html.push('    vid.src = url; vid.play();');
  html.push('  }');
  html.push('  wrap.scrollIntoView({ behavior: "smooth", block: "center" });');
  html.push('}');

  // Play magnet via WebTorrent
  html.push('function playMagnet(magnetUri) {');
  html.push('  stopPlayback();');
  html.push('  var wrap = document.getElementById("playerWrap");');
  html.push('  var vid = document.getElementById("vidPlayer");');
  html.push('  var wtStatus = document.getElementById("wtStatus");');
  html.push('  var wtText = document.getElementById("wtText");');
  html.push('  var wtBar = document.getElementById("wtBar");');
  html.push('  wrap.classList.remove("hidden");');
  html.push('  wtStatus.classList.remove("hidden");');
  html.push('  wtText.textContent = "Initializing WebTorrent...";');
  html.push('  wtBar.style.width = "0%";');

  html.push('  try {');
  html.push('    wtClient = new WebTorrent();');
  html.push('    wtText.textContent = "Connecting to peers (this may take 10-30s)...";');
  html.push('    activeTorrent = wtClient.add(magnetUri, {');
  html.push('      announce: ["wss://tracker.openwebtorrent.com","wss://tracker.btorrent.xyz","wss://tracker.fastcast.nz"]');
  html.push('    });');

  html.push('    activeTorrent.on("metadata", function() {');
  html.push('      wtText.textContent = "Metadata loaded. Finding video file...";');
  html.push('    });');

  html.push('    activeTorrent.on("ready", function() {');
  html.push('      var file = null;');
  html.push('      var videoExts = [".mp4",".mkv",".webm",".avi",".mov",".m4v"];');
  html.push('      for (var i = 0; i < activeTorrent.files.length; i++) {');
  html.push('        var f = activeTorrent.files[i];');
  html.push('        var ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();');
  html.push('        if (videoExts.indexOf(ext) > -1) {');
  html.push('          if (!file || f.length > file.length) file = f;');
  html.push('        }');
  html.push('      }');
  html.push('      if (!file && activeTorrent.files.length > 0) file = activeTorrent.files[0];');
  html.push('      if (!file) {');
  html.push('        wtText.textContent = "No video file found in torrent.";');
  html.push('        return;');
  html.push('      }');
  html.push('      wtText.textContent = "Streaming: " + file.name;');
  html.push('      file.renderTo(vid, { autoplay: true }, function(err) {');
  html.push('        if (err) wtText.textContent = "Render error: " + err.message;');
  html.push('      });');
  html.push('    });');

  html.push('    activeTorrent.on("download", function() {');
  html.push('      if (activeTorrent) {');
  html.push('        var pct = Math.round(activeTorrent.progress * 100);');
  html.push('        var speed = (activeTorrent.downloadSpeed / 1024 / 1024).toFixed(2);');
  html.push('        var peers = activeTorrent.numPeers;');
  html.push('        wtBar.style.width = pct + "%";');
  html.push('        wtText.textContent = "Downloading: " + pct + "% | " + speed + " MB/s | " + peers + " peers";');
  html.push('      }');
  html.push('    });');

  html.push('    activeTorrent.on("error", function(err) {');
  html.push('      wtText.textContent = "Error: " + err.message + ". Try a different stream.";');
  html.push('    });');

  html.push('    activeTorrent.on("noPeers", function() {');
  html.push('      wtText.textContent = "No WebRTC peers found. Try a different stream or use the magnet link in a torrent client.";');
  html.push('    });');

  html.push('  } catch(e) {');
  html.push('    wtText.textContent = "WebTorrent failed: " + e.message;');
  html.push('  }');
  html.push('  wrap.scrollIntoView({ behavior: "smooth", block: "center" });');
  html.push('}');

  // Stop playback
  html.push('function stopPlayback() {');
  html.push('  if (hlsInst) { hlsInst.destroy(); hlsInst = null; }');
  html.push('  if (activeTorrent) {');
  html.push('    try { activeTorrent.destroy(); } catch(e) {}');
  html.push('    activeTorrent = null;');
  html.push('  }');
  html.push('  if (wtClient) {');
  html.push('    try { wtClient.destroy(); } catch(e) {}');
  html.push('    wtClient = null;');
  html.push('  }');
  html.push('  var vid = document.getElementById("vidPlayer");');
  html.push('  vid.pause();');
  html.push('  vid.removeAttribute("src");');
  html.push('  vid.load();');
  html.push('}');

  // Close modal
  html.push('function closeModal() {');
  html.push('  stopPlayback();');
  html.push('  document.getElementById("modal").classList.add("hidden");');
  html.push('  document.body.style.overflow = "";');
  html.push('}');

  // Search
  html.push('document.getElementById("searchBox").addEventListener("keypress", async function(e) {');
  html.push('  if (e.key !== "Enter") return;');
  html.push('  var q = e.target.value.trim();');
  html.push('  if (!q) return;');
  html.push('  document.getElementById("sectionTitle").textContent = \'Results: "\' + q + \'"\';');
  html.push('  document.getElementById("statusMsg").textContent = "Searching...";');
  html.push('  document.getElementById("grid").innerHTML = \'<div class="col-span-full text-center py-10"><div class="inline-block w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div></div>\';');
  html.push('  try {');
  html.push('    var r = await fetch("/api/search?q=" + encodeURIComponent(q));');
  html.push('    var metas = await r.json();');
  html.push('    document.getElementById("statusMsg").textContent = metas.length + " results";');
  html.push('    renderGrid(metas);');
  html.push('  } catch(err) {');
  html.push('    document.getElementById("grid").innerHTML = \'<div class="col-span-full text-center text-red-500 py-10">Search failed.</div>\';');
  html.push('  }');
  html.push('});');

  html.push('init();');
  html.push('<\/script>');
  html.push('</body>');
  html.push('</html>');

  res.send(html.join('\n'));
});

app.listen(PORT, function() {
  console.log('AniStream running on port ' + PORT);
});
