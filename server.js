require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");

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

async function findWorkingKey() {
  for (let i = 0; i < YT_API_KEYS.length; i++) {
    try {
      await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: { part: "snippet", q: "test", type: "video", maxResults: 1, key: YT_API_KEYS[i] },
      });
      currentKeyIndex = i;
      console.log(`✅ Working key found: key ${i + 1}`);
      return;
    } catch {
      console.log(`❌ Key ${i + 1} failed, trying next...`);
    }
  }
  console.log("⚠️ No working keys found!");
}

const IS_LINUX = process.platform !== "win32";
const YTDLP = IS_LINUX ? path.join(__dirname, "yt-dlp") : path.join(__dirname, "yt-dlp.exe");

app.use(cors({
  origin: ["http://localhost:5173", "https://soundwave-chi.vercel.app", /\.vercel\.app$/],
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

// ── CLEANERS ──────────────────────────────────────────────
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
  return channel.replace(/ - Topic$/i, "").replace(/VEVO$/i, "").replace(/official$/i, "").trim();
}

// ── STREAM URL ────────────────────────────────────────────
function fetchStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const cached = getCached(videoId);
    if (cached) { resolve(cached); return; }
    const cmd = `${YTDLP} --get-url -f bestaudio/best --no-playlist "https://www.youtube.com/watch?v=${videoId}"`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err) { reject(new Error("yt-dlp failed")); return; }
      const streamUrl = stdout.trim().split("\n")[0];
      if (!streamUrl) { reject(new Error("No URL found")); return; }
      setCache(videoId, streamUrl);
      resolve(streamUrl);
    });
  });
}

// ── DEEZER — no API key needed for these endpoints ────────
async function fetchDeezerTracks() {
  const sources = [
    // Global chart — always works, no auth
    { url: "https://api.deezer.com/chart/0/tracks?limit=30", name: "Global Top 30" },
    // Deezer search for trending Indian music — no auth needed
    { url: "https://api.deezer.com/search/track?q=hindi+2025&order=RANKING&limit=20", name: "Hindi Trending" },
    { url: "https://api.deezer.com/search/track?q=punjabi+2025&order=RANKING&limit=15", name: "Punjabi Trending" },
    { url: "https://api.deezer.com/search/track?q=tamil+2025&order=RANKING&limit=10", name: "Tamil Trending" },
    { url: "https://api.deezer.com/search/track?q=telugu+2025&order=RANKING&limit=10", name: "Telugu Trending" },
    { url: "https://api.deezer.com/search/track?q=bollywood+2025&order=RANKING&limit=20", name: "Bollywood Trending" },
  ];

  let allTracks = [];

  for (const source of sources) {
    try {
      const res = await axios.get(source.url, { timeout: 8000 });
      const items = res.data.data || [];
      const tracks = items.map(track => ({
        deezerTitle: track.title,
        deezerArtist: track.artist?.name || "",
        deezerAlbumArt: track.album?.cover_xl || track.album?.cover_big || track.album?.cover_medium || "",
        searchQuery: `${track.title} ${track.artist?.name || ""} official audio`,
      }));
      allTracks = [...allTracks, ...tracks];
      console.log(`✅ Deezer ${source.name} → ${tracks.length} tracks`);
    } catch (e) {
      console.log(`⚠️ Deezer ${source.name} failed — ${e.message}`);
    }
  }

  // Deduplicate by title+artist
  const seen = new Set();
  return allTracks.filter(s => {
    const key = `${s.deezerTitle}-${s.deezerArtist}`.toLowerCase().replace(/\s/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── TRENDING CACHE (3 hours) ──────────────────────────────
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_TTL = 1000 * 60 * 60 * 3;

async function fetchTrending() {
  if (trendingCache && trendingCache.length > 0 && Date.now() - trendingCacheTime < TRENDING_TTL) {
    console.log("📦 Serving trending from cache");
    return trendingCache;
  }

  console.log("🔄 Fetching trending from Deezer (no API key)...");

  // Step 1 — get real song data from Deezer
  const deezerTracks = await fetchDeezerTracks();
  console.log(`📊 Deezer unique tracks: ${deezerTracks.length}`);

  if (deezerTracks.length === 0) throw new Error("Deezer returned 0 tracks");

  // Step 2 — match each to YouTube for streaming
  const songs = [];
  for (const track of deezerTracks.slice(0, 40)) {
    try {
      const ytRes = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          q: track.searchQuery,
          type: "video",
          videoCategoryId: "10",
          maxResults: 1,
          key: getApiKey(),
        },
      });

      const item = ytRes.data.items?.[0];
      if (!item) continue;

      songs.push({
        id: item.id.videoId,
        title: track.deezerTitle,         // ✅ Real title from Deezer
        artist: track.deezerArtist,       // ✅ Real artist from Deezer
        thumbnail: track.deezerAlbumArt || item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
        youtubeId: item.id.videoId,
      });

      console.log(`🎵 ${track.deezerTitle} — ${track.deezerArtist}`);

    } catch (e) {
      console.log(`⚠️ YT match failed for "${track.deezerTitle}" — ${e.message}`);
      rotateKey();
    }

    // Stop if we have enough
    if (songs.length >= 30) break;
  }

  console.log(`✅ Final trending: ${songs.length} songs`);
  if (songs.length === 0) throw new Error("No YouTube matches found");

  trendingCache = songs;
  trendingCacheTime = Date.now();
  return trendingCache;
}

// ── SEARCH CACHE (30 min) ─────────────────────────────────
const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 30;

// ── ROUTES ────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query required" });

    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.time < SEARCH_TTL) {
      return res.json({ success: true, songs: cached.songs });
    }

    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query + " official audio",
        type: "video",
        videoCategoryId: "10",
        maxResults: 20,
        order: "relevance",
        key: getApiKey(),
      },
    });

    const songs = response.data.items.map(item => ({
      id: item.id.videoId,
      title: cleanTitle(item.snippet.title),
      artist: cleanArtist(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
      youtubeId: item.id.videoId,
    }));

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
    if (req.query.refresh === "true") { trendingCache = null; trendingCacheTime = 0; }
    const songs = await fetchTrending();
    res.json({ success: true, songs });
    songs.slice(0, 5).forEach(s => fetchStreamUrl(s.youtubeId).catch(() => {}));
  } catch (err) {
    if (trendingCache) return res.json({ success: true, songs: trendingCache, stale: true });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/prefetch/:videoId", async (req, res) => {
  try { await fetchStreamUrl(req.params.videoId); res.json({ success: true }); }
  catch { res.json({ success: false }); }
});

app.get("/api/stream/:videoId", async (req, res) => {
  try { res.redirect(await fetchStreamUrl(req.params.videoId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/health", (req, res) => {
  const trendingAge = trendingCache ? Math.round((Date.now() - trendingCacheTime) / 60000) : null;
  res.json({
    status: "✅ SoundWave running!",
    platform: process.platform,
    youtube: `✅ ${YT_API_KEYS.length} keys loaded`,
    currentKey: currentKeyIndex + 1,
    ytdlp: YTDLP,
    urlCache: urlCache.size,
    searchCache: searchCache.size,
    trendingCache: trendingCache ? `✅ ${trendingCache.length} songs, ${trendingAge} mins old` : "❌ Empty",
  });
});

// ── KEEP ALIVE (every 14 min) ─────────────────────────────
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
  console.log(`⚡ Deezer (free) + YouTube streaming\n`);
  findWorkingKey().then(() =>
    fetchTrending().catch(err => console.log("⚠️ Startup prefetch failed:", err.message))
  );
});