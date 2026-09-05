'use strict';

const express = require('express');
// No need for node-fetch! Node 18+ has global fetch built-in.

const app = express();
app.disable('x-powered-by');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ANIKOTO_BASE = 'https://anikotoapi.site';

// Cache to protect against Anikoto rate limits (60 req / 120s)
const CACHE_TTL_RECENT = 5 * 60 * 1000; // 5 minutes
const CACHE_TTL_SERIES = 60 * 60 * 1000; // 1 hour (Series data rarely changes)

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

// --- HELPER: SAFE FETCH ---
async function safeFetch(path) {
  const url = `${ANIKOTO_BASE}${path}`;
  try {
    // Using native Node 18 fetch
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AniStream-Backend/2.0',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) {
      // If Anikoto returns 429 (Too Many Requests), we log it but don't crash
      if (response.status === 429) {
        console.warn('[Anikoto] Rate limit hit (429). Serving stale cache if available.');
      }
      throw new Error(`API Error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`[Fetch Error] ${path}:`, error.message);
    throw error;
  }
}

// --- API ROUTES ---

// 1. Get Recent Anime
app.get('/api/recent', async (req, res) => {
  const page = req.query.page || 1;
  const cacheKey = `recent:${page}`;
  
  // Try cache first
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await safeFetch(`/recent-anime?page=${page}&per_page=24`);
    
    // Validate structure slightly
    if (!data || !Array.isArray(data.data)) {
       throw new Error('Invalid API response structure');
    }

    cache.set(cacheKey, data, CACHE_TTL_RECENT);
    res.json(data);
  } catch (error) {
    // If we fail, check if we have stale cache to show *something*
    const stale = cache.get(cacheKey); // Note: simple cache deletes on expiry, so this might be null
    if (stale) {
      console.log('Serving stale cache due to error');
      return res.json(stale);
    }
    res.status(502).json({ ok: false, error: 'Failed to load library' });
  }
});

// 2. Get Series Details
app.get('/api/series/:id', async (req, res) => {
  const id = req.params.id;
  // Basic ID validation to prevent weird paths
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  const cacheKey = `series:${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await safeFetch(`/series/${id}`);
    if (!data || !data.data) {
      throw new Error('Series not found');
    }
    cache.set(cacheKey, data, CACHE_TTL_SERIES);
    res.json(data);
  } catch (error) {
    res.status(502).json({ ok: false, error: 'Failed to load series details' });
  }
});

// --- FRONTEND (Single File HTML) ---

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
        /* Loader Animation */
        .loader {
            border: 3px solid rgba(255,255,255,0.1);
            border-radius: 50%;
            border-top: 3px solid #ef4444;
            width: 24px;
            height: 24px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body class="min-h-screen flex flex-col">

    <!-- Header -->
    <header class="sticky top-0 z-40 bg-[#0f0f13]/95 backdrop-blur border-b border-white/10 p-4 shadow-lg">
        <div class="max-w-7xl mx-auto flex items-center justify-between">
            <h1 class="text-2xl font-bold text-red-500 tracking-tighter">AniKoto<span class="text-white">Stream</span></h1>
            <div class="text-xs text-gray-500 hidden sm:block">Native Node.js Backend</div>
        </div>
    </header>

    <!-- Main Content -->
    <main class="flex-grow max-w-7xl mx-auto w-full p-4">
        
        <!-- Hero Section -->
        <div id="hero" class="hidden mb-8 relative h-64 md:h-96 rounded-2xl overflow-hidden bg-gray-800 shadow-2xl">
            <img id="hero-img" src="" class="absolute inset-0 w-full h-full object-cover opacity-40 transition-opacity duration-500">
            <div class="absolute inset-0 bg-gradient-to-t from-[#0f0f13] via-transparent to-transparent"></div>
            <div class="absolute bottom-0 left-0 p-6 md:p-10 max-w-2xl">
                <h2 id="hero-title" class="text-3xl md:text-5xl font-bold mb-2 drop-shadow-lg text-white"></h2>
                <button id="hero-btn" class="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full font-bold transition shadow-lg mt-2">Watch Now</button>
            </div>
        </div>

        <!-- Grid -->
        <div class="flex items-center justify-between mb-4">
            <h3 class="text-xl font-bold border-l-4 border-red-500 pl-3">Recent Releases</h3>
            <div id="status-indicator" class="text-xs text-gray-500"></div>
        </div>

        <div id="grid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6 min-h-[400px]">
            <!-- Loading State -->
            <div class="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
                <div class="loader mb-4"></div>
                <p>Loading library...</p>
            </div>
        </div>
        
        <!-- Pagination -->
        <div class="mt-12 flex justify-center gap-4 pb-8">
            <button id="prev-page" class="px-6 py-2 bg-white/5 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition border border-white/5">Previous</button>
            <span id="page-indicator" class="py-2 text-gray-400 font-mono">Page 1</span>
            <button id="next-page" class="px-6 py-2 bg-white/5 rounded-lg hover:bg-white/10 transition border border-white/5">Next</button>
        </div>
    </main>

    <!-- Player Modal -->
    <div id="modal" class="fixed inset-0 z-50 hidden bg-black/95 backdrop-blur-md flex items-center justify-center p-0 md:p-4">
        <div class="bg-[#1a1a20] w-full h-full md:h-auto md:max-w-6xl md:rounded-2xl overflow-hidden shadow-2xl border border-white/10 flex flex-col">
            
            <!-- Modal Header -->
            <div class="p-4 border-b border-white/10 flex justify-between items-center bg-[#15151a] shrink-0">
                <div class="overflow-hidden">
                    <h2 id="modal-title" class="text-lg font-bold text-white truncate">Title</h2>
                    <p id="modal-sub" class="text-xs text-gray-400">Select an episode</p>
                </div>
                <button id="close-modal" class="text-gray-400 hover:text-white text-3xl leading-none px-2">&times;</button>
            </div>

            <!-- Video Player Area -->
            <div class="relative bg-black aspect-video w-full shrink-0">
                <iframe id="player-frame" class="w-full h-full" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>
                <div id="player-overlay" class="absolute inset-0 flex items-center justify-center bg-black/80 hidden z-10">
                    <div class="text-center">
                        <div class="loader mx-auto mb-2"></div>
                        <p class="text-sm text-gray-300">Loading Stream...</p>
                    </div>
                </div>
            </div>

            <!-- Controls & Episodes -->
            <div class="flex-grow flex flex-col md:flex-row overflow-hidden">
                <!-- Episode List -->
                <div class="w-full md:w-72 bg-[#15151a] border-r border-white/10 flex flex-col">
                    <div class="p-3 border-b border-white/5 bg-[#1a1a20]">
                        <h3 class="text-xs uppercase tracking-widest text-gray-500 font-bold">Episodes</h3>
                    </div>
                    <div id="episode-list" class="flex-grow overflow-y-auto p-2 space-y-1 scrollbar-hide">
                        <!-- Episodes injected here -->
                    </div>
                </div>
                
                <!-- Stream Options -->
                <div class="flex-grow p-6 bg-[#1a1a20]">
                    <h3 class="text-sm font-bold text-gray-300 mb-4">Audio Preference</h3>
                    <div class="flex gap-4 mb-6">
                        <button id="btn-sub" class="flex-1 py-3 rounded-lg bg-blue-600/10 text-blue-400 border border-blue-600/30 hover:bg-blue-600/20 hover:border-blue-500 transition font-bold text-sm">
                            SUBTITLED
                        </button>
                        <button id="btn-dub" class="flex-1 py-3 rounded-lg bg-green-600/10 text-green-400 border border-green-600/30 hover:bg-green-600/20 hover:border-green-500 transition font-bold text-sm">
                            DUBBED
                        </button>
                    </div>
                    
                    <div class="bg-black/30 rounded-lg p-4 text-xs text-gray-500 border border-white/5">
                        <p class="mb-2"><strong class="text-gray-400">Note:</strong> Streams are embedded from third-party providers. If a stream fails to load, try switching between Sub/Dub or refreshing the page.</p>
                        <p>Popups may occur on the source provider's end.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const API_BASE = ''; 
        
        let currentPage = 1;
        let currentSeries = null;
        let currentEpisodeIndex = 0;
        let currentType = 'sub'; // 'sub' or 'dub'

        // --- DOM Elements ---
        const grid = document.getElementById('grid');
        const modal = document.getElementById('modal');
        const playerFrame = document.getElementById('player-frame');
        const episodeList = document.getElementById('episode-list');
        const hero = document.getElementById('hero');
        
        // --- Fetch Data ---
        async function loadPage(page) {
            grid.innerHTML = \`
                <div class="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
                    <div class="loader mb-4"></div>
                    <p>Loading page \${page}...</p>
                </div>\`;
            
            document.getElementById('status-indicator').textContent = 'Fetching...';

            try {
                const res = await fetch(\`\${API_BASE}/api/recent?page=\${page}\`);
                if (!res.ok) throw new Error('Network response was not ok');
                const data = await res.json();
                
                if (!data.ok || !data.data) throw new Error('Invalid data structure');
                
                renderGrid(data.data);
                document.getElementById('status-indicator').textContent = 'Updated just now';
                
                // Setup Hero if first page
                if (page === 1 && data.data.length > 0) {
                    setupHero(data.data[0]);
                }
                
                currentPage = page;
                document.getElementById('page-indicator').textContent = \`Page \${page}\`;
                document.getElementById('prev-page').disabled = page <= 1;
                
            } catch (e) {
                console.error(e);
                grid.innerHTML = \`<div class="col-span-full text-red-500 text-center py-10">
                    <p class="font-bold">Failed to load library.</p>
                    <p class="text-sm text-gray-400 mt-2">\${e.message}</p>
                    <button onclick="loadPage(\${page})" class="mt-4 text-xs underline hover:text-white">Retry</button>
                </div>\`;
                document.getElementById('status-indicator').textContent = 'Error';
            }
        }

        function renderGrid(items) {
            grid.innerHTML = '';
            items.forEach(anime => {
                const card = document.createElement('div');
                card.className = 'card bg-white/5 rounded-xl overflow-hidden cursor-pointer border border-white/5 transition duration-300 group relative';
                
                // Handle missing images gracefully
                const imgUrl = anime.image || 'https://via.placeholder.com/300x450?text=No+Image';
                
                card.innerHTML = \`
                    <div class="aspect-[2/3] relative overflow-hidden">
                        <img src="\${imgUrl}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" loading="lazy" onerror="this.src='https://via.placeholder.com/300x450?text=Error'">
                        <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition"></div>
                        <div class="absolute top-2 right-2 bg-black/60 px-2 py-1 text-[10px] rounded text-white backdrop-blur font-bold uppercase">
                            \${anime.type || 'TV'}
                        </div>
                    </div>
                    <div class="p-3 bg-[#15151a]">
                        <h4 class="font-bold text-sm truncate text-gray-200 group-hover:text-red-400 transition">\${anime.title}</h4>
                        <p class="text-xs text-gray-500 mt-1 flex items-center gap-1">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"></path></svg>
                            \${anime.episodes ? anime.episodes + ' eps' : 'Ongoing'}
                        </p>
                    </div>
                \`;
                card.onclick = () => openSeries(anime.id);
                grid.appendChild(card);
            });
        }

        function setupHero(anime) {
            hero.classList.remove('hidden');
            const img = document.getElementById('hero-img');
            img.src = anime.image;
            document.getElementById('hero-title').textContent = anime.title;
            
            const btn = document.getElementById('hero-btn');
            btn.onclick = () => openSeries(anime.id);
        }

        // --- Series & Player Logic ---
        async function openSeries(id) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            document.body.style.overflow = 'hidden';
            
            // Reset Player
            playerFrame.src = '';
            document.getElementById('episode-list').innerHTML = '<div class="flex justify-center py-10"><div class="loader"></div></div>';
            document.getElementById('modal-title').textContent = 'Loading...';
            document.getElementById('modal-sub').textContent = '';
            
            try {
                const res = await fetch(\`\${API_BASE}/api/series/\${id}\`);
                if (!res.ok) throw new Error('Failed to fetch series');
                const data = await res.json();
                
                if (!data.ok) throw new Error('Series data invalid');
                
                currentSeries = data.data;
                document.getElementById('modal-title').textContent = currentSeries.title;
                document.getElementById('modal-sub').textContent = \`\${currentSeries.status || 'Unknown Status'} • \${currentSeries.type || 'TV'}\`;
                
                renderEpisodes();
                
                // Auto-play first episode
                if (currentSeries.episodes && currentSeries.episodes.length > 0) {
                    playEpisode(0);
                } else {
                    document.getElementById('episode-list').innerHTML = '<div class="text-gray-500 text-center py-4">No episodes available.</div>';
                }
                
            } catch (e) {
                document.getElementById('episode-list').innerHTML = \`<div class="text-red-500 text-center py-4">\${e.message}</div>\`;
            }
        }

        function renderEpisodes() {
            const list = document.getElementById('episode-list');
            list.innerHTML = '';
            
            if (!currentSeries.episodes || currentSeries.episodes.length === 0) {
                list.innerHTML = '<div class="text-gray-500 text-sm text-center py-4">No episodes found.</div>';
                return;
            }

            currentSeries.episodes.forEach((ep, index) => {
                const btn = document.createElement('button');
                const isActive = index === currentEpisodeIndex;
                
                btn.className = \`w-full text-left px-3 py-3 rounded-lg text-sm transition flex items-center justify-between group \${isActive ? 'bg-red-600 text-white shadow-lg' : 'hover:bg-white/10 text-gray-300'}\`;
                
                btn.innerHTML = \`
                    <span class="truncate font-medium">\${ep.number}. \${ep.title || 'Episode ' + ep.number}</span>
                    \${isActive ? '<svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"></path></svg>' : ''}
                \`;
                
                btn.onclick = () => playEpisode(index);
                list.appendChild(btn);
            });
            
            // Scroll active into view
            setTimeout(() => {
                const active = list.querySelector('.bg-red-600');
                if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 100);
        }

        function playEpisode(index) {
            currentEpisodeIndex = index;
            renderEpisodes(); // Update active state UI
            
            const ep = currentSeries.episodes[index];
            document.getElementById('modal-sub').textContent = \`Playing: Ep \${ep.number} - \${ep.title || 'Untitled'}\`;
            
            // Determine URL based on Sub/Dub preference
            let url = '';
            const embeds = ep.embed_url || {};
            
            if (currentType === 'sub' && embeds.sub) {
                url = embeds.sub;
            } else if (currentType === 'dub' && embeds.dub) {
                url = embeds.dub;
            } else if (embeds.sub) {
                // Fallback to sub if dub missing
                url = embeds.sub;
                currentType = 'sub'; 
                updateTypeButtons();
            }

            if (url) {
                document.getElementById('player-overlay').classList.remove('hidden');
                playerFrame.src = url;
                
                // Hide overlay after a delay (iframe load events are tricky with cross-origin)
                setTimeout(() => {
                    document.getElementById('player-overlay').classList.add('hidden');
                }, 3000);
            } else {
                alert('No stream available for this type (Sub/Dub).');
            }
        }

        function updateTypeButtons() {
            const subBtn = document.getElementById('btn-sub');
            const dubBtn = document.getElementById('btn-dub');
            
            if (currentType === 'sub') {
                subBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-500');
                subBtn.classList.remove('bg-blue-600/10', 'text-blue-400', 'border-blue-600/30');
                
                dubBtn.classList.remove('bg-green-600', 'text-white', 'border-green-500');
                dubBtn.classList.add('bg-green-600/10', 'text-green-400', 'border-green-600/30');
            } else {
                dubBtn.classList.add('bg-green-600', 'text-white', 'border-green-500');
                dubBtn.classList.remove('bg-green-600/10', 'text-green-400', 'border-green-600/30');
                
                subBtn.classList.remove('bg-blue-600', 'text-white', 'border-blue-500');
                subBtn.classList.add('bg-blue-600/10', 'text-blue-400', 'border-blue-600/30');
            }
        }

        // --- Event Listeners ---
        document.getElementById('close-modal').onclick = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = '';
            playerFrame.src = ''; // Stop video
        };

        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) {
                document.getElementById('close-modal').click();
            }
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
    console.log(`Using Native Node.js Fetch (No dependencies required)`);
});
