'use strict';

const express = require('express');
const app = express();
app.disable('x-powered-by');
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Public instances (can be overridden via env vars if self-hosting)
const ANIVEXA_BASE = process.env.ANIVEXA_BASE || 'https://anivexa-api-nine.vercel.app';
const ANILIST_API = 'https://graphql.anilist.co';

/* =========================================================
   CACHING (Protects against rate limits)
   ========================================================= */
const cache = new Map();

function getCached(key, ttl = 5 * 60 * 1000) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttl = 5 * 60 * 1000) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

/* =========================================================
   API PROXY ROUTES
   ========================================================= */

// 1. AniList GraphQL Proxy (Search & Discovery)
app.post('/api/anilist', async (req, res) => {
  try {
    const response = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[AniList Proxy Error]:', err.message);
    res.status(502).json({ error: 'Failed to fetch from AniList' });
  }
});

// 2. Anivexa Episodes Proxy
app.get('/api/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `ep_${id}`;
  const cached = getCached(cacheKey, 60 * 60 * 1000); // 1 hour cache
  if (cached) return res.json(cached);

  try {
    const response = await fetch(`${ANIVEXA_BASE}/episodes/${id}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    setCache(cacheKey, data, 60 * 60 * 1000);
    res.json(data);
  } catch (err) {
    console.error(`[Anivexa Episodes Error] ID: ${id}`, err.message);
    res.status(502).json({ error: 'Failed to fetch episodes' });
  }
});

// 3. Anivexa Watch Proxy
app.get('/api/watch/:provider/:id/:type/:ep', async (req, res) => {
  const { provider, id, type, ep } = req.params;
  // Anivexa route format: /watch/:provider/:anilistId/sub|dub/:provider-:ep
  const url = `${ANIVEXA_BASE}/watch/${provider}/${id}/${type}/${provider}-${ep}`;
  
  try {
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(`[Anivexa Watch Error] ${provider}/${id}/${type}/${ep}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch stream' });
  }
});

/* =========================================================
   FRONTEND (Single File HTML/JS/CSS)
   ========================================================= */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Anivexa Stream</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #09090b; color: #fafafa; }
        .glass { background: rgba(24, 24, 27, 0.8); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .glass-panel { background: rgba(39, 39, 42, 0.6); backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.05); }
        .card-hover { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
        .card-hover:hover { transform: translateY(-4px); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); border-color: rgba(239, 68, 68, 0.5); }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        .line-clamp-3 { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .loader { border: 3px solid rgba(255,255,255,0.1); border-radius: 50%; border-top: 3px solid #ef4444; width: 24px; height: 24px; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .episode-btn.active { background-color: #ef4444; color: white; border-color: #ef4444; }
    </style>
</head>
<body class="min-h-screen flex flex-col">

    <!-- Header -->
    <header class="glass sticky top-0 z-40 px-4 py-3">
        <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center gap-4">
            <div class="flex items-center gap-2 shrink-0">
                <div class="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center font-black text-white">A</div>
                <h1 class="text-xl font-bold tracking-tight">Anivexa<span class="text-red-500">Stream</span></h1>
            </div>
            
            <div class="relative w-full md:max-w-xl">
                <input type="text" id="search-input" placeholder="Search anime by title..." 
                    class="w-full bg-zinc-800/50 border border-zinc-700 rounded-full py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition">
                <svg class="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </div>
        </div>
    </header>

    <!-- Main Content -->
    <main class="flex-grow max-w-7xl mx-auto w-full p-4 md:p-6">
        
        <!-- Hero Section -->
        <div id="hero" class="hidden relative h-64 md:h-96 rounded-2xl overflow-hidden mb-8 group">
            <img id="hero-img" src="" class="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105">
            <div class="absolute inset-0 bg-gradient-to-t from-[#09090b] via-[#09090b]/60 to-transparent"></div>
            <div class="absolute bottom-0 left-0 p-6 md:p-10 max-w-2xl">
                <span class="inline-block px-2 py-1 bg-red-600/20 text-red-400 text-xs font-bold rounded mb-3 border border-red-600/30">TRENDING #1</span>
                <h2 id="hero-title" class="text-3xl md:text-5xl font-black mb-3 drop-shadow-lg"></h2>
                <p id="hero-desc" class="text-sm md:text-base text-zinc-300 line-clamp-3 mb-4"></p>
                <button id="hero-btn" class="bg-red-600 hover:bg-red-700 text-white px-6 py-2.5 rounded-full font-bold transition flex items-center gap-2">
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg>
                    Watch Now
                </button>
            </div>
        </div>

        <!-- Grid Header -->
        <div class="flex items-center justify-between mb-6">
            <h3 id="grid-title" class="text-xl font-bold border-l-4 border-red-500 pl-3">Trending Now</h3>
            <span id="status-indicator" class="text-xs text-zinc-500"></span>
        </div>

        <!-- Anime Grid -->
        <div id="grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 md:gap-6 min-h-[400px]">
            <div class="col-span-full flex flex-col items-center justify-center py-20 text-zinc-500">
                <div class="loader mb-4"></div>
                <p>Loading library...</p>
            </div>
        </div>
    </main>

    <!-- Detail Modal -->
    <div id="modal" class="fixed inset-0 z-50 hidden bg-black/95 backdrop-blur-md flex items-center justify-center p-0 md:p-6">
        <div class="bg-[#18181b] w-full h-full md:h-auto md:max-w-6xl md:rounded-2xl overflow-hidden shadow-2xl border border-zinc-800 flex flex-col">
            
            <!-- Modal Header -->
            <div class="p-4 border-b border-zinc-800 flex justify-between items-center bg-[#18181b] shrink-0">
                <div class="overflow-hidden">
                    <h2 id="modal-title" class="text-lg font-bold text-white truncate">Anime Title</h2>
                    <p id="modal-meta" class="text-xs text-zinc-400">Format • Status</p>
                </div>
                <button id="close-modal" class="text-zinc-400 hover:text-white hover:bg-zinc-800 w-10 h-10 rounded-full flex items-center justify-center transition text-2xl leading-none">&times;</button>
            </div>

            <!-- Video Player Area -->
            <div class="relative bg-black aspect-video w-full shrink-0 flex items-center justify-center">
                <video id="video-player" class="w-full h-full hidden" controls playsinline></video>
                <iframe id="iframe-player" class="w-full h-full hidden" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>
                
                <div id="player-overlay" class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 z-10">
                    <div class="loader mb-3"></div>
                    <p class="text-sm text-zinc-400">Loading stream...</p>
                </div>
                
                <div id="player-error" class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 z-10 hidden">
                    <svg class="w-10 h-10 text-red-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <p class="text-sm text-zinc-300 font-bold">Stream failed to load</p>
                    <p class="text-xs text-zinc-500 mt-1">Try a different provider or episode.</p>
                </div>
            </div>

            <!-- Controls & Episodes -->
            <div class="flex-grow flex flex-col md:flex-row overflow-hidden">
                <!-- Episode List -->
                <div class="w-full md:w-80 bg-[#121214] border-r border-zinc-800 flex flex-col">
                    <div class="p-4 border-b border-zinc-800 bg-[#18181b]">
                        <h3 class="text-xs uppercase tracking-widest text-zinc-500 font-bold mb-3">Episodes</h3>
                        
                        <!-- Provider Selector -->
                        <div id="provider-tabs" class="flex gap-2 overflow-x-auto scrollbar-hide pb-1 mb-3">
                            <!-- Injected via JS -->
                        </div>

                        <!-- Sub/Dub Toggle -->
                        <div class="flex bg-zinc-800/50 rounded-lg p-1">
                            <button id="btn-sub" class="flex-1 py-1.5 rounded-md text-xs font-bold transition bg-zinc-700 text-white shadow">SUB</button>
                            <button id="btn-dub" class="flex-1 py-1.5 rounded-md text-xs font-bold transition text-zinc-400 hover:text-white">DUB</button>
                        </div>
                    </div>
                    
                    <div id="episode-list" class="flex-grow overflow-y-auto p-4 scrollbar-hide">
                        <div class="flex justify-center py-10"><div class="loader"></div></div>
                    </div>
                </div>
                
                <!-- Description -->
                <div class="flex-grow p-6 bg-[#18181b] overflow-y-auto">
                    <h3 class="text-sm font-bold text-zinc-300 mb-3">Synopsis</h3>
                    <p id="modal-desc" class="text-sm text-zinc-400 leading-relaxed">Loading description...</p>
                    
                    <div class="mt-6 p-4 bg-zinc-800/30 rounded-lg border border-zinc-800">
                        <p class="text-xs text-zinc-500">
                            <strong class="text-zinc-400">Note:</strong> Streams are aggregated from third-party providers. If a stream fails, use the provider tabs above to switch sources. 
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // --- STATE ---
        let currentAnime = null;
        let episodesData = null;
        let selectedProvider = null;
        let selectedType = 'sub'; // 'sub' or 'dub'
        let currentEpisode = null;
        let hls = null;
        let searchTimeout = null;

        // --- GRAPHQL QUERIES ---
        const QUERY_TRENDING = \`
            query {
                Page(page: 1, perPage: 24) {
                    media(type: ANIME, sort: TRENDING_DESC) {
                        id
                        title { romaji english }
                        coverImage { large medium }
                        episodes
                        format
                        status
                        description
                    }
                }
            }
        \`;

        const QUERY_SEARCH = (search) => \`
            query {
                Page(page: 1, perPage: 24) {
                    media(search: "\${search.replace(/"/g, '\\"')}", type: ANIME, sort: SEARCH_MATCH) {
                        id
                        title { romaji english }
                        coverImage { large medium }
                        episodes
                        format
                        status
                        description
                    }
                }
            }
        \`;

        // --- DOM ELEMENTS ---
        const grid = document.getElementById('grid');
        const modal = document.getElementById('modal');
        const videoPlayer = document.getElementById('video-player');
        const iframePlayer = document.getElementById('iframe-player');
        const playerOverlay = document.getElementById('player-overlay');
        const playerError = document.getElementById('player-error');

        // --- API HELPERS ---
        async function fetchAniList(query) {
            const res = await fetch('/api/anilist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            const data = await res.json();
            return data.data?.Page?.media || [];
        }

        async function fetchEpisodes(anilistId) {
            const res = await fetch(\`/api/episodes/\${anilistId}\`);
            if (!res.ok) throw new Error('Failed to fetch episodes');
            return await res.json();
        }

        async function fetchWatchUrl(provider, id, type, ep) {
            const res = await fetch(\`/api/watch/\${provider}/\${id}/\${type}/\${ep}\`);
            if (!res.ok) throw new Error('Stream fetch failed');
            return await res.json();
        }

        // --- RENDER FUNCTIONS ---
        function renderGrid(animeList, isSearch = false) {
            grid.innerHTML = '';
            document.getElementById('grid-title').textContent = isSearch ? \`Search Results\` : 'Trending Now';
            document.getElementById('status-indicator').textContent = \`\${animeList.length} titles found\`;

            if (animeList.length === 0) {
                grid.innerHTML = \`<div class="col-span-full text-center py-20 text-zinc-500">No results found. Try a different search.</div>\`;
                return;
            }

            // Setup Hero if not searching
            if (!isSearch && animeList.length > 0) {
                setupHero(animeList[0]);
            }

            animeList.forEach(anime => {
                const title = anime.title.english || anime.title.romaji;
                const imgUrl = anime.coverImage.large || anime.coverImage.medium;
                
                const card = document.createElement('div');
                card.className = 'card-hover glass-panel rounded-xl overflow-hidden cursor-pointer group relative';
                card.innerHTML = \`
                    <div class="aspect-[2/3] relative overflow-hidden">
                        <img src="\${imgUrl}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" loading="lazy" onerror="this.src='https://via.placeholder.com/300x450?text=No+Image'">
                        <div class="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition"></div>
                        \${anime.format ? \`<div class="absolute top-2 right-2 bg-black/60 px-2 py-1 text-[10px] rounded text-white backdrop-blur font-bold uppercase">\${anime.format}</div>\` : ''}
                    </div>
                    <div class="p-3">
                        <h4 class="font-bold text-sm truncate text-zinc-200 group-hover:text-red-400 transition" title="\${title}">\${title}</h4>
                        <p class="text-xs text-zinc-500 mt-1 flex items-center gap-1">
                            \${anime.episodes ? \`\${anime.episodes} eps\` : 'Ongoing'} • \${anime.status || 'Unknown'}
                        </p>
                    </div>
                \`;
                card.onclick = () => openAnimeDetail(anime);
                grid.appendChild(card);
            });
        }

        function setupHero(anime) {
            const hero = document.getElementById('hero');
            hero.classList.remove('hidden');
            document.getElementById('hero-img').src = anime.coverImage.large || anime.coverImage.medium;
            document.getElementById('hero-title').textContent = anime.title.english || anime.title.romaji;
            document.getElementById('hero-desc').innerHTML = anime.description ? anime.description.replace(/<[^>]*>/g, '') : 'No description available.';
            document.getElementById('hero-btn').onclick = () => openAnimeDetail(anime);
        }

        // --- DETAIL & PLAYER LOGIC ---
        async function openAnimeDetail(anime) {
            currentAnime = anime;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            document.body.style.overflow = 'hidden';
            
            // Reset UI
            resetPlayer();
            document.getElementById('modal-title').textContent = anime.title.english || anime.title.romaji;
            document.getElementById('modal-meta').textContent = \`\${anime.format || 'TV'} • \${anime.status || 'Unknown'} • \${anime.episodes ? anime.episodes + ' Eps' : 'Unknown Eps'}\`;
            document.getElementById('modal-desc').innerHTML = anime.description ? anime.description.replace(/<[^>]*>/g, '') : 'No description available.';
            document.getElementById('episode-list').innerHTML = '<div class="flex justify-center py-10"><div class="loader"></div></div>';
            document.getElementById('provider-tabs').innerHTML = '';

            try {
                episodesData = await fetchEpisodes(anime.id);
                renderProviders();
            } catch (err) {
                document.getElementById('episode-list').innerHTML = \`<div class="text-red-500 text-center py-4">Failed to load episodes.<br><span class="text-xs text-zinc-500">\${err.message}</span></div>\`;
            }
        }

        function renderProviders() {
            const tabsContainer = document.getElementById('provider-tabs');
            tabsContainer.innerHTML = '';
            
            const providers = Object.keys(episodesData).filter(p => episodesData[p] && (episodesData[p].sub?.length > 0 || episodesData[p].dub?.length > 0));
            
            if (providers.length === 0) {
                document.getElementById('episode-list').innerHTML = '<div class="text-zinc-500 text-center py-4">No streams available for this title.</div>';
                return;
            }

            selectedProvider = providers[0]; // Default to first available
            
            providers.forEach(provider => {
                const btn = document.createElement('button');
                btn.className = \`px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition border \${provider === selectedProvider ? 'bg-red-600 border-red-600 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-white'}\`;
                btn.textContent = provider.charAt(0).toUpperCase() + provider.slice(1);
                btn.onclick = () => {
                    selectedProvider = provider;
                    renderProviders(); // Re-render to update active state
                    updateTypeToggle(); // Check if dub is available for new provider
                    renderEpisodes();
                };
                tabsContainer.appendChild(btn);
            });

            updateTypeToggle();
            renderEpisodes();
        }

        function updateTypeToggle() {
            const subBtn = document.getElementById('btn-sub');
            const dubBtn = document.getElementById('btn-dub');
            const providerData = episodesData[selectedProvider];
            
            const hasSub = providerData?.sub?.length > 0;
            const hasDub = providerData?.dub?.length > 0;

            if (selectedType === 'sub' && hasSub) {
                subBtn.className = 'flex-1 py-1.5 rounded-md text-xs font-bold transition bg-zinc-200 text-zinc-900 shadow';
                dubBtn.className = \`flex-1 py-1.5 rounded-md text-xs font-bold transition \${hasDub ? 'text-zinc-400 hover:text-white hover:bg-zinc-700' : 'text-zinc-700 cursor-not-allowed opacity-50'}\`;
            } else if (selectedType === 'dub' && hasDub) {
                dubBtn.className = 'flex-1 py-1.5 rounded-md text-xs font-bold transition bg-zinc-200 text-zinc-900 shadow';
                subBtn.className = 'flex-1 py-1.5 rounded-md text-xs font-bold transition text-zinc-400 hover:text-white hover:bg-zinc-700';
            } else {
                // Fallback if selected type is missing
                selectedType = hasSub ? 'sub' : 'dub';
                updateTypeToggle();
                return;
            }

            subBtn.onclick = () => { if (hasSub) { selectedType = 'sub'; updateTypeToggle(); renderEpisodes(); } };
            dubBtn.onclick = () => { if (hasDub) { selectedType = 'dub'; updateTypeToggle(); renderEpisodes(); } };
        }

        function renderEpisodes() {
            const list = document.getElementById('episode-list');
            list.innerHTML = '';
            
            const episodes = episodesData[selectedProvider]?.[selectedType] || [];
            
            if (episodes.length === 0) {
                list.innerHTML = '<div class="text-zinc-500 text-center py-4">No episodes for this type.</div>';
                return;
            }

            episodes.forEach(ep => {
                const btn = document.createElement('button');
                const isActive = currentEpisode && currentEpisode.number === ep.number;
                btn.className = \`episode-btn w-full text-left px-3 py-2.5 rounded-lg text-sm transition border border-zinc-800 hover:border-zinc-600 \${isActive ? 'active' : 'bg-zinc-800/50 text-zinc-300'}\`;
                btn.innerHTML = \`
                    <div class="font-bold">Ep \${ep.number}</div>
                    \${ep.title ? \`<div class="text-xs text-zinc-500 truncate mt-0.5">\${ep.title}</div>\` : ''}
                \`;
                btn.onclick = () => loadEpisode(ep);
                list.appendChild(btn);
            });

            // Auto-select first episode if none selected
            if (!currentEpisode && episodes.length > 0) {
                loadEpisode(episodes[0]);
            }
        }

        async function loadEpisode(ep) {
            currentEpisode = ep;
            renderEpisodes(); // Update active UI
            
            playerOverlay.classList.remove('hidden');
            playerError.classList.add('hidden');
            
            try {
                // ep.id might be the number or a specific string. Anivexa expects :provider-:ep
                const epIdentifier = ep.id || ep.number;
                const data = await fetchWatchUrl(selectedProvider, currentAnime.id, selectedType, epIdentifier);
                
                // Extract URL from various possible response structures
                const streamUrl = data.url || data.sources?.[0]?.url || data.embed || data.file;
                
                if (!streamUrl) {
                    throw new Error('No stream URL found in response');
                }

                playStream(streamUrl);
            } catch (err) {
                console.error('Load Episode Error:', err);
                playerOverlay.classList.add('hidden');
                playerError.classList.remove('hidden');
            }
        }

        function playStream(url) {
            playerOverlay.classList.add('hidden');
            
            // Reset players
            if (hls) { hls.destroy(); hls = null; }
            videoPlayer.pause();
            videoPlayer.src = '';
            iframePlayer.src = '';
            videoPlayer.classList.add('hidden');
            iframePlayer.classList.add('hidden');

            if (url.includes('.m3u8')) {
                if (Hls.isSupported()) {
                    videoPlayer.classList.remove('hidden');
                    hls = new Hls({ enableWorker: true });
                    hls.loadSource(url);
                    hls.attachMedia(videoPlayer);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => videoPlayer.play().catch(()=>{}));
                    hls.on(Hls.Events.ERROR, (event, data) => {
                        if (data.fatal) {
                            playerError.classList.remove('hidden');
                        }
                    });
                } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
                    videoPlayer.classList.remove('hidden');
                    videoPlayer.src = url;
                    videoPlayer.play().catch(()=>{});
                } else {
                    // Fallback to iframe if HLS not supported
                    iframePlayer.classList.remove('hidden');
                    iframePlayer.src = url;
                }
            } else {
                // Direct MP4 or Embed
                if (url.includes('http') && !url.includes('.mp4')) {
                    iframePlayer.classList.remove('hidden');
                    iframePlayer.src = url;
                } else {
                    videoPlayer.classList.remove('hidden');
                    videoPlayer.src = url;
                    videoPlayer.play().catch(()=>{});
                }
            }
        }

        function resetPlayer() {
            if (hls) { hls.destroy(); hls = null; }
            videoPlayer.pause();
            videoPlayer.src = '';
            iframePlayer.src = '';
            videoPlayer.classList.add('hidden');
            iframePlayer.classList.add('hidden');
            playerOverlay.classList.add('hidden');
            playerError.classList.add('hidden');
            currentEpisode = null;
        }

        // --- EVENT LISTENERS ---
        document.getElementById('close-modal').onclick = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = '';
            resetPlayer();
        };

        modal.onclick = (e) => {
            if (e.target === modal) document.getElementById('close-modal').click();
        };

        // Search with Debounce
        document.getElementById('search-input').addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const query = e.target.value.trim();
            
            if (!query) {
                loadTrending();
                return;
            }

            document.getElementById('status-indicator').textContent = 'Searching...';
            searchTimeout = setTimeout(async () => {
                try {
                    const results = await fetchAniList(QUERY_SEARCH(query));
                    renderGrid(results, true);
                } catch (err) {
                    grid.innerHTML = '<div class="col-span-full text-center py-20 text-red-500">Search failed. Please try again.</div>';
                }
            }, 400); // 400ms debounce
        });

        async function loadTrending() {
            document.getElementById('search-input').value = '';
            grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-20 text-zinc-500"><div class="loader mb-4"></div><p>Loading library...</p></div>';
            try {
                const results = await fetchAniList(QUERY_TRENDING);
                renderGrid(results, false);
            } catch (err) {
                grid.innerHTML = '<div class="col-span-full text-center py-20 text-red-500">Failed to load trending anime.</div>';
            }
        }

        // Init
        loadTrending();
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(INDEX_HTML);
});

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`Anivexa Stream running at http://${HOST}:${PORT}`);
  console.log(`Using Native Node.js Fetch (No external dependencies required)`);
});
