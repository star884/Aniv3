const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Publicly hosted Stremio catalog and stream endpoints 
const ANIME_CATALOG_URL = 'https://stremio.net';
const CYBERFLIX_STREAM_BASE = 'https://cyberflix.ovh'; 

app.use(express.static(path.join(__dirname, 'public')));

// 1. Dynamic Library Endpoint - Automatically syncs with the live Stremio addon data
app.get('/api/library', async (req, res) => {
    try {
        const response = await axios.get(ANIME_CATALOG_URL);
        // Map Stremio's standard Meta format into your website data layout
        const animeList = response.data.metas.map(item => ({
            id: item.id,
            title: item.name,
            poster: item.poster,
            description: item.description || 'No description available.',
            banner: item.background
        }));
        res.json({ success: true, data: animeList });
    } catch (error) {
        console.error("Error updating library from addon:", error.message);
        res.status(500).json({ success: false, message: "Could not fetch dynamic catalog." });
    }
});

// 2. Stream Fetcher Endpoint - Resolves Stremio streams to direct HTTP files
app.get('/api/stream/:id', async (req, res) => {
    try {
        const animeId = req.params.id;
        // Stremio addons require type:id:season:episode formatting for series
        // Defaulting to Season 1 Episode 1 for illustration
        const targetUrl = `${CYBERFLIX_STREAM_BASE}/${animeId}%3A1%3A1.json`;
        
        const response = await axios.get(targetUrl);
        
        if (response.data && response.data.streams && response.data.streams.length > 0) {
            // Filter for pure HTTP links to honor non-torrent preferences
            const directStreams = response.data.streams.filter(s => s.url && s.url.startsWith('http'));
            
            if (directStreams.length > 0) {
                return res.json({ success: true, streams: directStreams });
            }
        }
        res.status(404).json({ success: false, message: "No active HTTP streams found for this title." });
    } catch (error) {
        console.error("Error pulling streams:", error.message);
        res.status(500).json({ success: false, message: "Stream resolution failed." });
    }
});

app.listen(PORT, () => {
    console.log(`Anime Site running smoothly at http://localhost:${PORT}`);
});
