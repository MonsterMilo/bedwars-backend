// --- Clips: the moments you beat a tracked player, as their own small files ---
// When a replay finishes uploading (replays.js), this cuts clips from it
// (clipper.js): each tracked player's final kill and their team's bed
// break, when your team did it and you were close enough to see it. Each
// clip is its own .mcpr in the same B2 bucket (clips/<id>.mcpr), so it
// stays when the full replay is deleted. The website shows them as a strip
// on the player's popup and plays them in the replay viewer.
//
// Replays that were uploaded before clips existed are clipped in the
// background, one at a time. Each replay keeps a short note of what was
// found and why something was skipped (GET /replays/:id/clips).

const axios = require('axios');
const { presign, b2Config } = require('./replays');
const clipper = require('./clipper');
const jobs = require('./replay-jobs');
const { SUMMARY_VERSION } = require('./game-summary');

// Bump to clip every replay again (e.g. after changing the rules).
// 2 (2026-11-05): teams from the prefix colour, 60 blocks instead of 40.
const CLIP_VERSION = 2;
const LINK_SECONDS = 10 * 60;
const DOWNLOAD_LINK_SECONDS = 10 * 60;
// Replays over this (packed) are left alone (a real one is 1-3 MB); see also
// replay-jobs.js MAX_RECORDING.
const MAX_REPLAY_BYTES = 30 * 1024 * 1024;
const BACKFILL_MS = 10 * 60 * 1000;
const FIRST_BACKFILL_MS = 3 * 60 * 1000;
const LIST_MAX = 60;
// Clips made on the website: how long they can be.
const SITE_CLIP_MIN_MS = 2000;
const SITE_CLIP_MAX_MS = 60000;

module.exports = function setupClips({
  app, mongoose, Replay, requireWriteKey, writeLimiter, proxyLimiter, hasFullAccess = () => true,
  env = process.env, http = axios, log = console, inProcess = process.env.REPLAY_JOBS_IN_PROCESS === '1'
}) {
  const config = () => b2Config(env);
  const link = (method, key, expires = LINK_SECONDS, extra) => presign({ method, key, expires, extra, ...config() });

  const Clip = mongoose.model('Clip', new mongoose.Schema({
    key: { type: String, required: true },
    replayId: { type: mongoose.Schema.Types.ObjectId, index: true },
    // The tracked player it's for (uuid without dashes, lower case).
    uuid: { type: String, index: true },
    username: String,
    // As they showed in the game (a nick, say), and who did it.
    victim: String,
    by: String,
    team: String,
    kind: String,              // 'final' | 'bed' | 'manual' (/clip in game)
    // A /clip: everyone who came near you in it. It shows on any of their
    // entries, by uuid or by the name they had (a nick, say).
    people: [{ _id: false, uuid: String, name: String, team: String }],
    peopleKeys: { type: [String], index: true },
    at: Number,                // ms into the full replay
    markAt: Number,            // ms into the clip where it happens
    durationMs: Number,
    sizeBytes: Number,
    distance: Number,
    follow: String,            // who the viewer's camera follows
    playedAt: Date,
    map: String,
    mode: String,
    // 'site': made on the website (marked in the replay viewer), kept when
    // the replay is clipped again. Automatic and /clip ones have none.
    source: String,
    title: String,
    createdBy: String,
    status: { type: String, default: 'pending' }
  }, { timestamps: true }));

  const publicClip = (c) => ({
    id: c._id, replayId: c.replayId, uuid: c.uuid, username: c.username, victim: c.victim, by: c.by, team: c.team,
    kind: c.kind, at: c.at, markAt: c.markAt, durationMs: c.durationMs, sizeBytes: c.sizeBytes, distance: c.distance,
    follow: c.follow, playedAt: c.playedAt, map: c.map || null, mode: c.mode || null,
    ...(c.source ? { source: c.source, title: c.title || null } : {}),
    ...(c.kind === 'manual' ? { people: (c.people || []).map(p => ({ uuid: p.uuid, name: p.name, team: p.team || null })) } : {})
  });

  async function removeFile(key) {
    const r = await http.delete(link('DELETE', key, 60), { validateStatus: () => true, timeout: 10000 });
    if (r.status >= 300 && r.status !== 404) throw new Error(`B2 delete answered ${r.status}`);
  }

  /**
   * Cut the clips for one replay. Old automatic clips of that replay are
   * replaced. Returns the note saved on the replay.
   */
  async function clipReplay(replayId) {
    const rep = await Replay.findById(replayId);
    if (!rep || rep.status !== 'ready') return null;
    const note = { version: CLIP_VERSION, at: new Date(), clips: 0, moments: [], error: null };
    try {
      if ((rep.sizeBytes || 0) > MAX_REPLAY_BYTES) throw new Error('Replay too big to clip on the server');
      // Read piece by piece in the replay worker (replay-jobs.js), one
      // replay at a time across clips, the Atlas and the daily backup.
      const found = await jobs.exclusive(async () => {
        const r = await http.get(link('GET', rep.key, 60), { responseType: 'arraybuffer', timeout: 120000, validateStatus: () => true, maxContentLength: MAX_REPLAY_BYTES + 1 });
        if (r.status !== 200) throw new Error(`Storage answered ${r.status}`);
        const bytes = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data);
        jobs.checkSize(bytes);
        return jobs.run({ kind: 'clips', bytes, players: (rep.players || []).map(p => ({ uuid: p.uuid, username: p.username, nick: p.nick })), manual: Array.from(rep.manualClips || [], Number) }, { inProcess });
      });
      note.moments = found.moments.map(m => ({ kind: m.kind, username: m.username, victim: m.victim, by: m.by, t: m.t, ok: m.ok, reason: m.reason, inView: m.inView, distance: m.distance, ...(m.people ? { people: m.people.map(p => p.name) } : {}) }));
      const good = found.moments.filter(m => m.ok);
      const cut = found.cuts;

      if (found.summary) await Replay.updateOne({ _id: rep._id }, { $set: { summary: found.summary } });
      // Replace this replay's earlier automatic clips (clips made on the
      // website stay).
      const old = await Clip.find({ replayId: rep._id, source: { $ne: 'site' } }).lean();
      for (const c of old) {
        await removeFile(c.key).catch(err => log.warn('Clips: removing an old clip failed', err.message));
        await Clip.deleteOne({ _id: c._id });
      }
      for (let i = 0; i < good.length; i++) {
        const m = good[i]; const { bytes, durationMs } = cut[i];
        const before = m.kind === 'final' ? clipper.DEFAULTS.finalBeforeMs : m.kind === 'bed' ? clipper.DEFAULTS.bedBeforeMs : clipper.DEFAULTS.manualBeforeMs;
        const doc = new Clip({
          key: 'pending', replayId: rep._id, uuid: m.uuid, username: m.username, victim: m.victim, by: m.by, team: m.team,
          kind: m.kind, at: m.t, markAt: Math.min(before, m.t), durationMs, sizeBytes: bytes.length, distance: m.distance,
          follow: m.follow, playedAt: rep.playedAt ? new Date(rep.playedAt.getTime() + Math.max(0, m.t - before)) : null,
          map: rep.map, mode: rep.mode,
          ...(m.kind === 'manual' ? { people: m.people, peopleKeys: [...m.people.map(p => p.uuid), ...m.people.map(p => 'n:' + p.name.toLowerCase())] } : {})
        });
        doc.key = `clips/${doc._id}.mcpr`;
        await doc.save();
        await http.put(link('PUT', doc.key), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length },
          maxBodyLength: Infinity, timeout: 60000
        });
        doc.status = 'ready';
        await doc.save();
        note.clips++;
      }
    } catch (err) {
      note.error = String(err.message || err).slice(0, 200);
      log.warn(`Clips: replay ${replayId} failed:`, note.error);
    }
    await Replay.updateOne({ _id: replayId }, { $set: { clips: note } });
    return note;
  }

  // One replay at a time here; replay-jobs.js also keeps clips and the Atlas
  // from reading two replays at once.
  const queue = [];
  let busy = null;
  function enqueue(id) {
    const s = String(id);
    if (!queue.includes(s)) queue.push(s);
    if (!busy) busy = drain().finally(() => { busy = null; });
    return busy;
  }
  async function drain() {
    while (queue.length) {
      const id = queue.shift();
      try { await clipReplay(id); } catch (err) { log.warn('Clips: job failed', err.message); }
    }
  }

  // Replays never clipped (or clipped under older rules), oldest first.
  async function backfill(limit = 5) {
    if (!config() || mongoose.connection.readyState !== 1) return 0;
    const docs = await Replay.find({ status: 'ready', $or: [{ clips: null }, { 'clips.version': { $lt: CLIP_VERSION } }] }, { _id: 1 })
      .sort({ playedAt: 1 }).limit(limit).lean();
    for (const d of docs) enqueue(d._id);
    if (busy) await busy;
    // Replays clipped before game summaries existed: just the summary.
    if (!docs.length) {
      const old = await Replay.find({ status: 'ready', 'clips.version': CLIP_VERSION, 'clips.error': null, $or: [{ summary: null }, { 'summary.v': { $lt: SUMMARY_VERSION } }] }, { _id: 1 })
        .sort({ playedAt: -1 }).limit(limit).lean();
      for (const d of old) await summarize(d._id).catch(err => log.warn('Clips: summary failed', err.message));
      return old.length;
    }
    return docs.length;
  }

  // Reads one replay for its game summary only (game-summary.js).
  async function summarize(replayId) {
    const rep = await Replay.findById(replayId).lean();
    if (!rep || rep.status !== 'ready') return null;
    const bytes = await download(rep);
    let out;
    try {
      out = await jobs.exclusive(() => jobs.run({ kind: 'summary', bytes }, { inProcess }));
    } catch (err) {
      // A replay that can't be read keeps an empty summary, so it isn't tried again and again.
      out = { summary: { v: SUMMARY_VERSION, error: String(err.message || err).slice(0, 200) } };
    }
    if (out && out.summary) await Replay.updateOne({ _id: rep._id }, { $set: { summary: out.summary } });
    return out && out.summary;
  }

  async function download(rep) {
    if ((rep.sizeBytes || 0) > MAX_REPLAY_BYTES) throw new Error('Replay too big to read on the server');
    const r = await http.get(link('GET', rep.key, 60), { responseType: 'arraybuffer', timeout: 120000, validateStatus: () => true, maxContentLength: MAX_REPLAY_BYTES + 1 });
    if (r.status !== 200) throw new Error(`Storage answered ${r.status}`);
    const bytes = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data);
    jobs.checkSize(bytes);
    return bytes;
  }
  if (env.CLIPS_BACKFILL !== 'off') {
    const first = setTimeout(() => backfill().catch(err => log.warn('Clips: backfill failed', err.message)), FIRST_BACKFILL_MS);
    const timer = setInterval(() => backfill().catch(err => log.warn('Clips: backfill failed', err.message)), BACKFILL_MS);
    if (first.unref) first.unref();
    if (timer.unref) timer.unref();
  }

  const requireFullAccess = (req, res, next) => (hasFullAccess(req.keyOwner)
    ? next()
    : res.status(403).json({ error: 'Only Milo\'s key can do that' }));
  const badId = (id) => !mongoose.isValidObjectId(id);

  // The site: a player's clips, newest first (keys only, like replays).
  // ?name= also finds /clip clips they're in under that name.
  app.get('/clips', requireWriteKey, proxyLimiter, async (req, res) => {
    const uuid = String(req.query.uuid || '').replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(uuid)) return res.status(400).json({ error: 'Invalid uuid' });
    const name = /^\w{1,16}$/.test(String(req.query.name || '')) ? String(req.query.name).toLowerCase() : null;
    try {
      const keys = name ? [uuid, 'n:' + name] : [uuid];
      const docs = await Clip.find({ status: 'ready', $or: [{ uuid }, { peopleKeys: { $in: keys } }] }).sort({ playedAt: -1, at: -1 }).limit(LIST_MAX).lean();
      // The other clips from the same games (Milo 2026-11-05): with a whole
      // team tracked, each of them shows every final kill of that game.
      // One game can be uploaded more than once (again for a player tracked
      // later, under the same file name): those uploads are one game. And a
      // game they were tracked in counts even when none of the clips are theirs.
      const theirs = await Replay.find({ 'players.uuid': uuid }, { _id: 1 }).sort({ playedAt: -1 }).limit(LIST_MAX).lean();
      const ids = [...new Set([...docs.map(c => String(c.replayId || '')), ...theirs.map(r => String(r._id))].filter(Boolean))];
      const reps = ids.length ? await Replay.find({ _id: { $in: ids } }, { name: 1, uploadedBy: 1 }).lean() : [];
      const named = reps.filter(r => r.name);
      const copies = named.length
        ? await Replay.find({ $or: named.map(r => ({ name: r.name, uploadedBy: r.uploadedBy ?? null })) }, { name: 1, uploadedBy: 1 }).lean()
        : [];
      const gameOf = new Map();
      for (const r of [...reps, ...copies]) gameOf.set(String(r._id), r.name ? `${r.uploadedBy || ''}/${r.name}` : String(r._id));
      const game = (c) => gameOf.get(String(c.replayId || '')) || String(c.replayId || c._id);
      const allIds = [...gameOf.keys()];
      // A bed break is cut once per tracked player of that team (and again
      // in each upload of the game): shown once.
      const moment = (c) => `${game(c)}:${c.kind}:${c.at}`;
      const seen = new Set();
      const mine = [];
      for (const c of docs) { if (!seen.has(moment(c))) { seen.add(moment(c)); mine.push(c); } }
      const others = allIds.length
        ? await Clip.find({ status: 'ready', replayId: { $in: allIds }, _id: { $nin: docs.map(c => c._id) } }).sort({ playedAt: -1, at: -1 }).limit(LIST_MAX).lean()
        : [];
      const sameGame = [];
      for (const c of others) {
        const k = moment(c);
        if (seen.has(k)) continue;
        seen.add(k);
        sameGame.push({ ...publicClip(c), game: game(c) });
      }
      return res.json({ clips: mine.map(c => ({ ...publicClip(c), game: game(c) })), sameGame });
    } catch (err) {
      log.error('/clips GET error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  app.get('/clips/:id', requireWriteKey, proxyLimiter, async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Clip.findById(req.params.id).lean();
      if (!doc || doc.status !== 'ready') return res.status(404).json({ error: 'No such clip' });
      return res.json(publicClip(doc));
    } catch (err) {
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // The clip file for the viewer, passed through (the bucket has no CORS).
  app.get('/clips/:id/file', requireWriteKey, proxyLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Clip.findById(req.params.id).lean();
      if (!doc || doc.status !== 'ready') return res.status(404).json({ error: 'No such clip' });
      const r = await http.get(link('GET', doc.key, 60), { responseType: 'arraybuffer', validateStatus: () => true, timeout: 20000 });
      if (r.status !== 200) return res.status(502).json({ error: `Storage answered ${r.status}` });
      res.set('Content-Type', 'application/octet-stream');
      res.set('Cache-Control', 'private, max-age=86400');
      return res.send(Buffer.from(r.data));
    } catch (err) {
      log.error('/clips file error', err.message);
      if (!res.headersSent) return res.status(500).json({ error: 'Couldn\'t load the clip' });
    }
  });

  // Download for Replay Mod.
  app.get('/clips/:id/link', requireWriteKey, proxyLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Clip.findById(req.params.id).lean();
      if (!doc || doc.status !== 'ready') return res.status(404).json({ error: 'No such clip' });
      const what = doc.kind === 'bed' ? 'bed' : doc.kind === 'manual' ? 'clip' : 'final';
      const name = `${doc.victim || doc.username || doc.map || 'clip'}-${what}-${String(doc._id).slice(-6)}.mcpr`.replace(/[^A-Za-z0-9_.-]/g, '_');
      return res.json({ url: link('GET', doc.key, DOWNLOAD_LINK_SECONDS, { 'response-content-disposition': `attachment; filename="${name}"` }), name });
    } catch (err) {
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // Milo can remove a clip.
  app.delete('/clips/:id', requireWriteKey, requireFullAccess, writeLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Clip.findById(req.params.id).lean();
      if (!doc) return res.status(404).json({ error: 'No such clip' });
      await removeFile(doc.key);
      await Clip.deleteOne({ _id: doc._id });
      return res.json({ ok: true, deletedId: String(doc._id) });
    } catch (err) {
      log.error('/clips DELETE error', err.message);
      return res.status(500).json({ error: 'Delete failed' });
    }
  });

  // What clipping found in a replay, and why anything was skipped.
  app.get('/replays/:id/clips', requireWriteKey, proxyLimiter, async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Replay.findById(req.params.id, { clips: 1 }).lean();
      if (!doc) return res.status(404).json({ error: 'No such replay' });
      const clips = await Clip.find({ replayId: doc._id, status: 'ready' }).sort({ at: 1 }).lean();
      return res.json({ note: doc.clips || null, clips: clips.map(publicClip) });
    } catch (err) {
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // Milo: clip a replay again now.
  app.post('/replays/:id/clips', requireWriteKey, requireFullAccess, writeLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Replay.findById(req.params.id, { status: 1 }).lean();
      if (!doc || doc.status !== 'ready') return res.status(404).json({ error: 'No such replay' });
      await enqueue(doc._id);
      const after = await Replay.findById(doc._id, { clips: 1 }).lean();
      return res.json({ note: after && after.clips });
    } catch (err) {
      log.error('/replays clips POST error', err.message);
      return res.status(500).json({ error: 'Clipping failed' });
    }
  });

  // A clip marked in the replay viewer on the website: the part of the game
  // from `from` to `to` (ms into the replay), around the player the viewer
  // was following. Any key can make one; it shows for everyone in it, like
  // a /clip, and stays when the replay is clipped again.
  app.post('/replays/:id/site-clips', requireWriteKey, writeLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const b = req.body || {};
    const from = Math.round(Number(b.from)); const to = Math.round(Number(b.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return res.status(400).json({ error: 'Mark a start and an end first' });
    if (to - from < SITE_CLIP_MIN_MS) return res.status(400).json({ error: 'A clip needs at least 2 seconds' });
    if (to - from > SITE_CLIP_MAX_MS) return res.status(400).json({ error: 'A clip can be at most 60 seconds' });
    const title = typeof b.title === 'string' ? b.title.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
    const follow = /^\w{1,16}$/.test(String(b.follow || '')) ? String(b.follow) : null;
    try {
      const rep = await Replay.findById(req.params.id).lean();
      if (!rep || rep.status !== 'ready') return res.status(404).json({ error: 'No such replay' });
      if (rep.durationMs && from > rep.durationMs + 5000) return res.status(400).json({ error: 'That is past the end of the game' });
      const out = await jobs.exclusive(async () => {
        const bytes = await download(rep);
        return jobs.run({ kind: 'cut', bytes, from, to, follow, title: title || 'Clip' }, { inProcess });
      });
      const people = (out.people || []).slice(0, 16);
      const doc = new Clip({
        key: 'pending', replayId: rep._id, kind: 'manual', source: 'site', title: title || null, createdBy: req.keyOwner,
        by: (out.self && out.self.name) || null, follow: follow || (out.self && out.self.name) || null,
        at: to, markAt: 0, durationMs: out.durationMs, sizeBytes: out.bytes.length,
        playedAt: rep.playedAt ? new Date(rep.playedAt.getTime() + from) : null, map: rep.map, mode: rep.mode,
        people, peopleKeys: [...people.map(p => p.uuid), ...people.map(p => 'n:' + String(p.name).toLowerCase()), ...(out.followUuid ? [out.followUuid] : []), ...(follow ? ['n:' + follow.toLowerCase()] : [])]
      });
      doc.key = `clips/${doc._id}.mcpr`;
      await doc.save();
      const bytes = out.bytes;
      await http.put(link('PUT', doc.key), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length },
        maxBodyLength: Infinity, timeout: 60000
      });
      doc.status = 'ready';
      await doc.save();
      return res.status(201).json(publicClip(doc));
    } catch (err) {
      log.error('/replays site-clips POST error', err.message);
      return res.status(500).json({ error: 'Couldn\'t make the clip' });
    }
  });

  // A site clip's maker (or Milo) can rename it.
  app.patch('/clips/:id', requireWriteKey, writeLimiter, async (req, res) => {
    if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const doc = await Clip.findById(req.params.id);
      if (!doc || doc.status !== 'ready') return res.status(404).json({ error: 'No such clip' });
      if (doc.source !== 'site' || (doc.createdBy !== req.keyOwner && !hasFullAccess(req.keyOwner))) return res.status(403).json({ error: 'Only who made this clip can rename it' });
      doc.title = typeof req.body?.title === 'string' ? req.body.title.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || null : doc.title;
      await doc.save();
      return res.json(publicClip(doc));
    } catch (err) {
      return res.status(500).json({ error: 'DB write error' });
    }
  });

  async function usage() {
    const [row] = await Clip.aggregate([{ $match: { status: 'ready' } }, { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$sizeBytes' } } }]);
    return { count: row ? row.count : 0, bytes: row ? row.bytes : 0 };
  }

  // Waits until no clip is being cut.
  const idle = async () => { while (busy) await busy; };
  return { Clip, clipReplay, enqueue, backfill, summarize, usage, idle, CLIP_VERSION };
};
