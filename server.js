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
const URCHIN_KEY = process.env.URCHIN_KEY; // legacy urchin.ws cheater-tag lookup only
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
  console.warn('Warning: HYPIXEL_API_KEY not set. Player data still works via Bordic, but the direct-Hypixel fallback will be unavailable if Bordic errors.');
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
// Our key is locked out of the Player Data/Hypixel-permission endpoints (see
// Bordic section below, which replaced Coral for those), but still works for
// basic endpoints like cheater tags, which need no special permission.
const CORAL_BASE = 'https://api.urchin.gg/v3';

async function coralGet(path, params) {
  if (!URCHIN_KEY) throw new Error('URCHIN_KEY not configured');
  const res = await axios.get(`${CORAL_BASE}${path}`, {
    params,
    headers: { 'X-API-Key': URCHIN_KEY },
    timeout: 8_000
  });
  return res.data;
}

// --- Bordic API ---
// Preferred source for player lookups: a genuinely keyless public proxy that
// caches Hypixel responses, so it doesn't burn our own (temporary) Hypixel
// key and keeps working even when that key has expired. Falls back to
// Mojang/Hypixel directly if Bordic errors or hasn't cached this player yet.
// (Previously used Coral here too, but that requires permissions we lost -
// see above.)
const BORDIC_BASE = 'https://api.bordic.xyz';

async function bordicGet(path, params) {
  const res = await axios.get(`${BORDIC_BASE}${path}`, { params, timeout: 8_000 });
  return res.data;
}

function describeAxiosError(err) {
  return err.response
    ? `${err.response.status} ${JSON.stringify(err.response.data)}`
    : err.message;
}

// Resolve a username/UUID to { id, name } (Mojang's shape), trying Bordic first.
async function resolvePlayer(identifier) {
  try {
    const data = await bordicGet('/v2/convert/mojang', { player: identifier });
    return { id: data.uuid.replace(/-/g, ''), name: data.ign };
  } catch (bordicErr) {
    if (bordicErr.response && bordicErr.response.status === 404) {
      const notFound = new Error('Not found');
      notFound.status = 404;
      throw notFound;
    }
    const bordicDetail = describeAxiosError(bordicErr);
    console.warn('Bordic resolve failed, falling back to Mojang:', bordicDetail);
    try {
      const mojangRes = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(identifier)}`, { timeout: 10_000 });
      return mojangRes.data;
    } catch (mojangErr) {
      mojangErr.bordicDetail = bordicDetail;
      throw mojangErr;
    }
  }
}

// Get Hypixel's raw player payload (wrapped as { player }), trying Bordic first.
async function getHypixelPlayer(identifier) {
  try {
    const data = await bordicGet('/v3/cache/hypixel', { uuid: identifier });
    return { player: data.player };
  } catch (bordicErr) {
    const bordicDetail = describeAxiosError(bordicErr);
    console.warn('Bordic hypixel/player failed, falling back to direct Hypixel:', bordicDetail);
    if (!HYPIXEL_API_KEY) {
      bordicErr.bordicDetail = bordicDetail;
      throw bordicErr;
    }
    try {
      const hypRes = await axios.get('https://api.hypixel.net/player', {
        params: { key: HYPIXEL_API_KEY, uuid: identifier },
        timeout: 15_000
      });
      return hypRes.data;
    } catch (hypErr) {
      // Surface both failure reasons - the fallback failing (often just an
      // expired temp key) shouldn't hide why the primary source failed too.
      hypErr.bordicDetail = bordicDetail;
      throw hypErr;
    }
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
  max: { type: Boolean, default: false },
  sqoz: { type: Boolean, default: false },
  kermit: { type: Boolean, default: false },
  ssent: { type: Boolean, default: false },
  key: { type: Boolean, default: false },
  cheating: { type: Boolean, default: false },
  boosting: { type: Boolean, default: false },
  dateAdded: String, // e.g. "2025-08-09" (YYYY-MM-DD)
  createdAt: { type: Date, default: Date.now, index: true }
});

const Sweat = mongoose.model('Sweat', sweatSchema);

// --- Health ---
app.get('/ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Mojang proxy: get UUID and corrected name (via Bordic, falling back to Mojang) ---
app.get('/mojang/:username', proxyLimiter, async (req, res) => {
  try {
    const data = await resolvePlayer(req.params.username);
    return res.json(data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    if (err.response && (err.response.status === 204 || err.response.status === 404)) return res.status(404).json({ error: 'Not found' });
    console.error('/mojang error', err.message);
    return res.status(500).json({ error: 'Mojang proxy error', details: err.message, bordicDetail: err.bordicDetail });
  }
});

// --- Hypixel proxy: get player data by UUID (via Bordic, falling back to Hypixel directly) ---
app.get('/player/:uuid', proxyLimiter, async (req, res) => {
  try {
    const data = await getHypixelPlayer(req.params.uuid);
    return res.json(data);
  } catch (err) {
    console.error('/player error', err.message);
    return res.status(500).json({ error: 'Hypixel proxy error', details: err.message, bordicDetail: err.bordicDetail });
  }
});

// urchin.ws (the old legacy tag-lookup domain) has expired and now resolves
// to an unrelated parking page - Urchin's tag/blacklist system now lives on
// Coral. Normalizes Coral's `tag_type` field to `type` so the frontend's
// existing contract (data.tags[].type) doesn't need to change.
app.get('/urchin/:username', proxyLimiter, async (req, res) => {
  const username = req.params.username;
  try {
    const data = await coralGet('/player/tags', { player: username });
    const tags = (data.tags || []).map(t => ({ type: t.tag_type, reason: t.reason }));
    return res.json({ tags });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      // No tags on record for this player - not an error, just nothing found.
      return res.json({ tags: [] });
    }
    console.error("Urchin (Coral) tags fetch failed:", describeAxiosError(err));
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
      max: !!body.max,
      sqoz: !!body.sqoz,
      kermit: !!body.kermit,
      ssent: !!body.ssent,
      key: !!body.key,
      cheating: !!body.cheating,
      boosting: !!body.boosting,
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

// Edit an existing sweat: beaten-by roster, cheating/boosting, and stats.
// Username/uuid/dateAdded are intentionally not editable here.
const PATCH_BOOLEAN_FIELDS = ['milo','potat','aballs','zoiv','max','sqoz','kermit','ssent','key','cheating','boosting'];
const PATCH_NUMERIC_FIELDS = ['star','fkdr','wlr','bblr','kdr','finals','finalDeaths','beds','bedsLost','kills','deaths'];

app.patch('/sweats/:id', requireAdminKey, async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};
    const set = {};

    PATCH_BOOLEAN_FIELDS.forEach(k => { if (k in updates) set[k] = !!updates[k]; });
    PATCH_NUMERIC_FIELDS.forEach(k => {
      if (k in updates) {
        const num = Number(updates[k]);
        if (Number.isFinite(num)) set[k] = num;
      }
    });

    if (Object.keys(set).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

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
    res.status(500).json({ error: 'Failed to fetch stats by UUID', bordicDetail: err.bordicDetail });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));