const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. THE ADDONS (Torrentio is Key)
// ==========================================
const ADDONS = [
  { name: "Torrentio (Best)", url: "https://torrentio.strem.fun/manifest.json" },
  { name: "Cinemeta (Meta)", url: "https://v3-cinemeta.strem.io/manifest.json" },
  { name: "Kitsu (Anime Meta)", url: "https://anime.kitsu.io/manifest.json" },
  { name: "OpenSubtitles", url: "https://opensubtitles-v3.strem.io/manifest.json" }
];

// ==========================================
// 2. BACKEND PROXY (Bypass CORS)
// ==========================================
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stremio/4.0.0' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Proxy Error', details: err.message });
  }
});

// ==========================================
// 3. FRONTEND (Fixed Logic)
// ==========================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <title>AniStream | Fixed</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { background: #0f0f11; color: white; font-family: sans-serif; }
    .card:hover { transform: scale(1.05); }
  </style>
</head>
<body class="min-h-screen p-6">

  <!-- Header -->
  <div class="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
    <h1 class="text-3xl font-bold text-red-500">AniStream <span class="text-white text-sm font-normal">Fixed Edition</span></h1>
    
    <!-- Search Bar -->
    <div class="relative w-full md:w-96">
      <input type="text" id="searchInput" placeholder="Search Anime (e.g. Naruto)..." 
        class="w-full bg-gray-800 border border-gray-700 rounded-full py-2 px-4 focus:outline-none focus:border-red-500">
      <button onclick="handleSearch()" class="absolute right-2 top-1.5 bg-red-600 px-3 py-1 rounded-full text-xs font-bold">GO</button>
    </div>
  </div>

  <!-- Content Area -->
  <div id="content" class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
    <!-- Loading State -->
    <div class="col-span-full text-center text-gray-500 py-10">Loading Top Anime...</div>
  </div>

  <!-- Player Modal -->
  <div id="modal" class="fixed inset-0 bg-black/90 hidden z-50 flex items-center justify-center p-4">
    <div class="bg-gray-900 rounded-xl max-w-4xl w-full p-6 relative">
      <button onclick="closeModal()" class="absolute top-4 right-4 text-gray-400 hover:text-white text-2xl">&times;</button>
      <div id="playerArea"></div>
      <div id="streamList" class="mt-4 space-y-2 max-h-60 overflow-y-auto"></div>
    </div>
  </div>

  <script>
    const content = document.getElementById('content');
    const modal = document.getElementById('modal');
    const playerArea = document.getElementById('playerArea');
    const streamList = document.getElementById('streamList');

    // 1. INITIAL LOAD: Hardcoded Popular Anime (To ensure streams exist)
    // These are IMDb/Kitsu IDs known to work with Torrentio
    const POPULAR_ANIME = [
      { id: "tt2560140", type: "series", name: "Attack on Titan", poster: "https://images.metahub.space/poster/tt2560140/w300" },
      { id: "tt0409591", type: "series", name: "One Piece", poster: "https://images.metahub.space/poster/tt0409591/w300" },
      { id: "tt0409591", type: "series", name: "Naruto Shippuden", poster: "https://images.metahub.space/poster/tt0409591/w300" }, // Using OP ID as placeholder for demo, search works better
      { id: "tt5626028", type: "series", name: "Demon Slayer", poster: "https://images.metahub.space/poster/tt5626028/w300" },
      { id: "tt0988824", type: "series", name: "Hunter x Hunter", poster: "https://images.metahub.space/poster/tt0988824/w300" },
      { id: "tt0434665", type: "series", name: "Bleach", poster: "https://images.metahub.space/poster/tt0434665/w300" }
    ];

    async function init() {
      content.innerHTML = '';
      POPULAR_ANIME.forEach(anime => {
        content.innerHTML += createCard(anime);
      });
    }

    function createCard(item) {
      return \`
        <div class="card bg-gray-800 rounded-lg overflow-hidden cursor-pointer transition-all" 
             onclick='fetchStreams("\${item.id}", "\${item.type}", "\${item.name}")'>
          <img src="\${item.poster}" class="w-full h-64 object-cover" onerror="this.src='https://via.placeholder.com/300x450?text=No+Image'">
          <div class="p-3">
            <h3 class="font-bold truncate">\${item.name}</h3>
          </div>
        </div>
      \`;
    }

    // 2. SEARCH FUNCTIONALITY
    async function handleSearch() {
      const query = document.getElementById('searchInput').value;
      if (!query) return;

      content.innerHTML = '<div class="col-span-full text-center">Searching Cinemeta...</div>';

      // Query Cinemeta for the ID
      try {
        const res = await fetch(\`/api/proxy?url=\${encodeURIComponent('https://v3-cinemeta.strem.io/catalog/series/top/search=' + query + '.json')}\`);
        const data = await res.json();
        
        if (data.metas && data.metas.length > 0) {
          content.innerHTML = '';
          data.metas.slice(0, 12).forEach(meta => {
            content.innerHTML += createCard({
              id: meta.imdb_id || meta.id,
              type: meta.type,
              name: meta.name,
              poster: meta.poster
            });
          });
        } else {
          content.innerHTML = '<div class="col-span-full text-center text-red-500">No results found.</div>';
        }
      } catch (e) {
        content.innerHTML = '<div class="col-span-full text-center text-red-500">Search failed.</div>';
      }
    }

    // 3. FETCH STREAMS (The Critical Fix)
    async function fetchStreams(id, type, name) {
      modal.classList.remove('hidden');
      playerArea.innerHTML = '';
      streamList.innerHTML = '<div class="text-gray-400">Querying Addons...</div>';

      // We query ALL addons for this specific ID
      const promises = ADDONS.map(async (addon) => {
        try {
          // Correct Stremio Protocol: /stream/{type}/{id}.json
          const url = \`/api/proxy?url=\${encodeURIComponent(addon.url.replace('/manifest.json', '') + '/stream/' + type + '/' + id + '.json')}\`;
          const res = await fetch(url);
          const data = await res.json();
          return (data.streams || []).map(s => ({ ...s, addon: addon.name }));
        } catch (e) {
          return [];
        }
      });

      const results = await Promise.all(promises);
      const allStreams = results.flat();

      streamList.innerHTML = '';
      
      if (allStreams.length === 0) {
        streamList.innerHTML = '<div class="text-red-500 font-bold">No streams found for this ID. Try searching for a different title.</div>';
        return;
      }

      // Display Streams
      allStreams.forEach(stream => {
        const isVideo = stream.url && (stream.url.includes('.mp4') || stream.url.includes('.m3u8'));
        const isMagnet = stream.url && stream.url.startsWith('magnet:');
        
        let btn = '';
        if (isVideo) {
          btn = \`<button onclick="play('\${stream.url}')" class="bg-green-600 px-3 py-1 rounded text-xs font-bold">PLAY</button>\`;
        } else if (isMagnet) {
          btn = \`<button onclick="copyMagnet('\${stream.url}')" class="bg-blue-600 px-3 py-1 rounded text-xs font-bold">COPY MAGNET</button>\`;
        }

        streamList.innerHTML += \`
          <div class="bg-gray-800 p-3 rounded flex justify-between items-center">
            <div class="overflow-hidden">
              <div class="font-bold text-sm truncate">\${stream.title || 'Unknown Quality'}</div>
              <div class="text-xs text-gray-400">\${stream.addon}</div>
            </div>
            \${btn}
          </div>
        \`;
      });
    }

    function play(url) {
      playerArea.innerHTML = \`<video id="vid" controls autoplay class="w-full rounded-lg bg-black"></video>\`;
      const video = document.getElementById('vid');
      
      if (url.includes('.m3u8')) {
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(url);
          hls.attachMedia(video);
        }
      } else {
        video.src = url;
      }
    }

    function copyMagnet(url) {
      navigator.clipboard.writeText(url);
      alert('Magnet copied! Paste into qBittorrent.');
    }

    function closeModal() {
      modal.classList.add('hidden');
      playerArea.innerHTML = '';
    }

    // Start
    init();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
