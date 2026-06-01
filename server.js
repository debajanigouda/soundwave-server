require("dotenv").config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;

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

// ── TITLE & ARTIST CLEANER ────────────────────────────────
function cleanTitle(title) {
  return title
    .replace(/\(official.*?\)/gi, "")
    .replace(/\[official.*?\]/gi, "")
    .replace(/official (audio|video|music video|lyric video|lyrics)/gi, "")
    .replace(/\(audio\)/gi, "")
    .replace(/\(lyrics?\)/gi, "")
    .replace(/\(full video\)/gi, "")
    .replace(/\(full song\)/gi, "")
    .replace(/\|.*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
  const now = Date.now();

  const scored = songs.map(song => {
    let score = 100;

    // ✅ FIX — define title and channel from song object
    const title = (song.originalTitle || "").toLowerCase();
    const channel = (song.channelTitle || "").toLowerCase();

    // BOOST: Very recent songs
    if (song.publishedAt) {
      const daysOld = (now - new Date(song.publishedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld < 3) score += 30;
      else if (daysOld < 7) score += 20;
      else if (daysOld < 14) score += 10;
      else if (daysOld < 30) score += 5;
    }

    // BOOST: Official channels
    if (channel.includes("vevo")) score += 15;
    if (channel.includes("official")) score += 10;
    if (channel.includes("t-series")) score += 8;
    if (channel.includes("sony music")) score += 8;
    if (channel.includes("universal music")) score += 8;
    if (channel.includes("zee music")) score += 8;
    if (channel.includes("saregama")) score += 8;
    if (channel.includes("tips official")) score += 8;
    if (channel.includes("yrf")) score += 8;
    if (channel.includes("dharma")) score += 7;
    if (channel.includes("jio saavn")) score += 8;
    if (channel.includes("speed records")) score += 8;
    if (channel.includes("desi music")) score += 7;

    // BOOST: Official in title
    if (title.includes("official audio")) score += 12;
    if (title.includes("official video")) score += 10;
    if (title.includes("official music video")) score += 10;

    // BOOST: Query match
    if (queryLower && title.includes(queryLower)) score += 8;

    // PENALTY: Low quality
    if (title.includes("8d audio")) score -= 20;
    if (title.includes("lofi") || title.includes("lo-fi")) score -= 15;
    if (title.includes("remix")) score -= 15;
    if (title.includes("unplugged")) score -= 10;
    if (title.includes("cover")) score -= 20;
    if (title.includes("karaoke")) score -= 25;
    if (title.includes("ringtone")) score -= 25;
    if (title.includes("instrumental")) score -= 15;
    if (title.includes("slowed")) score -= 20;
    if (title.includes("reverb")) score -= 20;
    if (title.includes("bass boost")) score -= 20;
    if (title.includes("reaction")) score -= 30;
    if (title.includes("full album")) score -= 15;
    if (title.includes("jukebox")) score -= 10;
    if (title.includes("mashup")) score -= 20;
    if (title.includes("tribute")) score -= 25;
    if (title.includes("whatsapp status")) score -= 30;

    return { ...song, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Remove duplicates
  const seen = new Set();
  const unique = [];
  for (const song of scored) {
    const key = (song.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 3)
      .join(" ");

    if (key.length > 2 && !seen.has(key)) {
      seen.add(key);
      unique.push(song);
    }
  }

  return unique.map(({ score, originalTitle, channelTitle, publishedAt, ...song }) => song);
}

// ── STREAM URL ────────────────────────────────────────────
function fetchStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const cached = getCached(videoId);
    if (cached) { resolve(cached); return; }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const cmd = `${YTDLP} --get-url -f bestaudio/best --no-playlist "${url}"`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err) { reject(new Error("yt-dlp failed")); return; }
      const streamUrl = stdout.trim().split("\n")[0];
      if (!streamUrl) { reject(new Error("No URL found")); return; }
      setCache(videoId, streamUrl);
      resolve(streamUrl);
    });
  });
}

// ── TRENDING CACHE ────────────────────────────────────────
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_TTL = 1000 * 60 * 60 * 3; // 3 hours

async function fetchTrending() {
  if (trendingCache && trendingCache.length > 0 && Date.now() - trendingCacheTime < TRENDING_TTL) {
    console.log("📦 Serving trending from cache");
    return trendingCache;
  }

  console.log("🔄 Fetching REAL trending songs...");

  // Last 30 days
  const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const last14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const requests = [
      // 🇮🇳 India Hindi — last 14 days by viewCount
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "IN",
          relevanceLanguage: "hi",
          order: "viewCount",
          publishedAfter: last14,
          maxResults: 15,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🇮🇳 India — last 30 days by viewCount
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "IN",
          order: "viewCount",
          publishedAfter: last30,
          maxResults: 15,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🎵 Punjabi trending
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "IN",
          relevanceLanguage: "pa",
          order: "viewCount",
          publishedAfter: last30,
          maxResults: 10,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🌍 Global trending
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "US",
          order: "viewCount",
          publishedAfter: last14,
          maxResults: 10,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🎬 South India
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "IN",
          relevanceLanguage: "ta",
          order: "viewCount",
          publishedAfter: last30,
          maxResults: 8,
          key: getApiKey(),
        },
      }).catch(() => null),
    ];

    const responses = await Promise.all(requests);

    let allSongs = [];
    for (const response of responses) {
      if (!response?.data?.items?.length) continue;
      const songs = response.data.items.map(item => ({
        id: item.id.videoId,
        title: cleanTitle(item.snippet.title),
        artist: cleanArtist(item.snippet.channelTitle),
        thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
        youtubeId: item.id.videoId,
        originalTitle: item.snippet.title.toLowerCase(),
        channelTitle: item.snippet.channelTitle.toLowerCase(),
        publishedAt: item.snippet.publishedAt,
      }));
      allSongs = [...allSongs, ...songs];
    }

    console.log(`📊 Total raw songs: ${allSongs.length}`);

    if (allSongs.length === 0) throw new Error("No songs fetched");

    const filtered = filterSongs(allSongs, "");
    trendingCache = filtered.slice(0, 30);
    trendingCacheTime = Date.now();
    console.log(`✅ Trending cached — ${trendingCache.length} real trending songs`);
    return trendingCache;

  } catch (err) {
    rotateKey();
    throw err;
  }
}

async function fetchGeminiTrending(genre = "all") {
  const genrePrompt = genre === "all" 
    ? "Hindi, Punjabi, Tamil, Telugu, and Global English"
    : genre;

  const prompt = `You are a music expert. Give me exactly 20 currently trending songs in ${genrePrompt} music as of 2025.
Return ONLY a JSON array, no explanation, no markdown:
[{"title":"Song Name","artist":"Artist Name","searchQuery":"song name artist name official audio"}]`;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 }
    }
  );

  const text = response.data.candidates[0].content.parts[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  return JSON.parse(clean.slice(start, end + 1));
}

// ── SEARCH CACHE ──────────────────────────────────────────
const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 30;

// ── ROUTES ────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query required" });

    // Check search cache
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.time < SEARCH_TTL) {
      console.log(`📦 Search cache hit: ${query}`);
      return res.json({ success: true, songs: cached.songs });
    }

    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query + " official audio",
        type: "video",
        videoCategoryId: "10",
        maxResults: 30,
        order: "relevance",
        key: getApiKey(),
      },
    });

    const allSongs = response.data.items.map((item) => ({
      id: item.id.videoId,
      title: cleanTitle(item.snippet.title),
      artist: cleanArtist(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
      youtubeId: item.id.videoId,
      originalTitle: item.snippet.title.toLowerCase(),
      channelTitle: item.snippet.channelTitle.toLowerCase(),
      publishedAt: item.snippet.publishedAt,
    }));

    const filtered = filterSongs(allSongs, query);
    const songs = filtered.slice(0, 20);

    // Save to search cache
    searchCache.set(cacheKey, { songs, time: Date.now() });

    res.json({ success: true, songs });
    songs.slice(0, 3).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    rotateKey();
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/trending", async (req, res) => {
  try {
    if (req.query.refresh === "true") {
      trendingCache = null;
      trendingCacheTime = 0;
    }
    const songs = await fetchTrending();
    res.json({ success: true, songs });
    songs.slice(0, 5).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    if (trendingCache) {
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
    const streamUrl = await fetchStreamUrl(req.params.videoId);
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

app.get("/api/ai-trending", async (req, res) => {
  try {
    const genre = req.query.genre || "all";
    
    // Get song list from Gemini
    const geminiSongs = await fetchGeminiTrending(genre);
    
    // Now search YouTube for each song to get real video IDs + thumbnails
    const songResults = await Promise.all(
      geminiSongs.slice(0, 15).map(async (song) => {
        try {
          const ytRes = await axios.get("https://www.googleapis.com/youtube/v3/search", {
            params: {
              part: "snippet",
              q: song.searchQuery,
              type: "video",
              videoCategoryId: "10",
              maxResults: 1,
              key: getApiKey(),
            },
          });
          const item = ytRes.data.items?.[0];
          if (!item) return null;
          return {
            id: item.id.videoId,
            title: song.title,
            artist: song.artist,
            thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
            youtubeId: item.id.videoId,
          };
        } catch {
          return null;
        }
      })
    );

    const songs = songResults.filter(Boolean);
    res.json({ success: true, songs });

  } catch (err) {
    console.error("Gemini trending error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── KEEP ALIVE ────────────────────────────────────────────
setInterval(() => {
  fetch("https://soundwave-server.onrender.com/api/health")
    .then(() => console.log("🏓 Keep-alive ping sent"))
    .catch(() => console.log("⚠️ Keep-alive ping failed"));
}, 14 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🎵 SoundWave Server → http://localhost:${PORT}`);
  console.log(`🔑 YouTube API: ${YT_API_KEYS.length} keys loaded`);
  console.log(`🖥️  Platform: ${process.platform}`);
  console.log(`🎬 yt-dlp: ${YTDLP}`);
  console.log(`⚡ Caching: Trending=3h, Search=30min, Stream=1h\n`);
  fetchTrending().catch(err => console.log("⚠️ Startup prefetch failed:", err.message));
});