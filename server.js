const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// The base URL for the active Anime Vortex manifest/endpoints
const ADDON_BASE_URL = 'https://anime-vortex.onrender.com'; 

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// Global state serving as our automatic, dynamically updating memory cache
let animeLibrary = {
    trending: [],
    popular: [],
    lastUpdated: null
};

/**
 * Automatically fetch, normalize, and update the anime catalogs from the addon.
 * This runs on app initialization and can be scheduled via a cron job.
 */
async function updateAutomaticLibrary() {
    try {
        console.log('[Library Engine] Synchronizing catalogs from Stremio Addon...');
        
        // Fetch Trending Catalog from the Addon
        const trendingRes = await axios.get(`${ADDON_BASE_URL}/catalog/series/anime_vortex_trending.json`);
        // Fetch Popular Catalog from the Addon
        const popularRes = await axios.get(`${ADDON_BASE_URL}/catalog/series/anime_vortex_popular.json`);

        if (trendingRes.data && trendingRes.data.metas) {
            animeLibrary.trending = trendingRes.data.metas;
        }
        if (popularRes.data && popularRes.data.metas) {
            animeLibrary.popular = popularRes.data.metas;
        }
        
        animeLibrary.lastUpdated = new Date().toLocaleString();
        console.log(`[Library Engine] Synced successfully at ${animeLibrary.lastUpdated}. Total items: ${animeLibrary.trending.length + animeLibrary.popular.length}`);
    } catch (error) {
        console.error('[Library Engine] Error updating automated catalogs:', error.message);
    }
}

// Initialize the automated library syncing
updateAutomaticLibrary();
// Automatically update/poll the addon structure every 30 minutes
setInterval(updateAutomaticLibrary, 30 * 60 * 1000);

// Route: Main Index Hub
app.get('/', (req, res) => {
    res.render('index', { library: animeLibrary });
});

// Route: Detailed View + Episode Map
app.get('/anime/:id', async (req, requireRes) => {
    try {
        const animeId = req.params.id;
        // Hit the Meta resource endpoint of the addon to get full episode structure
        const metaRes = await axios.get(`${ADDON_BASE_URL}/meta/series/${animeId}.json`);
        
        if (!metaRes.data || !metaRes.data.meta) {
            return requireRes.status(404).send('Anime metadata profile not found.');
        }

        requireRes.render('detail', { anime: metaRes.data.meta });
    } catch (error) {
        requireRes.status(500).send('Error pulling details from backend addon: ' + error.message);
    }
});

// Route: Stream Fetching API
app.get('/api/stream/:id/:episodeId', async (req, res) => {
    try {
        const { id, episodeId } = req.params;
        // Query the /stream endpoint to retrieve HTTP playback urls
        const streamRes = await axios.get(`${ADDON_BASE_URL}/stream/series/${episodeId}.json`);
        
        if (!streamRes.data || !streamRes.data.streams || streamRes.data.streams.length === 0) {
            return res.json({ success: false, message: 'No active streams found for this release.' });
        }

        // Filter out any accidental P2P/torrent streams to ensure clean direct HTTPS delivery
        const nonTorrentStreams = streamRes.data.streams.filter(s => s.url && s.url.startsWith('http'));

        if (nonTorrentStreams.length === 0) {
            return res.json({ success: false, message: 'No direct-http streams available.' });
        }

        // Send the stream sources safely back to the client UI player
        res.json({ success: true, streams: nonTorrentStreams });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.listen(PORT, () => console.log(`[Production Server] Live and rendering on http://localhost:${PORT}`));
