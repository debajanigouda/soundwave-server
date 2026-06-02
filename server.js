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

// ── BAD CHANNELS (duplicate/spam channels to block) ───────
const BAD_CHANNELS = [
  "7clouds", "phantom lyrics", "lyrics vibes", "magic of music",
  "snippetlyrics", "latinhype", "latin city", "syrebralvibes",
  "pizza music", "more albums", "sing king", "karaoke",
  "nonstop", "jukebox", "status video", "whatsapp",
  "reaction", "bass boosted", "slowed reverb", "8d audio",
  "lofi", "lo-fi", "mashup king", "cover songs",
];

function isBadChannel(channelName) {
  const lower = channelName.toLowerCase();
  return BAD_CHANNELS.some(bad => lower.includes(bad));
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

// ── DEEZER — fetch from multiple regions, no API key ──────
async function fetchDeezerTracks() {
  const sources = [
    // Global chart
    { url: "https://api.deezer.com/chart/0/tracks?limit=20", name: "🌍 Global Top" },
    // India — Deezer has India chart
    { url: "https://api.deezer.com/chart/2/tracks?limit=20", name: "🇮🇳 India Top" },
    // Hindi search
    { url: "https://api.deezer.com/search/track?q=hindi+bollywood+2025&order=RANKING&limit=20", name: "🎵 Hindi" },
    // Punjabi
    { url: "https://api.deezer.com/search/track?q=punjabi+songs+2025&order=RANKING&limit=15", name: "🎤 Punjabi" },
    // Tamil
    { url: "https://api.deezer.com/search/track?q=tamil+songs+2025&order=RANKING&limit=10", name: "🎬 Tamil" },
    // Telugu
    { url: "https://api.deezer.com/search/track?q=telugu+songs+2025&order=RANKING&limit=10", name: "🎭 Telugu" },
    // K-pop
    { url: "https://api.deezer.com/search/track?q=kpop+2025&order=RANKING&limit=10", name: "🇰🇷 K-pop" },
    // Spanish/Latin
    { url: "https://api.deezer.com/search/track?q=latin+reggaeton+2025&order=RANKING&limit=10", name: "💃 Latin" },
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

  console.log("🔄 Fetching worldwide trending from Deezer...");

  const deezerTracks = await fetchDeezerTracks();
  console.log(`📊 Deezer unique tracks: ${deezerTracks.length}`);

  if (deezerTracks.length === 0) throw new Error("Deezer returned 0 tracks");

  // Match each Deezer song to YouTube for streaming
  const songs = [];
  for (const track of deezerTracks.slice(0, 50)) {
    if (songs.length >= 30) break;
    try {
      const ytRes = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          part: "snippet",
          q: track.searchQuery,
          type: "video",
          videoCategoryId: "10",
          maxResults: 3, // get 3 results so we can pick best one
          key: getApiKey(),
        },
      });

      const items = ytRes.data.items || [];
      // Pick first result that is NOT a bad channel
      const item = items.find(i => !isBadChannel(i.snippet.channelTitle)) || items[0];
      if (!item) continue;

      songs.push({
        id: item.id.videoId,
        title: track.deezerTitle,       // ✅ Real title from Deezer
        artist: track.deezerArtist,     // ✅ Real artist from Deezer
        thumbnail: track.deezerAlbumArt || item.snippet.thumbnails.high?.url,
        youtubeId: item.id.videoId,
      });

      console.log(`🎵 ${track.deezerTitle} — ${track.deezerArtist}`);
    } catch (e) {
      console.log(`⚠️ YT match failed: "${track.deezerTitle}" — ${e.message}`);
      rotateKey();
    }
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

// ── SEARCH — deduplicated, original songs only ────────────
async function searchYouTube(query) {
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_TTL) return cached.songs;

  // First search Deezer for the correct metadata
  let deezerMeta = null;
  try {
    const dRes = await axios.get(`https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=1`);
    const top = dRes.data.data?.[0];
    if (top) {
      deezerMeta = {
        title: top.title,
        artist: top.artist?.name || "",
        albumArt: top.album?.cover_xl || top.album?.cover_big || "",
      };
    }
  } catch {}

  // Search YouTube
  const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
    params: {
      part: "snippet",
      q: query + " official audio",
      type: "video",
      videoCategoryId: "10",
      maxResults: 25,
      order: "relevance",
      key: getApiKey(),
    },
  });

  // Filter bad channels and duplicates
  const seen = new Set();
  const songs = [];

  for (const item of response.data.items) {
    const channel = item.snippet.channelTitle;
    const title = cleanTitle(item.snippet.title);

    // Skip bad channels
    if (isBadChannel(channel)) continue;

    // Skip bad title content
    const titleLower = title.toLowerCase();
    if (
      titleLower.includes("karaoke") ||
      titleLower.includes("ringtone") ||
      titleLower.includes("reaction") ||
      titleLower.includes("whatsapp") ||
      titleLower.includes("status") ||
      (titleLower.includes("cover") && !channel.toLowerCase().includes("vevo"))
    ) continue;

    // Deduplicate by first 3 words of title
    const key = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(" ").slice(0, 3).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);

    songs.push({
      id: item.id.videoId,
      // Use Deezer metadata for top result if available
      title: songs.length === 0 && deezerMeta ? deezerMeta.title : title,
      artist: songs.length === 0 && deezerMeta ? deezerMeta.artist : cleanArtist(channel),
      thumbnail: songs.length === 0 && deezerMeta?.albumArt
        ? deezerMeta.albumArt
        : item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
      youtubeId: item.id.videoId,
    });

    if (songs.length >= 15) break;
  }

  searchCache.set(cacheKey, { songs, time: Date.now() });
  return songs;
}

// ── ROUTES ────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query required" });
    const songs = await searchYouTube(query);
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
  console.log(`⚡ Deezer (worldwide, free) + YouTube streaming\n`);
  findWorkingKey().then(() =>
    fetchTrending().catch(err => console.log("⚠️ Startup prefetch failed:", err.message))
  );
});