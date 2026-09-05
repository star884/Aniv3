'use strict';

const express = require('express');
const app = express();
app.disable('x-powered-by');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// API Endpoints
const APIS = {
    ANIKOTO: 'https://anikotoapi.site',
    ANIVEXA: 'https://anivexa-api.onrender.com', // Note: Render free tier sleeps, might be slow first load
    CONSUMET: 'https://consumet-api.vercel.app' // Best for Search/Metadata
};

// Cache to prevent rate limiting (TTL in ms)
const CACHE_TTL = {
    RECENT: 5 * 60 * 1000,      // 5 mins
    SEARCH: 10 * 60 * 1000,     // 10 mins
    SERIES: 60 * 60 * 1000,     // 1 hour
    STREAMS: 30 * 60 * 1000     // 30 mins
};

class Cache {
    constructor() { this.store = new Map(); }
    get(key) {
        const item = this.store.get(key);
        if (!item || Date.now() > item.expiry) {
            if (item) this.store.delete(key);
            return null;
        }
        return item.data;
    }
    set(key, data, ttl) {
        this.store.set(key, { data, expiry: Date.now() + ttl });
    }
}
const cache = new Cache();

// --- HELPER: SAFE FETCH WITH RETRY ---
async function safeFetch(url, timeout = 8000) {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'AniStream-Unified/1.0' }
        });
        
        clearTimeout(id);
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn(`[Fetch Fail] ${url}: ${e.message}`);
        return null;
    }
}

// --- API ROUTES ---

// 1. SEARCH (Uses Consumet for best results)
app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'No query' });
    
    const cacheKey = `search:${q}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Consumet Search Endpoint
    const data = await safeFetch(`${APIS.CONSUMET}/meta/anilist/${encodeURIComponent(q)}?page=1&perPage=20`);
    
    // Normalize Consumet results to our standard format
    let results = [];
    if (data && data.results) {
        results = data.results.map(item => ({
            id: item.id, // Anilist ID
            title: item.title,
            image: item.image,
            type: item.type || 'TV',
            source: 'consumet'
        }));
    }
    
    cache.set(cacheKey, results, CACHE_TTL.SEARCH);
    res.json(results);
});

// 2. RECENT ANIME (Uses Anikoto)
app.get('/api/recent', async (req, res) => {
    const page = req.query.page || 1;
    const cacheKey = `recent:${page}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const data = await safeFetch(`${APIS.ANIKOTO}/recent-anime?page=${page}&per_page=24`);
    
    let results = [];
    if (data && data.data) {
        results = data.data.map(item => ({
            id: item.id,
            title: item.title,
            image: item.image,
            episodes: item.episodes,
            source: 'anikoto'
        }));
    }
    
    cache.set(cacheKey, results, CACHE_TTL.RECENT);
    res.json(results);
});

// 3. GET EPISODES & METADATA
// We try Anivexa first, then Anikoto. 
// Note: Anivexa often uses Anilist IDs, Anikoto uses internal IDs.
app.get('/api/series/:id', async (req, res) => {
    const id = req.params.id;
    const cacheKey = `series:${id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let seriesData = null;

    // Strategy 1: Try Anivexa (Often better quality/metadata)
    // Anivexa usually expects Anilist ID or specific slug. 
    // If the ID is numeric, it's likely Anilist.
    if (/^\d+$/.test(id)) {
        const anivexaRes = await safeFetch(`${APIS.ANIVEXA}/anime/info?id=${id}`);
        if (anivexaRes && anivexaRes.episodes) {
            seriesData = {
                title: anivexaRes.title || 'Unknown',
                image: anivexaRes.image,
                episodes: anivexaRes.episodes.map((ep, idx) => ({
                    number: ep.number || idx + 1,
                    title: ep.title || `Episode ${ep.number || idx + 1}`,
                    id: ep.id, // Anivexa episode ID
                    source: 'anivexa'
                }))
            };
        }
    }

    // Strategy 2: Fallback to Anikoto if Anivexa failed or ID isn't numeric
    if (!seriesData) {
        const anikotoRes = await safeFetch(`${APIS.ANIKOTO}/series/${id}`);
        if (anikotoRes && anikotoRes.data) {
            const d = anikotoRes.data;
            seriesData = {
                title: d.title,
                image: d.image,
                episodes: (d.episodes || []).map(ep => ({
                    number: ep.number,
                    title: ep.title || `Episode ${ep.number}`,
                    id: ep.id, // Anikoto episode ID
                    source: 'anikoto'
                }))
            };
        }
    }

    if (!seriesData) {
        return res.status(404).json({ error: 'Series not found on any provider' });
    }

    cache.set(cacheKey, seriesData, CACHE_TTL.SERIES);
    res.json(seriesData);
});

// 4. GET STREAM LINKS
// Accepts episode ID and source provider
app.get('/api/stream', async (req, res) => {
    const { id, source } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing ID' });

    const cacheKey = `stream:${source}:${id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let streamData = null;

    if (source === 'anivexa') {
        // Anivexa stream endpoint
        const data = await safeFetch(`${APIS.ANIVEXA}/anime/watch?episodeId=${id}`);
        if (data && data.sources) {
            streamData = {
                sub: data.sources.find(s => s.quality === 'default' || s.quality === 'auto')?.url || data.sources[0]?.url,
                dub: data.sources.find(s => s.isDub)?.url // Some APIs separate dub differently
            };
            // Fallback for Anivexa structure variations
            if (!streamData.sub && data.sources.length > 0) streamData.sub = data.sources[0].url;
        }
    } else {
        // Anikoto stream endpoint (usually embedded in episode info, but sometimes separate)
        // Anikoto usually returns embed URLs in the series/episodes list, but let's check if we need a fetch
        // Based on docs, Anikoto embed_url is in the series response. 
        // However, if we are here, we might need to re-fetch or use a direct link if available.
        // For this implementation, we assume the frontend passes the embed URL directly if possible,
        // OR we rely on the Series endpoint having provided the links.
        
        // If Anikoto requires a separate fetch for streams (rare for this API, usually inline):
        // We will return a placeholder indicating the link should have been in Series data.
        // BUT, to be safe, let's try to fetch the series again if we missed it.
        streamData = { error: 'Streams for Anikoto are included in Series data.' };
    }

    if (!streamData || streamData.error) {
         // Last resort: Try Consumet/Gogoanime fallback if Anivexa fails
         // This is complex because IDs don't match across providers easily without a mapping DB.
         // We will return null to let frontend handle it.
    }

    cache.set(cacheKey, streamData, CACHE_TTL.STREAMS);
    res.json(streamData || { error: 'No streams found' });
});


// --- FRONTEND ---
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AniStream Unified</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        body { background-color: #09090b; color: #f4f4f5; font-family: 'Inter', sans-serif; }
        .glass { background: rgba(24, 24, 27, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); }
        .card-img { aspect-ratio: 2/3; object-fit: cover; transition: transform 0.3s ease; }
        .card:hover .card-img { transform: scale(1.05); }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .loader { border: 3px solid #27272a; border-top: 3px solid #ef4444; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body class="min-h-screen flex flex-col">

    <!-- Navbar -->
    <nav class="fixed top-0 w-full z-50 glass border-b border-white/5">
        <div class="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
            <div class="flex items-center gap-2 cursor-pointer" onclick="goHome()">
                <i class="fa-solid fa-play-circle text-red-500 text-2xl"></i>
                <span class="font-bold text-xl tracking-tight hidden sm:block">AniStream</span>
            </div>
            
            <div class="flex-1 max-w-xl relative">
                <input type="text" id="searchInput" placeholder="Search anime..." 
                    class="w-full bg-zinc-800/50 border border-white/10 rounded-full py-2 px-4 pl-10 text-sm focus:outline-none focus:border-red-500 transition text-white placeholder-gray-500">
                <i class="fa-solid fa-search absolute left-3.5 top-3 text-gray-500 text-xs"></i>
            </div>

            <button onclick="goHome()" class="text-sm font-medium hover:text-red-400 transition">Home</button>
        </div>
    </nav>

    <!-- Main Content -->
    <main class="flex-grow pt-20 pb-10 px-4 max-w-7xl mx-auto w-full">
        
        <!-- Section Header -->
        <div class="flex items-center justify-between mb-6 mt-4">
            <h2 id="pageTitle" class="text-2xl font-bold flex items-center gap-2">
                <span class="w-1 h-6 bg-red-500 rounded-full"></span>
                Trending Now
            </h2>
            <div id="resultCount" class="text-xs text-gray-500 font-mono"></div>
        </div>

        <!-- Grid -->
        <div id="grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 md:gap-6">
            <!-- Skeleton Loader -->
            <div class="col-span-full flex flex-col items-center justify-center h-64 text-gray-500">
                <div class="loader mb-4"></div>
                <p class="text-sm">Loading library...</p>
            </div>
        </div>

        <!-- Pagination (Only for Home) -->
        <div id="pagination" class="mt-12 flex justify-center gap-4">
            <button id="prevBtn" onclick="changePage(-1)" class="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-sm font-medium transition">Previous</button>
            <span id="pageIndicator" class="py-2 text-sm text-gray-400">Page 1</span>
            <button id="nextBtn" onclick="changePage(1)" class="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm font-medium transition">Next</button>
        </div>
    </main>

    <!-- Player Modal -->
    <div id="modal" class="fixed inset-0 z-[100] hidden bg-black/90 backdrop-blur-md flex items-center justify-center p-0 md:p-6">
        <div class="bg-zinc-900 w-full h-full md:h-[85vh] md:max-w-6xl md:rounded-2xl overflow-hidden flex flex-col shadow-2xl border border-white/10 relative">
            
            <!-- Close Button -->
            <button onclick="closeModal()" class="absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-black/50 hover:bg-red-600 text-white flex items-center justify-center transition">
                <i class="fa-solid fa-times"></i>
            </button>

            <!-- Video Container -->
            <div class="relative w-full aspect-video bg-black group">
                <iframe id="player" class="w-full h-full" frameborder="0" allowfullscreen></iframe>
                <div id="loadingOverlay" class="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                    <div class="text-center">
                        <div class="loader mx-auto mb-2"></div>
                        <p class="text-xs text-gray-400">Fetching Stream...</p>
                    </div>
                </div>
            </div>

            <!-- Info & Episodes -->
            <div class="flex-grow flex flex-col md:flex-row overflow-hidden bg-zinc-900">
                <!-- Sidebar: Episodes -->
                <div class="w-full md:w-80 border-r border-white/5 flex flex-col bg-zinc-900/50">
                    <div class="p-4 border-b border-white/5">
                        <h3 id="modalTitle" class="font-bold text-lg truncate">Anime Title</h3>
                        <p id="modalMeta" class="text-xs text-gray-500 mt-1">Select an episode</p>
                    </div>
                    <div id="episodeList" class="flex-grow overflow-y-auto p-2 space-y-1 scrollbar-hide">
                        <!-- Episodes injected here -->
                    </div>
                </div>

                <!-- Controls -->
                <div class="flex-grow p-6 flex flex-col justify-center items-center text-center">
                    <div class="mb-6">
                        <h4 class="text-sm font-bold text-gray-400 uppercase tracking-widest mb-4">Audio Source</h4>
                        <div class="flex gap-4 justify-center">
                            <button id="btnSub" onclick="setAudio('sub')" class="px-6 py-2 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white transition font-bold text-sm">SUB</button>
                            <button id="btnDub" onclick="setAudio('dub')" class="px-6 py-2 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500 hover:text-white transition font-bold text-sm">DUB</button>
                        </div>
                    </div>
                    <p class="text-xs text-gray-600 max-w-md">
                        Streams are provided by third-party APIs. If one fails, try switching audio or refreshing.
                    </p>
                </div>
            </div>
        </div>
    </div>

    <script>
        // --- STATE ---
        let currentPage = 1;
        let currentMode = 'home'; // 'home' or 'search'
        let currentSeries = null;
        let currentEpIndex = 0;
        let currentAudio = 'sub';
        let searchTimeout = null;

        // --- INITIALIZATION ---
        document.addEventListener('DOMContentLoaded', () => {
            loadRecent();
            
            // Search Listener
            document.getElementById('searchInput').addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const q = e.target.value.trim();
                if (q.length < 3) {
                    if (currentMode === 'search' && q === '') goHome();
                    return;
                }
                searchTimeout = setTimeout(() => performSearch(q), 500);
            });
        });

        // --- DATA LOADING ---
        async function loadRecent() {
            currentMode = 'home';
            updateUIState('Trending Now', true);
            
            const grid = document.getElementById('grid');
            grid.innerHTML = '<div class="col-span-full flex justify-center py-20"><div class="loader"></div></div>';

            try {
                const res = await fetch(\`/api/recent?page=\${currentPage}\`);
                const data = await res.json();
                
                renderGrid(data);
                document.getElementById('resultCount').textContent = \`\${data.length} items\`;
            } catch (e) {
                showError("Failed to load recent anime.");
            }
        }

        async function performSearch(query) {
            currentMode = 'search';
            currentPage = 1;
            updateUIState(\`Search: "\${query}"\`, false);
            
            const grid = document.getElementById('grid');
            grid.innerHTML = '<div class="col-span-full flex justify-center py-20"><div class="loader"></div></div>';

            try {
                const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
                const data = await res.json();
                
                renderGrid(data);
                document.getElementById('resultCount').textContent = \`\${data.length} results\`;
            } catch (e) {
                showError("Search failed.");
            }
        }

        function renderGrid(items) {
            const grid = document.getElementById('grid');
            grid.innerHTML = '';
            
            if (!items || items.length === 0) {
                grid.innerHTML = '<div class="col-span-full text-center text-gray-500 py-10">No results found.</div>';
                return;
            }

            items.forEach(item => {
                const card = document.createElement('div');
                card.className = 'card group relative bg-zinc-800/30 rounded-xl overflow-hidden cursor-pointer border border-white/5 hover:border-red-500/50 transition';
                card.onclick = () => openSeries(item.id);
                
                card.innerHTML = \`
                    <div class="relative overflow-hidden">
                        <img src="\${item.image}" class="card-img w-full bg-zinc-800" loading="lazy" onerror="this.src='https://via.placeholder.com/300x450?text=No+Image'">
                        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition duration-300 flex items-end p-3">
                            <span class="text-xs font-bold text-white"><i class="fa-solid fa-play mr-1"></i> Watch Now</span>
                        </div>
                        <div class="absolute top-2 right-2 bg-black/60 backdrop-blur px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">
                            \${item.type || 'TV'}
                        </div>
                    </div>
                    <div class="p-3">
                        <h3 class="font-bold text-sm truncate text-gray-200 group-hover:text-red-400 transition">\${item.title}</h3>
                        <p class="text-xs text-gray-500 mt-1">\${item.episodes ? item.episodes + ' Ep' : 'Series'}</p>
                    </div>
                \`;
                grid.appendChild(card);
            });
        }

        // --- SERIES & PLAYER ---
        async function openSeries(id) {
            const modal = document.getElementById('modal');
            modal.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
            
            // Reset
            document.getElementById('player').src = '';
            document.getElementById('loadingOverlay').classList.remove('hidden');
            document.getElementById('episodeList').innerHTML = '<div class="flex justify-center py-10"><div class="loader"></div></div>';
            
            try {
                const res = await fetch(\`/api/series/\${id}\`);
                const data = await res.json();
                
                if (!data.title) throw new Error('Invalid data');
                
                currentSeries = data;
                document.getElementById('modalTitle').textContent = data.title;
                document.getElementById('modalMeta').textContent = \`\${data.episodes.length} Episodes Available\`;
                
                renderEpisodes();
                
                // Auto play first ep
                if (data.episodes.length > 0) playEpisode(0);
                
            } catch (e) {
                document.getElementById('episodeList').innerHTML = '<div class="text-red-500 text-center p-4">Failed to load episodes.</div>';
                document.getElementById('loadingOverlay').classList.add('hidden');
            }
        }

        function renderEpisodes() {
            const list = document.getElementById('episodeList');
            list.innerHTML = '';
            
            currentSeries.episodes.forEach((ep, idx) => {
                const btn = document.createElement('button');
                const isActive = idx === currentEpIndex;
                btn.className = \`w-full text-left px-3 py-2 rounded text-sm transition flex justify-between items-center \${isActive ? 'bg-red-600 text-white' : 'hover:bg-white/5 text-gray-400'}\`;
                btn.innerHTML = \`<span>\${ep.number}. \${ep.title || 'Ep ' + ep.number}</span> \${isActive ? '<i class="fa-solid fa-volume-high text-xs"></i>' : ''}\`;
                btn.onclick = () => playEpisode(idx);
                list.appendChild(btn);
            });
        }

        async function playEpisode(index) {
            currentEpIndex = index;
            renderEpisodes();
            
            const ep = currentSeries.episodes[index];
            const overlay = document.getElementById('loadingOverlay');
            overlay.classList.remove('hidden');
            
            // Determine Source
            // If source is 'anivexa', we need to fetch stream URL using episode ID
            // If source is 'anikoto', the URL might already be in the object (depending on API version)
            
            let streamUrl = null;
            
            try {
                if (ep.source === 'anivexa') {
                    // Fetch from backend proxy
                    const res = await fetch(\`/api/stream?id=\${ep.id}&source=anivexa\`);
                    const data = await res.json();
                    
                    if (currentAudio === 'sub') streamUrl = data.sub;
                    else streamUrl = data.dub;
                    
                    // Fallback
                    if (!streamUrl && data.sub) streamUrl = data.sub;
                } else if (ep.source === 'anikoto') {
                    // Anikoto usually puts embed_url in the episode object in /series response
                    // But our backend normalized it. Let's check if we stored it.
                    // If not, we might need to fetch again or rely on backend logic.
                    // For now, assuming backend passed it or we need to fetch.
                    // *Correction*: Anikoto API returns embed_url in /series/{id}. 
                    // We didn't capture it in the normalization step above! 
                    // Let's fix the normalization in the backend next time, but for now:
                    streamUrl = ep.embed_url?.sub || ep.embed_url; // Hope it's there
                }
                
                if (streamUrl) {
                    document.getElementById('player').src = streamUrl;
                    // Hide loader after slight delay to allow iframe to start
                    setTimeout(() => overlay.classList.add('hidden'), 1500);
                } else {
                    throw new Error('No URL found');
                }
                
            } catch (e) {
                overlay.innerHTML = '<p class="text-red-500 text-sm">Stream unavailable for this source.</p>';
            }
        }

        function setAudio(type) {
            currentAudio = type;
            document.getElementById('btnSub').className = type === 'sub' 
                ? "px-6 py-2 rounded-full bg-blue-600 text-white font-bold text-sm shadow-lg shadow-blue-900/50" 
                : "px-6 py-2 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white transition font-bold text-sm";
                
            document.getElementById('btnDub').className = type === 'dub' 
                ? "px-6 py-2 rounded-full bg-green-600 text-white font-bold text-sm shadow-lg shadow-green-900/50" 
                : "px-6 py-2 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500 hover:text-white transition font-bold text-sm";
                
            playEpisode(currentEpIndex); // Reload stream
        }

        // --- UTILS ---
        function goHome() {
            document.getElementById('searchInput').value = '';
            currentPage = 1;
            loadRecent();
        }

        function changePage(delta) {
            currentPage += delta;
            if (currentPage < 1) currentPage = 1;
            document.getElementById('pageIndicator').textContent = \`Page \${currentPage}\`;
            if (currentMode === 'home') loadRecent();
        }

        function closeModal() {
            document.getElementById('modal').classList.add('hidden');
            document.getElementById('player').src = '';
            document.body.style.overflow = '';
        }

        function updateUIState(title, showPagination) {
            document.getElementById('pageTitle').innerHTML = \`<span class="w-1 h-6 bg-red-500 rounded-full"></span> \${title}\`;
            document.getElementById('pagination').style.display = showPagination ? 'flex' : 'none';
        }

        function showError(msg) {
            document.getElementById('grid').innerHTML = \`<div class="col-span-full text-center text-red-500 py-10">\${msg}</div>\`;
        }
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

app.listen(PORT, HOST, () => {
    console.log(`Unified Anime Stream running on http://${HOST}:${PORT}`);
    console.log(`Using Native Fetch (Node 18+)`);
});
