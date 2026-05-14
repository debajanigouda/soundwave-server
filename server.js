require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;

// Multiple API keys for rotation — 40,000 units/day total
const YT_API_KEYS = [
  process.env.YOUTUBE_API_KEY,
  process.env.YOUTUBE_API_KEY_2,
  process.env.YOUTUBE_API_KEY_3,
  process.env.YOUTUBE_API_KEY_4,
].filter(Boolean);

let currentKeyIndex = 0;

function getApiKey() {
  return YT_API_KEYS[currentKeyIndex % YT_API_KEYS.length];
}

function rotateKey() {
  currentKeyIndex = (currentKeyIndex + 1) % YT_API_KEYS.length;
  console.log(`🔄 Rotated to API key ${currentKeyIndex + 1}`);
}

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

// ── URL CACHE (1 hour) ────────────────────────────────────
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

// ── TRENDING CACHE (6 hours) ──────────────────────────────
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_TTL = 1000 * 60 * 60 * 6;

async function fetchTrending() {
  if (trendingCache && Date.now() - trendingCacheTime < TRENDING_TTL) {
    console.log("📦 Serving trending from cache");
    return trendingCache;
  }

  console.log("🔄 Fetching fresh trending from YouTube API...");
  const queries = [
    "top hindi songs 2025 official audio",
    "trending bollywood 2025",
    "top english songs 2025 official audio",
  ];
  const query = queries[Math.floor(Math.random() * queries.length)];

  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query,
        type: "video",
        videoCategoryId: "10",
        maxResults: 20,
        order: "viewCount",
        key: getApiKey(),
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
    trendingCache = songs;
    trendingCacheTime = Date.now();
    console.log(`✅ Trending cached — ${songs.length} songs for 6 hours`);
    return songs;
  } catch (err) {
    // If current key fails, rotate and try next
    rotateKey();
    throw err;
  }
}

// ── SEARCH CACHE (30 mins) ────────────────────────────────
const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 30;

async function fetchSearch(query) {
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_TTL) {
    console.log(`📦 Serving search "${query}" from cache`);
    return cached.songs;
  }

  console.log(`🔄 Searching YouTube for: ${query}`);
  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query + " official audio",
        type: "video",
        videoCategoryId: "10",
        maxResults: 20,
        key: getApiKey(),
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
    searchCache.set(cacheKey, { songs, time: Date.now() });
    console.log(`✅ Search "${query}" cached for 30 mins`);
    return songs;
  } catch (err) {
    rotateKey();
    throw err;
  }
}

// ── ROUTES ────────────────────────────────────────────────

app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query required" });
    const songs = await fetchSearch(query);
    res.json({ success: true, songs });
    songs.slice(0, 3).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/trending", async (req, res) => {
  try {
    const songs = await fetchTrending();
    res.json({ success: true, songs });
    songs.slice(0, 5).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    if (trendingCache) {
      console.log("⚠️ API failed, serving stale cache");
      return res.json({ success: true, songs: trendingCache, stale: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/prefetch/:videoId", async (req, res) => {
  try {
    await fetchStreamUrl(req.params.videoId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

app.get("/api/stream/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const streamUrl = await fetchStreamUrl(videoId);
    res.redirect(streamUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  const trendingAge = trendingCache
    ? Math.round((Date.now() - trendingCacheTime) / 1000 / 60)
    : null;
  res.json({
    status: "✅ SoundWave running!",
    platform: process.platform,
    youtube: `✅ ${YT_API_KEYS.length} keys loaded`,
    currentKey: currentKeyIndex + 1,
    ytdlp: YTDLP,
    urlCache: urlCache.size,
    searchCache: searchCache.size,
    trendingCache: trendingCache
      ? `✅ ${trendingCache.length} songs, ${trendingAge} mins old`
      : "❌ Empty",
  });
});

app.listen(PORT, () => {
  console.log(`\n🎵 SoundWave Server → http://localhost:${PORT}`);
  console.log(`🔑 YouTube API: ${YT_API_KEYS.length} keys loaded`);
  console.log(`🖥️  Platform: ${process.platform}`);
  console.log(`🎬 yt-dlp: ${YTDLP}`);
  console.log(`⚡ Caching: ✅ Trending=6h, Search=30min, Stream=1h\n`);
  fetchTrending().catch(err => console.log("⚠️ Startup prefetch failed:", err.message));
});