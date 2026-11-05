// --- Prism Atlas: every Bed Wars map, rebuilt from recorded games ---
// The website's Atlas shows each map in 3D. Maps come from the replays in
// B2: each finished replay is read once (in a worker thread, see
// replay-jobs.js, replay-worker.js and atlas-core.js), and its untouched pre-game map is
// merged into that map's file. A map file is small (20-60 KB for a 4s map),
// so it's kept in MongoDB with its details, not in B2.
//
// The proxy can also send a game's map on its own (POST /maps/captures), for
// games that weren't kept as replays.
//
// Bumping EXTRACT_VERSION (when the way maps are read changes) rebuilds every
// map from all the replays again, by itself.

const axios = require('axios');
const express = require('express');
const { presign, b2Config } = require('./replays');
const { slugOf } = require('./atlas-core');
const jobs = require('./replay-jobs');

const EXTRACT_VERSION = 1;
const FIRST_RUN_MS = 2 * 60 * 1000;
const CHECK_MS = 10 * 60 * 1000;
const BATCH = 25;                     // replays per run
const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
const REPLAY_MAX_BYTES = 30 * 1024 * 1024; // packed; the unpacked cap is in replay-jobs.js
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
// Maps taken out by hand (Milo 2026-11-05: "Base" was Lighthouse, named after
// a lobby's /locraw, from a replay that began mid-game, toppers and all). Their
// games are read again with today's rules, so they land where they belong or
// nowhere.
const REMOVED_SLUGS = ['base'];
const ROTATION_MIN = 5;       // a map selector lists far more; fewer is a mistake
const ROTATION_MAX = 150;
const ROTATION_NAME_MAX = 40;

module.exports = function setupAtlas({
  app, mongoose, Replay, requireWriteKey, writeLimiter, proxyLimiter,
  hasFullAccess = () => true, env = process.env, http = axios, now = Date.now,
  inProcess = process.env.ATLAS_IN_PROCESS === '1' || process.env.REPLAY_JOBS_IN_PROCESS === '1'
}) {
  const config = () => b2Config(env);

  const AtlasMap = mongoose.model('AtlasMap', new mongoose.Schema({
    slug: { type: String, required: true, unique: true },
    name: String,
    modes: [String],
    version: Number,       // EXTRACT_VERSION it was built with
    file: Buffer,          // the map file (atlas-core.js encodeMap)
    preview: Buffer,       // its top-down preview (atlas-core.js previewOf)
    sizeBytes: Number,
    games: Number,         // games merged in
    sources: [{ _id: false, id: String, playedAt: String, started: Boolean, used: Number }],
    stats: mongoose.Schema.Types.Mixed,
    builtAt: Date
  }, { timestamps: true }));

  // What happened to each replay (so it's read once): kept beside the replay.
  const AtlasRead = mongoose.model('AtlasRead', new mongoose.Schema({
    source: { type: String, required: true, unique: true }, // replay id, or the proxy's capture id
    version: Number,
    slug: String,
    error: String,
    at: Date
  }));

  // Maps the proxy sent on their own (POST /maps/captures). Kept so a rebuild
  // can merge them again: they exist nowhere else.
  const AtlasCapture = mongoose.model('AtlasCapture', new mongoose.Schema({
    source: { type: String, required: true, unique: true },
    file: Buffer,
    at: Date
  }));

  // Hypixel's own map selector, as the proxy last saw it (one per team size:
  // 8 = Solos/Doubles, 4 = 3s/4s). The website's rotation, instead of a
  // player-kept list that isn't always up to date (Milo 2026-11-05).
  const AtlasRotation = mongoose.model('AtlasRotation', new mongoose.Schema({
    teams: { type: Number, required: true, unique: true },
    maps: [String],
    title: String,
    at: Date
  }));

  // --- Reading a game: in a worker of its own, one replay at a time (replay-jobs.js) ---
  const buf = (b) => (b ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : null);
  const runJob = async (msg) => {
    const out = await jobs.run(msg, { inProcess });
    return { file: buf(out.file), preview: buf(out.preview), summary: out.summary };
  };

  /** Merges one game (a replay file or a capture) into its map. */
  async function addGame({ kind, bytes, source, fallbackName }) {
    // The capture says which map it is; find that map's current file first.
    // A replay without a map name in it falls back to the one the proxy
    // gave when it was uploaded.
    const slugHint = fallbackName ? slugOf(fallbackName) : null;
    const tryMerge = async (slug) => {
      const doc = slug ? await AtlasMap.findOne({ slug }).lean() : null;
      const current = doc && doc.version === EXTRACT_VERSION ? doc.file : null;
      return { doc, result: await runJob({ kind, bytes, map: current ? Buffer.from(current.buffer || current) : null, source, fallbackName }) };
    };
    let { doc, result } = await tryMerge(slugHint);
    if (result.summary.slug !== (doc && doc.slug)) {
      // The recording names a different map than we guessed: merge into that one.
      ({ doc, result } = await tryMerge(result.summary.slug));
    }
    const s = result.summary;
    if (!SLUG_RE.test(s.slug)) throw new Error('Bad map name');
    await AtlasMap.updateOne({ slug: s.slug }, {
      $set: {
        name: s.name, modes: s.modes, version: EXTRACT_VERSION, file: result.file, preview: result.preview, sizeBytes: result.file.length,
        games: s.sources.length, sources: s.sources, stats: s.stats, builtAt: new Date(now())
      }
    }, { upsert: true });
    return s;
  }

  // --- Reading the replays in B2 ---
  let running = null;
  async function runOnce() {
    if (!config() || mongoose.connection.readyState !== 1) return { read: 0 };
    // Built with an older way of reading: start those maps again.
    const stale = await AtlasMap.find({ version: { $ne: EXTRACT_VERSION } }, { slug: 1 }).lean();
    if (stale.length) {
      await AtlasMap.deleteMany({ version: { $ne: EXTRACT_VERSION } });
      console.log(`Atlas: rebuilding ${stale.length} map(s) with the new reader`);
    }
    for (const slug of REMOVED_SLUGS) {
      const gone = await AtlasMap.findOne({ slug }, { sources: 1 }).lean();
      if (!gone) continue;
      await AtlasRead.deleteMany({ source: { $in: (gone.sources || []).map(x => x.id) } });
      await AtlasMap.deleteOne({ slug });
      console.log(`Atlas: removed the map "${slug}"`);
    }
    const done = new Set((await AtlasRead.find({ version: EXTRACT_VERSION }, { source: 1 }).lean()).map(r => r.source));
    const replays = await Replay.find({ status: 'ready' }, { key: 1, map: 1, playedAt: 1 }).sort({ playedAt: 1 }).lean();
    const todo = replays.filter(r => !done.has(String(r._id))).slice(0, BATCH);
    let read = 0;
    for (const r of todo) {
      const source = { id: String(r._id), playedAt: r.playedAt ? new Date(r.playedAt).toISOString() : null };
      let slug = null; let error = null;
      try {
        // Its turn: no other replay (a clip being cut) is in memory meanwhile.
        slug = await jobs.exclusive(async () => {
          const res = await http.get(presign({ method: 'GET', key: r.key, expires: 120, ...config() }), {
            responseType: 'arraybuffer', timeout: 60000, maxContentLength: REPLAY_MAX_BYTES, validateStatus: () => true
          });
          if (res.status !== 200) throw new Error(`Storage answered ${res.status}`);
          const bytes = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
          jobs.checkSize(bytes);
          return (await addGame({ kind: 'replay', bytes, source, fallbackName: r.map })).slug;
        });
        read++;
      } catch (err) {
        error = String(err && err.message ? err.message : err).slice(0, 200);
        console.warn(`Atlas: replay ${r._id} not read: ${error}`);
      }
      await AtlasRead.updateOne({ source: source.id }, { $set: { version: EXTRACT_VERSION, slug, error, at: new Date(now()) } }, { upsert: true });
    }
    // Captures the proxy sent, after a rebuild.
    const caps = await AtlasCapture.find({ source: { $nin: [...done] } }).limit(BATCH).lean();
    for (const c of caps) {
      let slug = null; let error = null;
      try {
        slug = (await jobs.exclusive(() => addGame({ kind: 'capture', bytes: Buffer.from(c.file.buffer || c.file), source: { id: c.source, playedAt: null } }))).slug;
        read++;
      } catch (err) {
        error = String(err && err.message ? err.message : err).slice(0, 200);
      }
      await AtlasRead.updateOne({ source: c.source }, { $set: { version: EXTRACT_VERSION, slug, error, at: new Date(now()) } }, { upsert: true });
    }
    if (read) console.log(`Atlas: read ${read} game(s)`);
    // More waiting: carry on soon.
    if (todo.length === BATCH || caps.length === BATCH) { const t = setTimeout(kick, 5000); if (t.unref) t.unref(); }
    return { read, left: Math.max(0, replays.length - done.size - todo.length) };
  }
  function kick() {
    if (running) return running;
    running = runOnce().catch(err => { console.warn('Atlas run failed', err.message); return { read: 0 }; }).finally(() => { running = null; });
    return running;
  }
  const first = setTimeout(kick, FIRST_RUN_MS); if (first.unref) first.unref();
  const timer = setInterval(kick, CHECK_MS); if (timer.unref) timer.unref();

  const publicMap = (m) => ({
    slug: m.slug, name: m.name, modes: m.modes || [], games: m.games || 0, sizeBytes: m.sizeBytes || 0,
    builtAt: m.builtAt, stats: m.stats || null,
    newestGame: (m.sources || []).reduce((a, s) => (s.playedAt && (!a || s.playedAt > a) ? s.playedAt : a), null)
  });

  // --- Routes (keys only: the maps are Hypixel's builds, so they stay private) ---
  app.get('/maps', requireWriteKey, proxyLimiter, async (req, res) => {
    try {
      const maps = await AtlasMap.find({ version: EXTRACT_VERSION }, { file: 0, preview: 0 }).sort({ name: 1 }).lean();
      const [ready, readCount, failed] = await Promise.all([
        Replay.countDocuments({ status: 'ready' }),
        AtlasRead.countDocuments({ version: EXTRACT_VERSION }),
        AtlasRead.find({ version: EXTRACT_VERSION, error: { $ne: null } }, { source: 1, error: 1 }).limit(20).lean()
      ]);
      return res.json({
        maps: maps.map(publicMap),
        replays: { total: ready, waiting: Math.max(0, ready - readCount), failed: failed.map(f => ({ id: f.source, error: f.error })) }
      });
    } catch (err) {
      console.error('/maps error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // Every map's top-down preview, in one go (the list page draws them):
  // { previews: { slug: base64 of the gzipped preview } }.
  app.get('/maps/previews', requireWriteKey, proxyLimiter, async (req, res) => {
    try {
      const maps = await AtlasMap.find({ version: EXTRACT_VERSION }, { slug: 1, preview: 1 }).lean();
      const previews = {};
      for (const m of maps) if (m.preview) previews[m.slug] = Buffer.from(m.preview.buffer || m.preview).toString('base64');
      res.set('Cache-Control', 'private, max-age=300');
      return res.json({ previews });
    } catch (err) {
      console.error('/maps/previews error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // One map's file (gzip; the page unpacks it).
  app.get('/maps/:slug/file', requireWriteKey, proxyLimiter, async (req, res) => {
    try {
      if (!SLUG_RE.test(req.params.slug)) return res.status(400).json({ error: 'Bad map' });
      const m = await AtlasMap.findOne({ slug: req.params.slug, version: EXTRACT_VERSION }, { file: 1, builtAt: 1 }).lean();
      if (!m || !m.file) return res.status(404).json({ error: 'No such map' });
      const buf = Buffer.from(m.file.buffer || m.file);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Cache-Control', 'private, max-age=300');
      res.set('Content-Length', String(buf.length));
      return res.end(buf);
    } catch (err) {
      console.error('/maps file error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // The proxy: one game's map (a capture: a one-game map file), for games
  // that weren't kept as replays. Milo's keys only.
  app.post('/maps/captures', requireWriteKey, writeLimiter,
    (req, res, next) => (hasFullAccess(req.keyOwner) ? next() : res.status(403).json({ error: 'Only Milo\'s key can add maps' })),
    express.raw({ type: 'application/octet-stream', limit: CAPTURE_MAX_BYTES }),
    async (req, res) => {
      const id = String(req.query.id || '');
      if (!SOURCE_ID_RE.test(id)) return res.status(400).json({ error: 'Which game is it? (?id=)' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send the capture as application/octet-stream' });
      const source = { id: 'capture:' + id, playedAt: null };
      try {
        if (await AtlasCapture.exists({ source: source.id })) return res.json({ ok: true, duplicate: true });
        if (running) await running; // not while a run is changing the maps
        const s = await jobs.exclusive(() => addGame({ kind: 'capture', bytes: req.body, source }));
        await AtlasCapture.create({ source: source.id, file: req.body, at: new Date(now()) });
        await AtlasRead.updateOne({ source: source.id }, { $set: { version: EXTRACT_VERSION, slug: s.slug, error: null, at: new Date(now()) } }, { upsert: true });
        return res.status(201).json({ ok: true, map: s.name, slug: s.slug, games: s.sources.length, complete: !!(s.stats && s.stats.complete) });
      } catch (err) {
        return res.status(400).json({ error: `Couldn't read that map: ${String(err.message || err).slice(0, 120)}` });
      }
    });

  // The rotation (open to all: it's only map names). { rotation: [{ teams, maps, at }] }
  app.get('/maps/rotation', proxyLimiter, async (req, res) => {
    try {
      const rows = await AtlasRotation.find({}, { _id: 0, teams: 1, maps: 1, at: 1 }).sort({ teams: -1 }).lean();
      res.set('Cache-Control', 'public, max-age=60');
      return res.json({ rotation: rows });
    } catch (err) {
      console.error('/maps/rotation error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // The proxy: every map in Hypixel's map selector for one team size. Milo's keys only.
  app.post('/maps/rotation', requireWriteKey, writeLimiter, express.json({ limit: '32kb' }), async (req, res) => {
    if (!hasFullAccess(req.keyOwner)) return res.status(403).json({ error: 'Only Milo\'s key can set the rotation' });
    const b = req.body || {};
    const teams = Number(b.teams);
    if (teams !== 4 && teams !== 8) return res.status(400).json({ error: 'teams is 4 or 8' });
    const maps = Array.isArray(b.maps) ? [...new Set(b.maps.map(m => String(m || '').trim()).filter(m => m && m.length <= ROTATION_NAME_MAX))] : [];
    if (maps.length < ROTATION_MIN || maps.length > ROTATION_MAX) return res.status(400).json({ error: `Send ${ROTATION_MIN}-${ROTATION_MAX} map names` });
    try {
      const at = new Date(now());
      await AtlasRotation.updateOne({ teams }, { $set: { maps: maps.sort(), title: String(b.title || '').slice(0, 64) || null, at } }, { upsert: true });
      return res.json({ ok: true, teams, maps: maps.length });
    } catch (err) {
      console.error('/maps/rotation post error', err);
      return res.status(500).json({ error: 'DB write error' });
    }
  });

  // Milo: read every replay again (after a fix to how maps are read).
  app.post('/maps/rebuild', requireWriteKey, writeLimiter, async (req, res) => {
    if (!hasFullAccess(req.keyOwner)) return res.status(403).json({ error: 'Only Milo\'s key can rebuild the maps' });
    try {
      if (running) await running;
      await AtlasRead.deleteMany({});
      await AtlasMap.deleteMany({});
      kick();
      return res.json({ ok: true });
    } catch (err) {
      console.error('/maps/rebuild error', err);
      return res.status(500).json({ error: 'Rebuild failed' });
    }
  });

  // For /status.
  async function usage() {
    const [maps, complete] = await Promise.all([AtlasMap.countDocuments({ version: EXTRACT_VERSION }), AtlasMap.countDocuments({ version: EXTRACT_VERSION, 'stats.complete': true })]);
    return { maps, complete };
  }

  return { AtlasMap, AtlasRead, AtlasCapture, AtlasRotation, kick, runOnce, addGame, usage, EXTRACT_VERSION };
};
