// --- Games: every recorded game, for the website's Games page ---
// A game is a Replay (replays.js). The same game uploaded again (for a
// player tracked later) has the same file name and counts once. Each comes
// with its summary (game-summary.js: teams, kills, finals, beds, the kill
// log), our team's match stats (match-stats.js) and its clips (clips.js).
// Keys only, like replays: they show other people.

const PAGE_SIZE = 20;
const SCAN_MAX = 2000;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = function setupGames({ app, mongoose, Replay, Clip, MatchStat, requireWriteKey, proxyLimiter, log = console }) {
  const gameKey = (r) => (r.name ? `${r.uploadedBy || ''}/${r.name}` : String(r._id));

  // One row of the list: what the page needs without the kill log.
  const listRow = (r, copies) => {
    const s = r.summary && !r.summary.error ? r.summary : null;
    return {
      id: String(r._id),
      replayIds: copies.map(c => String(c._id)),
      name: r.name || null,
      playedAt: r.playedAt, durationMs: r.durationMs || 0, map: r.map || null, mode: r.mode || null,
      tracked: dedupe(copies.flatMap(c => (c.players || []).map(p => ({ uuid: p.uuid, username: p.username })))),
      summary: s ? {
        self: s.self, winner: s.winner, result: s.result, totals: s.totals,
        teams: (s.teams || []).map(t => ({ team: t.team, bedBrokenAt: t.bedBrokenAt, eliminatedAt: t.eliminatedAt, players: t.players.map(p => p.name) }))
      } : null
    };
  };
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter(p => { if (!p.uuid || seen.has(p.uuid)) return false; seen.add(p.uuid); return true; });
  };

  // The list, newest first: ?page=1&q=text (map, mode or a player's name).
  app.get('/games', requireWriteKey, proxyLimiter, async (req, res) => {
    const page = Math.max(1, Math.min(500, Math.floor(Number(req.query.page) || 1)));
    const q = String(req.query.q || '').trim().slice(0, 40);
    const filter = { status: 'ready' };
    if (q) {
      const re = new RegExp(escapeRe(q), 'i');
      filter.$or = [{ map: re }, { mode: re }, { 'players.username': re }, { 'players.nick': re }, { 'summary.teams.players.name': re }];
    }
    try {
      const docs = await Replay.find(filter, { key: 0, clips: 0, 'summary.events': 0, manualClips: 0 })
        .sort({ playedAt: -1 }).limit(SCAN_MAX).lean();
      // Copies of one game are one row; the copy with a summary leads.
      const groups = new Map();
      for (const d of docs) {
        const k = gameKey(d);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(d);
      }
      const rows = [...groups.values()].map(copies => {
        const lead = copies.find(c => c.summary && !c.summary.error) || copies[0];
        return listRow(lead, copies);
      });
      const total = rows.length;
      const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      // Which have our match stats, and how many clips each has.
      const names = slice.map(r => r.name).filter(Boolean);
      const stats = names.length ? await MatchStat.find({ game: { $in: names } }, { game: 1, result: 1, team: 1 }).lean() : [];
      const statOf = new Map(stats.map(s => [s.game, s]));
      const ids = slice.flatMap(r => r.replayIds);
      const clipCounts = ids.length
        ? await Clip.aggregate([{ $match: { status: 'ready', replayId: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } } }, { $group: { _id: { r: '$replayId', k: '$kind', a: '$at' } } }, { $group: { _id: '$_id.r', n: { $sum: 1 } } }])
        : [];
      const clipsOf = new Map(clipCounts.map(c => [String(c._id), c.n]));
      for (const r of slice) {
        const st = r.name && statOf.get(r.name);
        r.result = (r.summary && r.summary.result) || (st && st.result) || null;
        r.matchStats = !!st;
        r.clips = Math.max(0, ...r.replayIds.map(id => clipsOf.get(id) || 0));
      }
      return res.json({ games: slice, page, pageSize: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
    } catch (err) {
      log.error('/games GET error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // One game: its full summary with the kill log, our match stats and its clips.
  app.get('/games/:id', requireWriteKey, proxyLimiter, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    try {
      const rep = await Replay.findById(req.params.id, { key: 0, clips: 0, manualClips: 0 }).lean();
      if (!rep || rep.status !== 'ready') return res.status(404).json({ error: 'No such game' });
      const copies = rep.name
        ? await Replay.find({ name: rep.name, uploadedBy: rep.uploadedBy ?? null, status: 'ready' }, { key: 0, clips: 0, manualClips: 0 }).lean()
        : [rep];
      const lead = copies.find(c => c.summary && !c.summary.error) || rep;
      const row = listRow(lead, copies);
      const st = rep.name ? await MatchStat.findOne({ game: rep.name }).lean() : null;
      const clips = await Clip.find({ status: 'ready', replayId: { $in: copies.map(c => c._id) } }).sort({ at: 1 }).lean();
      const seen = new Set();
      const clipRows = [];
      for (const c of clips) {
        const k = `${c.kind}:${c.at}:${c.source || ''}:${c.title || ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        clipRows.push({ id: String(c._id), kind: c.kind, at: c.at, durationMs: c.durationMs, victim: c.victim || null, by: c.by || null, follow: c.follow || null, title: c.title || null, source: c.source || null, people: (c.people || []).map(p => p.name) });
      }
      const s = lead.summary && !lead.summary.error ? lead.summary : null;
      return res.json({
        ...row,
        result: (s && s.result) || (st && st.result) || null,
        summary: s,
        matchStats: st ? { team: st.team || null, result: st.result || null, players: (st.players || []).map(p => ({ name: p.name, me: !!p.me, finalDeath: !!p.finalDeath, kills: p.kills || 0, deaths: p.deaths || 0, finals: p.finals || 0, beds: p.beds || 0, iron: p.iron || 0, gold: p.gold || 0, dia: p.dia || 0, em: p.em || 0, pressureMs: p.pressureMs || 0 })) } : null,
        clips: clipRows
      });
    } catch (err) {
      log.error('/games/:id GET error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });
};
