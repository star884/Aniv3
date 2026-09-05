const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Top Tier verified Stremio Add-on protocols
const KITSU_CATALOG = 'https://anime-kitsu.strem.fun/catalog/series/kitsu-anime-list.json';
const KITSU_META_BASE = 'https://strem.fun';
const STREAM_ADDON_BASE = 'https://hayd.uk';

// Visual Layout Wrapper Configuration
const HTML_HEAD = (title) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://jsdelivr.net"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0c0d14; color: #f4f5f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 30px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { margin-bottom: 24px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 24px; }
        .card { background: #161824; border-radius: 12px; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; border: 1px solid #23263a; position: relative; display: flex; flex-direction: column; }
        .card:hover { transform: translateY(-4px); box-shadow: 0 12px 20px rgba(0,0,0,0.4); border-color: #3b4260; }
        .card img { width: 100%; height: 270px; object-fit: cover; background: #23263a; }
        .card-body { padding: 14px; flex-grow: 1; display: flex; flex-direction: column; justify-content: space-between; }
        .card-title { font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: #e4e6eb; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .btn { display: inline-block; background: #4f46e5; color: #fff; padding: 8px 12px; border-radius: 6px; text-decoration: none; font-size: 0.85rem; font-weight: 600; text-align: center; transition: background 0.2s; }
        .btn:hover { background: #6366f1; }
        .player-wrapper { display: flex; flex-direction: column; align-items: center; background: #161824; padding: 24px; border-radius: 16px; border: 1px solid #23263a; margin-top: 20px; }
        video { width: 100%; max-width: 900px; border-radius: 8px; background: #000; box-shadow: 0 20px 4px rgba(0,0,0,0.5); }
        .back-link { color: #9ca3af; text-decoration: none; display: inline-flex; align-items: center; margin-bottom: 20px; font-size: 0.9rem; }
        .back-link:hover { color: #ffffff; }
        .episode-list { width: 100%; max-width: 900px; display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 10px; margin-top: 20px; }
        .ep-btn { background: #23263a; color: #fff; padding: 10px; border-radius: 6px; text-align: center; text-decoration: none; font-size: 0.85rem; border: 1px solid transparent; }
        .ep-btn:hover { background: #2d314d; border-color: #4f46e5; }
        .ep-btn.active { background: #4f46e5; font-weight: bold; }
    </style>
</head>
<body>
<div class="container">
`;

const HTML_FOOT = `</div></body></html>`;

// Route A: Render Trending Dashboard Catalog
app.get('/', async (req, res) => {
    try {
        const response = await axios.get(KITSU_CATALOG, { headers: { 'User-Agent': 'StremioDashboard/1.0' }, timeout: 6000 });
        const items = response.data.metas || [];
        
        let output = HTML_HEAD("Anime Stream Dashboard") + `<h1>Trending Anime Series</h1><div class="grid">`;
        
        items.forEach(anime => {
            output += `
            <div class="card">
                <img src="${anime.poster}" alt="${anime.name}" loading="lazy">
                <div class="card-body">
                    <div class="card-title">${anime.name}</div>
                    <a href="/show/${anime.id}" class="btn">Browse Episodes</a>
                </div>
            </div>`;
        });
        
        output += `</div>` + HTML_FOOT;
        res.send(output);
    } catch (error) {
        res.status(500).send("Error compiling streaming catalog directory. Refresh to try again.");
    }
});

// Route B: Episode List Browser & Integrated HLS Player
app.get('/show/:id', async (req, res) => {
    const animeId = req.params.id;
    const currentEpIndex = parseInt(req.query.ep) || 0;

    try {
        const metaResponse = await axios.get(`${KITSU_META_BASE}/${animeId}.json`, { timeout: 6000 });
        const meta = metaResponse.data.meta;
        
        if (!meta || !meta.videos || meta.videos.length === 0) {
            return res.status(404).send(HTML_HEAD("Error") + "<p>No playable episode indexes found for this asset.</p>" + HTML_FOOT);
        }

        const selectedVideo = meta.videos[currentEpIndex] || meta.videos[0];
        const stremioId = selectedVideo.id;
        
        // Resolve stream via direct lookup
        let targetStreamUrl = null;
        let streamTitle = "Default Stream";
        
        try {
            const streamResponse = await axios.get(`${STREAM_ADDON_BASE}/${stremioId}.json`, { timeout: 5000 });
            const streams = streamResponse.data.streams || [];
            
            // Extract the cleanest working HTTP/HLS URL source asset
            const match = streams.find(s => s.url);
            if (match) {
                targetStreamUrl = match.url;
                streamTitle = match.title || match.name || streamTitle;
            }
        } catch (e) {
            console.error(`Stream parsing failure context: ${e.message}`);
        }

        let output = HTML_HEAD(`Watching: ${meta.name}`) + `
            <a href="/" class="back-link">← Return to Catalog</a>
            <div class="player-wrapper">
                <h1>${meta.name}</h1>
                <h3 style="color:#9ca3af; margin-bottom:20px;">Now Playing: ${selectedVideo.title || `Episode ${currentEpIndex + 1}`}</h3>`;

        if (targetStreamUrl) {
            // Secure server-side dynamic gateway endpoint generation to clean headers
            const proxiedUrl = `/stream-gateway?origin=${encodeURIComponent(targetStreamUrl)}`;
            
            output += `
                <video id="video-engine" controls></video>
                <p style="margin-top:15px; font-size:0.85rem; color:#a1a1aa;">Stream Engine Source: <strong>${streamTitle.split('\n')[0]}</strong></p>
                <script>
                    const video = document.getElementById('video-engine');
                    const videoSrc = '${proxiedUrl}';
                    if (Hls.isSupported()) {
                        const hls = new Hls({ maxBufferSize: 30 * 1024 * 1024 });
                        hls.loadSource(videoSrc);
                        hls.attachMedia(video);
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = videoSrc;
                    } else {
                        video.src = videoSrc; // Default mp4 fallback fallback assignment
                    }
                </script>`;
        } else {
            output += `
            <div style="padding:40px; background:#23263a; border-radius:8px; text-align:center; width:100%;">
                <p style="color:#ef4444; font-weight:600;">No responsive web-compatible streams returned for this episode.</p>
                <p style="font-size:0.85rem; color:#9ca3af; margin-top:8px;">Stremio ID attempted: ${stremioId}</p>
            </div>`;
        }

        // Ep Selector Grid Generation Loop
        output += `
                <div class="episode-list">`;
        meta.videos.forEach((vid, index) => {
            const activeClass = index === currentEpIndex ? 'active' : '';
            output += `<a href="/show/${animeId}?ep=${index}" class="ep-btn ${activeClass}">${index + 1}</a>`;
        });
        output += `</div></div>` + HTML_FOOT;
        
        res.send(output);
    } catch (error) {
        res.status(500).send("Error building playback profile structure target.");
    }
});

// Route C: The CORS & Mixed Content Reverse Proxy Gateway Engine
app.get('/stream-gateway', async (req, res) => {
    const remoteUrl = req.query.origin;
    if (!remoteUrl) return res.status(400).send("Origin source parameter required.");

    try {
        const response = await axios({
            method: 'get',
            url: remoteUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': new URL(remoteUrl).origin
            },
            timeout: 15000
        });

        // Force downstream browser validation alignment
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send("Streaming Gateway connection pipeline drop error.");
    }
});

app.listen(PORT, () => console.log(`Application online and listening on network interface port: ${PORT}`));
