const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. TOP 10 ANIME & STREAMING ADDONS
// ==========================================
const ADDONS = [
  { name: "Cinemeta (Official)", url: "https://v3-cinemeta.strem.io/manifest.json", priority: 1 },
  { name: "Kitsu Anime", url: "https://anime.kitsu.io/manifest.json", priority: 1 },
  { name: "Torrentio", url: "https://torrentio.strem.fun/manifest.json", priority: 2 },
  { name: "OpenSubtitles", url: "https://opensubtitles-v3.strem.io/manifest.json", priority: 3 },
  { name: "TMDB", url: "https://tmdb.strem.io/manifest.json", priority: 2 },
  { name: "IMDb", url: "https://imdb.strem.io/manifest.json", priority: 3 },
  { name: "Trakt", url: "https://trakt.strem.io/manifest.json", priority: 3 },
  { name: "Local Media", url: "https://local-media.strem.io/manifest.json", priority: 4 },
  { name: "YouTube", url: "https://youtube.strem.io/manifest.json", priority: 4 },
  { name: "AnimeFlix", url: "https://animeflix.io/stremio/manifest.json", priority: 2 }
];

// ==========================================
// 2. MEMORY CACHE (For Render Free Tier)
// ==========================================
const MAX_CACHE = 100;
const cache = new Map();

function getCache(key) {
  const item = cache.get(key);
  if (item && Date.now() < item.expiry) return item.data;
  if (item) cache.delete(key);
  return null;
}

function setCache(key, data, ttlMs = 3600000) { // 1 hour default
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

// ==========================================
// 3. BACKEND PROXY & API
// ==========================================
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });

  const cached = getCache(url);
  if (cached) return res.json(cached);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stremio/4.0.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      setCache(url, data);
      res.json(data);
    } else {
      res.status(500).json({ error: 'Non-JSON response from addon' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Proxy failed', details: err.message });
  }
});

app.get('/api/addons', async (req, res) => {
  const results = await Promise.all(ADDONS.map(async (addon) => {
    const manifest = await fetch(`${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(addon.url)}`)
      .then(r => r.json()).catch(() => null);
    
    if (!manifest || !manifest.catalogs) return null;
    
    // Find anime/series catalogs
    const catalogs = manifest.catalogs.filter(c => c.type === 'anime' || c.type === 'series');
    return { ...addon, baseUrl: addon.url.replace('/manifest.json', ''), catalogs, manifest };
  }));

  res.json(results.filter(a => a !== null));
});

// ==========================================
// 4. FRONTEND UI (EMBEDDED)
// ==========================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AnimeStream.io | Stremio Web Client</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { background: #0b0f19; color: #e2e8f0; font-family: 'Inter', system-ui, sans-serif; }
    .glass { background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.05); }
    .card { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card:hover { transform: scale(1.05); z-index: 10; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    .scrollbar-hide::-webkit-scrollbar { display: none; }
    .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
    .snap-x { scroll-snap-type: x mandatory; }
    .snap-start { scroll-snap-align: start; }
    .badge { font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
    .skeleton { background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: loading 1.5s infinite; }
    @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .modal-bg { backdrop-filter: blur(8px); background: rgba(0,0,0,0.7); }
  </style>
</head>
<body class="min-h-screen">

  <!-- Header -->
  <header class="glass fixed top-0 w-full z-50 px-4 md:px-8 py-3 flex justify-between items-center">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center font-bold text-white">A</div>
      <h1 class="text-xl md:text-2xl font-bold tracking-tight">Anime<span class="text-red-500">Stream</span></h1>
    </div>
    <div class="flex-1 max-w-xl mx-4 hidden md:block">
      <div class="relative">
        <input id="searchInput" type="text" placeholder="Search anime..." 
          class="w-full bg-slate-800/50 border border-slate-700 rounded-full py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
        <svg class="absolute left-3 top-2.5 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
      </div>
    </div>
    <div id="addonStatus" class="text-xs text-slate-400 hidden md:block">Connecting...</div>
  </header>

  <!-- Main Content -->
  <main class="pt-20 pb-10 px-4 md:px-8">
    <div id="heroSection" class="mb-10 rounded-2xl overflow-hidden relative h-[40vh] md:h-[50vh] skeleton"></div>
    <div id="carouselsContainer" class="space-y-10"></div>
    <div id="searchResults" class="hidden grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6"></div>
  </main>

  <!-- Stream Modal -->
  <div id="modal" class="fixed inset-0 modal-bg hidden items-center justify-center z-50 p-4 overflow-y-auto">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full my-10 shadow-2xl relative">
      <button onclick="closeModal()" class="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 hover:bg-red-600 transition text-white z-10">&times;</button>
      <div id="modalContent" class="p-6">
        <div class="skeleton h-64 rounded-lg mb-4"></div>
        <div class="skeleton h-6 w-1/2 rounded mb-2"></div>
        <div class="skeleton h-4 w-1/3 rounded"></div>
      </div>
    </div>
  </div>

  <script>
    const state = { addons: [], metas: new Map() };
    const hero = document.getElementById('heroSection');
    const carousels = document.getElementById('carouselsContainer');
    const searchResults = document.getElementById('searchResults');
    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modalContent');
    const status = document.getElementById('addonStatus');

    // 1. INIT
    async function init() {
      const res = await fetch('/api/addons');
      state.addons = await res.json();
      status.innerText = \`🟢 \${state.addons.length} Addons Online\`;
      
      if (state.addons.length === 0) {
        hero.innerHTML = '<div class="flex items-center justify-center h-full text-red-500">All addons are offline. Please try again later.</div>';
        return;
      }

      fetchCatalogs();
    }

    // 2. FETCH CATALOGS
    async function fetchCatalogs() {
      const promises = state.addons.flatMap(addon => 
        addon.catalogs.slice(0, 2).map(async (cat) => {
          const url = \`/api/proxy?url=\${encodeURIComponent(\`\${addon.baseUrl}/catalog/\${cat.type}/\${cat.id}.json\`)}\`;
          const data = await fetch(url).then(r => r.json()).catch(() => ({ metas: [] }));
          return { addon, cat, metas: data.metas || [] };
        })
      );

      const results = await Promise.all(promises);
      renderUI(results);
    }

    // 3. RENDER UI
    function renderUI(catalogData) {
      // Hero
      const allMetas = catalogData.flatMap(c => c.metas);
      const uniqueMetas = Array.from(new Map(allMetas.map(m => [m.id, m])).values());
      
      if (uniqueMetas.length > 0) {
        const featured = uniqueMetas[Math.floor(Math.random() * Math.min(10, uniqueMetas.length))];
        hero.className = "mb-10 rounded-2xl overflow-hidden relative h-[40vh] md:h-[50vh] bg-cover bg-center";
        hero.style.backgroundImage = \`url(\${featured.background || featured.poster})\`;
        hero.innerHTML = \`
          <div class="absolute inset-0 bg-gradient-to-t from-[#0b0f19] via-transparent to-transparent"></div>
          <div class="absolute bottom-0 left-0 p-6 md:p-10 max-w-2xl">
            <h2 class="text-3xl md:text-5xl font-bold mb-2 drop-shadow-lg">\${featured.name}</h2>
            <p class="text-slate-300 text-sm md:text-base line-clamp-3 mb-4">\${featured.description || 'No description available.'}</p>
            <button onclick='openModal(\${JSON.stringify(featured).replace(/'/g, "&#39;")})' class="px-6 py-2 bg-red-600 hover:bg-red-700 rounded-full font-semibold transition flex items-center gap-2">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg>
              Play Now
            </button>
          </div>
        \`;
      }

      // Carousels
      carousels.innerHTML = '';
      const grouped = {};
      catalogData.forEach(c => {
        if (c.metas.length > 0) {
          const key = c.cat.extra?.genre || c.cat.name || c.addon.name;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(...c.metas);
        }
      });

      Object.entries(grouped).slice(0, 5).forEach(([title, metas]) => {
        const unique = Array.from(new Map(metas.map(m => [m.id, m])).values()).slice(0, 20);
        if (unique.length === 0) return;

        const row = document.createElement('div');
        row.className = "space-y-3";
        row.innerHTML = \`
          <h3 class="text-xl md:text-2xl font-bold px-1">\${title}</h3>
          <div class="flex overflow-x-auto gap-3 md:gap-4 pb-4 scrollbar-hide snap-x">
            \${unique.map(m => renderCard(m)).join('')}
          </div>
        \`;
        carousels.appendChild(row);
      });
    }

    function renderCard(meta) {
      const poster = meta.poster || 'https://via.placeholder.com/300x450/1e293b/64748b?text=No+Image';
      return \`
        <div class="card snap-start flex-shrink-0 w-32 md:w-44 cursor-pointer group relative rounded-lg overflow-hidden shadow-lg" onclick='openModal(\${JSON.stringify(meta).replace(/'/g, "&#39;")})'>
          <img src="\${poster}" alt="\${meta.name}" class="w-full h-48 md:h-64 object-cover" loading="lazy">
          <div class="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-3">
            <p class="text-sm font-semibold line-clamp-2">\${meta.name}</p>
          </div>
        </div>
      \`;
    }

    // 4. MODAL & STREAMS
    async function openModal(meta) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      document.body.style.overflow = 'hidden';
      
      modalContent.innerHTML = \`
        <div class="flex flex-col md:flex-row gap-6 mb-6">
          <img src="\${meta.poster}" class="w-32 md:w-48 rounded-lg shadow-xl self-start">
          <div>
            <h2 class="text-2xl md:text-3xl font-bold mb-2">\${meta.name}</h2>
            <p class="text-slate-400 text-sm line-clamp-4">\${meta.description || 'No description.'}</p>
          </div>
        </div>
        <h3 class="text-xl font-bold mb-4 text-red-400 flex items-center gap-2">
          <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          Querying Streams...
        </h3>
        <div id="streamList" class="space-y-3"></div>
        <div id="playerContainer" class="mt-6 hidden"></div>
      \`;

      const streamPromises = state.addons.map(async (addon) => {
        const type = meta.type || 'series';
        const id = meta.imdb_id || meta.id;
        const url = \`/api/proxy?url=\${encodeURIComponent(\`\${addon.baseUrl}/stream/\${type}/\${id}.json\`)}\`;
        const data = await fetch(url).then(r => r.json()).catch(() => ({ streams: [] }));
        return (data.streams || []).map(s => ({ ...s, provider: addon.name }));
      });

      const results = await Promise.all(streamPromises);
      const streams = results.flat().filter(s => s.url || s.externalUrl || s.infoHash);
      renderStreams(meta, streams);
    }

    function renderStreams(meta, streams) {
      const list = document.getElementById('streamList');
      const spinner = list.previousElementSibling;
      spinner.innerHTML = \`Found \${streams.length} Streams\`;
      spinner.querySelector('svg')?.remove();

      if (streams.length === 0) {
        list.innerHTML = '<p class="text-slate-500 text-center py-4">No streams found for this title.</p>';
        return;
      }

      list.innerHTML = streams.slice(0, 30).map(stream => {
        const isVideo = stream.url && (stream.url.includes('.mp4') || stream.url.includes('.m3u8'));
        const isMagnet = stream.url && stream.url.startsWith('magnet:');
        const badges = parseQuality(stream.title);
        
        let actionBtn = '';
        if (isVideo) {
          actionBtn = \`<button onclick="playVideo('\${stream.url}')" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white text-sm font-semibold transition">Play</button>\`;
        } else if (isMagnet) {
          actionBtn = \`<button onclick="copyMagnet('\${stream.url}')" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm font-semibold transition">Copy Magnet</button>\`;
        } else {
          actionBtn = \`<a href="\${stream.url}" target="_blank" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white text-sm font-semibold transition">Open</a>\`;
        }

        return \`
          <div class="bg-slate-800/50 border border-slate-700 p-4 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3 hover:border-red-500/50 transition">
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-sm truncate">\${stream.title || 'Unknown Stream'}</p>
              <div class="flex items-center gap-2 mt-1 flex-wrap">
                <span class="text-xs text-slate-400">\${stream.provider}</span>
                \${badges.map(b => \`<span class="badge \${b.color}">\${b.text}</span>\`).join('')}
                \${stream.infoHash ? '<span class="badge bg-purple-900 text-purple-300">Torrent</span>' : ''}
              </div>
            </div>
            \${actionBtn}
          </div>
        \`;
      }).join('');
    }

    function parseQuality(title) {
      if (!title) return [];
      const badges = [];
      if (/\\b(4k|2160p)\\b/i.test(title)) badges.push({ text: '4K', color: 'bg-purple-600' });
      if (/\\b1080p\\b/i.test(title)) badges.push({ text: '1080p', color: 'bg-blue-600' });
      if (/\\b720p\\b/i.test(title)) badges.push({ text: '720p', color: 'bg-green-600' });
      if (/\\b480p\\b/i.test(title)) badges.push({ text: '480p', color: 'bg-yellow-600' });
      if (/\\b(h265|hevc|x265)\\b/i.test(title)) badges.push({ text: 'HEVC', color: 'bg-pink-600' });
      return badges;
    }

    function playVideo(url) {
      const container = document.getElementById('playerContainer');
      container.classList.remove('hidden');
      container.innerHTML = \`<video id="player" controls autoplay class="w-full rounded-xl shadow-2xl bg-black"></video>\`;
      const video = document.getElementById('player');
      
      if (url.includes('.m3u8')) {
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(url);
          hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        }
      } else {
        video.src = url;
      }
      container.scrollIntoView({ behavior: 'smooth' });
    }

    function copyMagnet(url) {
      navigator.clipboard.writeText(url);
      alert('Magnet link copied! Paste it into qBittorrent, Real-Debrid, or Stremio.');
    }

    function closeModal() {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      document.body.style.overflow = '';
      document.getElementById('playerContainer')?.remove();
    }

    // 5. SEARCH
    document.getElementById('searchInput').addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const query = e.target.value.trim();
        if (!query) return;
        
        carousels.classList.add('hidden');
        hero.classList.add('hidden');
        searchResults.classList.remove('hidden');
        searchResults.innerHTML = '<div class="col-span-full text-center py-10 skeleton h-20 rounded"></div>';

        const metaAddon = state.addons.find(a => a.name.includes('Cinemeta') || a.name.includes('Kitsu'));
        if (!metaAddon) return;

        const cat = metaAddon.catalogs.find(c => c.type === 'anime' || c.type === 'series');
        const url = \`/api/proxy?url=\${encodeURIComponent(\`\${metaAddon.baseUrl}/catalog/\${cat.type}/\${cat.id}/search=\${query}.json\`)}\`;
        const data = await fetch(url).then(r => r.json()).catch(() => ({ metas: [] }));
        
        searchResults.innerHTML = data.metas.length > 0 
          ? data.metas.map(m => renderCard(m)).join('')
          : '<div class="col-span-full text-center py-10 text-slate-500">No results found.</div>';
      }
    });

    init();
  </script>
</body>
</html>`);
});

// ==========================================
// 5. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(\`🚀 AnimeStream.io is live on port \${PORT}\`);
});
