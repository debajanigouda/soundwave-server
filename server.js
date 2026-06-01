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

    if (channel.includes("vevo")) score += 15;
    if (channel.includes("official")) score += 10;
    if (channel.includes("t-series")) score += 8;
    if (channel.includes("sony music")) score += 8;
    if (channel.includes("zee music")) score += 8;
    if (channel.includes("saregama")) score += 8;
    if (channel.includes("speed records")) score += 8;
    if (title.includes("official audio")) score += 12;
    if (title.includes("official video")) score += 10;
    if (queryLower && title.includes(queryLower)) score += 8;

    if (title.includes("8d audio")) score -= 20;
    if (title.includes("lofi") || title.includes("lo-fi")) score -= 15;
    if (title.includes("remix")) score -= 15;
    if (title.includes("cover")) score -= 20;
    if (title.includes("karaoke")) score -= 25;
    if (title.includes("ringtone")) score -= 25;
    if (title.includes("slowed")) score -= 20;
    if (title.includes("reaction")) score -= 30;
    if (title.includes("mashup")) score -= 20;
    if (title.includes("whatsapp")) score -= 30;

    return { ...song, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const unique = [];
  for (const song of scored) {
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

  console.log("🔄 Fetching trending songs...");

  const searches = [
    "new hindi songs 2026 official",
    "new punjabi songs 2026 official",
    "new tamil songs 2026 official",
    "new telugu songs 2026 official",
    "top bollywood songs 2026",
    "new english songs 2026 official",
  ];

  let allSongs = [];
  for (const q of searches) {
    try {
      const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: { part: "snippet", q, type: "video", videoCategoryId: "10", order: "date", maxResults: 8, key: getApiKey() },
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
      console.log(`✅ "${q}" → ${songs.length} songs`);
    } catch (e) {
      console.log(`⚠️ Failed: ${q} — ${e.message}`);
      rotateKey();
    }
  }

  console.log(`📊 Total raw: ${allSongs.length}`);
  if (allSongs.length === 0) throw new Error("All searches returned 0 results");

  const filtered = filterSongs(allSongs, "");
  trendingCache = filtered.slice(0, 30).map(s => {
    const { score, originalTitle, channelTitle, publishedAt, ...clean } = s;
    return clean;
  });

  trendingCacheTime = Date.now();
  console.log(`✅ Trending cached — ${trendingCache.length} songs`);
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
  // ── RELATED SONGS (Auto Radio) ────────────────────────────
app.get("/api/related/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, artist } = req.query;

    // Search for similar songs based on current song
    const searchQueries = [
      `${artist} songs`,           // same artist
      `songs like ${title}`,       // similar vibe
      `${title} similar songs`,    // related
    ];

    // Pick random query for variety
    const query = searchQueries[Math.floor(Math.random() * searchQueries.length)];

    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: {
        part: "snippet",
        q: query + " official audio",
        type: "video",
        videoCategoryId: "10",
        maxResults: 15,
        order: "relevance",
        key: getApiKey(),
      },
    });

    const allSongs = response.data.items
      .filter(item => item.id.videoId !== videoId) // exclude current song
      .map(item => ({
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
    res.json({ success: true, songs: filtered.slice(0, 10) });

  } catch (err) {
    rotateKey();
    res.status(500).json({ success: false, error: err.message });
  }
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