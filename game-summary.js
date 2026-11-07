// --- Game summary: who played, and who killed whom, from a game's chat ---
// Built from what clipper.findMoments reads anyway (tab names, teams and the
// game's chat lines), so it costs nothing extra. Stored on the Replay
// (replays.js) and shown on the website's Games page.
//
// Hypixel's kill messages name the victim first and the killer after it
// ("Steve was knocked into the void by Alex."), with cosmetic kill
// messages free to change the words in between. So a line counts as a
// death when it starts with a player's name and isn't someone talking
// ("Steve: gg"), and its killer is the other player named in it, if any.

const SUMMARY_VERSION = 1;
const EVENTS_MAX = 600;
const TEAM_ORDER = ['Red', 'Blue', 'Green', 'Yellow', 'Aqua', 'White', 'Pink', 'Gray'];

const DEATH = /^\S+ (was|fell|slipped|got|died|burned|tried|walked|hit the ground|didn't|withered|blew up|starved|drowned|suffocated|went|froze|stumbled)\b/;
const lc = (s) => String(s || '').toLowerCase();
const word = (s) => String(s || '').replace(/[^A-Za-z0-9_]/g, '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

/**
 * lines: [{ t, text }] (game chat, private chat already left out)
 * names: Map tab uuid -> name; teamOf: Map lower-case name -> team label
 * self: { name, team }; startT: when the cages opened (or null);
 * endT: the recording's last packet.
 */
function summarizeGame({ lines = [], names = new Map(), teamOf = new Map(), self = {}, startT = null, endT = 0 }) {
  // Everyone on a Bed Wars team (spectators and lobby NPCs have none).
  const players = new Map(); // lower-case name -> row
  for (const nm of new Set(names.values())) {
    const team = teamOf.get(lc(nm));
    if (!team) continue;
    players.set(lc(nm), { name: nm, team, kills: 0, finals: 0, deaths: 0, finalDeath: false, beds: 0, left: false });
  }
  const byLength = [...players.values()].map(p => p.name).sort((a, b) => b.length - a.length);
  const mention = (text, skip) => {
    for (const nm of byLength) {
      if (skip && lc(nm) === lc(skip)) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${word(nm)}([^A-Za-z0-9_]|$)`);
      if (re.test(text)) return nm;
    }
    return null;
  };
  const row = (nm) => (nm ? players.get(lc(nm)) : null);

  const events = [];
  const bedGone = new Map(); // team -> t
  const eliminated = new Map(); // team -> t
  let ended = null;
  let firstBlood = true;
  const push = (e) => { if (events.length < EVENTS_MAX) events.push(e); };

  for (const { t, text: raw } of lines) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (startT != null && t < startT) continue;
    if (ended != null && t > ended) continue;
    let m;
    if ((m = text.match(/^BED DESTRUCTION\s*>\s*(\w+) Bed\b/))) {
      const team = m[1] === 'Your' ? self.team || null : cap(m[1]);
      const by = mention(text.slice(text.indexOf('Bed') + 3));
      if (team && !bedGone.has(team)) bedGone.set(team, t);
      if (row(by)) row(by).beds++;
      push({ t, kind: 'bed', team, by: by || null, text });
      continue;
    }
    if ((m = text.match(/^TEAM ELIMINATED\s*>\s*(\w+) Team\b/))) {
      const team = cap(m[1]);
      if (!eliminated.has(team)) { eliminated.set(team, t); push({ t, kind: 'eliminated', team, text }); }
      continue;
    }
    if (/^(VICTORY|GAME OVER)\b/i.test(text) || /^\s*1st Killer\s*-/.test(text)) { ended = ended ?? t; continue; }
    if ((m = text.match(/^(\S+) (?:disconnected\.?|was kicked for being AFK!?)$/)) && row(m[1])) {
      push({ t, kind: 'left', victim: row(m[1]).name, team: row(m[1]).team, text });
      continue;
    }
    if ((m = text.match(/^(\S+) reconnected\.?$/)) && row(m[1])) continue;
    // A death: starts with a player, isn't them talking.
    const first = word(text.split(/\s+/)[0]);
    const victim = row(first);
    if (!victim || /^\S+:/.test(text) || text.includes(':')) continue;
    const final = /FINAL KILL!\s*$/.test(text);
    const killer = mention(text.slice(text.split(/\s+/)[0].length), victim.name);
    // Without a killer or FINAL KILL it has to read like a death ("fell
    // into the void"), not "Steve has enabled private game modifiers!".
    if (!final && !killer && !DEATH.test(text)) continue;
    victim.deaths++;
    if (final) victim.finalDeath = true;
    const k = row(killer);
    if (k && k.team !== victim.team) { k.kills++; if (final) k.finals++; }
    push({ t, kind: final ? 'final' : 'kill', victim: victim.name, team: victim.team, by: k ? k.name : null, byTeam: k ? k.team : null, firstBlood: !!k && firstBlood, text });
    if (k) firstBlood = false;
  }

  // Leavers: someone who disconnected and never came back after their bed
  // went is out (Hypixel prints no final kill for them).
  const lastLeft = new Map();
  for (const e of events) if (e.kind === 'left') lastLeft.set(lc(e.victim), e.t);
  for (const { t, text } of lines) {
    const m = String(text || '').trim().match(/^(\S+) reconnected\.?$/);
    if (m && lastLeft.has(lc(m[1])) && t > lastLeft.get(lc(m[1]))) lastLeft.delete(lc(m[1]));
  }
  for (const [n] of lastLeft) { const p = players.get(n); if (p) p.left = true; }

  // A team is out once its bed is gone and every member is out (final
  // death, or left for good), or when Hypixel says so.
  const teams = new Map();
  for (const p of players.values()) {
    if (!teams.has(p.team)) teams.set(p.team, { team: p.team, players: [], bedBrokenAt: bedGone.get(p.team) ?? null, eliminatedAt: eliminated.get(p.team) ?? null });
    teams.get(p.team).players.push(p);
  }
  for (const tm of teams.values()) {
    if (tm.eliminatedAt == null && tm.bedBrokenAt != null && tm.players.every(p => p.finalDeath || p.left)) {
      const outs = events.filter(e => (e.kind === 'final' || e.kind === 'left') && tm.players.some(p => p.name === e.victim)).map(e => e.t);
      tm.eliminatedAt = outs.length ? Math.max(...outs) : tm.bedBrokenAt;
    }
  }
  const standing = [...teams.values()].filter(tm => tm.eliminatedAt == null);
  const winner = standing.length === 1 && teams.size > 1 ? standing[0].team : null;
  const result = winner && self.team ? (winner === self.team ? 'win' : 'loss')
    : (self.team && teams.get(self.team) && teams.get(self.team).eliminatedAt != null ? 'loss' : null);

  const sortedTeams = [...teams.values()].sort((a, b) => (TEAM_ORDER.indexOf(a.team) + 99) % 99 - (TEAM_ORDER.indexOf(b.team) + 99) % 99);
  const total = (k) => [...players.values()].reduce((s, p) => s + (p[k] || 0), 0);
  return {
    v: SUMMARY_VERSION,
    startT, endT: ended ?? endT,
    self: { name: self.name || null, team: self.team || null },
    winner, result,
    totals: { kills: events.filter(e => e.kind === 'kill' || e.kind === 'final').length, finals: total('finals') || events.filter(e => e.kind === 'final').length, beds: bedGone.size },
    teams: sortedTeams.map(tm => ({
      team: tm.team, bedBrokenAt: tm.bedBrokenAt, eliminatedAt: tm.eliminatedAt,
      players: tm.players.map(p => ({ name: p.name, kills: p.kills, finals: p.finals, deaths: p.deaths, finalDeath: p.finalDeath, beds: p.beds, left: p.left }))
    })),
    events
  };
}

module.exports = { summarizeGame, SUMMARY_VERSION };
