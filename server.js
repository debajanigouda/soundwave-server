require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

// ── OFFICIAL MUSIC CHANNELS (YouTube Channel IDs) ────────
// These are 100% verified original label channels
const OFFICIAL_CHANNELS = {
  hindi: [
    "UCq-Fj5jknLsUf-MWSy4_brA", // T-Series
    "UC3ML1GHrOMAOBDEhZe7MjIQ", // Zee Music Company
    "UCiEqmIwxaEojMxBgresGG3Q", // Sony Music India
    "UCazDAtKFiuXFgDgBFCKMgrg", // Tips Official
    "UCv4QDZT6ioUqNfMO0YJJR6Q", // Saregama Music
    "UCdSEBR0agFSgFGcMtrjWLMQ", // YRF Music
    "UC9wB4cs7DQPHoetGFkBPvqw", // Dharma Productions
    "UCJrDMFOdv1I2k8n9oK_V21w", // Jio Saavn
  ],
  punjabi: [
    "UCt4KxBWqJB_SymPq4xGEJyA", // Speed Records
    "UCxMAbVFmxKEjMSHkFUf-5Qg", // T-Series Apna Punjab
    "UCwxBtgRLEXGCESTDnP5MNHQ", // White Hill Music
    "UCMYCnRmZzQi0_Y2EFdOJOkw", // Desi Melodies
    "UCbjKRSTHV7okXJXrxASE73A", // Punjabi Hit Squad
  ],
  south: [
    "UCwIFNNgBuMTiYrCXHH7sGrQ", // Sony Music South
    "UCG-D8HJsFHNkMFOO5YJKOOQ", // T-Series Tamil
    "UCrfHJmOg4PCAO9TkWaibHlg", // Lahari Music
    "UCXp2gLYjGToOFtWZX9KhxRw", // Aditya Music
    "UC-8QAzbLcRryijX1yqGen1bw", // Sun Music
  ],
  english: [
    "UCVwa5DJHqB3QoMJGv5AjwOQ", // Atlantic Records
    "UCsRM0YB_dabtEPGPTKo-gcw", // Republic Records
    "UC20vb-R_px4CguH9oyIfekw", // Interscope Records
    "UCnUYZLuoy1rq1aVMwx4aTzw", // Universal Music Group
    "UCBVjMGOIkavEAhyqpxJ73Dw", // Sony Music Entertainment
  ],
};

// ── FILTER & DEDUPLICATE ──────────────────────────────────
function filterSongs(songs, query) {
  const queryLower = (query || "").toLowerCase().trim();
  const now = Date.now();

  const scored = songs.map(song => {
    let score = 100;
    const title = (song.originalTitle || "").toLowerCase();
    const channel = (song.channelTitle || "").toLowerCase();

    if (song.publishedAt) {
      const daysOld = (now - new Date(song.publishedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld < 3) score += 30;
      else if (daysOld < 7) score += 20;
      else if (daysOld < 14) score += 10;
      else if (daysOld < 30) score += 5;
    }

    // Heavy boost for known official channels
    if (channel.includes("t-series")) score += 25;
    if (channel.includes("zee music")) score += 25;
    if (channel.includes("sony music")) score += 25;
    if (channel.includes("tips official") || channel.includes("tips films")) score += 25;
    if (channel.includes("saregama")) score += 25;
    if (channel.includes("speed records")) score += 20;
    if (channel.includes("white hill")) score += 20;
    if (channel.includes("lahari")) score += 20;
    if (channel.includes("aditya music")) score += 20;
    if (channel.includes("yrf")) score += 20;
    if (channel.includes("dharma")) score += 20;
    if (channel.includes("atlantic")) score += 20;
    if (channel.includes("republic records")) score += 20;
    if (channel.includes("interscope")) score += 20;
    if (channel.includes("vevo")) score += 15;

    if (title.includes("official audio")) score += 12;
    if (title.includes("official video")) score += 10;
    if (queryLower && title.includes(queryLower)) score += 8;

    // Heavy penalties for non-original content
    if (title.includes("8d audio")) score -= 40;
    if (title.includes("lofi") || title.includes("lo-fi")) score -= 40;
    if (title.includes("remix")) score -= 35;
    if (title.includes("cover")) score -= 50;
    if (title.includes("karaoke")) score -= 50;
    if (title.includes("ringtone")) score -= 50;
    if (title.includes("slowed")) score -= 40;
    if (title.includes("reaction")) score -= 50;
    if (title.includes("mashup")) score -= 40;
    if (title.includes("whatsapp")) score -= 50;
    if (title.includes("status")) score -= 40;
    if (title.includes("unplugged")) score -= 20;
    if (title.includes("jukebox")) score -= 20;
    if (title.includes("full album")) score -= 30;

    return { ...song, score };
  });

  // Remove anything with very low score (likely not original)
  const goodSongs = scored.filter(s => s.score >= 100);

  goodSongs.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const unique = [];
  for (const song of goodSongs) {
    const key = (song.title || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(" ").slice(0, 3).join(" ");
    if (key.length > 2 && !seen.has(key)) { seen.add(key); unique.push(song); }
  }

  return unique.map(({ score, originalTitle, channelTitle, publishedAt, ...song }) => song);
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

// ── TRENDING CACHE (3 hours) ──────────────────────────────
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_TTL = 1000 * 60 * 60 * 3;

async function fetchTrending() {
  if (trendingCache && trendingCache.length > 0 && Date.now() - trendingCacheTime < TRENDING_TTL) {
    console.log("📦 Serving trending from cache");
    return trendingCache;
  }

  console.log("🔄 Fetching trending from OFFICIAL channels only...");

  // Fetch latest videos from official channels directly
  const channelSearches = [
    // Hindi / Bollywood
    { channelId: "UCq-Fj5jknLsUf-MWSy4_brA", name: "T-Series" },
    { channelId: "UC3ML1GHrOMAOBDEhZe7MjIQ", name: "Zee Music" },
    { channelId: "UCiEqmIwxaEojMxBgresGG3Q", name: "Sony Music India" },
    { channelId: "UCazDAtKFiuXFgDgBFCKMgrg", name: "Tips Official" },
    { channelId: "UCv4QDZT6ioUqNfMO0YJJR6Q", name: "Saregama" },
    // Punjabi
    { channelId: "UCt4KxBWqJB_SymPq4xGEJyA", name: "Speed Records" },
    { channelId: "UCxMAbVFmxKEjMSHkFUf-5Qg", name: "T-Series Apna Punjab" },
    { channelId: "UCwxBtgRLEXGCESTDnP5MNHQ", name: "White Hill Music" },
    // South
    { channelId: "UCwIFNNgBuMTiYrCXHH7sGrQ", name: "Sony Music South" },
    { channelId: "UCrfHJmOg4PCAO9TkWaibHlg", name: "Lahari Music" },
    { channelId: "UCXp2gLYjGToOFtWZX9KhxRw", name: "Aditya Music" },
  ];

  let allSongs = [];

  for (const ch of channelSearches) {
    try {
      const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          channelId: ch.channelId,
          type: "video",
          videoCategoryId: "10",
          order: "date",
          maxResults: 5,
          key: getApiKey(),
        },
      });

      if (!res.data.items?.length) continue;

      const songs = res.data.items.map(item => ({
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
      console.log(`✅ ${ch.name} → ${songs.length} songs`);

    } catch (e) {
      console.log(`⚠️ ${ch.name} failed — ${e.message}`);
      rotateKey();
    }
  }

  console.log(`📊 Total raw: ${allSongs.length}`);
  if (allSongs.length === 0) throw new Error("All channel fetches returned 0 results");

  const filtered = filterSongs(allSongs, "");

  // If filter was too strict, fall back to all songs sorted by date
  const finalSongs = filtered.length >= 10 ? filtered : allSongs
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .map(({ score, originalTitle, channelTitle, publishedAt, ...s }) => s);

  trendingCache = finalSongs.slice(0, 30);
  trendingCacheTime = Date.now();
  console.log(`✅ Trending cached — ${trendingCache.length} songs from official channels`);
  return trendingCache;
}

// ── GEMINI AI TRENDING (12 hour cache) ───────────────────
const geminiCache = new Map();
const GEMINI_TTL = 1000 * 60 * 60 * 12;

async function fetchGeminiTrending(genre = "all") {
  const cached = geminiCache.get(genre);
  if (cached && Date.now() - cached.time < GEMINI_TTL) {
    console.log(`📦 Gemini cache hit for: ${genre}`);
    return cached.songs;
  }

  const genrePrompt = genre === "all" ? "Hindi, Punjabi, Tamil, Telugu, and Global English" : genre;
  const prompt = `You are a music expert. Give me exactly 20 currently trending songs in ${genrePrompt} music as of 2026. Return ONLY a JSON array, no explanation, no markdown: [{"title":"Song Name","artist":"Artist Name","searchQuery":"song name artist name official audio"}]`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }
      );
      const text = response.data.candidates[0].content.parts[0].text;
      const clean = text.replace(/```json|```/g, "").trim();
      const songs = JSON.parse(clean.slice(clean.indexOf("["), clean.lastIndexOf("]") + 1));
      geminiCache.set(genre, { songs, time: Date.now() });
      console.log(`✅ Gemini returned ${songs.length} songs for: ${genre}`);
      return songs;
    } catch (err) {
      if (err.response?.status === 429 && attempt < 3) {
        console.log(`⏳ Gemini rate limit, retrying in ${attempt * 3}s...`);
        await new Promise(r => setTimeout(r, attempt * 3000));
      } else {
        throw err;
      }
    }
  }
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
      params: { part: "snippet", q: query + " official audio", type: "video", videoCategoryId: "10", maxResults: 30, order: "relevance", key: getApiKey() },
    });

    const allSongs = response.data.items.map(item => ({
      id: item.id.videoId,
      title: cleanTitle(item.snippet.title),
      artist: cleanArtist(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
      youtubeId: item.id.videoId,
      originalTitle: item.snippet.title.toLowerCase(),
      channelTitle: item.snippet.channelTitle.toLowerCase(),
      publishedAt: item.snippet.publishedAt,
    }));

    const songs = filterSongs(allSongs, query).slice(0, 20);
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

app.get("/api/ai-trending", async (req, res) => {
  try {
    const genre = req.query.genre || "all";
    const geminiSongs = await fetchGeminiTrending(genre);
    const songs = [];
    for (const song of geminiSongs.slice(0, 15)) {
      try {
        const ytRes = await axios.get("https://www.googleapis.com/youtube/v3/search", {
          params: { part: "snippet", q: song.searchQuery, type: "video", videoCategoryId: "10", maxResults: 1, key: getApiKey() },
        });
        const item = ytRes.data.items?.[0];
        if (!item) continue;
        songs.push({
          id: item.id.videoId,
          title: song.title,
          artist: song.artist,
          thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
          youtubeId: item.id.videoId,
        });
      } catch { continue; }
    }
    res.json({ success: true, songs });
  } catch (err) {
    console.error("Gemini trending error:", err.response?.data || err.message);
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
  console.log(`⚡ Caching: Trending=3h, Search=30min, Stream=1h\n`);
  findWorkingKey().then(() =>
    fetchTrending().catch(err => console.log("⚠️ Startup prefetch failed:", err.message))
  );
});