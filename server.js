const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. FAST & RELIABLE ADDONS ONLY
// ==========================================
// We removed slow addons. Torrentio is the king of streams. 
// Cinemeta/Kitsu provide the fastest, most accurate metadata.
const STREAM_ADDONS = [
  { name: "Torrentio", baseUrl: "https://torrentio.strem.fun" },
  { name: "Kitsu Anime", baseUrl: "https://anime.kitsu.io" }
];

// ==========================================
// 2. HIGH-PERFORMANCE CACHING & PROXY
// ==========================================
const cache = new Map();

function getCache(key) {
  const item = cache.get(key);
  if (item && Date.now() < item.expiry) return item.data;
  if (item) cache.delete(key);
  return null;
}

function setCache(key, data, ttlMs = 3600000) {
  if (cache.size >= 200) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

async function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'Stremio/4.0.0' }
    });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

app.get('/api/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const cached = getCache(url);
  if (cached) return res.json(cached);

  try {
    const data = await fetchWithTimeout(url, 8000);
    setCache(url, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Proxy timeout or failed' });
  }
});

// ==========================================
// 3. OPTIMIZED API ENDPOINTS
// ==========================================

// Instant trending library (cached for 1 hour)
app.get('/api/trending', async (req, res) => {
  const cached = getCache('trending_anime');
  if (cached) return res.json(cached);

  try {
    const data = await fetchWithTimeout('https://v3-cinemeta.strem.io/catalog/series/top.json', 5000);
    const metas = (data.metas || []).filter(m => m.name && m.poster).slice(0, 60);
    setCache('trending_anime', metas, 3600000);
    res.json(metas);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trending' });
  }
});

// Fast search endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  
  const cacheKey = `search_${query}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await fetchWithTimeout(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(query)}.json`, 5000);
    const metas = (data.metas || []).slice(0, 30);
    setCache(cacheKey, metas, 300000);
    res.json(metas);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Ultra-fast stream aggregation with individual timeouts
app.get('/api/streams', async (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'Missing type or id' });

  const promises = STREAM_ADDONS.map(async (addon) => {
    const url = `${addon.baseUrl}/stream/${type}/${id}.json`;
    try {
      // Strict 4-second timeout per addon. If it hangs, it's skipped instantly.
      const data = await fetchWithTimeout(url, 4000);
      return (data.streams || []).map(s => ({ ...s, provider: addon.name }));
    } catch (err) {
      return []; // Silently fail and move on
    }
  });

  const results = await Promise.all(promises);
  const streams = results.flat().filter(s => s.url || s.infoHash);
  
  // Prioritize Torrentio streams
  streams.sort((a, b) => {
    if (a.provider === "Torrentio" && b.provider !== "Torrentio") return -1;
    if (b.provider === "Torrentio" && a.provider !== "Torrentio") return 1;
    return 0;
  });

  res.json(streams);
});

// ==========================================
// 4. PREMIUM FRONTEND UI
// ==========================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AniStream | Ultra-Fast</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { background: #0b0f19; color: #e2e8f0; font-family: 'Inter', system-ui, sans-serif; }
    .glass { background: rgba(11, 15, 25, 0.85); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.05); }
    .card { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card:hover { transform: scale(1.05); z-index: 10; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6); }
    .scrollbar-hide::-webkit-scrollbar { display: none; }
    .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
    .skeleton { background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: loading 1.5s infinite; }
    @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .modal-bg { backdrop-filter: blur(8px); background: rgba(0,0,0,0.85); }
  </style>
</head>
<body class="min-h-screen">

  <header class="glass fixed top-0 w-full z-50 px-4 md:px-8 py-3 flex flex-col md:flex-row justify-between items-center gap-4">
    <div class="flex items-center gap-3 w-full md:w-auto justify-between">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center font-bold text-white">A</div>
        <h1 class="text-xl md:text-2xl font-bold tracking-tight">Ani<span class="text-red-500">Stream</span></h1>
      </div>
      <button id="mobileSearchBtn" class="md:hidden text-gray-300">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
      </button>
    </div>
    <div id="searchContainer" class="w-full md:w-96 hidden md:block">
      <div class="relative">
        <input id="searchInput" type="text" placeholder="Search anime (e.g., Naruto, One Piece)..." 
          class="w-full bg-slate-800/80 border border-slate-700 rounded-full py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition">
        <svg class="absolute left-3 top-2.5 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
      </div>
    </div>
  </header>

  <main class="pt-24 pb-10 px-4 md:px-8 max-w-7xl mx-auto">
    <div id="heroSection" class="mb-10 rounded-2xl overflow-hidden relative h-[40vh] md:h-[50vh] skeleton"></div>
    
    <div class="flex items-center justify-between mb-6">
      <h2 id="sectionTitle" class="text-2xl md:text-3xl font-bold">Trending Anime</h2>
      <span id="statusText" class="text-xs text-slate-400 bg-slate-800 px-3 py-1 rounded-full">Loading library...</span>
    </div>

    <div id="contentGrid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
      <div class="skeleton h-64 rounded-lg"></div>
      <div class="skeleton h-64 rounded-lg"></div>
      <div class="skeleton h-64 rounded-lg"></div>
      <div class="skeleton h-64 rounded-lg"></div>
      <div class="skeleton h-64 rounded-lg"></div>
      <div class="skeleton h-64 rounded-lg"></div>
    </div>
  </main>

  <div id="modal" class="fixed inset-0 modal-bg hidden z-50 flex items-center justify-center p-4 overflow-y-auto">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-5xl w-full my-8 shadow-2xl relative overflow-hidden">
      <button onclick="closeModal()" class="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-slate-800/80 hover:bg-red-600 transition text-white z-20 backdrop-blur-sm">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>
      
      <div class="flex flex-col md:flex-row">
        <div class="md:w-1/3 p-6 bg-slate-950/50">
          <img id="modalPoster" src="" class="w-full rounded-xl shadow-lg mb-4 object-cover aspect-[2/3] skeleton">
          <h2 id="modalTitle" class="text-2xl font-bold mb-2 leading-tight"></h2>
          <div id="modalMeta" class="flex flex-wrap gap-2 mb-4 text-xs"></div>
          <p id="modalDesc" class="text-sm text-slate-300 leading-relaxed line-clamp-6"></p>
        </div>
        
        <div class="md:w-2/3 p-6 flex flex-col">
          <div id="playerContainer" class="hidden mb-6 bg-black rounded-xl overflow-hidden shadow-2xl aspect-video">
            <video id="videoPlayer" controls class="w-full h-full"></video>
          </div>
          
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-xl font-bold text-red-400 flex items-center gap-2">
              <svg id="loadingSpinner" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
              <span id="streamCount">Finding Streams...</span>
            </h3>
          </div>
          
          <div id="streamList" class="space-y-3 overflow-y-auto max-h-[40vh] pr-2 scrollbar-hide"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const contentGrid = document.getElementById('contentGrid');
    const modal = document.getElementById('modal');
    const heroSection = document.getElementById('heroSection');
    const statusText = document.getElementById('statusText');
    let hlsInstance = null;

    async function init() {
      try {
        const res = await fetch('/api/trending');
        const metas = await res.json();
        statusText.innerText = \`🟢 \${metas.length} Titles Loaded Instantly\`;
        
        if (metas.length > 0) {
          const featured = metas[Math.floor(Math.random() * Math.min(10, metas.length))];
          heroSection.className = "mb-10 rounded-2xl overflow-hidden relative h-[40vh] md:h-[50vh] bg-cover bg-center";
          heroSection.style.backgroundImage = \`url(\${featured.background || featured.poster})\`;
          heroSection.innerHTML = \`
            <div class="absolute inset-0 bg-gradient-to-t from-[#0b0f19] via-transparent to-transparent"></div>
            <div class="absolute bottom-0 left-0 p-6 md:p-10 max-w-2xl">
              <h2 class="text-3xl md:text-5xl font-bold mb-2 drop-shadow-lg">\${featured.name}</h2>
              <p class="text-slate-300 text-sm md:text-base line-clamp-3 mb-4">\${featured.description || 'No description available.'}</p>
              <button onclick='openModalById("\${featured.id}", "\${featured.type || 'series'}")' class="px-6 py-2 bg-red-600 hover:bg-red-700 rounded-full font-semibold transition flex items-center gap-2">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg>
                Play Now
              </button>
            </div>
          \`;
        }

        contentGrid.innerHTML = metas.map(m => createCard(m)).join('');
      } catch (err) {
        statusText.innerText = 'Failed to load library';
        contentGrid.innerHTML = '<div class="col-span-full text-center text-red-500 py-10">Failed to load library. Please refresh.</div>';
      }
    }

    function createCard(meta) {
      return \`
        <div class="card bg-slate-800 rounded-lg overflow-hidden cursor-pointer shadow-lg" 
             onclick='openModalById("\${meta.id}", "\${meta.type || 'series'}", \${JSON.stringify(meta).replace(/"/g, '&quot;')})'>
          <img src="\${meta.poster}" class="w-full h-64 object-cover" loading="lazy" onerror="this.src='https://via.placeholder.com/300x450/1e293b/64748b?text=No+Image'">
          <div class="p-3">
            <h3 class="font-bold text-sm truncate">\${meta.name}</h3>
            <p class="text-xs text-slate-400 mt-1">\${meta.year || 'N/A'}</p>
          </div>
        </div>
      \`;
    }

    async function openModalById(id, type, metaObj = null) {
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      
      if (metaObj) {
        document.getElementById('modalPoster').src = metaObj.poster || 'https://via.placeholder.com/300x450?text=No+Image';
        document.getElementById('modalTitle').innerText = metaObj.name;
        document.getElementById('modalDesc').innerText = metaObj.description || 'No description available.';
        document.getElementById('modalMeta').innerHTML = \`
          <span class="bg-slate-800 px-2 py-1 rounded text-slate-300">\${type === 'series' ? 'TV Series' : 'Movie'}</span>
          <span class="bg-slate-800 px-2 py-1 rounded text-slate-300">\${metaObj.year || 'N/A'}</span>
          <span class="bg-red-900/50 text-red-300 px-2 py-1 rounded border border-red-800">Stremio Source</span>
        \`;
      }

      document.getElementById('playerContainer').classList.add('hidden');
      const video = document.getElementById('videoPlayer');
      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
      video.pause();
      video.src = '';
      
      document.getElementById('streamList').innerHTML = '<div class="text-center text-slate-500 py-8">Querying high-speed addons...</div>';
      document.getElementById('loadingSpinner').classList.remove('hidden');
      document.getElementById('streamCount').innerText = 'Finding Streams...';

      try {
        const res = await fetch(\`/api/streams?type=\${type}&id=\${encodeURIComponent(id)}\`);
        const streams = await res.json();
        
        document.getElementById('loadingSpinner').classList.add('hidden');
        document.getElementById('streamCount').innerText = \`\${streams.length} Streams Found\`;
        
        if (streams.length === 0) {
          document.getElementById('streamList').innerHTML = '<div class="text-center text-red-400 py-8">No streams found. Try a different title.</div>';
          return;
        }

        document.getElementById('streamList').innerHTML = streams.map(stream => {
          const isVideo = stream.url && (stream.url.includes('.mp4') || stream.url.includes('.m3u8') || stream.url.includes('.mkv'));
          const isMagnet = stream.url && stream.url.startsWith('magnet:');
          const badges = parseQuality(stream.title);
          
          let actionBtn = '';
          if (isVideo) {
            actionBtn = \`<button onclick="playStream('\${stream.url}')" class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white text-sm font-bold transition flex items-center gap-2"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg> Play</button>\`;
          } else if (isMagnet) {
            actionBtn = \`<button onclick="copyMagnet('\${stream.url}')" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm font-bold transition flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg> Copy Magnet</button>\`;
          } else {
            actionBtn = \`<a href="\${stream.url}" target="_blank" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white text-sm font-bold transition">Open Link</a>\`;
          }

          return \`
            <div class="bg-slate-800/50 border border-slate-700 p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-red-500/50 transition group">
              <div class="flex-1 min-w-0">
                <p class="font-semibold text-sm text-slate-200 truncate group-hover:text-white transition">\${stream.title || 'Unknown Quality Stream'}</p>
                <div class="flex items-center gap-2 mt-2 flex-wrap">
                  <span class="text-xs font-bold text-slate-400 bg-slate-900 px-2 py-0.5 rounded">\${stream.provider}</span>
                  \${badges.map(b => \`<span class="text-[10px] font-bold uppercase tracking-wider \${b.color} px-2 py-0.5 rounded">\${b.text}</span>\`).join('')}
                  \${stream.infoHash ? '<span class="text-[10px] font-bold uppercase tracking-wider bg-purple-900 text-purple-300 px-2 py-0.5 rounded">Torrent</span>' : ''}
                </div>
              </div>
              \${actionBtn}
            </div>
          \`;
        }).join('');
      } catch (err) {
        document.getElementById('loadingSpinner').classList.add('hidden');
        document.getElementById('streamCount').innerText = 'Error';
        document.getElementById('streamList').innerHTML = '<div class="text-center text-red-400 py-8">Failed to load streams.</div>';
      }
    }

    function parseQuality(title) {
      if (!title) return [];
      const badges = [];
      if (/\\b(4k|2160p)\\b/i.test(title)) badges.push({ text: '4K', color: 'bg-purple-600 text-white' });
      if (/\\b1080p\\b/i.test(title)) badges.push({ text: '1080p', color: 'bg-blue-600 text-white' });
      if (/\\b720p\\b/i.test(title)) badges.push({ text: '720p', color: 'bg-green-600 text-white' });
      if (/\\b480p\\b/i.test(title)) badges.push({ text: '480p', color: 'bg-yellow-600 text-black' });
      if (/\\b(h265|hevc|x265)\\b/i.test(title)) badges.push({ text: 'HEVC', color: 'bg-pink-600 text-white' });
      if (/\\b(dual audio)\\b/i.test(title)) badges.push({ text: 'Dual Audio', color: 'bg-indigo-600 text-white' });
      return badges;
    }

    function playStream(url) {
      const container = document.getElementById('playerContainer');
      const video = document.getElementById('videoPlayer');
      container.classList.remove('hidden');
      
      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
      
      if (url.includes('.m3u8')) {
        if (Hls.isSupported()) {
          hlsInstance = new Hls();
          hlsInstance.loadSource(url);
          hlsInstance.attachMedia(video);
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play());
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          video.play();
        }
      } else {
        video.src = url;
        video.play();
      }
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function copyMagnet(url) {
      navigator.clipboard.writeText(url);
      alert('Magnet link copied! Paste it into qBittorrent, Real-Debrid, or the Stremio desktop app.');
    }

    function closeModal() {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
      const video = document.getElementById('videoPlayer');
      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
      video.pause();
      video.src = '';
    }

    document.getElementById('searchInput').addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const query = e.target.value.trim();
        if (!query) return;
        
        document.getElementById('sectionTitle').innerText = \`Search Results: "\${query}"\`;
        statusText.innerText = 'Searching...';
        contentGrid.innerHTML = '<div class="col-span-full text-center py-10"><div class="inline-block w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div></div>';
        
        try {
          const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
          const metas = await res.json();
          statusText.innerText = \`🟢 \${metas.length} Results Found\`;
          
          if (metas.length === 0) {
            contentGrid.innerHTML = '<div class="col-span-full text-center text-slate-400 py-10">No results found. Try a different spelling.</div>';
          } else {
            contentGrid.innerHTML = metas.map(m => createCard(m)).join('');
          }
        } catch (err) {
          contentGrid.innerHTML = '<div class="col-span-full text-center text-red-500 py-10">Search failed.</div>';
        }
      }
    });

    document.getElementById('mobileSearchBtn').addEventListener('click', () => {
      const container = document.getElementById('searchContainer');
      container.classList.toggle('hidden');
      if (!container.classList.contains('hidden')) {
        document.getElementById('searchInput').focus();
      }
    });

    init();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 AniStream Ultra-Fast is running on port ${PORT}`);
});
