// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { MemoryStore } = rateLimit;
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs in rate limiting

const MONGODB_URI = process.env.MONGODB_URI;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;
const URCHIN_KEY = process.env.URCHIN_KEY; // Coral (api.urchin.gg) key, for Urchin cheater tags
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
const BEDLIFY_API_KEY = process.env.BEDLIFY_API_KEY; // proxies Bedlify's nick sightings (see /bedlify routes below)
const PORT = process.env.PORT || 3000;

// Comma-separated list of allowed origins, e.g. "https://monstermilo.github.io"
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || 'https://monstermilo.github.io')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(helmet());
// Gzip responses over 1kb. The full sweat list (up to 1000 entries with
// notes) is repetitive JSON that gzips to a small fraction of its size, so
// the site's first load and every refresh download much less.
app.use(compression());
app.use(cors({
  origin(origin, callback) {
    // allow same-origin/non-browser requests (no Origin header, e.g. curl, health checks)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
// The Discord endpoint checks a signature over the exact bytes Discord sent,
// so keep them for that route.
app.use(express.json({
  limit: '100kb',
  verify(req, res, buf) {
    if (req.originalUrl === '/discord/interactions') req.rawBody = buf;
  }
}));

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
if (!BEDLIFY_API_KEY) {
  console.warn('Warning: BEDLIFY_API_KEY not set. /bedlify routes will report { noKey: true } until set - the website just leaves Bedlify out.');
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
// Keys are compared as SHA-256 digests with timingSafeEqual, and every key
// is checked on every request, so response timing can't be used to guess a
// key one character at a time.
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const KEY_DIGESTS = [
  ...(KEY_ADMIN ? [[sha256(KEY_ADMIN), 'admin']] : []),
  ...[...PERSONAL_KEYS].map(([value, who]) => [sha256(value), who])
];
function keyOwner(req) {
  const key = req.get('x-admin-key');
  if (!key || key.length > 256) return null;
  const digest = sha256(key);
  let owner = null;
  for (const [known, who] of KEY_DIGESTS) {
    if (crypto.timingSafeEqual(digest, known) && owner === null) owner = who;
  }
  return owner;
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

// Removing a sweat: full-access keys can remove any; everyone else only ones
// they added themselves, from the last 10 days. Returns why not, or null.
// Shared by the website's DELETE route and the Discord bot.
function canRemoveSweat(owner, sweat) {
  if (hasFullAccess(owner)) return null;
  if (!sweat.addedBy || sweat.addedBy !== owner) return 'You can only remove sweats you added yourself';
  if (!withinChangeWindow({ keyOwner: owner }, sweat.createdAt, 'delete')) return changeWindowError('delete', 'sweats');
  return null;
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

// Protects the Hypixel/Mojang/Urchin proxies (and the API keys behind
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
// URL can burn through our personal Urchin/Hypixel quota. Skipped
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
// it: 15/min for a personal key, 60/min for full-access keys. The Discord
// bot's /denick counts against the same budget (see spendLimit below).
const DENICKER_LIMIT = owner => (hasFullAccess(owner) ? 60 : 15);
const denickerStore = new MemoryStore();
const denickerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => DENICKER_LIMIT(req.keyOwner),
  store: denickerStore,
  keyGenerator: (req) => `key:${req.keyOwner}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Denicker rate limit exceeded. Try again shortly.' }
});

// Bedlify gets a tighter cap than Denicker: its own limit (120/min) is
// shared with Milo's proxy plugins, and a website search only ever needs
// one call. 6/min for a personal key, 20/min for full-access keys. Cached
// answers (see bedlifySightings) still count here, so the cap is simple to
// reason about.
const BEDLIFY_LIMIT = owner => (hasFullAccess(owner) ? 20 : 6);
const bedlifyStore = new MemoryStore();
const bedlifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => BEDLIFY_LIMIT(req.keyOwner),
  store: bedlifyStore,
  keyGenerator: (req) => `key:${req.keyOwner}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bedlify rate limit exceeded. Try again shortly.', rateLimited: true }
});

// One search's worth of a limiter's budget, outside a web request (the
// Discord bot's /denick, where the person is known from their Discord
// account rather than a key). Counted in the limiter's own store under the
// same "key:<owner>" name, so it's one budget with that person's website
// searches. Resolves to 0 when allowed, or the time (ms) the limit resets.
async function spendLimit(store, limitFor, owner) {
  const { totalHits, resetTime } = await store.increment(`key:${owner}`);
  return totalHits > limitFor(owner) ? (resetTime ? resetTime.getTime() : Date.now() + 60 * 1000) : 0;
}

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

// --- Bordic API ---
// Preferred source for player lookups: a genuinely keyless public proxy that
// caches Hypixel responses, so it doesn't burn our own (temporary) Hypixel
// key and keeps working even when that key has expired. Falls back to
// Mojang/Hypixel directly if Bordic errors or hasn't cached this player yet.
// (Previously used Coral here too, but that requires permissions we lost -
// see above.)
const BORDIC_BASE = 'https://api.bordic.xyz';

async function bordicGet(path, params, timeout = 8_000) {
  const res = await axios.get(`${BORDIC_BASE}${path}`, { params, timeout });
  return res.data;
}

// --- Denicker API ---
// A private nick-lookup database (separate project, same author) - proxied
// here for the same reason Hypixel/Urchin are above: DENICKER_API_KEY
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

// --- Bedlify API ---
// Nick sightings from Bedlify's game tracker (api.bedlify.xyz), asked the
// same way the denicker plugin's Bedlify class does. Proxied so
// BEDLIFY_API_KEY never reaches the browser. Answers are boiled down here to
// one sighting per nick + real name pair (newest first), the same shape as
// the scraped sources' rows, and cached for 10 minutes.
const BEDLIFY_BASE = 'https://api.bedlify.xyz';
const BEDLIFY_CACHE_MS = 10 * 60 * 1000;
const BEDLIFY_CACHE_MAX = 500;
const BEDLIFY_MODES = {
  BEDWARS_EIGHT_ONE: 'Solos',
  BEDWARS_EIGHT_TWO: 'Doubles',
  BEDWARS_FOUR_THREE: '3v3v3v3',
  BEDWARS_FOUR_FOUR: '4v4v4v4',
  BEDWARS_TWO_FOUR: '4v4'
};
const bedlifyCache = new Map(); // "nick|x" / "player|x" -> { at, sightings }
let bedlifyBlockedUntil = 0; // Bedlify said our limit is used up until then

function describeBedlifyGame(r) {
  const mode = r.mode ? (BEDLIFY_MODES[r.mode] || String(r.mode).replace(/^BEDWARS_/, '').replace(/_/g, ' ').toLowerCase()) : null;
  if (r.map && mode) return `${r.map} (${mode})`;
  return r.map || mode || 'Unknown';
}

// param: 'nick' (who used it) or 'player' (a player's nicks).
async function bedlifySightings(param, value) {
  if (!BEDLIFY_API_KEY) {
    const err = new Error('BEDLIFY_API_KEY not configured');
    err.noKey = true;
    throw err;
  }
  const cacheKey = `${param}|${value.toLowerCase()}`;
  const cached = bedlifyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BEDLIFY_CACHE_MS) return cached.sightings;
  if (Date.now() < bedlifyBlockedUntil) {
    const err = new Error('Bedlify request limit reached');
    err.rateLimited = true;
    throw err;
  }

  const res = await axios.get(`${BEDLIFY_BASE}/nick`, {
    params: { [param]: value, limit: 200 },
    headers: { 'X-API-Key': BEDLIFY_API_KEY, Accept: 'application/json' },
    timeout: 8_000,
    validateStatus: (status) => status === 200 || status === 404 || status === 429
  });
  const retryAfter = parseInt(res.headers['retry-after'], 10) || parseInt(res.headers['x-ratelimit-reset'], 10) || 60;
  if (res.status === 429) {
    bedlifyBlockedUntil = Date.now() + retryAfter * 1000;
    const err = new Error('Bedlify request limit reached');
    err.rateLimited = true;
    throw err;
  }
  if (res.headers['x-ratelimit-remaining'] === '0') bedlifyBlockedUntil = Date.now() + retryAfter * 1000;

  const pairs = new Map();
  const results = res.status === 200 && Array.isArray(res.data?.results) ? res.data.results : [];
  for (const r of results) {
    if (typeof r?.name !== 'string' || typeof r.nick !== 'string' || !r.name || !r.nick) continue;
    const at = (Number(r.timestamp) || 0) * 1000;
    const key = `${r.nick.toLowerCase()}|${r.name.toLowerCase()}`;
    const s = pairs.get(key);
    if (!s) {
      pairs.set(key, { nick: r.nick, player: r.name, count: 1, first: at, last: at, game: describeBedlifyGame(r) });
      continue;
    }
    s.count++;
    if (at < s.first) s.first = at;
    if (at > s.last) {
      s.last = at;
      s.game = describeBedlifyGame(r);
    }
  }
  const sightings = [...pairs.values()].sort((a, b) => b.last - a.last);
  if (bedlifyCache.size >= BEDLIFY_CACHE_MAX) bedlifyCache.delete(bedlifyCache.keys().next().value);
  bedlifyCache.set(cacheKey, { at: Date.now(), sightings });
  return sightings;
}

// For /status: one uncached Bedlify request, answered as { status } (or
// { blockedFor } while its limit is used up, { error } if it didn't answer).
// Respects and updates the same back-off as real searches.
async function bedlifyPing() {
  if (Date.now() < bedlifyBlockedUntil) return { blockedFor: bedlifyBlockedUntil - Date.now() };
  try {
    const res = await axios.get(`${BEDLIFY_BASE}/nick`, {
      params: { nick: 'Technoblade', limit: 1 },
      headers: { 'X-API-Key': BEDLIFY_API_KEY, Accept: 'application/json' },
      timeout: 8_000,
      validateStatus: () => true
    });
    const retryAfter = parseInt(res.headers['retry-after'], 10) || parseInt(res.headers['x-ratelimit-reset'], 10) || 60;
    if (res.status === 429 || res.headers['x-ratelimit-remaining'] === '0') bedlifyBlockedUntil = Date.now() + retryAfter * 1000;
    return { status: res.status };
  } catch (err) {
    return { status: 0, error: describeAxiosError(err) };
  }
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

// Worth one more try: a timeout, a dropped connection, a rate limit or a
// 5xx. A 4xx (other than 429) would just fail the same way again.
function isRetryable(err) {
  const status = err.response && err.response.status;
  return !status || status === 429 || status >= 500;
}

// Get Hypixel's raw player payload (wrapped as { player }), trying Bordic first.
// Bordic answers straight from its cache for players it has seen lately, but
// has to go to Hypixel for one it hasn't, which can be slow or briefly fail.
// That's why a player that loaded fine when added (cache warm) could later
// fail: so Bordic gets a longer timeout and one retry before we fall back to
// our own Hypixel key, which is a temporary one and often expired.
async function getHypixelPlayer(identifier) {
  const uuid = String(identifier).replace(/-/g, '');
  const fromBordic = async () => {
    const data = await bordicGet('/v3/cache/hypixel', { uuid }, 15_000);
    return { player: data.player };
  };
  try {
    try {
      return await fromBordic();
    } catch (firstErr) {
      if (!isRetryable(firstErr)) throw firstErr;
      console.warn('Bordic hypixel/player failed, retrying once:', describeAxiosError(firstErr));
      await new Promise(r => setTimeout(r, 1_500));
      return await fromBordic();
    }
  } catch (bordicErr) {
    const bordicDetail = describeAxiosError(bordicErr);
    console.warn('Bordic hypixel/player failed, falling back to direct Hypixel:', bordicDetail);
    if (!HYPIXEL_API_KEY) {
      bordicErr.bordicDetail = bordicDetail;
      throw bordicErr;
    }
    try {
      const hypRes = await axios.get('https://api.hypixel.net/player', {
        params: { key: HYPIXEL_API_KEY, uuid },
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
  // Who added it (roster id or 'admin'): only they can remove it, apart from
  // full-access keys. Older sweats get it from the activity log at startup.
  addedBy: { type: String, default: null },
  // The Sweat Log message for this sweat ({ channelId, messageId, author,
  // footer }), so the bot can edit it when the sweat changes on the site.
  discordPost: { type: mongoose.Schema.Types.Mixed, default: null },
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

// updatedAt is set by Mongoose on every save/update (edits, notes, flags,
// delete, restore - from the site or the bot), so open pages can ask for just
// what changed since their last check. createdAt stays our own field above.
const sweatSchema = new mongoose.Schema(sweatSchemaFields, { timestamps: { createdAt: false, updatedAt: true } });
sweatSchema.index({ updatedAt: 1 });

const Sweat = mongoose.model('Sweat', sweatSchema);

// Matches sweats that haven't been (soft) deleted - includes older documents
// saved before deletedAt existed.
const LIVE = { deletedAt: null };

// --- Activity log ---
// One entry per change made with a key: who (roster id or 'admin'), what,
// and on which sweat. Edits keep a before/after of each changed field; note
// actions keep the note text. Denick lookups (site and bot) are logged too,
// with what was searched and what came back. Only the admin key can read it
// (GET /activity).
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
  noteAuthor: String, // note.delete: who had written the removed note
  // denick.search only:
  via: String,         // 'site' or 'bot'
  mode: String,        // 'nick' (who used it) or 'player' (a player's nicks)
  query: String,       // the nick or player searched
  resultCount: Number,
  found: mongoose.Schema.Types.Mixed, // up to DENICK_LOG_FOUND [{ name, source }], newest first
  partial: Boolean     // part of the database didn't answer (or a limit was hit)
});
const Activity = mongoose.model('Activity', activitySchema);

// One-off fill-in for sweats saved before addedBy existed: take it from the
// activity log's "sweat.add" entry. Runs at every start but only touches
// sweats still missing it, so after the first run it's a single empty query.
// Sweats older than the activity log stay unowned: only full-access keys can
// remove those.
mongoose.connection.once('open', async () => {
  try {
    const missing = await Sweat.find({ addedBy: null }, { _id: 1 }).lean();
    if (!missing.length) return;
    const adds = await Activity.find(
      { action: 'sweat.add', sweatId: { $in: missing.map(d => d._id) }, who: { $ne: null } },
      { sweatId: 1, who: 1 }
    ).lean();
    if (!adds.length) return;
    await Sweat.bulkWrite(adds.map(a => ({
      updateOne: { filter: { _id: a.sweatId, addedBy: null }, update: { $set: { addedBy: a.who } }, timestamps: false }
    })));
    console.log(`Filled in who added ${adds.length} older sweat(s) from the activity log`);
  } catch (err) {
    console.error('addedBy fill-in failed', err.message);
  }
});

// Fire-and-forget: a failed log write is reported but never fails the change
// the person actually made.
function logActivity(req, action, sweat, extra = {}) {
  if (!sweat) return;
  // Keep its Sweat Log card in Discord matching. req.discordMessageId is
  // the card a bot click came from, which the click redraws itself.
  if (action !== 'sweat.add') discord.refreshCard(sweat, req.discordMessageId);
  Activity.create({
    who: req.keyOwner,
    action,
    sweatId: sweat._id,
    username: sweat.username,
    uuid: sweat.uuid,
    ...extra
  }).catch(err => console.error('activity log write failed', err.message));
}

// One denick lookup, from the website or the bot's /denick. who: roster id,
// 'admin', or 'guest' (a site visitor with no key). results: the merged,
// newest-first rows (only the first few names are kept); count: how many
// there were in all. Fire-and-forget.
const DENICK_LOG_FOUND = 3;
function logDenick(who, via, mode, query, results, count, partial) {
  const rows = Array.isArray(results) ? results : [];
  const found = rows.slice(0, DENICK_LOG_FOUND).map(r => ({
    name: String((mode === 'nick' ? r.username : r.nick) || '').slice(0, 16),
    source: String(r.source || '').slice(0, 30)
  })).filter(r => NAME_RE.test(r.name));
  Activity.create({
    who, action: 'denick.search', via, mode, query,
    resultCount: Math.max(rows.length, count || 0), found, partial: !!partial
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

// --- Input checks ---
// Minecraft names (and nicks) are 1-16 letters, digits or underscores;
// UUIDs are 32 hex digits, with or without dashes. Path params that end up
// in a third-party URL are checked first, so a crafted value like
// "../something" can't reach a different endpoint on that service with our
// API key attached.
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Today's calendar date (YYYY-MM-DD) in US Eastern time, where the roster
// plays. Used when a sweat arrives without its own date, so one added after
// 8pm Eastern isn't stamped with tomorrow's UTC date.
const todayUS = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// A sweat for the same player added in the last 24 hours, if any - the same
// window the bot's /add uses for "already added today".
async function recentDuplicate(uuid, username) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const plain = uuid ? uuid.replace(/-/g, '').toLowerCase() : null;
  const who = plain
    ? { uuid: { $in: [plain, plain.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), uuid] } }
    : { username: new RegExp(`^${username}$`, 'i') };
  return Sweat.findOne({ ...LIVE, ...who, createdAt: { $gte: since } }, { addedBy: 1, username: 1, createdAt: 1 })
    .sort({ createdAt: -1 }).lean();
}
const STAT_MAX = 1e9;
function checkParam(name, re, label) {
  return (req, res, next) => (re.test(String(req.params[name] || ''))
    ? next()
    : res.status(400).json({ error: `Invalid ${label}` }));
}
const validName = (param) => checkParam(param, NAME_RE, 'username');
const validUuid = (param) => checkParam(param, UUID_RE, 'uuid');
// A finite, non-negative stat, or null when the value isn't usable.
function cleanStat(raw) {
  const num = Number(raw);
  return Number.isFinite(num) ? Math.min(Math.max(num, 0), STAT_MAX) : null;
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
app.get('/mojang/:username', validName('username'), publicProxyLimiter, proxyLimiter, async (req, res) => {
  try {
    const data = await resolvePlayer(req.params.username);
    return res.json(data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    if (err.response && (err.response.status === 204 || err.response.status === 404)) return res.status(404).json({ error: 'Not found' });
    console.error('/mojang error', err.message, err.bordicDetail || '');
    return res.status(500).json({ error: 'Mojang proxy error' });
  }
});

// --- Hypixel proxy: get player data by UUID (via Bordic, falling back to Hypixel directly) ---
app.get('/player/:uuid', validUuid('uuid'), publicProxyLimiter, proxyLimiter, async (req, res) => {
  try {
    const data = await getHypixelPlayer(req.params.uuid);
    return res.json(data);
  } catch (err) {
    console.error('/player error', err.message, err.bordicDetail || '');
    return res.status(500).json({ error: 'Hypixel proxy error' });
  }
});

// urchin.ws (the old legacy tag-lookup domain) has expired and now resolves
// to an unrelated parking page - Urchin's tag/blacklist system now lives on
// Coral. Normalizes Coral's `tag_type` field to `type` so the frontend's
// existing contract (data.tags[].type) doesn't need to change.
app.get('/urchin/:username', validName('username'), publicProxyLimiter, proxyLimiter, async (req, res) => {
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

// Who has used a given nick, most recent first (mirrors /denicker owners).
// Requires holding a key at all (see requireKeyForDenicker) - unlike
// the proxy routes above, this one isn't public.
app.get('/denicker/nick/:nick', validName('nick'), requireKeyForDenicker, denickerLimiter, async (req, res) => {
  try {
    const data = await denickerGet({ nick: req.params.nick });
    return res.json(data);
  } catch (err) {
    if (err.noKey) return res.json({ success: false, noKey: true, nicks: [] });
    console.error('/denicker/nick error', describeAxiosError(err));
    return res.status(500).json({ error: 'Denicker proxy error' });
  }
});

// Nicks a player has used, most recent first (mirrors /denicker history).
// Looked up by uuid (the API's key) plus the current username it wants
// alongside it - the frontend resolves both via /mojang/:username first.
app.get('/denicker/history/:uuid', validUuid('uuid'), requireKeyForDenicker, denickerLimiter, async (req, res) => {
  try {
    const username = NAME_RE.test(String(req.query.username || '')) ? String(req.query.username) : '';
    const data = await denickerGet({ uuid: req.params.uuid, username });
    return res.json(data);
  } catch (err) {
    if (err.noKey) return res.json({ success: false, noKey: true, nicks: [] });
    console.error('/denicker/history error', describeAxiosError(err));
    return res.status(500).json({ error: 'Denicker proxy error' });
  }
});

// Bedlify sightings of a nick (who used it) or a player (their nicks), most
// recent first. Same key gate as Denicker, with its own tighter cap.
function bedlifyRoute(param) {
  return async (req, res) => {
    try {
      const sightings = await bedlifySightings(param, req.params[param]);
      return res.json({ success: true, sightings });
    } catch (err) {
      if (err.noKey) return res.json({ success: false, noKey: true, sightings: [] });
      if (err.rateLimited) return res.status(429).json({ error: 'Bedlify request limit reached. Try again shortly.', rateLimited: true });
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        console.error(`/bedlify/${param} error: Bedlify rejected BEDLIFY_API_KEY`);
      } else {
        console.error(`/bedlify/${param} error`, describeAxiosError(err));
      }
      return res.status(500).json({ error: 'Bedlify proxy error' });
    }
  };
}
app.get('/bedlify/nick/:nick', validName('nick'), requireKeyForDenicker, bedlifyLimiter, bedlifyRoute('nick'));
app.get('/bedlify/player/:player', validName('player'), requireKeyForDenicker, bedlifyLimiter, bedlifyRoute('player'));

// Saves a new sweat with its optional first note, logs it and posts it to
// the Sweat Log channel. Shared by POST /sweats and the bot's /add.
async function createSweat(fields, who, noteText) {
  fields.addedBy = who;
  fields.notes = noteText ? [{ text: noteText, author: who }] : [];
  const saved = await new Sweat(fields).save();
  logActivity({ keyOwner: who }, 'sweat.add', saved, noteText ? { noteId: saved.notes[0]._id, noteText } : {});
  discord.postNewSweat(saved, who);
  return saved;
}

// A player's current Bed Wars stats by name, worked out the same way the
// website's add form does, plus whether Urchin tags them as a cheater (the
// site ticks Cheating for that). Used by the bot's /add.
// A player's Bedwars numbers, worked out the same way as the website.
function bedwarsStats(player) {
  const bw = player.stats?.Bedwars || {};
  const n = k => bw[k] || 0;
  const ratio = (a, b) => a / (b === 0 ? 1 : b);
  const stats = {
    star: player.achievements?.bedwars_level || 0,
    wlr: ratio(n('wins_bedwars'), n('losses_bedwars')),
    fkdr: ratio(n('final_kills_bedwars'), n('final_deaths_bedwars')),
    kdr: ratio(n('kills_bedwars'), n('deaths_bedwars')),
    bblr: n('beds_lost_bedwars') === 0 ? n('beds_broken_bedwars') : n('beds_broken_bedwars') / n('beds_lost_bedwars'),
    finals: n('final_kills_bedwars'),
    finalDeaths: n('final_deaths_bedwars'),
    beds: n('beds_broken_bedwars'),
    bedsLost: n('beds_lost_bedwars'),
    kills: n('kills_bedwars'),
    deaths: n('deaths_bedwars')
  };
  return stats;
}

async function lookupPlayerStats(name) {
  const { id, name: ign } = await resolvePlayer(name);
  const { player } = await getHypixelPlayer(id);
  if (!player) {
    const err = new Error('No Hypixel data');
    err.status = 404;
    throw err;
  }
  const stats = bedwarsStats(player);
  let cheaterTagged = false;
  try {
    const data = await coralGet('/player/tags', { player: ign });
    cheaterTagged = (data.tags || []).some(t => String(t.tag_type || '').includes('cheater') || t.tag_type === 'sniper');
  } catch {
    // No tags, or Urchin down: just don't auto-flag.
  }
  return { username: ign || player.displayname || name, uuid: id, stats, cheaterTagged };
}

// Current stats by uuid (no name lookup, no tags): for the "since logged"
// changes on /sweat cards. null when Hypixel has nothing.
async function currentStats(uuid) {
  const { player } = await getHypixelPlayer(uuid);
  return player ? bedwarsStats(player) : null;
}

// --- Denick requests ---
// When a nick isn't in any database, a roster member can ask Milo to denick
// it by hand: POST /denick-requests saves it and the bot DMs Milo with
// [Found] [Possible] [Not found] buttons (see discord.js). His answer is
// DMed back to whoever asked and shown in their "Your requests" list on the
// site. A Found answer also turns up in later searches for that nick (or
// that player), as the source "Milo".
const DENICK_REQUEST_STATUSES = ['open', 'found', 'possible', 'notfound'];
const DenickRequest = mongoose.model('DenickRequest', new mongoose.Schema({
  nick: { type: String, required: true },
  nickLower: { type: String, required: true, index: true },
  replay: { type: String, default: '' },
  note: { type: String, default: '' },
  by: { type: String, required: true, index: true }, // roster id or 'admin'
  status: { type: String, enum: DENICK_REQUEST_STATUSES, default: 'open' },
  names: { type: [String], default: [] }, // Found: one name; Possible: a few
  namesLower: { type: [String], default: [], index: true },
  reply: { type: String, default: '' }, // Milo's note back
  answeredAt: { type: Date, default: null },
  notified: { type: Boolean, default: false }, // the asker got the answer by DM
  dm: { type: mongoose.Schema.Types.Mixed, default: null } // { channelId, messageId } of Milo's copy
}, { timestamps: true, versionKey: false }));
// A personal key can have this many waiting at once, and send this many a
// day. Milo and the admin key have no cap.
const DENICK_REQUESTS_OPEN_MAX = 3;
const DENICK_REQUESTS_DAY_MAX = 10;
const REPLAY_MAX_LENGTH = 120;

// Found answers as denick entries, for the website's search and /denick.
async function manualDenicks(mode, query) {
  const q = String(query || '').toLowerCase();
  const docs = await DenickRequest.find(
    { status: 'found', ...(mode === 'nick' ? { nickLower: q } : { namesLower: q }) },
    { nick: 1, names: 1, answeredAt: 1 }).sort({ answeredAt: -1 }).limit(50).lean();
  return docs.filter(d => d.names[0]).map(d => ({
    username: d.names[0], nick: d.nick, updated: new Date(d.answeredAt).getTime() || 0, source: 'Milo'
  }));
}

// --- Discord bot (see discord.js) ---
// /denick runs the website's Denicking search server-side (see denick.js).
const denick = require('./denick')({
  denickerGet, bedlifySightings, resolvePlayer, describeAxiosError,
  denickerOn: () => !!DENICKER_API_KEY,
  bedlifyOn: () => !!BEDLIFY_API_KEY,
  spendDenicker: owner => spendLimit(denickerStore, DENICKER_LIMIT, owner),
  spendBedlify: owner => spendLimit(bedlifyStore, BEDLIFY_LIMIT, owner),
  manualDenicks
});
// Which sources work right now: GET /status below and the bot's /status.
const status = require('./status')({
  mongoose, Sweat, LIVE, bordicGet, coralGet, denickerGet, bedlifyPing, denick, describeAxiosError,
  hypixelKey: () => HYPIXEL_API_KEY,
  urchinOn: () => !!URCHIN_KEY,
  denickerOn: () => !!DENICKER_API_KEY,
  bedlifyOn: () => !!BEDLIFY_API_KEY
});
// Public, like the site's other read routes: it only says what works, never
// any keys. Answers are shared and kept for a few minutes (see status.js);
// ?fresh=1 re-checks sooner.
app.get('/status', proxyLimiter, async (req, res) => {
  try {
    return res.json(await status.get({ fresh: req.query.fresh === '1' }));
  } catch (err) {
    console.error('/status error', err);
    return res.status(500).json({ error: 'Status check failed' });
  }
});

const discord = require('./discord')({
  app, Sweat, LIVE, ROSTER_FIELDS, NAME_RE, NOTE_MAX_LENGTH, NOTES_PER_SWEAT_MAX,
  cleanStat, cleanNoteText, logActivity, withinChangeWindow, canRemoveSweat, describeAxiosError,
  NUMERIC_FIELDS, BOOLEAN_FIELDS, createSweat, lookupPlayerStats, resolvePlayer, currentStats, denick, todayUS, status,
  DenickRequest, createDenickRequest, logDenick
});

// What the site sees of a request (never Milo's DM ids).
const publicRequest = r => ({
  id: r._id, nick: r.nick, replay: r.replay, note: r.note, status: r.status, names: r.names,
  reply: r.reply, createdAt: r.createdAt, answeredAt: r.answeredAt
});

// Files a denick request for `by` (roster id or 'admin') and DMs Milo.
// Shared by the website (POST below) and the bot's [Ask Milo] button on an
// empty /denick. -> { status, error } or { status: 201, request }
async function createDenickRequest(by, body) {
  const nick = String((body && body.nick) || '').trim();
  if (!NAME_RE.test(nick)) return { status: 400, error: 'Enter the nick (letters, numbers and _ only, up to 16).' };
  const replay = String((body && body.replay) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (replay.length > REPLAY_MAX_LENGTH) return { status: 400, error: `The replay can be at most ${REPLAY_MAX_LENGTH} characters.` };
  const note = cleanNoteText(body && body.note);
  if (note === null) return { status: 400, error: `The note can be at most ${NOTE_MAX_LENGTH} characters.` };
  if (!discord.requestsOn()) return { status: 503, error: 'The bot can\'t reach Milo right now, so requests are off.' };

  const nickLower = nick.toLowerCase();
  if (await DenickRequest.exists({ by, nickLower, status: 'open' })) {
    return { status: 409, error: `You already asked about ${nick}. Milo usually answers within a day.` };
  }
  if (!hasFullAccess(by)) {
    const [open, today] = await Promise.all([
      DenickRequest.countDocuments({ by, status: 'open' }),
      DenickRequest.countDocuments({ by, createdAt: { $gt: new Date(Date.now() - DAY_MS) } })
    ]);
    if (open >= DENICK_REQUESTS_OPEN_MAX) return { status: 429, error: `You have ${open} requests waiting. Wait for Milo to answer one first.` };
    if (today >= DENICK_REQUESTS_DAY_MAX) return { status: 429, error: `That's ${today} requests today, the most in a day. Try again tomorrow.` };
  }

  const doc = await DenickRequest.create({ nick, nickLower, replay, note: note || '', by });
  try {
    await discord.sendDenickRequest(doc.toObject());
  } catch (err) {
    console.error('Denick request: DM to Milo failed', describeAxiosError(err));
    await DenickRequest.deleteOne({ _id: doc._id }).catch(() => {});
    return { status: 502, error: 'Couldn\'t message Milo on Discord. Try again in a bit.' };
  }
  return { status: 201, request: publicRequest(doc.toObject()) };
}

// Send Milo a denick request. Any key; body { nick, replay?, note? }.
app.post('/denick-requests', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const out = await createDenickRequest(req.keyOwner, req.body);
    return res.status(out.status).json(out.error ? { error: out.error } : { request: out.request });
  } catch (err) {
    console.error('POST /denick-requests error', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// The key's own requests, newest first, with Milo's answers.
app.get('/denick-requests/mine', requireWriteKey, proxyLimiter, async (req, res) => {
  try {
    const docs = await DenickRequest.find({ by: req.keyOwner }).sort({ createdAt: -1 }).limit(20).lean();
    return res.json({ requests: docs.map(publicRequest), on: discord.requestsOn() });
  } catch (err) {
    console.error('GET /denick-requests/mine error', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

// Milo's Found answers for a nick (mode "nick") or a player ("player"), as
// denick entries. Same access as the other denick sources.
app.get('/denick-requests/known/:mode/:name', validName('name'), requireKeyForDenicker, proxyLimiter, async (req, res) => {
  if (!['nick', 'player'].includes(req.params.mode)) return res.status(404).json({ error: 'Not found' });
  try {
    return res.json({ success: true, entries: await manualDenicks(req.params.mode, req.params.name) });
  } catch (err) {
    console.error('GET /denick-requests/known error', err);
    return res.status(500).json({ success: false, error: 'Something went wrong on the server.' });
  }
});

// --- Sweats API: shared DB ---
// GET all sweats (sorted newest first). Public and unauthenticated like the
// proxy routes above, so it needs a rate limit too - otherwise it's the one
// endpoint anyone who finds the backend URL could hammer with zero limit at
// all. Just proxyLimiter, not the tighter publicProxyLimiter stacked in
// front of the Mojang/Hypixel/Urchin routes: that tighter tier exists
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
//   Add `changedSince` (ms or ISO time) and the response also carries
//   `changed` (live sweats updated since then), `removed` (ids deleted since
//   then) and `changedAt` to pass as changedSince next time. If more than
//   SWEATS_CHANGED_MAX changed, `changedTruncated` is true and the caller
//   should reload the whole list instead.
const SWEATS_PAGE_MAX = 1000;
const SWEATS_CHANGED_MAX = 100;
// changedAt is set this far back so a write that lands while the query runs
// is picked up again next time instead of slipping between two checks.
const CHANGED_OVERLAP_MS = 5000;

function parseChangedSince(v) {
  if (v === undefined || v === '') return null;
  const d = /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}

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
    const since = parseChangedSince(req.query.changedSince);
    if (since === undefined) return res.status(400).json({ error: 'Invalid changedSince' });
    const checkedAt = Date.now();
    // Fetch one extra to know whether another page exists without a second query.
    const [docs, total, changedDocs] = await Promise.all([
      Sweat.find(filter).sort(sort).limit(limit + 1).lean(),
      Sweat.countDocuments(LIVE),
      since ? Sweat.find({ updatedAt: { $gt: since } }).sort({ updatedAt: 1 }).limit(SWEATS_CHANGED_MAX + 1).lean() : null
    ]);
    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();
    const body = {
      sweats: docs,
      nextCursor: hasMore ? encodeSweatCursor(docs[docs.length - 1]) : null,
      total
    };
    if (changedDocs) {
      body.changedTruncated = changedDocs.length > SWEATS_CHANGED_MAX;
      if (body.changedTruncated) changedDocs.pop();
      body.changed = changedDocs.filter(d => !d.deletedAt);
      body.removed = changedDocs.filter(d => d.deletedAt).map(d => String(d._id));
      body.changedAt = new Date(checkedAt - CHANGED_OVERLAP_MS).toISOString();
    }
    return res.json(body);
  } catch (err) {
    console.error('/sweats GET error', err);
    return res.status(500).json({ error: 'DB read error' });
  }
});

// POST add a sweat
app.post('/sweats', requireWriteKey, writeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username) return res.status(400).json({ error: 'username required' });
    if (!NAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 1-16 letters, numbers or underscores' });
    const uuid = typeof body.uuid === 'string' && UUID_RE.test(body.uuid) ? body.uuid : null;

    const dateAdded = typeof body.dateAdded === 'string' && DATE_RE.test(body.dateAdded)
      ? body.dateAdded
      : todayUS();
    // The website asks to be warned about a same-day duplicate; it then
    // resends with confirmDuplicate once the person clicks "Add anyway".
    // Other callers (the tracker plugin) are unaffected.
    if (body.warnDuplicate === true && body.confirmDuplicate !== true) {
      const dup = await recentDuplicate(uuid, username);
      if (dup) {
        return res.status(409).json({
          error: `${dup.username} was already added today`,
          duplicate: { username: dup.username, addedBy: dup.addedBy || null, createdAt: dup.createdAt }
        });
      }
    }
    const fields = { username, uuid, dateAdded, addedBy: req.keyOwner };
    NUMERIC_FIELDS.forEach(f => { fields[f] = cleanStat(body[f]) ?? 0; });
    BOOLEAN_FIELDS.forEach(f => { fields[f] = !!body[f]; });

    // Optional first note, written alongside the sweat itself.
    const noteText = cleanNoteText(body.note);
    if (noteText === null) return res.status(400).json({ error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer` });
    const saved = await createSweat(fields, req.keyOwner, noteText);
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
    const existing = await Sweat.findOne({ _id: id, ...LIVE }).lean();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const notAllowed = canRemoveSweat(req.keyOwner, existing);
    if (notAllowed) return res.status(403).json({ error: notAllowed });

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
        const num = cleanStat(updates[k]);
        if (num !== null) set[k] = num;
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

// The website reports each Denicking search here once it has merged every
// source (the gists are read in the browser, so only it knows the full
// answer). Anyone who can search can report; a visitor with no key is
// logged as 'guest'. Body { mode, query, count, results: [{ username, nick,
// source }] (first few), partial }.
app.post('/activity/denick', proxyLimiter, (req, res) => {
  const b = req.body || {};
  const mode = b.mode === 'player' ? 'player' : 'nick';
  const query = String(b.query || '').trim();
  if (!NAME_RE.test(query)) return res.status(400).json({ error: 'Invalid name' });
  const results = (Array.isArray(b.results) ? b.results : []).slice(0, DENICK_LOG_FOUND)
    .filter(r => r && typeof r === 'object');
  const count = Number.isInteger(b.count) ? Math.min(Math.max(b.count, 0), 10000) : 0;
  logDenick(keyOwner(req) || 'guest', 'site', mode, query, results, count, b.partial);
  return res.status(204).end();
});

// --- Activity log + restore (admin key only) ---
// GET newest-first page of activity. Optional filters: who (roster id or
// 'admin'), action (e.g. sweat.delete, or a comma list), sweatId. Page with ?before=<entry id>
// from the previous response's nextBefore. Delete entries whose sweat is
// still deleted come back with restorable: true.
app.get('/activity', requireAdminKey, proxyLimiter, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filter = {};
    if (req.query.who) filter.who = String(req.query.who);
    if (req.query.action) {
      const actions = String(req.query.action).split(',').filter(Boolean).slice(0, 10);
      filter.action = actions.length > 1 ? { $in: actions } : actions[0];
    }
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
app.get('/stats/uuid/:uuid', validUuid('uuid'), publicProxyLimiter, proxyLimiter, async (req, res) => {
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

    // Stored uuids come from Mojang without dashes, but match either form.
    const bare = uuid.replace(/-/g, '');
    const dashed = bare.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const sweatDoc = await Sweat.findOne({ uuid: { $in: [uuid, bare, dashed] }, ...LIVE }).lean();

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
    console.error('/stats/uuid error', err.message, err.bordicDetail || '');
    // Almost always means neither stats source could answer right now, not
    // that anything is wrong with the saved entry - say so, so the site can
    // fall back to the saved stats instead of a dead end.
    res.status(502).json({ error: "Couldn't reach the stats service for this player right now.", sourcesDown: true });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));