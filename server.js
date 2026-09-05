'use strict';

const express = require('express');
const fetch = require('node-fetch'); // Ensure you run: npm install node-fetch

const app = express();
app.disable('x-powered-by');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ANIKOTO_BASE = 'https://anikotoapi.site';

// Cache settings to respect Anikoto rate limits (60 req / 120s)
const CACHE_TTL_RECENT = 5 * 60 * 1000; // 5 minutes
const CACHE_TTL_SERIES = 30 * 60 * 1000; // 30 minutes (Episodes don't change often)

class SimpleCache {
  constructor() {
    this.store = new Map();
  }
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.store.delete(key);
      return null;
    }
    return item.data;
  }
  set(key, data, ttl) {
    this.store.set(key, {
      data,
      expiry: Date.now() + ttl
    });
  }
}

const cache = new SimpleCache();

// --- ANIKOTO API CLIENT ---

async function anikotoFetch(path) {
  try {
    const url = `${ANIKOTO_BASE}${path}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AniStream-Backend/1.0',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`Anikoto API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`[Anikoto] Failed to fetch ${path}:`, error.message);
    throw error;
  }
}

// --- ROUTES ---

// 1. Get Recent Anime (Library)
app.get('/api/recent', async (req, res) => {
  const page = req.query.page || 1;
  const cacheKey = `recent:${page}`;
  
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await anikotoFetch(`/recent-anime?page=${page}&per_page=24`);
    cache.set(cacheKey, data, CACHE_TTL_RECENT);
    res.json(data);
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

// 2. Search Anime
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  // Anikoto doesn't have a explicit search endpoint in the docs provided, 
  // but usually 'recent' or specific ID lookup is used. 
  // However, most anime APIs support a search param on recent or a dedicated endpoint.
  // Since the docs only show /recent-anime and /series/{id}, we will assume 
  // users browse via "Recent" or direct ID. 
  // *If* Anikoto supports search via a different undocumented path, it would go here.
  // For now, we'll return a helpful error or mock search if the API doesn't support it.
  
  // NOTE: Many simple anime APIs don't have robust search. 
  // We will implement a client-side filter or assume the user knows the ID.
  // If you find a search endpoint, replace this logic.
  
  res.status(404).json({ error: 'Search not supported by this API version. Browse via Recent.' });
});

// 3. Get Series Details (Episodes & Links)
app.get('/api/series/:id', async (req, res) => {
  const id = req.params.id;
  const cacheKey = `series:${id}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await anikotoFetch(`/series/${id}`);
    cache.set(cacheKey, data, CACHE_TTL_SERIES);
    res.json(data);
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

// --- FRONTEND ---

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AniKoto Stream</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background-color: #0f0f13; color: #e5e5e5; font-family: sans-serif; }
        .card:hover { transform: translateY(-4px); border-color: #ef4444; }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
    </style>
</head>
<body class="min-h-screen flex flex-col">

    <!-- Header -->
    <header class="sticky top-0 z-40 bg-[#0f0f13]/95 backdrop-blur border-b border-white/10 p-4">
        <div class="max-w-7xl mx-auto flex items-center justify-between">
            <h1 class="text-2xl font-bold text-red-500 tracking-tighter">AniKoto<span class="text-white">Stream</span></h1>
            <div class="text-xs text-gray-500">Powered by Anikoto API</div>
        </div>
    </header>

    <!-- Main Content -->
    <main class="flex-grow max-w-7xl mx-auto w-full p-4">
        
        <!-- Hero / Featured (First Item) -->
        <div id="hero" class="hidden mb-8 relative h-64 md:h-96 rounded-2xl overflow-hidden bg-gray-800">
            <img id="hero-img" src="" class="absolute inset-0 w-full h-full object-cover opacity-40">
            <div class="absolute inset-0 bg-gradient-to-t from-[#0f0f13] via-transparent to-transparent"></div>
            <div class="absolute bottom-0 left-0 p-6 md:p-10">
                <h2 id="hero-title" class="text-3xl md:text-5xl font-bold mb-2 drop-shadow-lg"></h2>
                <button id="hero-btn" class="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full font-bold transition">Watch Now</button>
            </div>
        </div>

        <!-- Grid -->
        <h3 class="text-xl font-bold mb-4 border-l-4 border-red-500 pl-3">Recent Releases</h3>
        <div id="grid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
            <!-- Loading Skeleton -->
            <div class="col-span-full py-10 text-center text-gray-500">Loading library...</div>
        </div>
        
        <div class="mt-8 flex justify-center gap-4">
            <button id="prev-page" class="px-4 py-2 bg-white/5 rounded hover:bg-white/10 disabled:opacity-50">Previous</button>
            <span id="page-indicator" class="py-2 text-gray-400">Page 1</span>
            <button id="next-page" class="px-4 py-2 bg-white/5 rounded hover:bg-white/10">Next</button>
        </div>
    </main>

    <!-- Player Modal -->
    <div id="modal" class="fixed inset-0 z-50 hidden bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-[#1a1a20] w-full max-w-5xl rounded-xl overflow-hidden shadow-2xl border border-white/10 flex flex-col max-h-[90vh]">
            
            <!-- Modal Header -->
            <div class="p-4 border-b border-white/10 flex justify-between items-center bg-[#15151a]">
                <div>
                    <h2 id="modal-title" class="text-lg font-bold text-white">Title</h2>
                    <p id="modal-sub" class="text-xs text-gray-400">Episode Selector</p>
                </div>
                <button id="close-modal" class="text-gray-400 hover:text-white text-2xl">&times;</button>
            </div>

            <!-- Video Player Area -->
            <div class="relative bg-black aspect-video w-full group">
                <iframe id="player-frame" class="w-full h-full" frameborder="0" allowfullscreen></iframe>
                <div id="player-overlay" class="absolute inset-0 flex items-center justify-center bg-black/50 hidden">
                    <div class="text-center">
                        <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-2"></div>
                        <p class="text-sm">Loading Stream...</p>
                    </div>
                </div>
            </div>

            <!-- Episode List -->
            <div class="flex-grow overflow-hidden flex flex-col md:flex-row">
                <div class="w-full md:w-64 bg-[#15151a] border-r border-white/10 p-4 overflow-y-auto max-h-40 md:max-h-full">
                    <h3 class="text-xs uppercase tracking-widest text-gray-500 mb-3">Episodes</h3>
                    <div id="episode-list" class="space-y-1">
                        <!-- Episodes injected here -->
                    </div>
                </div>
                
                <!-- Stream Options (Sub/Dub) -->
                <div class="flex-grow p-4 bg-[#1a1a20] overflow-y-auto">
                    <div class="mb-4">
                        <h3 class="text-sm font-bold text-gray-300 mb-2">Stream Source</h3>
                        <div class="flex gap-2">
                            <button id="btn-sub" class="flex-1 py-2 rounded bg-blue-600/20 text-blue-400 border border-blue-600/50 hover:bg-blue-600/40 text-sm font-bold transition">SUB</button>
                            <button id="btn-dub" class="flex-1 py-2 rounded bg-green-600/20 text-green-400 border border-green-600/50 hover:bg-green-600/40 text-sm font-bold transition">DUB</button>
                        </div>
                    </div>
                    <div class="text-xs text-gray-500 mt-4">
                        <p>Note: Streams are embedded from third-party providers. Popups may occur.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const API_BASE = ''; // Relative to current host
        
        let currentPage = 1;
        let currentSeries = null;
        let currentEpisodeIndex = 0;
        let currentType = 'sub'; // 'sub' or 'dub'

        // --- DOM Elements ---
        const grid = document.getElementById('grid');
        const modal = document.getElementById('modal');
        const playerFrame = document.getElementById('player-frame');
        const episodeList = document.getElementById('episode-list');
        
        // --- Fetch Data ---
        async function loadPage(page) {
            grid.innerHTML = '<div class="col-span-full py-10 text-center text-gray-500">Loading...</div>';
            try {
                const res = await fetch(\`\${API_BASE}/api/recent?page=\${page}\`);
                const data = await res.json();
                
                if (!data.ok || !data.data) throw new Error('Invalid data');
                
                renderGrid(data.data);
                
                // Setup Hero if first page
                if (page === 1 && data.data.length > 0) {
                    setupHero(data.data[0]);
                }
                
                currentPage = page;
                document.getElementById('page-indicator').textContent = \`Page \${page}\`;
                document.getElementById('prev-page').disabled = page <= 1;
                
            } catch (e) {
                grid.innerHTML = \`<div class="col-span-full text-red-500 text-center">Error: \${e.message}</div>\`;
            }
        }

        function renderGrid(items) {
            grid.innerHTML = '';
            items.forEach(anime => {
                const card = document.createElement('div');
                card.className = 'card bg-white/5 rounded-xl overflow-hidden cursor-pointer border border-white/5 transition duration-300';
                card.innerHTML = \`
                    <div class="aspect-[2/3] relative">
                        <img src="\${anime.image}" class="w-full h-full object-cover" loading="lazy">
                        <div class="absolute top-2 right-2 bg-black/60 px-2 py-1 text-xs rounded text-white backdrop-blur">
                            \${anime.type || 'TV'}
                        </div>
                    </div>
                    <div class="p-3">
                        <h4 class="font-bold text-sm truncate">\${anime.title}</h4>
                        <p class="text-xs text-gray-500 mt-1">\${anime.episodes ? anime.episodes + ' eps' : 'Unknown'}</p>
                    </div>
                \`;
                card.onclick = () => openSeries(anime.id);
                grid.appendChild(card);
            });
        }

        function setupHero(anime) {
            const hero = document.getElementById('hero');
            hero.classList.remove('hidden');
            document.getElementById('hero-img').src = anime.image;
            document.getElementById('hero-title').textContent = anime.title;
            document.getElementById('hero-btn').onclick = () => openSeries(anime.id);
        }

        // --- Series & Player Logic ---
        async function openSeries(id) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            document.body.style.overflow = 'hidden';
            
            // Reset Player
            playerFrame.src = '';
            document.getElementById('episode-list').innerHTML = '<div class="text-center text-gray-500 py-4">Loading episodes...</div>';
            
            try {
                const res = await fetch(\`\${API_BASE}/api/series/\${id}\`);
                const data = await res.json();
                
                if (!data.ok) throw new Error('Failed to load series');
                
                currentSeries = data.data;
                document.getElementById('modal-title').textContent = currentSeries.title;
                
                renderEpisodes();
                
                // Auto-play first episode
                playEpisode(0);
                
            } catch (e) {
                document.getElementById('episode-list').innerHTML = \`<div class="text-red-500">\${e.message}</div>\`;
            }
        }

        function renderEpisodes() {
            const list = document.getElementById('episode-list');
            list.innerHTML = '';
            
            if (!currentSeries.episodes || currentSeries.episodes.length === 0) {
                list.innerHTML = '<div class="text-gray-500 text-sm">No episodes found.</div>';
                return;
            }

            currentSeries.episodes.forEach((ep, index) => {
                const btn = document.createElement('button');
                btn.className = \`w-full text-left px-3 py-2 rounded text-sm transition \${index === currentEpisodeIndex ? 'bg-red-600 text-white' : 'hover:bg-white/10 text-gray-300'}\`;
                btn.textContent = \`Ep \${ep.number}: \${ep.title || 'Episode ' + ep.number}\`;
                btn.onclick = () => playEpisode(index);
                list.appendChild(btn);
            });
        }

        function playEpisode(index) {
            currentEpisodeIndex = index;
            renderEpisodes(); // Update active state
            
            const ep = currentSeries.episodes[index];
            document.getElementById('modal-sub').textContent = \`Playing: \${ep.title || 'Episode ' + ep.number}\`;
            
            // Determine URL based on Sub/Dub preference
            let url = '';
            if (currentType === 'sub' && ep.embed_url?.sub) {
                url = ep.embed_url.sub;
            } else if (currentType === 'dub' && ep.embed_url?.dub) {
                url = ep.embed_url.dub;
            } else if (ep.embed_url?.sub) {
                // Fallback to sub if dub missing
                url = ep.embed_url.sub;
                currentType = 'sub'; 
                updateTypeButtons();
            }

            if (url) {
                document.getElementById('player-overlay').classList.remove('hidden');
                playerFrame.src = url;
                // Hide overlay after delay (assuming load)
                setTimeout(() => document.getElementById('player-overlay').classList.add('hidden'), 2000);
            } else {
                alert('No stream available for this type.');
            }
        }

        function updateTypeButtons() {
            const subBtn = document.getElementById('btn-sub');
            const dubBtn = document.getElementById('btn-dub');
            
            if (currentType === 'sub') {
                subBtn.classList.add('bg-blue-600', 'text-white');
                subBtn.classList.remove('bg-blue-600/20', 'text-blue-400');
                dubBtn.classList.remove('bg-green-600', 'text-white');
                dubBtn.classList.add('bg-green-600/20', 'text-green-400');
            } else {
                dubBtn.classList.add('bg-green-600', 'text-white');
                dubBtn.classList.remove('bg-green-600/20', 'text-green-400');
                subBtn.classList.remove('bg-blue-600', 'text-white');
                subBtn.classList.add('bg-blue-600/20', 'text-blue-400');
            }
        }

        // --- Event Listeners ---
        document.getElementById('close-modal').onclick = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = '';
            playerFrame.src = ''; // Stop video
        };

        document.getElementById('btn-sub').onclick = () => {
            currentType = 'sub';
            updateTypeButtons();
            playEpisode(currentEpisodeIndex);
        };

        document.getElementById('btn-dub').onclick = () => {
            currentType = 'dub';
            updateTypeButtons();
            playEpisode(currentEpisodeIndex);
        };

        document.getElementById('next-page').onclick = () => loadPage(currentPage + 1);
        document.getElementById('prev-page').onclick = () => loadPage(currentPage - 1);

        // Init
        loadPage(1);
        updateTypeButtons();

    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.type('html').send(INDEX_HTML);
});

// Start Server
app.listen(PORT, HOST, () => {
    console.log(`AniKoto Stream running at http://${HOST}:${PORT}`);
});
