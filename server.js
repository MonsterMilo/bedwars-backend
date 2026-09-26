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
const SERAPH_KEY = process.env.SERAPH_KEY; // api.seraph.si personal API key
// Three escalating tiers (renamed 2026-09-24 from ADD_KEY/TRUSTED_KEY/ADMIN_KEY -
// same three secrets, same escalation order, just generic names instead of
// role-specific ones now that TIER_ONE also gates Denicker access below).
const TIER_ONE = process.env.TIER_ONE; // add sweats, toggle flags (any age), Denicker at 5/min - no stat edits, no delete
const TIER_TWO = process.env.TIER_TWO; // + edit any field/delete, but only entries added in the last 7 days; Denicker at 15/min
const TIER_THREE = process.env.TIER_THREE; // + edit/delete any age, unlimited Denicker - full access
const DENICKER_API_KEY = process.env.DENICKER_API_KEY; // proxies the Denicker nick-lookup DB (see /denicker routes below)
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
if (!TIER_THREE) {
  console.warn('Warning: TIER_THREE not set. Full-access write endpoints will be disabled (TIER_ONE/TIER_TWO, if set, still work within their own limits).');
}
if (!TIER_THREE && !TIER_TWO && !TIER_ONE) {
  console.warn('Warning: no tier key (TIER_ONE/TIER_TWO/TIER_THREE) is set. All write endpoints (add/edit/delete sweat) and all Denicker lookups will be disabled.');
}
if (!DENICKER_API_KEY) {
  console.warn('Warning: DENICKER_API_KEY not set. /denicker routes will report { noKey: true } until set - the frontend falls back to Diamond Dome-only results.');
}

// Single source of truth for the sweat roster/flag fields, reused by the
// schema, the POST body mapping, and the PATCH whitelist below so the three
// can't drift out of sync with each other.
const ROSTER_FIELDS = ['milo', 'potat', 'aballs', 'zoiv', 'max', 'sqoz', 'kermit', 'ssent', 'key'];
const BOOLEAN_FIELDS = [...ROSTER_FIELDS, 'cheating', 'boosting'];
const NUMERIC_FIELDS = ['star', 'fkdr', 'wlr', 'bblr', 'kdr', 'finals', 'finalDeaths', 'beds', 'bedsLost', 'kills', 'deaths'];

// Which tier (if any) the request presented:
//   'tier3' full access - add, edit any field, delete, any age, unlimited Denicker.
//   'tier2' can add with no restrictions, and can edit any field or delete -
//           but only on entries added in the last 7 days (see requireRecentEnough) -
//           Denicker capped at 15/min.
//   'tier1' the restricted tier handed out for the /tracker plugin: add sweats
//           and toggle their beaten-by/cheating/boosting flags, never edit
//           stats or delete, no age limit on the flag toggles it is allowed -
//           Denicker capped at 5/min.
function keyKind(req) {
  const key = req.get('x-admin-key');
  if (TIER_THREE && key === TIER_THREE) return 'tier3';
  if (TIER_TWO && key === TIER_TWO) return 'tier2';
  if (TIER_ONE && key === TIER_ONE) return 'tier1';
  return null;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// A 'tier2' key may only edit/delete a sweat that was added within the last
// 7 days - 'tier3' bypasses this entirely, and 'tier1' never reaches this
// check since it can't delete and its PATCH restriction (boolean-only) is
// separate. Looks the document up itself (rather than trusting a
// client-supplied date) so the check can't be spoofed by editing the request body.
async function requireRecentEnough(req, res, id) {
  if (req.keyKind !== 'tier2') return true;
  const existing = await Sweat.findById(id).lean();
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  const created = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
  if (Date.now() - created > SEVEN_DAYS_MS) {
    res.status(403).json({ error: 'Trusted key can only edit or remove entries added in the last 7 days' });
    return false;
  }
  return true;
}

// Shared by requireWriteKey/requirePatchKey below: resolves which key was used,
// or writes the appropriate 503/401 response itself and returns null.
function resolveKeyKind(req, res) {
  const kind = keyKind(req);
  if (kind) return kind;
  if (!TIER_THREE && !TIER_TWO && !TIER_ONE) res.status(503).json({ error: 'Write access not configured on server' });
  else res.status(401).json({ error: 'Invalid or missing admin key' });
  return null;
}

function requireWriteKey(req, res, next) {
  const kind = resolveKeyKind(req, res);
  if (!kind) return;
  req.keyKind = kind;
  next();
}

// Same as requireWriteKey, but the restricted 'tier1' key may only touch
// boolean flags (roster/cheating/boosting) - never numeric stats.
function requirePatchKey(req, res, next) {
  const kind = resolveKeyKind(req, res);
  if (!kind) return;
  if (kind === 'tier1') {
    const bodyKeys = Object.keys(req.body || {});
    const hasNonBoolean = bodyKeys.some(k => !BOOLEAN_FIELDS.includes(k));
    if (hasNonBoolean) {
      return res.status(403).json({ error: 'Restricted key can only toggle beaten-by/cheating/boosting flags' });
    }
  }
  req.keyKind = kind;
  next();
}

// Protects the Hypixel/Mojang/Urchin/Seraph proxies (and the API keys behind
// them) from being hammered by anyone who finds the backend URL - this also
// covers /stats/uuid, so clicking through sweat cards to fetch live stats is
// rate-limited the same way. This is the normal cap - anyone presenting a
// valid tier key (any of the three) only has to clear this one, not the
// tighter publicProxyLimiter below.
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

// A tighter cap stacked in front of proxyLimiter for callers with no key at
// all - these routes are intentionally public (the website's own anonymous
// visitors use them), but that also means anyone who just finds the backend
// URL can burn through our personal Urchin/Seraph/Hypixel quota. Skipped
// entirely for a valid key, so keyed access keeps the normal 30/min above.
const publicProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !!keyKind(req),
  message: { error: 'Rate limit exceeded. Try again shortly.' }
});

// The restricted 'tier1' key is meant for the /tracker plugin and could end up
// on multiple machines, so cap how fast it can write - tier2/tier3 are unlimited.
const addKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.keyKind !== 'tier1',
  message: { error: 'Rate limit exceeded for the restricted tier1 key. Try again shortly.' }
});

// Denicker costs a real, metered API call per lookup (unlike the proxies
// above, which are either free or backed by a keyless cache), so unlike
// them it isn't public at all - requireTierForDenicker below turns away
// anyone with no key before this ever runs. Budget then scales with tier
// rather than sharing the general proxyLimiter/publicProxyLimiter pool, so
// browsing player cards can't eat into it (or vice versa). tier3 skips this
// limiter entirely (unlimited).
const denickerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (req.keyKind === 'tier2' ? 15 : 5), // tier1 default (the only other kind that reaches this point)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.keyKind === 'tier3',
  message: { error: 'Denicker rate limit exceeded for your tier. Try again shortly.' }
});

// Turns away anyone with no tier key at all before denickerLimiter even runs.
// Responds with the same { noKey: true } shape used when DENICKER_API_KEY
// itself isn't configured server-side, so the frontend's existing
// fall-back-to-Diamond-Dome path handles "you don't have access" and "no one
// has access yet" identically - it doesn't need to tell them apart.
function requireTierForDenicker(req, res, next) {
  const kind = keyKind(req);
  if (!kind) return res.json({ success: false, noKey: true, nicks: [] });
  req.keyKind = kind;
  next();
}

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

// --- Seraph API ---
// A second, independent player-blacklist service - separate from Urchin/Coral,
// keyed by UUID rather than username. Requires our own personal API key (like
// Urchin originally did), sent as the seraph-api-key header.
const SERAPH_BASE = 'https://api.seraph.si';

async function seraphGet(path) {
  if (!SERAPH_KEY) throw new Error('SERAPH_KEY not configured');
  const res = await axios.get(`${SERAPH_BASE}${path}`, {
    headers: { 'seraph-api-key': SERAPH_KEY },
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

// --- Denicker API ---
// A private nick-lookup database (separate project, same author) - proxied
// here for the same reason Hypixel/Urchin/Seraph are above: DENICKER_API_KEY
// can't go in the public frontend, and the API itself is plain http:// on a
// bare IP, which a browser on this https:// site couldn't call directly
// even if the key weren't a problem (mixed-content blocked).
const DENICKER_BASE = 'http://91.99.172.247:5025';

async function denickerGet(params) {
  if (!DENICKER_API_KEY) {
    const err = new Error('DENICKER_API_KEY not configured');
    err.noKey = true;
    throw err;
  }
  const res = await axios.get(`${DENICKER_BASE}/nick`, {
    // sources=MANUAL_STARFISH matches what the in-game /denicker command
    // uses for a manually-typed lookup (as opposed to GAME_STARFISH, used
    // only for live in-match auto-resolution).
    params: { ...params, sources: 'MANUAL_STARFISH', key: DENICKER_API_KEY },
    timeout: 8_000
  });
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

const sweatSchemaFields = {
  username: { type: String, required: true },
  uuid: { type: String, index: true },
  dateAdded: String, // e.g. "2025-08-09" (YYYY-MM-DD)
  createdAt: { type: Date, default: Date.now, index: true }
};
NUMERIC_FIELDS.forEach(f => { sweatSchemaFields[f] = Number; });
BOOLEAN_FIELDS.forEach(f => { sweatSchemaFields[f] = { type: Boolean, default: false }; });

const sweatSchema = new mongoose.Schema(sweatSchemaFields);

const Sweat = mongoose.model('Sweat', sweatSchema);

// --- Health ---
app.get('/ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Mojang proxy: get UUID and corrected name (via Bordic, falling back to Mojang) ---
app.get('/mojang/:username', publicProxyLimiter, proxyLimiter, async (req, res) => {
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
app.get('/player/:uuid', publicProxyLimiter, proxyLimiter, async (req, res) => {
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
app.get('/urchin/:username', publicProxyLimiter, proxyLimiter, async (req, res) => {
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

// Seraph tags a player as blacklist/bot/annoylist independently (a player can
// be on more than one at once) - returns one entry per list that's tagged.
app.get('/seraph/:uuid', publicProxyLimiter, proxyLimiter, async (req, res) => {
  const uuid = req.params.uuid;
  try {
    const data = await seraphGet(`/${uuid}/blacklist`);
    const lists = data?.data || {};
    const tags = ['blacklist', 'bot', 'annoylist']
      .filter(list => lists[list]?.tagged === true)
      .map(list => ({
        type: lists[list].report_type || list,
        verified: !!lists[list].verified,
        reason: lists[list].tooltip || ''
      }));
    return res.json({ tags });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      // No tags on record for this player - not an error, just nothing found.
      return res.json({ tags: [] });
    }
    console.error("Seraph tags fetch failed:", describeAxiosError(err));
    res.json({ error: "Seraph service unavailable", uuid });
  }
});

// Who has used a given nick, most recent first (mirrors /denicker owners).
// Requires holding a tier key at all (see requireTierForDenicker) - unlike
// the proxy routes above, this one isn't public.
app.get('/denicker/nick/:nick', requireTierForDenicker, denickerLimiter, async (req, res) => {
  try {
    const data = await denickerGet({ nick: req.params.nick });
    return res.json(data);
  } catch (err) {
    if (err.noKey) return res.json({ success: false, noKey: true, nicks: [] });
    console.error('/denicker/nick error', describeAxiosError(err));
    return res.status(500).json({ error: 'Denicker proxy error', details: err.message });
  }
});

// Nicks a player has used, most recent first (mirrors /denicker history).
// Looked up by uuid (the API's key) plus the current username it wants
// alongside it - the frontend resolves both via /mojang/:username first.
app.get('/denicker/history/:uuid', requireTierForDenicker, denickerLimiter, async (req, res) => {
  try {
    const data = await denickerGet({ uuid: req.params.uuid, username: req.query.username || '' });
    return res.json(data);
  } catch (err) {
    if (err.noKey) return res.json({ success: false, noKey: true, nicks: [] });
    console.error('/denicker/history error', describeAxiosError(err));
    return res.status(500).json({ error: 'Denicker proxy error', details: err.message });
  }
});

// --- Sweats API: shared DB ---
// GET all sweats (sorted newest first). Public and unauthenticated like the
// proxy routes above, so it needs a rate limit too - otherwise it's the one
// endpoint anyone who finds the backend URL could hammer with zero limit at
// all. Just proxyLimiter, not the tighter publicProxyLimiter stacked in
// front of the Mojang/Hypixel/Urchin/Seraph routes: that tighter tier exists
// specifically to protect our own metered third-party API quota, which this
// route never touches (it only reads our own Mongo) - and the frontend
// reloads this list after every add/edit/delete, so an admin doing several
// of those in a row needs more headroom than an anonymous visitor.
//
// Two response shapes:
// - no `paged` param: a bare array of up to `limit` (max 1000) newest sweats,
//   kept as-is so older frontends keep working.
// - `paged=1`: { sweats, nextCursor, total }, one page of up to `limit`
//   (max 1000). Pass nextCursor back as `cursor` to get the next page; it is
//   null on the last page. Keyset paging on (createdAt, _id) rather than
//   skip, so a sweat added or deleted between page loads can't shift the
//   pages and make an entry show up twice or go missing.
const SWEATS_PAGE_MAX = 1000;

// Cursor is "<createdAt ms or empty>_<_id>". Empty createdAt covers legacy
// docs saved before the field existed, which sort after everything else.
function encodeSweatCursor(doc) {
  const ts = doc.createdAt ? new Date(doc.createdAt).getTime() : '';
  return `${ts}_${doc._id}`;
}

function sweatCursorFilter(cursor) {
  const m = /^(\d*)_([a-f0-9]{24})$/i.exec(String(cursor));
  if (!m) return null;
  const id = new mongoose.Types.ObjectId(m[2]);
  if (m[1] === '') return { createdAt: null, _id: { $lt: id } };
  const ts = new Date(Number(m[1]));
  return {
    $or: [
      { createdAt: { $lt: ts } },
      { createdAt: ts, _id: { $lt: id } },
      { createdAt: null }
    ]
  };
}

app.get('/sweats', proxyLimiter, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || SWEATS_PAGE_MAX, SWEATS_PAGE_MAX);
    const sort = { createdAt: -1, _id: -1 };

    if (!req.query.paged) {
      const docs = await Sweat.find({}).sort(sort).limit(limit).lean();
      return res.json(docs);
    }

    let filter = {};
    if (req.query.cursor) {
      filter = sweatCursorFilter(req.query.cursor);
      if (!filter) return res.status(400).json({ error: 'Invalid cursor' });
    }
    // Fetch one extra to know whether another page exists without a second query.
    const [docs, total] = await Promise.all([
      Sweat.find(filter).sort(sort).limit(limit + 1).lean(),
      Sweat.estimatedDocumentCount()
    ]);
    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();
    return res.json({
      sweats: docs,
      nextCursor: hasMore ? encodeSweatCursor(docs[docs.length - 1]) : null,
      total
    });
  } catch (err) {
    console.error('/sweats GET error', err);
    return res.status(500).json({ error: 'DB read error' });
  }
});

// POST add a sweat
app.post('/sweats', requireWriteKey, addKeyLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.username) return res.status(400).json({ error: 'username required' });

    const dateAdded = body.dateAdded || (new Date().toISOString().slice(0, 10));
    const fields = { username: body.username, uuid: body.uuid || null, dateAdded };
    NUMERIC_FIELDS.forEach(f => { fields[f] = Number(body[f]) || 0; });
    BOOLEAN_FIELDS.forEach(f => { fields[f] = !!body[f]; });

    const saved = await new Sweat(fields).save();
    return res.status(201).json(saved);
  } catch (err) {
    console.error('/sweats POST error', err);
    return res.status(500).json({ error: 'DB write error' });
  }
});

// DELETE remove a sweat by id - tier3 (any age) or tier2 (last 7 days only).
app.delete('/sweats/:id', requireWriteKey, async (req, res) => {
  try {
    if (req.keyKind === 'tier1') {
      return res.status(403).json({ error: 'Restricted key cannot delete sweats' });
    }

    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!(await requireRecentEnough(req, res, id))) return;

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
app.patch('/sweats/:id', requirePatchKey, addKeyLimiter, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const updates = req.body || {};
    const set = {};

    BOOLEAN_FIELDS.forEach(k => { if (k in updates) set[k] = !!updates[k]; });
    NUMERIC_FIELDS.forEach(k => {
      if (k in updates) {
        const num = Number(updates[k]);
        if (Number.isFinite(num)) set[k] = num;
      }
    });

    if (Object.keys(set).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    if (!(await requireRecentEnough(req, res, id))) return;

    const updated = await Sweat.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    return res.json(updated);
  } catch (err) {
    console.error('/sweats PATCH error', err);
    return res.status(500).json({ error: 'DB update error' });
  }
});

// --- UUID-based stats (for modal only) ---
app.get('/stats/uuid/:uuid', publicProxyLimiter, proxyLimiter, async (req, res) => {
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