// Match stats: how Milo's team did in a game with a tracked player
// (kills, deaths, finals, beds, diamonds/emeralds picked up, pressure
// time). Kept on their own, so they stay after the game's replay is
// deleted. Shown as "Match stats" on the player's popup.
//
// One source of truth: the server works them out from the uploaded replay
// (match-replay.js, in the clip job), so rejoined and recovered games get
// them too. The plugin still sends its own copy (POST below); it's kept only
// for a game whose replay couldn't be read, and for what a replay can't
// show (`missing`, e.g. your pressure time in old recordings without your
// own moves). A replay's numbers are never overwritten by the plugin's.

const PLAYERS_MAX = 16; // tracked players a game is for
const TEAM_MAX = 8;     // our team's rows
const LIST_MAX = 50;
const NUM_FIELDS = ['kills', 'deaths', 'finals', 'beds', 'iron', 'gold', 'dia', 'em', 'pressureMs'];

module.exports = function setupMatchStats({ app, mongoose, requireWriteKey, writeLimiter, proxyLimiter, hasFullAccess = () => true, UUID_RE, NAME_RE }) {
  const MatchStat = mongoose.model('MatchStat', new mongoose.Schema({
    uuid: { type: String, index: true }, // the tracked player (no dashes, lower case)
    username: String,
    nick: String,                         // what they played under, when known
    game: String,                         // the recording's name: one row per player and game
    playedAt: Date,
    mode: String,
    map: String,
    durationMs: Number,
    team: String,
    result: String,                       // 'win' | 'loss' | 'left' (left before the end, still in it) | null
    missing: { type: [String], default: undefined }, // what the replay couldn't show (the plugin's value is kept)
    source: String,                       // 'replay' (worked out here) | 'plugin' (sent by the plugin)
    players: [{
      _id: false, name: String, me: Boolean, finalDeath: Boolean,
      kills: Number, deaths: Number, finals: Number, beds: Number,
      iron: Number, gold: Number, dia: Number, em: Number, pressureMs: Number
    }],
    uploadedBy: String
  }, { timestamps: true }));
  MatchStat.collection.createIndex({ uuid: 1, game: 1 }, { unique: true }).catch(() => {});

  const plainUuid = (u) => String(u || '').replace(/-/g, '').toLowerCase();
  const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const count = (v, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
  };

  const RESULTS = ['win', 'loss', 'left'];
  const publicStat = (s) => ({
    game: s.game, playedAt: s.playedAt, mode: s.mode || null, map: s.map || null, durationMs: s.durationMs || 0,
    team: s.team || null, result: s.result || null, nick: s.nick || null,
    players: (s.players || []).map(p => ({
      name: p.name, me: !!p.me, finalDeath: !!p.finalDeath,
      ...Object.fromEntries(NUM_FIELDS.map(k => [k, p[k] || 0]))
    }))
  });

  // The plugin: one game's stats, for the tracked players in it. Sending the
  // same game again replaces it (a later, fuller copy wins).
  app.post('/match-stats', requireWriteKey, writeLimiter, async (req, res) => {
    if (!hasFullAccess(req.keyOwner)) return res.status(403).json({ error: 'Only Milo\'s key can send match stats' });
    const b = req.body || {};
    const game = text(b.name, 80);
    if (!game) return res.status(400).json({ error: 'Which game is it?' });
    const tracked = (Array.isArray(b.players) ? b.players : []).slice(0, PLAYERS_MAX)
      .map(p => ({ uuid: plainUuid(p?.uuid), username: String(p?.username || ''), nick: NAME_RE.test(String(p?.nick || '')) ? String(p.nick) : null }))
      .filter(p => UUID_RE.test(p.uuid));
    if (!tracked.length) return res.status(400).json({ error: 'Which tracked players is it for?' });
    const s = b.stats && typeof b.stats === 'object' ? b.stats : null;
    const rows = (Array.isArray(s?.players) ? s.players : []).slice(0, TEAM_MAX)
      .filter(p => NAME_RE.test(String(p?.name || '')))
      .map(p => ({
        name: String(p.name), me: !!p.me, finalDeath: !!p.finalDeath,
        ...Object.fromEntries(NUM_FIELDS.map(k => [k, count(p[k], k === 'pressureMs' ? 6 * 3600000 : 100000)]))
      }));
    if (!rows.length) return res.status(400).json({ error: 'No stats in it' });
    const playedAt = new Date(b.playedAt || s.playedAt);
    const base = {
      game, playedAt: isNaN(playedAt) ? new Date() : playedAt,
      mode: text(b.mode || s.mode, 30), map: text(b.map || s.map, 40),
      durationMs: count(s.durationMs ?? b.durationMs, 6 * 3600000),
      team: text(s.team, 12), result: RESULTS.includes(s.result) ? s.result : null,
      players: rows, uploadedBy: req.keyOwner, source: 'plugin'
    };
    try {
      for (const t of tracked) {
        const had = await MatchStat.findOne({ uuid: t.uuid, game }).lean();
        if (had && had.source === 'replay') {
          // Worked out from the replay already: only what it couldn't show.
          const set = { ...(NAME_RE.test(t.username) ? { username: t.username } : {}), ...(t.nick && !had.nick ? { nick: t.nick } : {}) };
          const players = fillMissing(had.players, rows, had.missing);
          if (players) set.players = players;
          if (Object.keys(set).length) await MatchStat.updateOne({ _id: had._id }, { $set: set });
          continue;
        }
        await MatchStat.updateOne(
          { uuid: t.uuid, game },
          { $set: { ...base, uuid: t.uuid, username: NAME_RE.test(t.username) ? t.username : null, nick: t.nick } },
          { upsert: true }
        );
      }
      return res.status(201).json({ saved: tracked.length });
    } catch (err) {
      console.error('/match-stats POST error', err.message);
      return res.status(500).json({ error: 'DB write error' });
    }
  });

  // The site: a player's games with our stats in them, newest first.
  app.get('/match-stats', requireWriteKey, proxyLimiter, async (req, res) => {
    const uuid = plainUuid(req.query.uuid);
    if (!UUID_RE.test(uuid)) return res.status(400).json({ error: 'Invalid uuid' });
    try {
      const docs = await MatchStat.find({ uuid }).sort({ playedAt: -1 }).limit(LIST_MAX).lean();
      return res.json({ games: docs.map(publicStat) });
    } catch (err) {
      console.error('/match-stats GET error', err.message);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // 'me.pressureMs' -> your row's pressure time from the plugin's rows (the
  // replay couldn't show it). Null when nothing changes.
  function fillMissing(players, from, missing) {
    if (!Array.isArray(missing) || !missing.length || !Array.isArray(from) || !from.length) return null;
    let changed = false;
    const out = (players || []).map(p => ({ ...p }));
    for (const m of missing) {
      const [who, field] = String(m).split('.');
      if (who !== 'me' || !NUM_FIELDS.includes(field)) continue;
      const mine = out.find(p => p.me); const theirs = from.find(p => p.me);
      if (mine && theirs && theirs[field] != null && mine[field] !== theirs[field]) { mine[field] = theirs[field]; changed = true; }
    }
    return changed ? out : null;
  }

  /**
   * A game's stats worked out from its replay (clips.js, match-replay.js),
   * saved for each tracked player of that upload. They replace what the
   * plugin sent, except where the replay couldn't show something.
   * rep: the Replay row; stats: statsFromReplay's output.
   */
  async function saveFromReplay(rep, stats) {
    if (!rep || !rep.name || !stats || !Array.isArray(stats.players) || !stats.players.length) return 0;
    const rows = stats.players.slice(0, TEAM_MAX).filter(p => NAME_RE.test(String(p.name || ''))).map(p => ({
      name: String(p.name), me: !!p.me, finalDeath: !!p.finalDeath,
      ...Object.fromEntries(NUM_FIELDS.map(k => [k, count(p[k], k === 'pressureMs' ? 6 * 3600000 : 100000)]))
    }));
    if (!rows.length) return 0;
    const missing = Array.isArray(stats.missing) ? stats.missing.map(String).slice(0, 10) : [];
    let saved = 0;
    for (const t of rep.players || []) {
      const uuid = plainUuid(t.uuid);
      if (!UUID_RE.test(uuid)) continue;
      const had = await MatchStat.findOne({ uuid, game: rep.name }).lean();
      const players = (had && fillMissing(rows, had.players, missing)) || rows;
      await MatchStat.updateOne({ uuid, game: rep.name }, {
        $set: {
          uuid, game: rep.name,
          username: NAME_RE.test(String(t.username || '')) ? t.username : (had && had.username) || null,
          nick: (NAME_RE.test(String(t.nick || '')) ? t.nick : null) || (had && had.nick) || null,
          playedAt: rep.playedAt || (had && had.playedAt) || new Date(),
          mode: text(rep.mode, 30) || (had && had.mode) || null, map: text(rep.map, 40) || (had && had.map) || null,
          durationMs: count(stats.durationMs, 6 * 3600000), team: text(stats.team, 12),
          result: RESULTS.includes(stats.result) ? stats.result : null,
          players, missing, source: 'replay', uploadedBy: rep.uploadedBy || (had && had.uploadedBy) || null
        }
      }, { upsert: true });
      saved++;
    }
    return saved;
  }

  return { MatchStat, saveFromReplay };
};
