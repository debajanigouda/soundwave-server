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
  const queryLower = query.toLowerCase().trim();

  // ✅ Priority scoring — higher = better
  const now = Date.now();
  const scored = songs.map(song => {
    let score = 100;

    // ✅ BOOST very recent songs — newer = more trending
    if (song.publishedAt) {
      const age = now - new Date(song.publishedAt).getTime();
      const daysOld = age / (1000 * 60 * 60 * 24);
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

    // BOOST: Official in title
    if (title.includes("official audio")) score += 12;
    if (title.includes("official video")) score += 10;
    if (title.includes("official music video")) score += 10;

    // BOOST: Title matches query closely
    if (title.includes(queryLower)) score += 8;

    // PENALTY: Low quality versions
    if (title.includes("8d audio")) score -= 20;
    if (title.includes("lofi")) score -= 15;
    if (title.includes("lo-fi")) score -= 15;
    if (title.includes("remix")) score -= 15;
    if (title.includes("unplugged")) score -= 10;
    if (title.includes("cover")) score -= 20;
    if (title.includes("karaoke")) score -= 25;
    if (title.includes("ringtone")) score -= 25;
    if (title.includes("instrumental")) score -= 15;
    if (title.includes("slowed")) score -= 20;
    if (title.includes("reverb")) score -= 20;
    if (title.includes("bass boosted")) score -= 20;
    if (title.includes("reaction")) score -= 30;
    if (title.includes("lyrics video") && !title.includes("official")) score -= 5;
    if (title.includes("lyric video") && !title.includes("official")) score -= 5;
    if (title.includes("full album")) score -= 15;
    if (title.includes("jukebox")) score -= 10;
    if (title.includes("mashup")) score -= 20;
    if (title.includes("tribute")) score -= 25;
    if (title.includes("status")) score -= 20;
    if (title.includes("whatsapp")) score -= 25;

    return { ...song, score };
  });
  
  // ✅ Sort by score — best first
  scored.sort((a, b) => b.score - a.score);

  // ✅ Remove duplicates — keep only best version of same song
  const seen = new Set();
  const unique = [];

  for (const song of scored) {
    // Create a simplified key to detect duplicates
    const key = song.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 4) // first 4 words
      .join(" ");

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(song);
    }
  }

  // ✅ Remove score field before sending
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

  console.log("🔄 Fetching REAL trending songs...");

  try {
    const [india, global, punjabi, south] = await Promise.all([

      // 🇮🇳 India trending music chart
      axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: {
          part: "snippet,statistics",
          chart: "mostPopular",
          videoCategoryId: "10",
          regionCode: "IN",
          maxResults: 20,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🌍 Global (US) trending music chart
      axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: {
          part: "snippet,statistics",
          chart: "mostPopular",
          videoCategoryId: "10",
          regionCode: "US",
          maxResults: 10,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🎵 Punjabi — search-based (no chart for language)
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "IN",
          relevanceLanguage: "pa",
          order: "date",
          publishedAfter: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          maxResults: 8,
          key: getApiKey(),
        },
      }).catch(() => null),

      // 🎬 South India — Tamil trending
      axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          type: "video",
          videoCategoryId: "10",
          regionCode: "IN",
          relevanceLanguage: "ta",
          order: "date",
          publishedAfter: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          maxResults: 8,
          key: getApiKey(),
        },
      }).catch(() => null),
    ]);

    let allSongs = [];

    // Videos API returns items differently — id is a string, not object
    for (const response of [india, global]) {
      if (!response?.data?.items) continue;
      const songs = response.data.items.map(item => ({
        id: item.id,                         // ← string directly
        title: cleanTitle(item.snippet.title),
        artist: cleanArtist(item.snippet.channelTitle),
        thumbnail: item.snippet.thumbnails.high?.url ||
          item.snippet.thumbnails.medium?.url,
        youtubeId: item.id,                  // ← string directly
        originalTitle: item.snippet.title.toLowerCase(),
        channelTitle: item.snippet.channelTitle.toLowerCase(),
        publishedAt: item.snippet.publishedAt,
      }));
      allSongs = [...allSongs, ...songs];
    }

    // Search API returns id as object — keep existing logic
    for (const response of [punjabi, south]) {
      if (!response?.data?.items) continue;
      const songs = response.data.items.map(item => ({
        id: item.id.videoId,
        title: cleanTitle(item.snippet.title),
        artist: cleanArtist(item.snippet.channelTitle),
        thumbnail: item.snippet.thumbnails.high?.url ||
          item.snippet.thumbnails.medium?.url,
        youtubeId: item.id.videoId,
        originalTitle: item.snippet.title.toLowerCase(),
        channelTitle: item.snippet.channelTitle.toLowerCase(),
        publishedAt: item.snippet.publishedAt,
      }));
      allSongs = [...allSongs, ...songs];
    }

    console.log(`📊 Total raw songs fetched: ${allSongs.length}`);

    const filtered = filterSongs(allSongs, "");

    trendingCache = filtered
      .slice(0, 30)
      .map(({ score, originalTitle, channelTitle, publishedAt, ...s }) => s);

    trendingCacheTime = Date.now();
    console.log(`✅ Real trending cached — ${trendingCache.length} songs`);
    return trendingCache;

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