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
  process.env.YOUTUBE_API_KEY_5,
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

// ── TITLE CLEANER ─────────────────────────────────────────
function cleanTitle(title) {
  return title
    .replace(/\(official.*?\)/gi, "")
    .replace(/\[official.*?\]/gi, "")
    .replace(/official (audio|video|music video|lyric video|lyrics)/gi, "")
    .replace(/\(audio\)/gi, "")
    .replace(/\(lyrics?\)/gi, "")
    .replace(/\(full video\)/gi, "")
    .replace(/\(full song\)/gi, "")
    .replace(/ft\..*?(?=\s*[-|]|$)/gi, s => s) // keep ft. artist
    .replace(/\|.*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── ARTIST CLEANER ────────────────────────────────────────
function cleanArtist(channel) {
  return channel
    .replace(/ - Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/official$/i, "")
    .trim();
}

// ── SONG FILTER & DEDUPLICATOR ────────────────────────────
function filterSongs(songs, query) {
  const queryLower = (query || "").toLowerCase().trim();

  const scored = songs.map(song => {
    let score = 100; // start with base score
    const title = song.originalTitle || "";
    const channel = song.channelTitle || "";

    // ✅ BOOST official channels
    if (channel.includes("vevo")) score += 20;
    if (channel.includes("t-series")) score += 15;
    if (channel.includes("sony music")) score += 15;
    if (channel.includes("zee music")) score += 15;
    if (channel.includes("saregama")) score += 15;
    if (channel.includes("tips official")) score += 15;
    if (channel.includes("yrf")) score += 15;
    if (channel.includes("universal music")) score += 15;
    if (channel.includes("dharma")) score += 12;
    if (channel.includes("official")) score += 10;
    if (channel.includes("music")) score += 5;

    // ✅ BOOST official in title
    if (title.includes("official audio")) score += 15;
    if (title.includes("official video")) score += 12;
    if (title.includes("official music video")) score += 12;

    // ✅ BOOST if title matches query
    if (queryLower && title.includes(queryLower)) score += 10;

    // ⚠️ SOFT penalty — don't remove, just rank lower
    if (title.includes("8d audio")) score -= 30;
    if (title.includes("lofi") || title.includes("lo-fi")) score -= 25;
    if (title.includes("remix")) score -= 20;
    if (title.includes("cover")) score -= 25;
    if (title.includes("karaoke")) score -= 30;
    if (title.includes("ringtone")) score -= 30;
    if (title.includes("instrumental")) score -= 20;
    if (title.includes("slowed")) score -= 25;
    if (title.includes("reverb")) score -= 25;
    if (title.includes("bass boost")) score -= 25;
    if (title.includes("reaction")) score -= 35;
    if (title.includes("mashup")) score -= 20;
    if (title.includes("tribute")) score -= 25;
    if (title.includes("whatsapp status")) score -= 35;
    if (title.includes("unplugged")) score -= 15;

    return { ...song, score };
  });

  // Sort by score
  scored.sort((a, b) => b.score - a.score);

  // ✅ Remove duplicates — keep best version
  const seen = new Set();
  const unique = [];

  for (const song of scored) {
    // Normalize title for duplicate detection
    const normalized = (song.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Use first 3 words as key
    const words = normalized.split(" ").slice(0, 3).join(" ");

    if (words.length > 2 && !seen.has(words)) {
      seen.add(words);
      unique.push(song);
    } else if (words.length <= 2) {
      // Very short titles — use full title
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(song);
      }
    }
  }

  // Clean up internal fields
  return unique.map(({ score, originalTitle, channelTitle, ...song }) => song);
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
const songs = response.data.items
  .map((item) => ({
    id: item.id.videoId,
    title: cleanTitle(item.snippet.title),
    artist: cleanArtist(item.snippet.channelTitle),
    thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium.url,
    youtubeId: item.id.videoId,
    originalTitle: item.snippet.title.toLowerCase(),
    channelTitle: item.snippet.channelTitle.toLowerCase(),
  }));

const filtered = filterSongs(songs, query);
// Save to cache
trendingCache = filtered.map(({ score, originalTitle, channelTitle, ...s }) => s);
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

    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query + " official audio",
        type: "video",
        videoCategoryId: "10",
        maxResults: 50, // fetch more to filter better
        order: "relevance",
        key: getApiKey(),
      },
    });

    const allSongs = response.data.items.map((item) => ({
      id: item.id.videoId,
      title: cleanTitle(item.snippet.title),
      artist: cleanArtist(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium.url,
      youtubeId: item.id.videoId,
      originalTitle: item.snippet.title.toLowerCase(),
      channelTitle: item.snippet.channelTitle.toLowerCase(),
    }));

    // ✅ Filter out duplicates and low quality results
    const filtered = filterSongs(allSongs, query);

    res.json({ success: true, songs: filtered.slice(0, 20) });
    filtered.slice(0, 3).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    rotateKey();
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

// ── KEEP ALIVE — ping self every 14 minutes ──────────────
setInterval(() => {
  const url = "https://soundwave-server.onrender.com/api/health";
  fetch(url)
    .then(() => console.log("🏓 Keep-alive ping sent"))
    .catch(() => console.log("⚠️ Keep-alive ping failed"));
}, 14 * 60 * 1000); // every 14 minutes

app.listen(PORT, () => {
  console.log(`\n🎵 SoundWave Server → http://localhost:${PORT}`);
  console.log(`🔑 YouTube API: ${YT_API_KEYS.length} keys loaded`);
  console.log(`🖥️  Platform: ${process.platform}`);
  console.log(`🎬 yt-dlp: ${YTDLP}`);
  console.log(`⚡ Caching: ✅ Trending=6h, Search=30min, Stream=1h\n`);
  fetchTrending().catch(err => console.log("⚠️ Startup prefetch failed:", err.message));
});