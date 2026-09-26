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
// Write access (added 2026-09-26, replacing the old TIER_ONE/TWO/THREE keys):
// one personal key per roster member, so the backend knows who is writing and
// signs their notes automatically, plus one KEY_ADMIN.
//   - personal keys: add anything; edit entries and notes from the last 30
//     days, delete ones from the last 10 days; normal rate limits.
//   - KEY_ADMIN and KEY_MILO: no restrictions, just higher rate limits
//     (Milo runs the site, so his key is an admin key that still signs
//     notes as Milo).
// Map of env var -> roster id (the roster field name used in the schema).
const PERSONAL_KEY_ENV = {
  KEY_MILO: 'milo',
  KEY_POTAT: 'potat',
  KEY_ABOI: 'aballs',
  KEY_ZOIV: 'zoiv',
  KEY_MAX: 'max',
  KEY_SQOZ: 'sqoz',
  KEY_KERMIT: 'kermit',
  KEY_SSENT: 'ssent',
  KEY_KEY: 'key'
};
const PERSONAL_KEYS = new Map(); // key value -> roster id
Object.entries(PERSONAL_KEY_ENV).forEach(([envName, who]) => {
  const value = process.env[envName];
  if (value) PERSONAL_KEYS.set(value, who);
});
const KEY_ADMIN = process.env.KEY_ADMIN;
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
const missingPersonalKeys = Object.keys(PERSONAL_KEY_ENV).filter(k => !process.env[k]);
if (missingPersonalKeys.length) {
  console.warn(`Warning: ${missingPersonalKeys.join(', ')} not set - those people can't write or use Denicker until their key is added.`);
}
if (!KEY_ADMIN) {
  console.warn('Warning: KEY_ADMIN not set.');
}
if (!KEY_ADMIN && PERSONAL_KEYS.size === 0) {
  console.warn('Warning: no write keys (KEY_ADMIN / KEY_<NAME>) are set. All write endpoints (add/edit/delete sweat) and all Denicker lookups will be disabled.');
}
if (!DENICKER_API_KEY) {
  console.warn('Warning: DENICKER_API_KEY not set. /denicker routes will report { noKey: true } until set - the frontend falls back to Diamond Dome-only results.');
}

// Single source of truth for the sweat roster/flag fields, reused by the
// schema, the POST body mapping, and the PATCH whitelist below so the three
// can't drift out of sync with each other.
const ROSTER_FIELDS = ['milo', 'potat', 'aballs', 'zoiv', 'max', 'sqoz', 'kermit', 'ssent', 'key'];
const BOOLEAN_FIELDS = [...ROSTER_FIELDS, 'cheating', 'boosting'];
// Notes: a running log per sweat, each with its own author (one of the
// roster names above, 'admin', or blank on older notes) and timestamp. The
// author always comes from the key that wrote it, never from the request
// body. Any key can add one; editing or deleting a note follows the same
// 10-day rule as editing a sweat, measured from when that note was written.
const NOTE_MAX_LENGTH = 280;
const NOTES_PER_SWEAT_MAX = 50;
const NUMERIC_FIELDS = ['star', 'fkdr', 'wlr', 'bblr', 'kdr', 'finals', 'finalDeaths', 'beds', 'bedsLost', 'kills', 'deaths'];

// Who (if anyone) the request's key belongs to: a roster id for a personal
// key, 'admin' for KEY_ADMIN, or null for no/unknown key.
function keyOwner(req) {
  const key = req.get('x-admin-key');
  if (!key) return null;
  if (KEY_ADMIN && key === KEY_ADMIN) return 'admin';
  return PERSONAL_KEYS.get(key) || null;
}

// Full access: KEY_ADMIN, and KEY_MILO (still signed as Milo).
const FULL_ACCESS_OWNERS = new Set(['admin', 'milo']);
function hasFullAccess(owner) {
  return FULL_ACCESS_OWNERS.has(owner);
}

// How far back a personal key can reach, per action.
const CHANGE_WINDOW_DAYS = { edit: 30, delete: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;

// true when this key may still `action` ('edit' or 'delete') something
// created at `createdAt`: full-access keys always, personal keys only inside
// that action's window.
function withinChangeWindow(req, createdAt, action) {
  if (hasFullAccess(req.keyOwner)) return true;
  const created = createdAt ? new Date(createdAt).getTime() : 0;
  return Date.now() - created <= CHANGE_WINDOW_DAYS[action] * DAY_MS;
}
function changeWindowError(action, what) {
  const verb = action === 'edit' ? 'edit' : 'remove';
  return `Personal keys can only ${verb} ${what} from the last ${CHANGE_WINDOW_DAYS[action]} days`;
}

// Loads a live (not deleted) sweat for an edit/delete and checks the key may
// touch it: personal keys may only edit a sweat added in the last 30 days, or
// delete one from the last 10. Looks the document up itself (rather than
// trusting a client-supplied date) so the check can't be spoofed by editing
// the request body. Returns the sweat as it was before the change (the
// activity log diffs against it), or null once it has written the error.
async function loadSweatForChange(req, res, id, action) {
  const existing = await Sweat.findOne({ _id: id, ...LIVE }).lean();
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (!withinChangeWindow(req, existing.createdAt, action)) {
    res.status(403).json({ error: changeWindowError(action, 'entries') });
    return null;
  }
  return existing;
}

function requireWriteKey(req, res, next) {
  const owner = keyOwner(req);
  if (!owner) {
    if (!KEY_ADMIN && PERSONAL_KEYS.size === 0) return res.status(503).json({ error: 'Write access not configured on server' });
    return res.status(401).json({ error: 'Invalid or missing key' });
  }
  req.keyOwner = owner;
  next();
}

// Protects the Hypixel/Mojang/Urchin/Seraph proxies (and the API keys behind
// them) from being hammered by anyone who finds the backend URL - this also
// covers /stats/uuid, so clicking through sweat cards to fetch live stats is
// rate-limited the same way. This is the normal cap - anyone presenting a
// valid key only has to clear this one, not the tighter publicProxyLimiter
// below. Full-access keys get a higher cap.
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (hasFullAccess(keyOwner(req)) ? 120 : 30),
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
  skip: (req) => !!keyOwner(req),
  message: { error: 'Rate limit exceeded. Try again shortly.' }
});

// Caps writes (add/edit/delete sweats and notes) per key rather than per IP,
// so one person's plugin plus browser share a budget and nothing can be
// spammed: 30/min for a personal key, 120/min for full-access keys.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (hasFullAccess(req.keyOwner) ? 120 : 30),
  keyGenerator: (req) => `key:${req.keyOwner}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many changes in a short time. Try again shortly.' }
});

// Denicker costs a real, metered API call per lookup (unlike the proxies
// above, which are either free or backed by a keyless cache), so unlike
// them it isn't public at all - requireKeyForDenicker below turns away
// anyone with no key before this ever runs. Counted per key rather than
// sharing the general proxy pool, so browsing player cards can't eat into
// it: 15/min for a personal key, 60/min for full-access keys.
const denickerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (hasFullAccess(req.keyOwner) ? 60 : 15),
  keyGenerator: (req) => `key:${req.keyOwner}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Denicker rate limit exceeded. Try again shortly.' }
});

// Turns away anyone with no key at all before denickerLimiter even runs.
// Responds with the same { noKey: true } shape used when DENICKER_API_KEY
// itself isn't configured server-side, so the frontend's existing
// fall-back-to-Diamond-Dome path handles "you don't have access" and "no one
// has access yet" identically - it doesn't need to tell them apart.
function requireKeyForDenicker(req, res, next) {
  const owner = keyOwner(req);
  if (!owner) return res.json({ success: false, noKey: true, nicks: [] });
  req.keyOwner = owner;
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
  createdAt: { type: Date, default: Date.now, index: true },
  // Soft delete: removing a sweat hides it (and records who did it) instead
  // of erasing it, so the admin key can restore it with everything intact.
  deletedAt: { type: Date, default: null, index: true },
  deletedBy: String,
  notes: {
    type: [{
      text: { type: String, required: true, maxlength: NOTE_MAX_LENGTH },
      author: { type: String, default: '' },
      createdAt: { type: Date, default: Date.now },
      editedAt: Date
    }],
    default: []
  }
};
NUMERIC_FIELDS.forEach(f => { sweatSchemaFields[f] = Number; });
BOOLEAN_FIELDS.forEach(f => { sweatSchemaFields[f] = { type: Boolean, default: false }; });

const sweatSchema = new mongoose.Schema(sweatSchemaFields);

const Sweat = mongoose.model('Sweat', sweatSchema);

// Matches sweats that haven't been (soft) deleted - includes older documents
// saved before deletedAt existed.
const LIVE = { deletedAt: null };

// --- Activity log ---
// One entry per change made with a key: who (roster id or 'admin'), what,
// and on which sweat. Edits keep a before/after of each changed field; note
// actions keep the note text. Only the admin key can read it (GET /activity).
const activitySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },
  who: { type: String, index: true },
  action: { type: String, index: true }, // sweat.add|sweat.edit|sweat.delete|sweat.restore|note.add|note.edit|note.delete
  sweatId: { type: mongoose.Schema.Types.ObjectId, index: true },
  username: String,
  uuid: String,
  changes: mongoose.Schema.Types.Mixed, // { field: [before, after] } for sweat.edit
  noteId: mongoose.Schema.Types.ObjectId,
  noteText: String,
  noteBefore: String, // note.edit: the text before the edit
  noteAuthor: String  // note.delete: who had written the removed note
});
const Activity = mongoose.model('Activity', activitySchema);

// Fire-and-forget: a failed log write is reported but never fails the change
// the person actually made.
function logActivity(req, action, sweat, extra = {}) {
  if (!sweat) return;
  Activity.create({
    who: req.keyOwner,
    action,
    sweatId: sweat._id,
    username: sweat.username,
    uuid: sweat.uuid,
    ...extra
  }).catch(err => console.error('activity log write failed', err.message));
}

// Only KEY_ADMIN itself - not KEY_MILO, despite its full access - can read
// the activity log or restore deleted sweats.
function requireAdminKey(req, res, next) {
  const owner = keyOwner(req);
  if (owner !== 'admin') return res.status(403).json({ error: 'Admin key required' });
  req.keyOwner = owner;
  next();
}

// Returns the trimmed note text, '' for an empty/missing note, or null when
// it is too long (the caller answers 400).
function cleanNoteText(raw) {
  if (raw == null) return '';
  const text = String(raw).replace(/\r\n?/g, '\n').trim();
  return text.length > NOTE_MAX_LENGTH ? null : text;
}


// --- Health ---
app.get('/ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Who the presented key belongs to, so the site can say "Writing as Milo"
// and check a key when it's entered. { who: null } for no/unknown key.
app.get('/whoami', proxyLimiter, (req, res) => {
  const who = keyOwner(req);
  const full = hasFullAccess(who);
  return res.json({
    who,
    admin: full,
    editWindowDays: full ? null : CHANGE_WINDOW_DAYS.edit,
    deleteWindowDays: full ? null : CHANGE_WINDOW_DAYS.delete
  });
});

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
// Requires holding a key at all (see requireKeyForDenicker) - unlike
// the proxy routes above, this one isn't public.
app.get('/denicker/nick/:nick', requireKeyForDenicker, denickerLimiter, async (req, res) => {
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
app.get('/denicker/history/:uuid', requireKeyForDenicker, denickerLimiter, async (req, res) => {
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
      const docs = await Sweat.find(LIVE).sort(sort).limit(limit).lean();
      return res.json(docs);
    }

    let filter = LIVE;
    if (req.query.cursor) {
      const cursorFilter = sweatCursorFilter(req.query.cursor);
      if (!cursorFilter) return res.status(400).json({ error: 'Invalid cursor' });
      filter = { $and: [LIVE, cursorFilter] };
    }
    // Fetch one extra to know whether another page exists without a second query.
    const [docs, total] = await Promise.all([
      Sweat.find(filter).sort(sort).limit(limit + 1).lean(),
      Sweat.countDocuments(LIVE)
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
app.post('/sweats', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.username) return res.status(400).json({ error: 'username required' });

    const dateAdded = body.dateAdded || (new Date().toISOString().slice(0, 10));
    const fields = { username: body.username, uuid: body.uuid || null, dateAdded };
    NUMERIC_FIELDS.forEach(f => { fields[f] = Number(body[f]) || 0; });
    BOOLEAN_FIELDS.forEach(f => { fields[f] = !!body[f]; });

    // Optional first note, written alongside the sweat itself.
    const noteText = cleanNoteText(body.note);
    if (noteText === null) return res.status(400).json({ error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer` });
    fields.notes = noteText ? [{ text: noteText, author: req.keyOwner }] : [];

    const saved = await new Sweat(fields).save();
    logActivity(req, 'sweat.add', saved, noteText ? { noteId: saved.notes[0]._id, noteText } : {});
    return res.status(201).json(saved);
  } catch (err) {
    console.error('/sweats POST error', err);
    return res.status(500).json({ error: 'DB write error' });
  }
});

// DELETE remove a sweat by id - full-access keys (any age) or a personal key
// (last 10 days only). A soft delete: the sweat is hidden, not erased, so the
// admin key can restore it from the activity log.
app.delete('/sweats/:id', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!(await loadSweatForChange(req, res, id, 'delete'))) return;

    const deleted = await Sweat.findOneAndUpdate(
      { _id: id, ...LIVE },
      { $set: { deletedAt: new Date(), deletedBy: req.keyOwner } },
      { new: true }
    ).lean();
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    logActivity(req, 'sweat.delete', deleted);
    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error('/sweats DELETE error', err);
    return res.status(500).json({ error: 'DB delete error' });
  }
});

// Edit an existing sweat: beaten-by roster, cheating/boosting, and stats.
// Username/uuid/dateAdded are intentionally not editable here.
app.patch('/sweats/:id', requireWriteKey, writeLimiter, async (req, res) => {
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

    const before = await loadSweatForChange(req, res, id, 'edit');
    if (!before) return;

    const updated = await Sweat.findOneAndUpdate({ _id: id, ...LIVE }, { $set: set }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    const changes = {};
    Object.keys(set).forEach(k => {
      const was = before[k] === undefined ? null : before[k];
      if (was !== set[k]) changes[k] = [was, set[k]];
    });
    if (Object.keys(changes).length) logActivity(req, 'sweat.edit', updated, { changes });
    return res.json(updated);
  } catch (err) {
    console.error('/sweats PATCH error', err);
    return res.status(500).json({ error: 'DB update error' });
  }
});

// --- Notes on a sweat ---
// POST add a note - any key, on a sweat of any age. Signed with the key's owner.
app.post('/sweats/:id/notes', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const text = cleanNoteText((req.body || {}).text);
    if (text === null) return res.status(400).json({ error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer` });
    if (!text) return res.status(400).json({ error: 'Note text required' });

    const note = { text, author: req.keyOwner, createdAt: new Date() };
    // The size check lives in the filter so two notes added at once can't
    // push a sweat past the cap.
    const updated = await Sweat.findOneAndUpdate(
      { _id: id, ...LIVE, [`notes.${NOTES_PER_SWEAT_MAX - 1}`]: { $exists: false } },
      { $push: { notes: note } },
      { new: true }
    ).lean();
    if (!updated) {
      const exists = await Sweat.exists({ _id: id, ...LIVE });
      if (!exists) return res.status(404).json({ error: 'Not found' });
      return res.status(400).json({ error: `A sweat can have at most ${NOTES_PER_SWEAT_MAX} notes` });
    }
    const saved = updated.notes[updated.notes.length - 1];
    logActivity(req, 'note.add', updated, { noteId: saved._id, noteText: text });
    return res.status(201).json(updated);
  } catch (err) {
    console.error('/sweats/:id/notes POST error', err);
    return res.status(500).json({ error: 'DB write error' });
  }
});

// Shared by the note edit/delete routes: a personal key may only edit a
// note written in the last 30 days or delete one from the last 10 (the
// note's own createdAt, looked up server-side); full-access keys any note. Returns the sweat, or null once it has
// written the error response itself.
async function loadNoteForChange(req, res, action) {
  const { id, noteId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(noteId)) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  const sweat = await Sweat.findOne({ _id: id, ...LIVE }).lean();
  const note = sweat && (sweat.notes || []).find(n => String(n._id) === noteId);
  if (!note) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (!withinChangeWindow(req, note.createdAt, action)) {
    res.status(403).json({ error: changeWindowError(action, 'notes') });
    return null;
  }
  return { sweat, note };
}

// PATCH edit a note's text - full-access keys (any age) or a personal key (last 30 days only).
app.patch('/sweats/:id/notes/:noteId', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const text = cleanNoteText((req.body || {}).text);
    if (text === null) return res.status(400).json({ error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer` });
    if (!text) return res.status(400).json({ error: 'Note text required' });
    const found = await loadNoteForChange(req, res, 'edit');
    if (!found) return;

    const { id, noteId } = req.params;
    const updated = await Sweat.findOneAndUpdate(
      { _id: id, 'notes._id': noteId },
      { $set: { 'notes.$.text': text, 'notes.$.editedAt': new Date() } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    logActivity(req, 'note.edit', updated, { noteId, noteText: text, noteBefore: found.note.text });
    return res.json(updated);
  } catch (err) {
    console.error('/sweats/:id/notes PATCH error', err);
    return res.status(500).json({ error: 'DB update error' });
  }
});

// DELETE remove a note - full-access keys (any age) or a personal key (last 10 days only).
app.delete('/sweats/:id/notes/:noteId', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const found = await loadNoteForChange(req, res, 'delete');
    if (!found) return;
    const { id, noteId } = req.params;
    const updated = await Sweat.findByIdAndUpdate(
      id,
      { $pull: { notes: { _id: noteId } } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    logActivity(req, 'note.delete', updated, { noteId, noteText: found.note.text, noteAuthor: found.note.author || '' });
    return res.json(updated);
  } catch (err) {
    console.error('/sweats/:id/notes DELETE error', err);
    return res.status(500).json({ error: 'DB delete error' });
  }
});

// --- Activity log + restore (admin key only) ---
// GET newest-first page of activity. Optional filters: who (roster id or
// 'admin'), action (e.g. sweat.delete), sweatId. Page with ?before=<entry id>
// from the previous response's nextBefore. Delete entries whose sweat is
// still deleted come back with restorable: true.
app.get('/activity', requireAdminKey, proxyLimiter, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filter = {};
    if (req.query.who) filter.who = String(req.query.who);
    if (req.query.action) filter.action = String(req.query.action);
    if (req.query.sweatId && mongoose.Types.ObjectId.isValid(req.query.sweatId)) filter.sweatId = req.query.sweatId;
    if (req.query.before) {
      if (!mongoose.Types.ObjectId.isValid(req.query.before)) return res.status(400).json({ error: 'Invalid cursor' });
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.before) };
    }
    const entries = await Activity.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = entries.length > limit;
    if (hasMore) entries.pop();

    const deleteIds = entries.filter(e => e.action === 'sweat.delete').map(e => e.sweatId);
    const stillDeleted = new Set(
      (await Sweat.find({ _id: { $in: deleteIds }, deletedAt: { $ne: null } }, { _id: 1 }).lean()).map(d => String(d._id))
    );
    entries.forEach(e => {
      if (e.action === 'sweat.delete') e.restorable = stillDeleted.has(String(e.sweatId));
    });
    return res.json({ entries, nextBefore: hasMore ? String(entries[entries.length - 1]._id) : null });
  } catch (err) {
    console.error('/activity GET error', err);
    return res.status(500).json({ error: 'DB read error' });
  }
});

// POST restore a deleted sweat exactly as it was (stats, flags, notes).
app.post('/sweats/:id/restore', requireAdminKey, writeLimiter, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const restored = await Sweat.findOneAndUpdate(
      { _id: id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null }, $unset: { deletedBy: '' } },
      { new: true }
    ).lean();
    if (!restored) return res.status(404).json({ error: 'Not found or not deleted' });
    logActivity(req, 'sweat.restore', restored);
    return res.json(restored);
  } catch (err) {
    console.error('/sweats/:id/restore error', err);
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

    const sweatDoc = await Sweat.findOne({ uuid, ...LIVE }).lean();

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