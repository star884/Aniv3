const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

// Render sets the PORT dynamically via environment variables
const PORT = process.env.PORT || 3000;

// Base Stremio provider API gateway URL (hidden from the frontend browser)
const STREMIO_ADDON_URL = "https://onrender.com";

// Serve static HTML/JS files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Proxy route: Your frontend fetches from here, and this server talks to Stremio
app.get('/api/streams/:imdbId', async (req, res) => {
    try {
        const { imdbId } = req.params;
        // Construct the Stremio Addon Protocol path for Season 1, Episode 1
        const targetUrl = `${STREMIO_ADDON_URL}${imdbId}:1:1.json`;

        // Server-to-server request (never blocked by browser CORS policies)
        const response = await fetch(targetUrl);
        if (!response.ok) {
            throw new Error(`Addon responded with status: ${response.status}`);
        }

        const data = await response.json();
        
        // Clean the data: Only return safe HTTP direct video streams, ignore torrent links
        const safeStreams = (data.streams || []).filter(stream => stream.url);

        res.json({ streams: safeStreams });
    } catch (error) {
        console.error("Proxy Error:", error.message);
        res.status(500).json({ error: "Failed to fetch streams from addon source." });
    }
});

app.listen(PORT, () => {
    console.log(`Server engine running smoothly on port ${PORT}`);
});
