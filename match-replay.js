// --- Match stats from a recorded game ---
// How Milo's team did in a game (kills, deaths, finals, beds, resources
// picked up, pressure time), worked out from the replay itself while the
// clip job reads it (clipper.findMoments hands over what it saw). This is
// what the "Match stats" box shows; the plugin's own copy (match-stats.js
// POST) is only kept for games whose replay the server can't read.
//
// The rules are the plugin's (lib/matches/stats.js), so the numbers match:
//  - kills/deaths/finals/beds: the game summary's kill-line rule
//    (game-summary.js), a final kill isn't also a kill.
//  - resources: items picked up, as the game shows them (collect packets).
//    Yours are all there; a teammate's only while they were near you (the
//    server only shows items and players close by), the same as before.
//  - pressure: a second at a time, on an enemy island while their bed is
//    alive and at least one of them is there with you (Milo 2026-11-06).
//  - result: win / loss, or left (Milo 2026-11-13: you left before the end
//    and weren't out yet).

const STATS_VERSION = 1;
// An island: this close to its spawn (sideways) counts as on it.
const ISLAND_RADIUS = 28;
// Where each team's island is: where its players stand in the first seconds
// (from 1 s in: everyone is still on the waiting platform for a moment after
// the start line, then moved to their island).
const SPAWN_FROM_MS = 1000;
const SPAWN_WINDOW_MS = 4000;
// A team not seen then: where its players show up again after dying (they
// respawn on their island 5 s later, while their bed is alive).
const RESPAWN_FROM_MS = 4500;
const RESPAWN_TO_MS = 9000;
const RESPAWN_MS = 5000;
// The map's middle (the waiting platform hangs over it before the start, and
// players coming back into view there aren't on their island): never an
// island. The nearest real island seen in 86 games was 46 blocks out.
const MIDDLE_RADIUS = 30;
const STEP_MS = 1000;
const RESOURCES = { 265: 'iron', 266: 'gold', 264: 'dia', 388: 'em' };
const TEAM_MAX = 8;

const lc = (s) => String(s || '').toLowerCase();

/** The newest sample at or before t (null if none, or they'd gone out of view). */
function sampleAt(list, t) {
  if (!list || !list.length || list[0].t > t) return null;
  let lo = 0; let hi = list.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].t <= t) lo = mid; else hi = mid - 1; }
  const s = list[lo];
  return s.gone ? null : s;
}

/**
 * What findMoments saw -> { v, team, result, durationMs, players, missing } or
 * null (no team for the recording player).
 *  names: Map uuid -> name; teamOf: Map lower name -> team
 *  self: { name, team, uuid, seen } (seen: the recording has your own moves)
 *  samples: Map uuid -> [{ t, x, y, z, gone }]
 *  pickups: [{ t, id (item id), n, self (you picked it up), uuid (who did) }]
 *  titles: [{ t, text }]; lines: game chat [{ t, text }]
 *  summary: game-summary.js output; startT; endT (last packet)
 * missing: what the replay couldn't show (e.g. 'pressureMs' for you in old
 * recordings without your own moves): the plugin's value is kept for it.
 */
function statsFromReplay({ names, teamOf, self = {}, samples = new Map(), pickups = [], titles = [], lines = [], summary, startT = null, endT = 0 }) {
  const myTeam = self.team || null;
  const meName = self.name || null;
  if (!myTeam || !meName || !summary || !Array.isArray(summary.teams)) return null;
  const ours = summary.teams.find(t => t.team === myTeam);
  if (!ours) return null;

  const uuidOf = new Map(); // lower name -> uuid
  for (const [u, n] of names) if (!uuidOf.has(lc(n))) uuidOf.set(lc(n), u);
  if (self.uuid) uuidOf.set(lc(meName), self.uuid);
  const rows = ours.players.slice(0, TEAM_MAX).map(p => ({
    name: p.name, me: lc(p.name) === lc(meName),
    kills: p.kills || 0, deaths: p.deaths || 0, finals: p.finals || 0, finalDeath: !!p.finalDeath, beds: p.beds || 0,
    iron: 0, gold: 0, dia: 0, em: 0, pressureMs: 0
  }));
  const row = new Map(rows.map(r => [lc(r.name), r]));

  // --- Pickups ---
  for (const k of pickups) {
    const res = RESOURCES[k.id];
    if (!res) continue;
    const who = k.self ? meName : (k.uuid ? names.get(k.uuid) : null);
    const r = who && row.get(lc(who));
    if (r) r[res] += k.n || 1;
  }

  // --- Pressure ---
  const t0 = startT != null ? startT : 0;
  const bedGoneAt = new Map(summary.teams.filter(t => t.bedBrokenAt != null).map(t => [t.team, t.bedBrokenAt]));
  for (const l of lines) {
    if (/^All beds have been destroyed!?$/.test(String(l.text || '').trim()) && (startT == null || l.t >= startT)) {
      for (const t of summary.teams) if (!bedGoneAt.has(t.team)) bedGoneAt.set(t.team, l.t);
    }
  }
  const deaths = (summary.events || []).filter(e => e.kind === 'kill' || e.kind === 'final').map(e => ({ t: e.t, victim: e.victim, final: e.kind === 'final' }));
  const people = [];   // { name, team, list }
  for (const t of summary.teams) {
    for (const p of t.players) {
      const u = uuidOf.get(lc(p.name));
      people.push({ name: p.name, team: t.team, list: u ? samples.get(u) || null : null });
    }
  }
  const islands = islandsOf(people, startT, deaths, bedGoneAt);
  const deadUntil = new Map();
  const byTime = deaths.slice().sort((a, b) => a.t - b.t);
  let di = 0;
  for (let t = t0; t <= endT; t += STEP_MS) {
    while (di < byTime.length && byTime[di].t <= t) {
      const d = byTime[di++];
      deadUntil.set(lc(d.victim), d.final ? Infinity : d.t + RESPAWN_MS);
    }
    const alive = (n) => !(deadUntil.get(lc(n)) > t);
    for (const p of people) {
      if (p.team !== myTeam || !alive(p.name)) continue;
      const pos = sampleAt(p.list, t);
      if (!pos) continue;
      for (const [colour, centre] of islands) {
        if (colour === myTeam) continue;
        const goneAt = bedGoneAt.get(colour);
        if (goneAt !== undefined && goneAt <= t) continue;
        if (!near(pos, centre)) continue;
        const defender = people.some(o => o.team === colour && alive(o.name) && (() => { const q = sampleAt(o.list, t); return q && near(q, centre); })());
        if (defender) row.get(lc(p.name)).pressureMs += STEP_MS;
        break;
      }
    }
  }

  // --- The result ---
  const meRow = row.get(lc(meName));
  const meOut = !!(meRow && meRow.finalDeath);
  const titleText = titles.filter(x => startT == null || x.t >= startT).map(x => x.text);
  const eliminated = lines.some(l => {
    const s = String(l.text || '').trim();
    if (startT != null && l.t < startT) return false;
    const m = s.match(/^TEAM ELIMINATED\s*>\s*(\w+) Team\b/);
    return (m && m[1].toLowerCase() === myTeam.toLowerCase()) || /^You have been eliminated!?$/.test(s);
  });
  let result = null;
  if (titleText.some(s => /VICTORY/.test(s))) result = 'win';
  else if (titleText.some(s => /GAME OVER/.test(s)) || eliminated) result = 'loss';
  else if (summary.result === 'win' || summary.result === 'loss') result = summary.result;
  // The recording ended with the game still on and you still in it: you left.
  else if (!meOut && !summary.winner) result = 'left';

  const missing = [];
  // Old recordings don't have your own moves.
  if (!self.seen) missing.push('me.pressureMs');
  return {
    v: STATS_VERSION,
    team: myTeam,
    result,
    durationMs: Math.max(0, endT - t0),
    joinedLate: startT == null,
    players: rows,
    missing
  };
}

/** Each team's island: where its players stood in the first seconds. A team
 *  not seen then (or a recording that began after the start): the middle of
 *  where its players came back after a death while their bed was alive. */
function islandsOf(people, startT, deaths, bedGoneAt) {
  const out = new Map();
  if (startT != null) {
    const sums = new Map();
    for (const p of people) {
      for (const s of p.list || []) {
        if (s.t < startT + SPAWN_FROM_MS) continue;
        if (s.t > startT + SPAWN_WINDOW_MS) break;
        if (s.gone || inMiddle(s)) continue;
        const acc = sums.get(p.team) || { x: 0, z: 0, n: 0 };
        acc.x += s.x; acc.z += s.z; acc.n++;
        sums.set(p.team, acc);
      }
    }
    for (const [c, s] of sums) out.set(c, { x: s.x / s.n, z: s.z / s.n });
  }
  const byName = new Map(people.map(p => [lc(p.name), p]));
  const seen = new Map();
  for (const d of deaths) {
    const p = byName.get(lc(d.victim));
    if (!p || out.has(p.team) || d.final) continue;
    const gone = bedGoneAt.get(p.team);
    if (gone !== undefined && gone <= d.t) continue;
    for (const s of p.list || []) {
      if (s.t <= d.t + RESPAWN_FROM_MS || s.gone || inMiddle(s)) continue;
      if (s.t > d.t + RESPAWN_TO_MS) break;
      (seen.get(p.team) || seen.set(p.team, []).get(p.team)).push([s.x, s.z]);
      break;
    }
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  for (const [c, spots] of seen) out.set(c, { x: median(spots.map(s => s[0])), z: median(spots.map(s => s[1])) });
  return out;
}

const inMiddle = (s) => s.x * s.x + s.z * s.z <= MIDDLE_RADIUS * MIDDLE_RADIUS;

function near(p, centre) {
  const dx = p.x - centre.x;
  const dz = p.z - centre.z;
  return dx * dx + dz * dz <= ISLAND_RADIUS * ISLAND_RADIUS;
}

module.exports = { statsFromReplay, STATS_VERSION, ISLAND_RADIUS, RESOURCES };
