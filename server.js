// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs in rate limiting

const MONGODB_URI = process.env.MONGODB_URI;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PORT = process.env.PORT || 3000;

// Comma-separated list of allowed origins, e.g. "https://monstermilo.github.io"
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || 'https://monstermilo.github.io')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // allow same-origin/non-browser requests (no Origin header, e.g. curl, health checks)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));

if (!MONGODB_URI) {
  console.warn('Warning: MONGODB_URI not set. DB features will fail until set.');
}
if (!HYPIXEL_API_KEY) {
  console.warn('Warning: HYPIXEL_API_KEY not set. Player data still works via Coral, but the direct-Hypixel fallback will be unavailable if Coral errors.');
}
if (!ADMIN_KEY) {
  console.warn('Warning: ADMIN_KEY not set. Write endpoints (add/delete/update sweat) will be disabled.');
}

// Require a shared secret (sent as the x-admin-key header) for any request that
// mutates the shared sweats list, so strangers who find the API URL can't spam or wipe it.
function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Write access not configured on server' });
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid or missing admin key' });
  next();
}

// Protects the Hypixel/Mojang/Urchin proxies (and the API key behind them) from being
// hammered by anyone who finds the backend URL.
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

// --- Coral API (Urchin) ---
// Preferred source for player lookups: it caches Hypixel responses and can serve a
// stale snapshot when Hypixel itself is down, and doesn't burn our own Hypixel key.
// Falls back to Mojang/Hypixel directly if Coral errors (e.g. the key lacks permission).
const CORAL_BASE = 'https://api.urchin.gg/v3';
const URCHIN_KEY = process.env.URCHIN_KEY;

async function coralGet(path, params) {
  if (!URCHIN_KEY) throw new Error('URCHIN_KEY not configured');
  const res = await axios.get(`${CORAL_BASE}${path}`, {
    params,
    headers: { 'X-API-Key': URCHIN_KEY },
    timeout: 8_000
  });
  return res.data;
}

// Resolve a username/UUID to { id, name } (Mojang's shape), trying Coral first.
async function resolvePlayer(identifier) {
  try {
    const data = await coralGet(`/resolve/${encodeURIComponent(identifier)}`);
    return { id: data.uuid.replace(/-/g, ''), name: data.username };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      const notFound = new Error('Not found');
      notFound.status = 404;
      throw notFound;
    }
    console.warn('Coral resolve failed, falling back to Mojang:', err.message);
    const mojangRes = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(identifier)}`, { timeout: 10_000 });
    return mojangRes.data;
  }
}

// Get Hypixel's raw player payload (wrapped as { player }), trying Coral first.
async function getHypixelPlayer(identifier) {
  try {
    const data = await coralGet('/hypixel/player', { player: identifier, max_cache_age: '2m' });
    return { player: data.player };
  } catch (err) {
    console.warn('Coral hypixel/player failed, falling back to direct Hypixel:', err.message);
    if (!HYPIXEL_API_KEY) throw err;
    const hypRes = await axios.get('https://api.hypixel.net/player', {
      params: { key: HYPIXEL_API_KEY, uuid: identifier },
      timeout: 15_000
    });
    return hypRes.data;
  }
}

// --- MongoDB (Mongoose) setup ---
mongoose.set('strictQuery', false);
mongoose
  .connect(MONGODB_URI || 'mongodb://localhost:27017/bedwars')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.warn('MongoDB connection error:', err.message));

const sweatSchema = new mongoose.Schema({
  username: { type: String, required: true },
  uuid: { type: String, index: true },
  star: Number,
  fkdr: Number,
  wlr: Number,
  bblr: Number,
  kdr: Number,
  finals: Number,
  finalDeaths: Number,
  beds: Number,
  bedsLost: Number,
  kills: Number,
  deaths: Number,
  milo: { type: Boolean, default: false },
  potat: { type: Boolean, default: false },
  aballs: { type: Boolean, default: false },
  zoiv: { type: Boolean, default: false },
  cheating: { type: Boolean, default: false },
  dateAdded: String, // e.g. "2025-08-09" (YYYY-MM-DD)
  createdAt: { type: Date, default: Date.now }
});

const Sweat = mongoose.model('Sweat', sweatSchema);

// --- Health ---
app.get('/ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Mojang proxy: get UUID and corrected name (via Coral, falling back to Mojang) ---
app.get('/mojang/:username', proxyLimiter, async (req, res) => {
  try {
    const data = await resolvePlayer(req.params.username);
    return res.json(data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    if (err.response && (err.response.status === 204 || err.response.status === 404)) return res.status(404).json({ error: 'Not found' });
    console.error('/mojang error', err.message);
    return res.status(500).json({ error: 'Mojang proxy error', details: err.message });
  }
});

// --- Hypixel proxy: get player data by UUID (via Coral, falling back to Hypixel directly) ---
app.get('/player/:uuid', proxyLimiter, async (req, res) => {
  try {
    const data = await getHypixelPlayer(req.params.uuid);
    return res.json(data);
  } catch (err) {
    console.error('/player error', err.message);
    return res.status(500).json({ error: 'Hypixel proxy error', details: err.message });
  }
});

app.get('/urchin/:username', proxyLimiter, async (req, res) => {
  const username = req.params.username;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout

  try {
    const response = await fetch(
      `https://urchin.ws/player/${username}?key=${URCHIN_KEY}&sources=MANUAL`,
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    if (response.status === 404) {
      // No tags on record for this player - not an error, just nothing found.
      return res.json({ tags: [] });
    }
    if (!response.ok) {
      throw new Error(`Urchin API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error("Urchin fetch failed:", err.message);

    // Always respond with safe fallback
    res.json({ error: "Urchin service unavailable", username });
  }
});

// --- Sweats API: shared DB ---
// GET all sweats (sorted newest first)
app.get('/sweats', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 1000);
    const docs = await Sweat.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json(docs);
  } catch (err) {
    console.error('/sweats GET error', err);
    return res.status(500).json({ error: 'DB read error' });
  }
});

// POST add a sweat
app.post('/sweats', requireAdminKey, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.username) return res.status(400).json({ error: 'username required' });

    const dateAdded = body.dateAdded || (new Date().toISOString().slice(0, 10));
    const doc = new Sweat({
      username: body.username,
      uuid: body.uuid || null,
      star: body.star || 0,
      fkdr: body.fkdr || 0,
      wlr: body.wlr || 0,
      bblr: body.bblr || 0,
      kdr: body.kdr || 0,
      finals: body.finals || 0,
      finalDeaths: body.finalDeaths || 0,
      beds: body.beds || 0,
      bedsLost: body.bedsLost || 0,
      kills: body.kills || 0,
      deaths: body.deaths || 0,
      milo: !!body.milo,
      potat: !!body.potat,
      aballs: !!body.aballs,
      zoiv: !!body.zoiv,
      cheating: !!body.cheating,
      dateAdded
    });
    const saved = await doc.save();
    return res.status(201).json(saved);
  } catch (err) {
    console.error('/sweats POST error', err);
    return res.status(500).json({ error: 'DB write error' });
  }
});

// DELETE remove a sweat by id
app.delete('/sweats/:id', requireAdminKey, async (req, res) => {
  try {
    const id = req.params.id;
    const deleted = await Sweat.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error('/sweats DELETE error', err);
    return res.status(500).json({ error: 'DB delete error' });
  }
});

// optional: update beaten-by flags (PATCH)
app.patch('/sweats/:id', requireAdminKey, async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};
    const allowed = ['milo','potat','aballs','zoiv'];
    const set = {};
    allowed.forEach(k => { if (k in updates) set[k] = !!updates[k]; });
    const updated = await Sweat.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    return res.json(updated);
  } catch (err) {
    console.error('/sweats PATCH error', err);
    return res.status(500).json({ error: 'DB update error' });
  }
});

// --- UUID-based stats (for modal only) ---
app.get('/stats/uuid/:uuid', proxyLimiter, async (req, res) => {
  try {
    const uuid = req.params.uuid;

    const { player } = await getHypixelPlayer(uuid);
    if (!player) {
      return res.status(404).json({ error: 'No Hypixel data' });
    }

    const bw = player.stats?.Bedwars || {};

    const finals = bw.final_kills_bedwars || 0;
    const finalDeaths = bw.final_deaths_bedwars || 1;

    const wins = bw.wins_bedwars || 0;
    const losses = bw.losses_bedwars || 1;

    const star = player.achievements?.bedwars_level || 0;

    const sweatDoc = await Sweat.findOne({ uuid }).lean();

    res.json({
      currentName: player.displayname,
      originalName: sweatDoc?.username || player.displayname,

      star,
      fkdr: finals / finalDeaths,
      wlr: wins / losses,
      finals,
      finalDeaths,
      wins,
      losses
    });

  } catch (err) {
    console.error('/stats/uuid error', err.message);
    res.status(500).json({ error: 'Failed to fetch stats by UUID' });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));