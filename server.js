require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
const YT_API_KEY = process.env.YOUTUBE_API_KEY;

// ✅ Use 'yt-dlp' (no .exe) for Linux on Render
const IS_LINUX = process.platform !== "win32";
const YTDLP = IS_LINUX ? path.join(__dirname, "yt-dlp") : path.join(__dirname, "yt-dlp.exe");

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://soundwave-chi.vercel.app",
    /\.vercel\.app$/
  ],
  methods: ["GET", "POST", "DELETE"],
  credentials: true
}));
app.use(express.json());

// ── URL CACHE ─────────────────────────────────────────────
const urlCache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

function getCached(videoId) {
  const entry = urlCache.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { urlCache.delete(videoId); return null; }
  return entry.url;
}

function setCache(videoId, url) {
  urlCache.set(videoId, { url, time: Date.now() });
}

function fetchStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const cached = getCached(videoId);
    if (cached) { resolve(cached); return; }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const cmd = `${YTDLP} --get-url -f bestaudio/best --no-playlist "${url}"`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error("yt-dlp failed")); return; }
      const streamUrl = stdout.trim().split("\n")[0];
      if (!streamUrl) { reject(new Error("No URL found")); return; }
      setCache(videoId, streamUrl);
      resolve(streamUrl);
    });
  });
}

// ── SEARCH ───────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query required" });
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query + " official audio",
        type: "video",
        videoCategoryId: "10",
        maxResults: 20,
        key: YT_API_KEY,
      },
    });
    const songs = response.data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title
        .replace(/\(Official.*?\)/gi, "")
        .replace(/\[Official.*?\]/gi, "")
        .replace(/Official (Audio|Video|Music Video)/gi, "")
        .replace(/\|.*$/g, "")
        .trim(),
      artist: item.snippet.channelTitle.replace(/ - Topic$/i, "").trim(),
      thumbnail: item.snippet.thumbnails.medium.url,
      youtubeId: item.id.videoId,
    }));
    res.json({ success: true, songs });
    songs.slice(0, 3).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── TRENDING ─────────────────────────────────────────────
app.get("/api/trending", async (req, res) => {
  try {
    const queries = [
      "top hindi songs 2025 official audio",
      "trending bollywood 2025",
      "top english songs 2025 official audio",
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query,
        type: "video",
        videoCategoryId: "10",
        maxResults: 20,
        order: "viewCount",
        key: YT_API_KEY,
      },
    });
    const songs = response.data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title
        .replace(/\(Official.*?\)/gi, "")
        .replace(/\[Official.*?\]/gi, "")
        .replace(/Official (Audio|Video|Music Video)/gi, "")
        .replace(/\|.*$/g, "")
        .trim(),
      artist: item.snippet.channelTitle.replace(/ - Topic$/i, "").trim(),
      thumbnail: item.snippet.thumbnails.medium.url,
      youtubeId: item.id.videoId,
    }));
    res.json({ success: true, songs });
    songs.slice(0, 5).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PREFETCH ─────────────────────────────────────────────
app.get("/api/prefetch/:videoId", async (req, res) => {
  try {
    await fetchStreamUrl(req.params.videoId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ── STREAM ───────────────────────────────────────────────
app.get("/api/stream/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const streamUrl = await fetchStreamUrl(videoId);
    res.redirect(streamUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ───────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "✅ SoundWave running!",
    platform: process.platform,
    youtube: YT_API_KEY ? "✅ Connected" : "❌ Missing",
    ytdlp: YTDLP,
    cachedSongs: urlCache.size,
  });
});

app.listen(PORT, () => {
  console.log(`\n🎵 SoundWave Server → http://localhost:${PORT}`);
  console.log(`🔑 YouTube API: ${YT_API_KEY ? "✅ Connected" : "❌ Missing!"}`);
  console.log(`🖥️  Platform: ${process.platform}`);
  console.log(`🎬 yt-dlp: ${YTDLP}`);
  console.log(`⚡ URL caching: ✅ Enabled\n`);
});