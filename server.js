const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const ADDONS = [
  { name: "Torrentio", url: "https://torrentio.strem.fun/manifest.json" },
  { name: "Cinemeta", url: "https://v3-cinemeta.strem.io/manifest.json" },
  { name: "Kitsu Anime", url: "https://anime.kitsu.io/manifest.json" },
  { name: "OpenSubtitles v3", url: "https://opensubtitles-v3.strem.io/manifest.json" },
  { name: "MediaFusion", url: "https://mediafusion.elfhosted.com/manifest.json" },
  { name: "Comet", url: "https://comet.elfhosted.com/manifest.json" },
  { name: "Peerflix", url: "https://peerflix-addon.strem.io/manifest.json" },
  { name: "ThePirateBay", url: "https://tpb-addon.strem.io/manifest.json" },
  { name: "1337x", url: "https://1337x-addon.strem.io/manifest.json" },
  { name: "YTS", url: "https://yts-addon.strem.io/manifest.json" },
  { name: "Nyaa Anime", url: "https://nyaa.strem.fun/manifest.json" },
  { name: "AnimeTosho", url: "https://animetosho.strem.fun/manifest.json" },
  { name: "TMDB Catalog", url: "https://tmdb-addon.strem.io/manifest.json" },
  { name: "Trakt", url: "https://trakt-addon.strem.io/manifest.json" },
  { name: "IMDb Lists", url: "https://imdb-lists.strem.io/manifest.json" },
  { name: "Subscene", url: "https://subscene-addon.strem.io/manifest.json" },
  { name: "YouTube", url: "https://youtube-addon.strem.io/manifest.json" },
  { name: "WatchHub", url: "https://watchhub-addon.strem.io/manifest.json" },
  { name: "AnimeFlix", url: "https://animeflix.io/stremio/manifest.json" },
  { name: "Jackett", url: "https://jackett.strem.fun/manifest.json" }
];

var cache = new Map();
function getC(k) { var i = cache.get(k); if (i && Date.now() < i.e) return i.d; if (i) cache.delete(k); return null; }
function setC(k, d, t) { if (cache.size >= 300) cache.delete(cache.keys().next().value); cache.set(k, { d: d, e: Date.now() + (t || 3600000) }); }

async function safeFetch(url, ms) {
  var c = new AbortController();
  var t = setTimeout(function() { c.abort(); }, ms || 4000);
  try {
    var r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Stremio/4.0.0' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { clearTimeout(t); return null; }
}

app.get('/api/proxy', async function(req, res) {
  var url = req.query.url;
  if (!url) return res.status(400).json({ error: 'no url' });
  var c = getC(url);
  if (c) return res.json(c);
  var d = await safeFetch(url, 8000);
  if (d) { setC(url, d); res.json(d); } else { res.status(502).json({ error: 'upstream failed' }); }
});

app.get('/api/library', async function(req, res) {
  var c = getC('lib');
  if (c) return res.json(c);
  var urls = [
    'https://v3-cinemeta.strem.io/catalog/series/top.json',
    'https://v3-cinemeta.strem.io/catalog/movie/top.json'
  ];
  var all = [];
  for (var i = 0; i < urls.length; i++) {
    var d = await safeFetch(urls[i], 6000);
    if (d && d.metas) all = all.concat(d.metas);
  }
  var seen = {};
  var unique = [];
  for (var j = 0; j < all.length; j++) {
    var m = all[j];
    if (m && m.id && !seen[m.id] && m.poster) { seen[m.id] = true; unique.push(m); }
  }
  unique = unique.slice(0, 120);
  if (unique.length > 0) setC('lib', unique, 7200000);
  res.json(unique);
});

app.get('/api/search', async function(req, res) {
  var q = req.query.q;
  if (!q) return res.json([]);
  var ck = 's_' + q;
  var c = getC(ck);
  if (c) return res.json(c);
  var urls = [
    'https://v3-cinemeta.strem.io/catalog/series/top/search=' + encodeURIComponent(q) + '.json',
    'https://v3-cinemeta.strem.io/catalog/movie/top/search=' + encodeURIComponent(q) + '.json'
  ];
  var all = [];
  for (var i = 0; i < urls.length; i++) {
    var d = await safeFetch(urls[i], 5000);
    if (d && d.metas) all = all.concat(d.metas);
  }
  setC(ck, all.slice(0, 40), 600000);
  res.json(all.slice(0, 40));
});

app.get('/api/streams', async function(req, res) {
  var type = req.query.type;
  var id = req.query.id;
  if (!type || !id) return res.json([]);
  var results = await Promise.all(ADDONS.map(function(a) {
    var base = a.url.replace('/manifest.json', '');
    var u = base + '/stream/' + type + '/' + id + '.json';
    return safeFetch(u, 4000).then(function(d) {
      if (!d || !d.streams) return [];
      return d.streams.map(function(s) { s._src = a.name; return s; });
    }).catch(function() { return []; });
  }));
  var flat = [];
  for (var i = 0; i < results.length; i++) flat = flat.concat(results[i]);
  var valid = flat.filter(function(s) { return s.url || s.infoHash; });
  valid.sort(function(a, b) {
    if (a._src === 'Torrentio') return -1;
    if (b._src === 'Torrentio') return 1;
    return 0;
  });
  res.json(valid.slice(0, 50));
});

app.get('/', function(req, res) {
  var html = [];
  html.push('<!DOCTYPE html>');
  html.push('<html lang="en"><head>');
  html.push('<meta charset="UTF-8">');
  html.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
  html.push('<title>AniStream v2</title>');
  html.push('<script src="https://cdn.tailwindcss.com"><\/script>');
  html.push('<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>');
  html.push('<script src="https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js"><\/script>');
  html.push('<style>');
  html.push('body{background:#0a0a0f;color:#e5e5e5;font-family:system-ui,sans-serif;margin:0}');
  html.push('.card{transition:transform .2s,box-shadow .2s;cursor:pointer}');
  html.push('.card:hover{transform:scale(1.06);box-shadow:0 12px 40px rgba(0,0,0,.7);z-index:10}');
  html.push('.skel{background:linear-gradient(90deg,#1a1a2e 25%,#2a2a4a 50%,#1a1a2e 75%);background-size:200% 100%;animation:sh 1.5s infinite}');
  html.push('@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}');
  html.push('.hide-sb::-webkit-scrollbar{display:none}.hide-sb{-ms-overflow-style:none;scrollbar-width:none}');
  html.push('.badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}');
  html.push('#modal-overlay{backdrop-filter:blur(10px);background:rgba(0,0,0,.8)}');
  html.push('.progress-bar{height:4px;background:#333;border-radius:2px;overflow:hidden}');
  html.push('.progress-fill{height:100%;background:#ef4444;transition:width .3s}');
  html.push('</style></head><body>');

  html.push('<header class="fixed top-0 w-full z-50 px-4 py-3 flex items-center gap-4" style="background:rgba(10,10,15,.92);border-bottom:1px solid rgba(255,255,255,.06)">');
  html.push('<div class="flex items-center gap-2"><div class="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center font-black text-white text-sm">A</div><span class="text-xl font-bold">Ani<span class="text-red-500">Stream</span></span></div>');
  html.push('<div class="flex-1 max-w-md mx-auto"><input id="searchBox" type="text" placeholder="Search any anime or movie..." class="w-full bg-white/5 border border-white/10 rounded-full py-2 px-4 text-sm focus:outline-none focus:border-red-500"></div>');
  html.push('<div id="statusBadge" class="text-xs px-3 py-1 rounded-full bg-white/5 text-gray-400 hidden md:block">Loading...</div>');
  html.push('</header>');

  html.push('<main class="pt-20 pb-12 px-4 md:px-8 max-w-7xl mx-auto">');
  html.push('<div id="hero" class="mb-10 rounded-2xl overflow-hidden relative skel" style="height:45vh"></div>');
  html.push('<h2 id="sectionLabel" class="text-2xl font-bold mb-5">Trending Now</h2>');
  html.push('<div id="grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">');
  for (var i = 0; i < 12; i++) html.push('<div class="skel rounded-lg" style="height:280px"></div>');
  html.push('</div></main>');

  html.push('<div id="modal-overlay" class="fixed inset-0 z-50 hidden items-center justify-center p-4 overflow-y-auto">');
  html.push('<div class="bg-gray-950 border border-white/10 rounded-2xl max-w-5xl w-full my-8 shadow-2xl relative">');
  html.push('<button onclick="closeModal()" class="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-red-600 text-white flex items-center justify-center z-20 text-lg">&times;</button>');
  html.push('<div class="flex flex-col md:flex-row">');

  html.push('<div class="md:w-1/3 p-6 border-b md:border-b-0 md:border-r border-white/5">');
  html.push('<img id="mPoster" src="" class="w-full rounded-xl shadow-lg mb-4" style="aspect-ratio:2/3;object-fit:cover">');
  html.push('<h2 id="mTitle" class="text-2xl font-bold mb-2"></h2>');
  html.push('<div id="mMeta" class="flex flex-wrap gap-2 mb-3 text-xs"></div>');
  html.push('<p id="mDesc" class="text-sm text-gray-400 leading-relaxed"></p>');
  html.push('</div>');

  html.push('<div class="md:w-2/3 p-6 flex flex-col">');
  html.push('<div id="playerBox" class="hidden mb-5 bg-black rounded-xl overflow-hidden shadow-2xl" style="aspect-ratio:16/9">');
  html.push('<video id="vid" controls autoplay class="w-full h-full"></video>');
  html.push('</div>');
  html.push('<div id="wtStatus" class="hidden mb-4 p-3 bg-white/5 rounded-lg text-sm">');
  html.push('<div id="wtText" class="mb-2 text-gray-300"></div>');
  html.push('<div class="progress-bar"><div id="wtBar" class="progress-fill" style="width:0%"></div></div>');
  html.push('</div>');
  html.push('<div class="flex items-center gap-2 mb-4">');
  html.push('<div id="spinIcon" class="w-5 h-5 border-2 border-red-500 border-t-transparent rounded-full animate-spin"></div>');
  html.push('<span id="streamLabel" class="font-bold text-red-400">Searching 20 addons...</span>');
  html.push('</div>');
  html.push('<div id="streamList" class="space-y-2 overflow-y-auto hide-sb" style="max-height:45vh"></div>');
  html.push('</div>');

  html.push('</div></div></div>');

  html.push('<script>');
  html.push('var grid=document.getElementById("grid");');
  html.push('var hero=document.getElementById("hero");');
  html.push('var modal=document.getElementById("modal-overlay");');
  html.push('var wtClient=null;');
  html.push('var currentTorrent=null;');

  html.push('async function init(){');
  html.push('try{');
  html.push('var r=await fetch("/api/library");');
  html.push('var metas=await r.json();');
  html.push('document.getElementById("statusBadge").textContent=metas.length+" titles loaded";');
  html.push('if(metas.length>0){');
  html.push('var f=metas[Math.floor(Math.random()*Math.min(15,metas.length))];');
  html.push('hero.className="mb-10 rounded-2xl overflow-hidden relative bg-cover bg-center";hero.style.height="45vh";');
  html.push('hero.style.backgroundImage="url("+(f.background||f.poster)+")";');
  html.push('hero.innerHTML=\'<div style="position:absolute;inset:0;background:linear-gradient(to top,#0a0a0f 5%,transparent 60%)"></div><div style="position:absolute;bottom:0;left:0;padding:2rem;max-width:600px"><h2 style="font-size:2.5rem;font-weight:800;margin-bottom:.5rem;text-shadow:0 2px 20px rgba(0,0,0,.8)">\'+f.name+\'</h2><p style="color:#aaa;font-size:.9rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:1rem">\'+(f.description||"")+\'</p><button onclick="openModal(\\\'\'+f.id+\'\\\',\\\'\'+(f.type||"series")+\'\\\',this.closest(\\\'#hero\\\').dataset.meta)" style="background:#dc2626;color:#fff;border:none;padding:10px 24px;border-radius:999px;font-weight:700;cursor:pointer;font-size:.95rem">Play Now</button></div>\';');
  html.push('hero.dataset.meta=JSON.stringify(f);');
  html.push('}');
  html.push('grid.innerHTML="";');
  html.push('metas.forEach(function(m){grid.innerHTML+=makeCard(m)});');
  html.push('}catch(e){grid.innerHTML=\'<div class="col-span-full text-center text-red-400 py-10">Failed to load. Refresh page.</div>\'}');
  html.push('}');

  html.push('function makeCard(m){');
  html.push('var p=m.poster||"https://via.placeholder.com/300x450/1a1a2e/555?text=No+Image";');
  html.push('var esc=JSON.stringify(m).replace(/"/g,"&quot;");');
  html.push('return \'<div class="card bg-white/5 rounded-lg overflow-hidden shadow-lg" onclick="openModal(\\\'\'+m.id+\'\\\',\\\'\'+(m.type||"series")+\'\\\',\'+esc.replace(/\'/g,"\\\\\'")+\'  )"><img src="\'+p+\'" class="w-full" style="height:260px;object-fit:cover" loading="lazy" onerror="this.src=\\\'https://via.placeholder.com/300x450/1a1a2e/555?text=No+Image\\\'"><div class="p-3"><h3 class="font-bold text-sm truncate">\'+m.name+\'</h3><p class="text-xs text-gray-500 mt-1">\'+(m.year||"")+" "+(m.type||"")+"</p></div></div>";');
  html.push('}');

  html.push('async function openModal(id,type,meta){');
  html.push('modal.classList.remove("hidden");modal.classList.add("flex");document.body.style.overflow="hidden";');
  html.push('cleanupPlayer();');
  html.push('if(meta){');
  html.push('document.getElementById("mPoster").src=meta.poster||"";');
  html.push('document.getElementById("mTitle").textContent=meta.name||"Unknown";');
  html.push('document.getElementById("mDesc").textContent=meta.description||"No description available.";');
  html.push('var mh="";');
  html.push('if(meta.year)mh+=\'<span class="bg-white/10 px-2 py-1 rounded">\'+meta.year+"</span>";');
  html.push('mh+=\'<span class="bg-white/10 px-2 py-1 rounded">\'+(type==="series"?"TV Series":"Movie")+"</span>";');
  html.push('if(meta.genres&&meta.genres.length)mh+=\'<span class="bg-red-900/40 text-red-300 px-2 py-1 rounded">\'+meta.genres.slice(0,3).join(", ")+"</span>";');
  html.push('mh+=\'<span class="bg-blue-900/40 text-blue-300 px-2 py-1 rounded">ID: \'+id+"</span>";');
  html.push('document.getElementById("mMeta").innerHTML=mh;');
  html.push('}');
  html.push('document.getElementById("streamList").innerHTML=\'<div class="text-center text-gray-500 py-6">Querying 20 addons...</div>\';');
  html.push('document.getElementById("spinIcon").classList.remove("hidden");');
  html.push('document.getElementById("streamLabel").textContent="Searching 20 addons...";');
  html.push('try{');
  html.push('var r=await fetch("/api/streams?type="+type+"&id="+encodeURIComponent(id));');
  html.push('var streams=await r.json();');
  html.push('document.getElementById("spinIcon").classList.add("hidden");');
  html.push('document.getElementById("streamLabel").textContent=streams.length+" streams found";');
  html.push('if(streams.length===0){document.getElementById("streamList").innerHTML=\'<div class="text-center text-red-400 py-6">No streams found. Try another title.</div>\';return;}');
  html.push('var h="";');
  html.push('streams.forEach(function(s,i){');
  html.push('var isVid=s.url&&(s.url.indexOf(".mp4")>-1||s.url.indexOf(".m3u8")>-1||s.url.indexOf(".mkv")>-1);');
  html.push('var isMag=s.url&&s.url.indexOf("magnet:")===0;');
  html.push('var badges=parseQ(s.title);');
  html.push('var btn="";');
  html.push('if(isVid)btn=\'<button onclick="playDirect(\\\'\'+s.url.replace(/\'/g,"\\\\\'")+\'\\\')" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white text-xs font-bold">PLAY</button>\';');
  html.push('else if(isMag)btn=\'<button onclick="playMagnet(\\\'\'+s.url.replace(/\'/g,"\\\\\'")+\'\\\')" class="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-white text-xs font-bold">STREAM</button>\';');
  html.push('else btn=\'<span class="text-xs text-gray-500">Unsupported</span>\';');
  html.push('h+=\'<div class="bg-white/5 border border-white/5 p-3 rounded-xl flex items-center justify-between gap-3 hover:border-red-500/30 transition"><div class="flex-1 min-w-0"><p class="text-sm font-semibold truncate">\'+(s.title||"Unknown stream")+\'</p><div class="flex items-center gap-2 mt-1 flex-wrap"><span class="text-[10px] text-gray-500 bg-white/5 px-2 py-0.5 rounded">\'+(s._src||"")+\'</span>\'+badges+(s.infoHash?\'<span class="badge bg-purple-900 text-purple-300">Torrent</span>\':"")+\'</div></div>\'+btn+"</div>";');
  html.push('});');
  html.push('document.getElementById("streamList").innerHTML=h;');
  html.push('}catch(e){document.getElementById("spinIcon").classList.add("hidden");document.getElementById("streamLabel").textContent="Error";document.getElementById("streamList").innerHTML=\'<div class="text-center text-red-400 py-6">Failed.</div>\';}');
  html.push('}');

  html.push('function parseQ(t){');
  html.push('if(!t)return"";var b="";');
  html.push('if(/(4k|2160p)/i.test(t))b+=\'<span class="badge bg-purple-600 text-white">4K</span>\';');
  html.push('if(/1080p/i.test(t))b+=\'<span class="badge bg-blue-600 text-white">1080p</span>\';');
  html.push('if(/720p/i.test(t))b+=\'<span class="badge bg-green-600 text-white">720p</span>\';');
  html.push('if(/480p/i.test(t))b+=\'<span class="badge bg-yellow-600 text-black">480p</span>\';');
  html.push('if(/(hevc|h265|x265)/i.test(t))b+=\'<span class="badge bg-pink-600 text-white">HEVC</span>\';');
  html.push('if(/dual.audio/i.test(t))b+=\'<span class="badge bg-indigo-600 text-white">Dual</span>\';');
  html.push('return b;');
  html.push('}');

  html.push('function playDirect(url){');
  html.push('cleanupPlayer();');
  html.push('var box=document.getElementById("playerBox");box.classList.remove("hidden");');
  html.push('var v=document.getElementById("vid");');
  html.push('if(url.indexOf(".m3u8")>-1){');
  html.push('if(typeof Hls!=="undefined"&&Hls.isSupported()){var h=new Hls();h.loadSource(url);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,function(){v.play()});}');
  html.push('else if(v.canPlayType("application/vnd.apple.mpegurl")){v.src=url;v.play();}');
  html.push('}else{v.src=url;v.play();}');
  html.push('box.scrollIntoView({behavior:"smooth",block:"center"});');
  html.push('}');

  html.push('function playMagnet(magnetUrl){');
  html.push('cleanupPlayer();');
  html.push('var box=document.getElementById("playerBox");box.classList.remove("hidden");');
  html.push('var v=document.getElementById("vid");');
  html.push('var ws=document.getElementById("wtStatus");ws.classList.remove("hidden");');
  html.push('var wt=document.getElementById("wtText");');
  html.push('var wb=document.getElementById("wtBar");');
  html.push('wt.textContent="Initializing WebTorrent...";wb.style.width="0%";');
  html.push('if(typeof WebTorrent==="undefined"){wt.textContent="WebTorrent failed to load. Copy magnet link to use in qBittorrent or VLC.";return;}');
  html.push('if(!wtClient){try{wtClient=new WebTorrent();}catch(e){wt.textContent="WebTorrent error: "+e.message;return;}}');
  html.push('wtClient.torrents.forEach(function(t){t.destroy()});');
  html.push('wt.textContent="Connecting to peers... This may take 10-30 seconds.";');
  html.push('var timeout=setTimeout(function(){if(currentTorrent&&currentTorrent.progress<0.01){wt.textContent="No peers found. Copy magnet to use desktop torrent client.";}},15000);');
  html.push('currentTorrent=wtClient.add(magnetUrl,function(torrent){');
  html.push('clearTimeout(timeout);');
  html.push('torrent.on("metadata",function(){wt.textContent="Metadata loaded. Finding video...";});');
  html.push('torrent.on("ready",function(){');
  html.push('var vf=torrent.files.filter(function(f){return/\\.(mp4|webm|mkv|avi|mov)$/i.test(f.name)}).sort(function(a,b){return b.length-a.length})[0];');
  html.push('if(!vf){wt.textContent="No video file in torrent. Files: "+torrent.files.map(function(f){return f.name}).join(", ");return;}');
  html.push('if(/\\.(mp4|webm)$/i.test(vf.name)){vf.renderTo(v,{autoplay:true});wt.textContent="Streaming: "+vf.name;}');
  html.push('else{wt.textContent=vf.name+" (MKV/AVI may not play in browser). Try copying magnet to VLC or qBittorrent.";}');
  html.push('});');
  html.push('torrent.on("download",function(){');
  html.push('var pct=(torrent.progress*100).toFixed(1);');
  html.push('var spd=(torrent.downloadSpeed/1024/1024).toFixed(2);');
  html.push('wt.textContent=pct+"% | "+spd+" MB/s | "+torrent.numPeers+" peers";');
  html.push('wb.style.width=pct+"%";');
  html.push('});');
  html.push('torrent.on("error",function(err){wt.textContent="Torrent error: "+err.message;});');
  html.push('});');
  html.push('box.scrollIntoView({behavior:"smooth",block:"center"});');
  html.push('}');

  html.push('function cleanupPlayer(){');
  html.push('var v=document.getElementById("vid");if(v){v.pause();v.removeAttribute("src");v.load();}');
  html.push('if(currentTorrent){try{currentTorrent.destroy();}catch(e){}}currentTorrent=null;');
  html.push('document.getElementById("playerBox").classList.add("hidden");');
  html.push('document.getElementById("wtStatus").classList.add("hidden");');
  html.push('}');

  html.push('function closeModal(){');
  html.push('modal.classList.add("hidden");modal.classList.remove("flex");document.body.style.overflow="";cleanupPlayer();');
  html.push('}');

  html.push('document.getElementById("searchBox").addEventListener("keypress",async function(e){');
  html.push('if(e.key!=="Enter")return;var q=this.value.trim();if(!q)return;');
  html.push('document.getElementById("sectionLabel").textContent="Searching: "+q;');
  html.push('grid.innerHTML=\'<div class="col-span-full text-center py-10"><div class="inline-block w-8 h-8 border-3 border-red-500 border-t-transparent rounded-full animate-spin"></div></div>\';');
  html.push('try{var r=await fetch("/api/search?q="+encodeURIComponent(q));var m=await r.json();');
  html.push('if(m.length===0){grid.innerHTML=\'<div class="col-span-full text-center text-gray-500 py-10">No results.</div>\';}');
  html.push('else{grid.innerHTML="";m.forEach(function(x){grid.innerHTML+=makeCard(x)});}');
  html.push('}catch(e){grid.innerHTML=\'<div class="col-span-full text-center text-red-400 py-10">Search failed.</div>\';}');
  html.push('});');

  html.push('init();');
  html.push('<\/script></body></html>');

  res.send(html.join('\n'));
});

app.listen(PORT, function() {
  console.log('AniStream v2 running on port ' + PORT);
});
