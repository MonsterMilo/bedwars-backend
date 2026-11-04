// --- Clips: short replay files of the moments you beat a tracked player ---
// A clip is a slice of a recorded game (a ReplayMod .mcpr), saved as its
// own small file so it outlives the full replay. Two steps, both pure (no
// network or database here, so the tests run them on made-up games):
//
//   findMoments(rec, tracked)  reads the game once and lists, for each
//     tracked player, their final kill and their team's bed break by your
//     team. Each one says whether it's worth a clip: the player (or whoever
//     broke the bed) has to have been in view for most of the seconds
//     before, and close to you. Far-away or barely-loaded moments are
//     skipped, with the reason kept.
//   cutClips(rec, windows)     writes one .mcpr per window. The game before
//     the window is squeezed into time 0 as the world as it stood then (the
//     map around the moment, every entity where it was, the tab list,
//     teams and scoreboard), followed by the window's own packets.
//
// Minecraft 1.8 (protocol 47) clientbound play packets, as the Prism Proxy
// replay saver writes them.

const zlib = require('zlib');
const { unzipSync } = require('fflate');

const P = {
  KEEPALIVE: 0x00, JOIN: 0x01, CHAT: 0x02, TIME: 0x03, EQUIP: 0x04, SPAWN_POS: 0x05, HEALTH: 0x06,
  RESPAWN: 0x07, POSITION: 0x08, HELD: 0x09, ANIMATION: 0x0b, SPAWN_PLAYER: 0x0c,
  SPAWN_OBJECT: 0x0e, SPAWN_MOB: 0x0f, SPAWN_PAINTING: 0x10, SPAWN_XP: 0x11, VELOCITY: 0x12, DESTROY: 0x13,
  ENTITY: 0x14, REL_MOVE: 0x15, LOOK: 0x16, LOOK_MOVE: 0x17, TELEPORT: 0x18, HEAD_LOOK: 0x19, STATUS: 0x1a,
  ATTACH: 0x1b, METADATA: 0x1c, EFFECT_ADD: 0x1d, EFFECT_REMOVE: 0x1e, XP: 0x1f, PROPERTIES: 0x20,
  CHUNK: 0x21, MULTI_BLOCK: 0x22, BLOCK: 0x23, CHUNK_BULK: 0x26, GAME_STATE: 0x2b,
  WINDOW_ITEMS: 0x30, SET_SLOT: 0x2f, SIGN: 0x33, TILE: 0x35, PLAYER_LIST: 0x38, ABILITIES: 0x39,
  OBJECTIVE: 0x3b, SCORE: 0x3c, DISPLAY: 0x3d, TEAMS: 0x3e, CUSTOM_PAYLOAD: 0x3f, DISCONNECT: 0x40,
  DIFFICULTY: 0x41, BORDER: 0x44, COMPRESSION: 0x46, HEADER_FOOTER: 0x47, RESOURCE_PACK: 0x48, ENTITY_NBT: 0x49
};

// Window packets that never go in a clip.
const DROP_IN_WINDOW = new Set([P.KEEPALIVE, P.CUSTOM_PAYLOAD, P.DISCONNECT, P.COMPRESSION, P.RESOURCE_PACK]);
// Settings where only the newest one before the window matters.
const LATEST = [P.TIME, P.SPAWN_POS, P.DIFFICULTY, P.ABILITIES, P.HEALTH, P.XP, P.HELD, P.HEADER_FOOTER, P.POSITION];

// Private, party and guild chat never goes in a clip (same rule as the viewer).
const PRIVATE_CHAT = /^\s*(From |To |Party >|P >|Guild >|G >|Officer >|O >|Friend >|F >|\[Party\]|-{5,}|You'll be partying with|.* has (invited you|joined the party|left the party)|Party (Leader|Moderators|Members))/;

const DEFAULTS = {
  finalBeforeMs: 12000, finalAfterMs: 3000,
  bedBeforeMs: 10000, bedAfterMs: 3000,
  // "Close enough": the subject was in view for this share of the last
  // few seconds, and this near you when it happened.
  lookBackMs: 6000, minInView: 0.6, maxDistance: 40, closeMs: 3000,
  // How much map goes in a clip: chunk columns this many chunks around
  // where it happened (16 blocks each).
  radiusChunks: 7,
  // /clip: the 20 seconds before you typed it (and a moment after), and
  // who counts as in it.
  manualBeforeMs: 20000, manualAfterMs: 1000, nearBlocks: 24,
  manual: []
};

// --- Reading ---

class Reader {
  constructor(buf, pos, end) {
    this.b = buf; this.pos = pos; this.end = end;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  // Reading past the packet's end throws, so a packet we misread can't
  // run a loop forever.
  varint() { let r = 0; let s = 0; let x; do { if (this.pos >= this.end) throw new Error('past end'); x = this.b[this.pos++]; r |= (x & 0x7f) << s; s += 7; } while ((x & 0x80) && s < 35); return r; }
  u8() { if (this.pos >= this.end) throw new Error('past end'); return this.b[this.pos++]; }
  i8() { const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
  bool() { return this.b[this.pos++] !== 0; }
  i16() { const v = this.dv.getInt16(this.pos); this.pos += 2; return v; }
  u16() { const v = this.dv.getUint16(this.pos); this.pos += 2; return v; }
  i32() { const v = this.dv.getInt32(this.pos); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos); this.pos += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.pos); this.pos += 8; return v; }
  skip(n) { this.pos += n; if (this.pos > this.end) throw new Error('past end'); }
  blockPos() {
    const hi = this.dv.getInt32(this.pos); const lo = this.dv.getUint32(this.pos + 4); this.pos += 8;
    return [hi >> 6, ((hi & 0x3f) << 6) | (lo >>> 26), (lo << 6) >> 6];
  }
  uuid() { let s = ''; for (let k = 0; k < 16; k++) s += this.b[this.pos++].toString(16).padStart(2, '0'); return s; }
  str() { const n = this.varint(); const s = Buffer.from(this.b.buffer, this.b.byteOffset + this.pos, n).toString('utf8'); this.pos += n; return s; }
  skipStr() { const n = this.varint(); this.pos += n; }
  // NBT payload of one tag type, skipped.
  skipNbt(type) {
    switch (type) {
      case 1: this.pos += 1; break;
      case 2: this.pos += 2; break;
      case 3: case 5: this.pos += 4; break;
      case 4: case 6: this.pos += 8; break;
      case 7: { const n = this.i32(); this.pos += n; break; }
      case 8: { const n = this.u16(); this.pos += n; break; }
      case 9: { const t = this.u8(); const n = this.i32(); for (let k = 0; k < n; k++) this.skipNbt(t); break; }
      case 10: for (;;) { const t = this.u8(); if (t === 0) break; const n = this.u16(); this.pos += n; this.skipNbt(t); } break;
      case 11: { const n = this.i32(); this.pos += n * 4; break; }
      default: throw new Error('bad nbt');
    }
  }
  skipSlot() {
    const id = this.i16();
    if (id < 0) return;
    this.pos += 3;
    const t = this.u8();
    if (t !== 0) { const n = this.u16(); this.pos += n; this.skipNbt(t); }
  }
  // Entity metadata -> [[index, startByte, endByte]] (the raw entry bytes).
  metadataSpans() {
    const out = [];
    for (;;) {
      const at = this.pos;
      const h = this.u8();
      if (h === 0x7f) break;
      switch (h >> 5) {
        case 0: this.pos += 1; break;
        case 1: this.pos += 2; break;
        case 2: case 3: this.pos += 4; break;
        case 4: this.skipStr(); break;
        case 5: this.skipSlot(); break;
        case 6: case 7: this.pos += 12; break;
        default: return out;
      }
      out.push([h & 0x1f, at, this.pos]);
    }
    return out;
  }
}

/** Chat JSON -> plain text (colour codes removed). */
function chatText(json) {
  let c;
  try { c = JSON.parse(json); } catch { c = String(json); }
  let out = '';
  const walk = (n) => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') { out += n; return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.text) out += n.text; else if (n.translate) out += n.translate;
    if (Array.isArray(n.extra)) n.extra.forEach(walk);
  };
  walk(c);
  return out.replace(/§[0-9a-fk-or]/gi, '');
}

/**
 * Raw .mcpr bytes -> { meta, rec, n, t, id, at, body, end }:
 * for packet k, its time t[k], packet id id[k], the record start at[k]
 * (packet bytes, id included, run at[k]..end[k]) and body[k] (after the id).
 */
function readRecording(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    filter: f => f.name === 'recording.tmcpr' || f.name === 'metaData.json'
  });
  const rec = files['recording.tmcpr'];
  if (!rec) throw new Error('No recording.tmcpr in the file');
  let meta = {};
  try { meta = JSON.parse(Buffer.from(files['metaData.json']).toString('utf8')); } catch { /* optional */ }
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  let n = 0;
  for (let i = 0; i + 8 <= rec.length;) { const len = dv.getInt32(i + 4); if (len < 0 || i + 8 + len > rec.length) break; i += 8 + len; n++; }
  const t = new Int32Array(n); const id = new Int32Array(n); const at = new Int32Array(n); const body = new Int32Array(n); const end = new Int32Array(n);
  let i = 0;
  for (let k = 0; k < n; k++) {
    t[k] = dv.getInt32(i); const len = dv.getInt32(i + 4); i += 8;
    const r = new Reader(rec, i, i + len);
    at[k] = i; id[k] = r.varint(); body[k] = r.pos; end[k] = i + len;
    i += len;
  }
  return { meta, rec, n, t, id, at, body, end };
}

// --- Bed Wars bits ---

// Teams are named like "Red8"; eliminated players get moved to other teams
// later, so a player keeps the first Bed Wars team they're put in.
const TEAM_RE = /^(Red|Blue|Green|Yellow|Aqua|White|Pink|Gr[ae]y)\d*$/i;
const teamLabel = (name) => { const m = String(name || '').match(TEAM_RE); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase().replace('grey', 'gray') : null; };
// Hypixel's NPCs are player entities with version-2 uuids.
const isNpc = (uuid) => uuid && uuid[12] === '2';

const lc = (s) => String(s || '').toLowerCase();

/** Fixed-point (1/32 block) position of an entity, or null. */
class Pos { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }

/**
 * Every final kill and bed break in the game, with who was involved and
 * where people were, then which of them are clips for the tracked players.
 * tracked: [{ uuid, username, nick? }] (uuid without dashes).
 * Returns { self: { name, team }, moments: [...] }, each moment
 * { kind: 'final'|'bed', t, uuid, username, victim, team, by, ok, reason,
 *   inView, distance, focus: {x,y,z}, follow }.
 */
function findMoments(recording, tracked, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { rec, n, t: T, id: ID, body: B, end: E, meta } = recording;
  const names = new Map();        // tab uuid -> name
  const teamOf = new Map();       // name -> 'Red'
  const live = new Map();         // eid -> { uuid, pos }
  const uuidEid = new Map();      // uuid -> eid (newest)
  const samples = new Map();      // uuid -> [{ t, x, y, z, gone }]
  const events = [];
  let selfId = meta && meta.selfId != null ? meta.selfId : null;
  let dimension = 0;
  let sidebarTeam = null;
  const selfMoves = [];           // where the server put you (0x08), for old recordings

  const sample = (uuid, t, pos, gone = false) => {
    let list = samples.get(uuid);
    if (!list) samples.set(uuid, list = []);
    const last = list[list.length - 1];
    if (last && !gone && !last.gone && t - last.t < 200) { last.x = pos.x / 32; last.y = pos.y / 32; last.z = pos.z / 32; return; }
    list.push({ t, x: pos ? pos.x / 32 : 0, y: pos ? pos.y / 32 : 0, z: pos ? pos.z / 32 : 0, gone });
  };

  for (let k = 0; k < n; k++) {
    const id = ID[k];
    if (id !== P.CHAT && id !== P.JOIN && id !== P.POSITION && id !== P.SPAWN_PLAYER && id !== P.REL_MOVE && id !== P.LOOK_MOVE &&
        id !== P.TELEPORT && id !== P.DESTROY && id !== P.PLAYER_LIST && id !== P.TEAMS && id !== P.RESPAWN) continue;
    const t = T[k];
    const r = new Reader(rec, B[k], E[k]);
    try {
      switch (id) {
        case P.JOIN: { const eid = r.i32(); r.u8(); dimension = r.i8(); if (selfId == null) selfId = eid; break; }
        case P.POSITION: {
          const x = r.f64(); const y = r.f64(); const z = r.f64(); r.f32(); r.f32(); const rel = r.i8();
          if (!rel) selfMoves.push({ t, x, y, z });
          break;
        }
        case P.RESPAWN: {
          // A new dimension is a new world: everyone seen so far is gone.
          const dim = r.i32();
          if (dim === dimension) break;
          dimension = dim;
          for (const [eid, e] of live) if (eid !== selfId) sample(e.uuid, t, null, true);
          for (const eid of [...live.keys()]) if (eid !== selfId) live.delete(eid);
          break;
        }
        case P.SPAWN_PLAYER: {
          const eid = r.varint(); const uuid = r.uuid();
          const pos = new Pos(r.i32(), r.i32(), r.i32());
          if (isNpc(uuid)) break;
          live.set(eid, { uuid, pos }); uuidEid.set(uuid, eid);
          sample(uuid, t, pos);
          break;
        }
        case P.REL_MOVE: case P.LOOK_MOVE: {
          const e = live.get(r.varint()); if (!e) break;
          e.pos.x += r.i8(); e.pos.y += r.i8(); e.pos.z += r.i8();
          sample(e.uuid, t, e.pos);
          break;
        }
        case P.TELEPORT: {
          const e = live.get(r.varint()); if (!e) break;
          e.pos.x = r.i32(); e.pos.y = r.i32(); e.pos.z = r.i32();
          sample(e.uuid, t, e.pos);
          break;
        }
        case P.DESTROY: {
          const cnt = r.varint();
          for (let q = 0; q < cnt; q++) { const eid = r.varint(); const e = live.get(eid); if (e) { sample(e.uuid, t, e.pos, true); live.delete(eid); } }
          break;
        }
        case P.PLAYER_LIST: {
          const action = r.varint(); const cnt = r.varint();
          if (action !== 0) break;
          for (let q = 0; q < cnt; q++) {
            const u = r.uuid(); const name = r.str(); const np = r.varint();
            for (let w = 0; w < np; w++) { r.skipStr(); r.skipStr(); if (r.bool()) r.skipStr(); }
            r.varint(); r.varint(); if (r.bool()) r.skipStr();
            if (!isNpc(u)) names.set(u, name);
          }
          break;
        }
        case P.TEAMS: {
          const name = r.str(); const mode = r.i8();
          if (mode === 0 || mode === 2) {
            // The sidebar marks your team: "R Red: ✓ YOU".
            r.skipStr(); const line = (r.str() + r.str()).replace(/§[0-9a-fk-or]/gi, '');
            const you = line.match(/\b(Red|Blue|Green|Yellow|Aqua|White|Pink|Gr[ae]y)\b.*\bYOU\b/i);
            if (you) sidebarTeam = teamLabel(you[1]);
            r.i8(); r.skipStr(); r.i8();
          }
          if ((mode === 0 || mode === 3) && teamLabel(name)) {
            const cnt = r.varint();
            for (let q = 0; q < cnt; q++) { const p = r.str(); if (!teamOf.has(lc(p))) teamOf.set(lc(p), teamLabel(name)); }
          }
          break;
        }
        case P.CHAT: {
          const json = r.str(); const pos = r.pos < r.end ? r.i8() : 0;
          if (pos === 2) break;
          const text = chatText(json).trim();
          if (!text || PRIVATE_CHAT.test(text)) break;
          if (/FINAL KILL!\s*$/.test(text)) events.push({ kind: 'final', t, text });
          else if (/^BED DESTRUCTION\s*>/.test(text)) events.push({ kind: 'bed', t, text });
          break;
        }
      }
    } catch { /* one odd packet doesn't stop the rest */ }
  }

  // Who the recording player is: the spawned entity with the join's id, or
  // the tab entry whose name the metadata lists.
  let selfUuid = null;
  for (const [u, eid] of uuidEid) if (eid === selfId) selfUuid = u;
  let selfName = selfUuid ? names.get(selfUuid) || null : null;
  const selfTeam = (selfName && teamOf.get(lc(selfName))) || sidebarTeam || null;
  // Older recordings don't have you as an entity: you're the one on your
  // team who never shows up (you never see yourself).
  if (!selfName && selfTeam) {
    const spawned = new Set(uuidEid.keys());
    const unseen = [...names].filter(([u, nm]) => teamOf.get(lc(nm)) === selfTeam && !spawned.has(u));
    if (unseen.length === 1) { selfUuid = unseen[0][0]; selfName = unseen[0][1]; }
  }
  const selfSeen = selfUuid && samples.has(selfUuid);
  const allNames = [...new Set(names.values())].sort((a, b) => b.length - a.length);

  // A name mentioned in a chat line (longest names first, whole words).
  const nameIn = (text, skip) => {
    for (const nm of allNames) {
      if (skip && lc(nm) === lc(skip)) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${nm.replace(/[^A-Za-z0-9_]/g, '')}([^A-Za-z0-9_]|$)`);
      if (re.test(text)) return nm;
    }
    return null;
  };
  const uuidOfName = (nm) => { for (const [u, n2] of names) if (lc(n2) === lc(nm)) return u; return null; };

  // Where someone was at time t (their last sample at or before t, unless
  // they had gone out of view), and how much of [from, t] they were in view.
  const at = (uuid, time) => {
    const list = samples.get(uuid); if (!list) return null;
    let s = null;
    for (const x of list) { if (x.t > time) break; s = x; }
    return s && !s.gone ? s : null;
  };
  const inView = (uuid, from, to) => {
    const list = samples.get(uuid); if (!list || !list.length) return 0;
    let seen = 0; let since = null;
    for (const x of list) {
      if (x.t > to) break;
      if (!x.gone && since == null) since = Math.max(from, x.t);
      if (x.gone && since != null) { if (x.t > from) seen += x.t - since; since = null; }
    }
    if (since != null) seen += to - Math.max(from, since);
    return Math.max(0, Math.min(1, seen / Math.max(1, to - from)));
  };
  // Across the ground only: someone knocked into the void falls a long way
  // straight down from where the fight was.
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  // How close you got to someone in the few seconds before t.
  const closest = (uuid, time) => {
    let best = null;
    for (let tt = time - o.closeMs; tt <= time; tt += 250) {
      const a = at(selfUuid, tt) || lastSeen(selfUuid, tt); const b = at(uuid, tt);
      if (a && b) { const d = flat(a, b); if (best == null || d < best) best = d; }
    }
    return best;
  };

  // Tracked players by name, as they showed in this game (a nicked player
  // is listed under the name they had, or matched by their uuid).
  const want = new Map();
  for (const p of tracked || []) {
    const u = String(p.uuid || '').replace(/-/g, '').toLowerCase();
    const inGame = names.get(u);
    if (inGame) want.set(lc(inGame), { uuid: u, username: p.username, name: inGame });
    if (p.username && !want.has(lc(p.username))) want.set(lc(p.username), { uuid: u, username: p.username, name: p.username });
    if (p.nick && !want.has(lc(p.nick))) want.set(lc(p.nick), { uuid: u, username: p.username, name: p.nick });
  }

  // With no idea who you are, any named killer counts and only the in-view
  // rule applies.
  const ours = (who) => !!who && ((!selfName && !selfTeam) || lc(who) === lc(selfName) || (!!selfTeam && teamOf.get(lc(who)) === selfTeam));
  const moments = [];
  for (const ev of events) {
    if (ev.kind === 'final') {
      const victim = ev.text.split(/\s+/)[0].replace(/[^A-Za-z0-9_]/g, '');
      const p = want.get(lc(victim));
      if (!p) continue;
      const by = nameIn(ev.text.slice(victim.length), victim);
      const vu = uuidOfName(victim);
      moments.push(judge({ kind: 'final', t: ev.t, uuid: p.uuid, username: p.username, victim, team: teamOf.get(lc(victim)) || null, by, text: ev.text }, vu));
    } else {
      // "BED DESTRUCTION > Red Bed was destroyed by Steve!" (bed-break
      // cosmetics change the verb, never the start).
      const m = ev.text.match(/>\s*(\w+) Bed\b/);
      const team = m ? (m[1] === 'Your' ? selfTeam : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : null;
      if (!team) continue;
      const by = nameIn(ev.text.slice(ev.text.indexOf('Bed') + 3));
      for (const [nm, p] of want) {
        if (teamOf.get(nm) !== team) continue;
        if (moments.some(x => x.kind === 'bed' && x.t === ev.t && x.uuid === p.uuid)) continue;
        moments.push(judge({ kind: 'bed', t: ev.t, uuid: p.uuid, username: p.username, victim: p.name, team, by, text: ev.text }, by ? uuidOfName(by) : null));
      }
    }
  }

  // Is it worth a clip? The subject (the victim, or the bed breaker) has to
  // have been in view most of the last few seconds and near you, and the
  // kill or break has to be your team's.
  function judge(m, subjectUuid) {
    const lookFrom = m.t - o.lookBackMs;
    const selfAt = selfSeen ? at(selfUuid, m.t) || lastSeen(selfUuid, m.t) : serverPlaced(m.t);
    const subj = subjectUuid ? lastSeen(subjectUuid, m.t) : null;
    const share = subjectUuid ? inView(subjectUuid, lookFrom, m.t) : 0;
    const d = subjectUuid === selfUuid && subjectUuid ? 0 : selfSeen && subjectUuid ? closest(subjectUuid, m.t) : null;
    const out = { ...m, inView: Math.round(share * 100) / 100, distance: d == null ? null : Math.round(d), focus: subj ? { x: subj.x, y: subj.y, z: subj.z } : (selfAt ? { x: selfAt.x, y: selfAt.y, z: selfAt.z } : null), follow: m.kind === 'final' ? m.victim : (m.by || null) };
    if (selfTeam && m.team === selfTeam) return { ...out, ok: false, reason: 'teammate' };
    if (!ours(m.by)) return { ...out, ok: false, reason: m.by ? 'not your team' : 'no killer' };
    if (subjectUuid && subjectUuid === selfUuid) return { ...out, ok: true, reason: null };
    if (!subjectUuid || share < o.minInView) return { ...out, ok: false, reason: 'not in view' };
    // Your own kills only need the player in view (a bow shot from afar).
    if (d != null && d > o.maxDistance && lc(m.by) !== lc(selfName)) return { ...out, ok: false, reason: 'too far' };
    if (!out.focus) return { ...out, ok: false, reason: 'not in view' };
    return { ...out, ok: true, reason: null };
  }
  // Old recordings: where the server last put you (spawns, respawns).
  function serverPlaced(time) {
    let s = null;
    for (const x of selfMoves) { if (x.t > time) break; s = x; }
    return s && time - s.t < 10000 ? s : null;
  }
  // Last place someone was seen at or before t (even if they then went out
  // of view, e.g. dying).
  function lastSeen(uuid, time) {
    const list = samples.get(uuid); if (!list) return null;
    let s = null;
    for (const x of list) { if (x.t > time) break; if (!x.gone) s = x; }
    return s;
  }

  // /clip in game: the last 20 seconds before the moment you typed it,
  // with everyone who came near you in them (they're who it's about).
  for (const atMs of o.manual || []) {
    const t = Math.round(Number(atMs));
    if (!Number.isFinite(t) || t < 0) continue;
    const from = t - o.manualBeforeMs;
    const people = [];
    if (selfSeen) {
      for (const [u, nm] of names) {
        if (u === selfUuid || !samples.has(u)) continue;
        let near = false;
        for (let tt = Math.max(0, from); tt <= t && !near; tt += 250) {
          const a = at(selfUuid, tt); const b = at(u, tt);
          if (a && b && flat(a, b) <= o.nearBlocks) near = true;
        }
        if (near) people.push({ uuid: u, name: nm, team: teamOf.get(lc(nm)) || null });
      }
    }
    const me = selfSeen ? at(selfUuid, t) || lastSeen(selfUuid, t) : serverPlaced(t);
    // Opponents first: they're who a clip is usually about.
    people.sort((a, b) => (a.team === selfTeam) - (b.team === selfTeam));
    moments.push({ kind: 'manual', t, uuid: null, username: null, victim: null, team: null, by: selfName, people,
      ok: true, reason: null, inView: null, distance: null, focus: me ? { x: me.x, y: me.y, z: me.z } : null, follow: selfName });
  }

  return { self: { name: selfName, team: selfTeam, uuid: selfUuid }, moments };
}

// --- Writing ---

function varintBytes(v) { const out = []; v >>>= 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return out; }

/** Packet bytes (id included) from an id and a body built by fn(w). */
function packet(id, fn) {
  const parts = []; let len = 0;
  const w = {
    raw(bytes) { parts.push(bytes); len += bytes.length; },
    varint(v) { this.raw(Uint8Array.from(varintBytes(v))); },
    i8(v) { this.raw(Uint8Array.of(v & 0xff)); },
    bool(v) { this.raw(Uint8Array.of(v ? 1 : 0)); },
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.raw(b); }
  };
  w.varint(id);
  fn(w);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The world as it stands, kept as raw packets so it can be written out. */
class WorldState {
  constructor(rec) {
    this.rec = rec;
    this.join = null; this.respawn = null; this.dimension = 0;
    this.latest = new Map();       // packet id -> bytes
    this.gameState = new Map();    // reason -> bytes
    this.border = [];
    this.columns = new Map();      // 'x,z' -> { x, z, chunk, changes: [], tiles: Map }
    this.entities = new Map();     // eid -> entity
    this.tab = new Map();          // uuid -> { add, mode, display, present }
    this.teams = new Map();        // name -> [bytes]
    this.objectives = new Map();   // name -> bytes
    this.displays = new Map();     // slot -> bytes
    this.scores = new Map();       // item\0objective -> bytes
    this.inventory = null; this.slots = [];
  }

  slice(a, b) { return this.rec.subarray(a, b); }

  apply(id, at, bodyAt, end) {
    const rec = this.rec;
    const raw = rec.subarray(at, end);
    const r = new Reader(rec, bodyAt, end);
    switch (id) {
      case P.JOIN: {
        if (!this.join) { this.join = raw; r.i32(); r.u8(); this.dimension = r.i8(); }
        return;
      }
      case P.RESPAWN: {
        const dim = r.i32();
        if (dim !== this.dimension) { this.columns.clear(); this.entities.clear(); }
        this.dimension = dim; this.respawn = raw;
        return;
      }
      case P.GAME_STATE: this.gameState.set(r.u8(), raw); return;
      case P.BORDER: { const action = r.varint(); if (action === 3) this.border = []; this.border.push(raw); return; }
      case P.WINDOW_ITEMS: if (r.u8() === 0) { this.inventory = raw; this.slots = []; } return;
      case P.SET_SLOT: { const w = r.i8(); if (w === 0) { this.slots.push(raw); if (this.slots.length > 64) this.slots.shift(); } return; }
      case P.CHUNK: {
        const cx = r.i32(); const cz = r.i32(); const full = r.bool(); const mask = r.u16();
        const key = cx + ',' + cz;
        if (full && mask === 0) return; // unload: keep the last copy, so the map stays whole
        if (full) this.columns.set(key, { x: cx, z: cz, chunk: raw, changes: [], tiles: new Map() });
        else { const c = this.columns.get(key); if (c) c.changes.push(raw); }
        return;
      }
      case P.CHUNK_BULK: {
        const sky = r.bool(); const cnt = r.varint();
        const heads = [];
        for (let q = 0; q < cnt; q++) heads.push([r.i32(), r.i32(), r.u16()]);
        for (const [cx, cz, mask] of heads) {
          let sections = 0; for (let b = mask; b; b &= b - 1) sections++;
          const size = sections * (8192 + 2048 + (sky ? 2048 : 0)) + 256;
          const data = rec.subarray(r.pos, r.pos + size); r.skip(size);
          const chunk = packet(P.CHUNK, w => { w.i32(cx); w.i32(cz); w.bool(true); w.raw(Uint8Array.of(mask >> 8, mask & 0xff)); w.varint(size); w.raw(data); });
          this.columns.set(cx + ',' + cz, { x: cx, z: cz, chunk, changes: [], tiles: new Map() });
        }
        return;
      }
      case P.MULTI_BLOCK: { const c = this.columns.get(r.i32() + ',' + r.i32()); if (c) c.changes.push(raw); return; }
      case P.BLOCK: {
        const [x, , z] = r.blockPos();
        const c = this.columns.get((x >> 4) + ',' + (z >> 4)); if (c) c.changes.push(raw);
        return;
      }
      case P.TILE: case P.SIGN: {
        const [x, y, z] = r.blockPos();
        const c = this.columns.get((x >> 4) + ',' + (z >> 4)); if (c) c.tiles.set(id + ':' + x + ',' + y + ',' + z, raw);
        return;
      }
      case P.SPAWN_PLAYER: {
        const eid = r.varint(); const uuid = r.uuid(); const x = r.i32(); const y = r.i32(); const z = r.i32(); const yaw = r.i8(); const pitch = r.i8();
        this.entities.set(eid, this.newEntity(raw, { uuid, x, y, z, yaw, pitch }));
        return;
      }
      case P.SPAWN_OBJECT: {
        const eid = r.varint(); r.i8(); const x = r.i32(); const y = r.i32(); const z = r.i32(); const pitch = r.i8(); const yaw = r.i8();
        this.entities.set(eid, this.newEntity(raw, { x, y, z, yaw, pitch }));
        return;
      }
      case P.SPAWN_MOB: {
        const eid = r.varint(); r.u8(); const x = r.i32(); const y = r.i32(); const z = r.i32(); const yaw = r.i8(); const pitch = r.i8();
        this.entities.set(eid, this.newEntity(raw, { x, y, z, yaw, pitch }));
        return;
      }
      case P.SPAWN_PAINTING: { const eid = r.varint(); this.entities.set(eid, this.newEntity(raw, { fixed: true })); return; }
      case P.SPAWN_XP: { const eid = r.varint(); this.entities.set(eid, this.newEntity(raw, { x: r.i32(), y: r.i32(), z: r.i32(), yaw: 0, pitch: 0 })); return; }
      case P.DESTROY: { const cnt = r.varint(); for (let q = 0; q < cnt; q++) this.entities.delete(r.varint()); return; }
      case P.REL_MOVE: case P.LOOK_MOVE: case P.LOOK: {
        const e = this.entities.get(r.varint()); if (!e || e.fixed) return;
        if (id !== P.LOOK) { e.x += r.i8(); e.y += r.i8(); e.z += r.i8(); }
        if (id !== P.REL_MOVE) { e.yaw = r.i8(); e.pitch = r.i8(); }
        e.onGround = r.pos < r.end ? r.bool() : e.onGround;
        return;
      }
      case P.TELEPORT: {
        const e = this.entities.get(r.varint()); if (!e || e.fixed) return;
        e.x = r.i32(); e.y = r.i32(); e.z = r.i32(); e.yaw = r.i8(); e.pitch = r.i8(); e.onGround = r.pos < r.end ? r.bool() : e.onGround;
        return;
      }
      case P.HEAD_LOOK: { const e = this.entities.get(r.varint()); if (e) e.head = raw; return; }
      case P.VELOCITY: { const e = this.entities.get(r.varint()); if (e) e.velocity = raw; return; }
      case P.PROPERTIES: { const e = this.entities.get(r.varint()); if (e) e.props = raw; return; }
      case P.ATTACH: { const e = this.entities.get(r.i32()); if (e) e.attach = raw; return; }
      case P.EQUIP: { const e = this.entities.get(r.varint()); if (e) e.equip.set(r.i16(), raw); return; }
      case P.EFFECT_ADD: { const e = this.entities.get(r.varint()); if (e) e.effects.set(r.i8(), raw); return; }
      case P.EFFECT_REMOVE: { const e = this.entities.get(r.varint()); if (e) e.effects.delete(r.i8()); return; }
      case P.METADATA: {
        const e = this.entities.get(r.varint()); if (!e) return;
        for (const [idx, a, b] of r.metadataSpans()) e.meta.set(idx, rec.subarray(a, b));
        return;
      }
      case P.PLAYER_LIST: {
        const action = r.varint(); const cnt = r.varint();
        for (let q = 0; q < cnt; q++) {
          const start = r.pos; const u = r.uuid();
          let row = this.tab.get(u);
          if (action === 0) {
            r.skipStr(); const np = r.varint();
            for (let w = 0; w < np; w++) { r.skipStr(); r.skipStr(); if (r.bool()) r.skipStr(); }
            r.varint(); r.varint(); if (r.bool()) r.skipStr();
            this.tab.set(u, row = { add: rec.subarray(start, r.pos), mode: null, display: null, present: true });
          } else if (action === 1) { r.varint(); if (row) row.mode = rec.subarray(start, r.pos); }
          else if (action === 2) r.varint();
          else if (action === 3) { if (r.bool()) r.skipStr(); if (row) row.display = rec.subarray(start, r.pos); }
          else if (action === 4) { if (row) row.present = false; }
        }
        return;
      }
      case P.TEAMS: {
        // Kept as: the creating packet, the newest settings change, and who
        // is in it now (Hypixel re-adds the same player every second).
        const name = r.str(); const mode = r.i8();
        if (mode === 1) { this.teams.delete(name); return; }
        if (mode === 0) {
          r.skipStr(); r.skipStr(); r.skipStr(); r.i8(); r.skipStr(); r.i8();
          const first = new Set(); const cnt = r.varint();
          for (let q = 0; q < cnt; q++) first.add(r.str());
          this.teams.set(name, { create: raw, update: null, first, members: new Set(first) });
          return;
        }
        const team = this.teams.get(name); if (!team) return;
        if (mode === 2) { team.update = raw; return; }
        const cnt = r.varint();
        for (let q = 0; q < cnt; q++) { const p = r.str(); if (mode === 3) team.members.add(p); else if (mode === 4) team.members.delete(p); }
        return;
      }
      case P.OBJECTIVE: {
        const name = r.str(); const mode = r.i8();
        if (mode === 1) { this.objectives.delete(name); for (const k of [...this.scores.keys()]) if (k.endsWith('\0' + name)) this.scores.delete(k); } else this.objectives.set(name, raw);
        return;
      }
      case P.DISPLAY: this.displays.set(r.i8(), raw); return;
      case P.SCORE: {
        const item = r.str(); const action = r.i8(); const obj = r.str();
        if (action === 1) this.scores.delete(item + '\0' + obj); else this.scores.set(item + '\0' + obj, raw);
        return;
      }
      default:
        if (LATEST.includes(id)) this.latest.set(id, raw);
    }
  }

  newEntity(spawn, f) {
    return { spawn, x: f.x | 0, y: f.y | 0, z: f.z | 0, yaw: f.yaw | 0, pitch: f.pitch | 0, onGround: true, fixed: !!f.fixed, uuid: f.uuid || null,
      head: null, velocity: null, props: null, attach: null, equip: new Map(), effects: new Map(), meta: new Map() };
  }

  /** The world right now as packets, in the order a client needs them. */
  snapshot(focus, radiusChunks) {
    const out = [];
    if (this.join) out.push(this.join);
    if (this.respawn) out.push(this.respawn);
    for (const id of [P.DIFFICULTY, P.SPAWN_POS, P.ABILITIES, P.TIME]) if (this.latest.has(id)) out.push(this.latest.get(id));
    for (const b of this.gameState.values()) out.push(b);
    out.push(...this.border);
    if (this.latest.has(P.POSITION)) out.push(this.latest.get(P.POSITION));
    for (const id of [P.HEALTH, P.XP, P.HELD]) if (this.latest.has(id)) out.push(this.latest.get(id));
    if (this.inventory) out.push(this.inventory, ...this.slots);
    // The map around the moment.
    const fx = focus ? Math.floor(focus.x) >> 4 : null; const fz = focus ? Math.floor(focus.z) >> 4 : null;
    for (const c of this.columns.values()) {
      if (focus && Math.max(Math.abs(c.x - fx), Math.abs(c.z - fz)) > radiusChunks) continue;
      out.push(c.chunk, ...c.changes, ...c.tiles.values());
    }
    // Tab list first: a client can't spawn a player it has no tab entry for
    // (Hypixel's NPCs are added, spawned, then taken off the list).
    const spawnedUuids = new Set([...this.entities.values()].map(e => e.uuid).filter(Boolean));
    const rows = [...this.tab.entries()].filter(([u, row]) => row.present || spawnedUuids.has(u));
    if (rows.length) out.push(packet(P.PLAYER_LIST, w => { w.varint(0); w.varint(rows.length); for (const [, row] of rows) w.raw(row.add); }));
    const modes = rows.filter(([, row]) => row.mode && row.present);
    if (modes.length) out.push(packet(P.PLAYER_LIST, w => { w.varint(1); w.varint(modes.length); for (const [, row] of modes) w.raw(row.mode); }));
    const shown = rows.filter(([, row]) => row.display && row.present);
    if (shown.length) out.push(packet(P.PLAYER_LIST, w => { w.varint(3); w.varint(shown.length); for (const [, row] of shown) w.raw(row.display); }));
    for (const [name, team] of this.teams) {
      out.push(team.create);
      if (team.update) out.push(team.update);
      const gone = [...team.first].filter(p => !team.members.has(p));
      const added = [...team.members].filter(p => !team.first.has(p));
      const names = (w, list) => { w.varint(list.length); for (const p of list) { const b = Buffer.from(p, 'utf8'); w.varint(b.length); w.raw(b); } };
      const str = (w, v) => { const b = Buffer.from(v, 'utf8'); w.varint(b.length); w.raw(b); };
      if (gone.length) out.push(packet(P.TEAMS, w => { str(w, name); w.i8(4); names(w, gone); }));
      if (added.length) out.push(packet(P.TEAMS, w => { str(w, name); w.i8(3); names(w, added); }));
    }
    for (const b of this.objectives.values()) out.push(b);
    for (const b of this.displays.values()) out.push(b);
    for (const b of this.scores.values()) out.push(b);
    // Every entity, then moved to where it is now.
    for (const [eid, e] of this.entities) {
      out.push(e.spawn);
      if (!e.fixed) out.push(packet(P.TELEPORT, w => { w.varint(eid); w.i32(e.x); w.i32(e.y); w.i32(e.z); w.i8(e.yaw); w.i8(e.pitch); w.bool(e.onGround); }));
      if (e.head) out.push(e.head);
      if (e.meta.size) out.push(packet(P.METADATA, w => { w.varint(eid); for (const b of e.meta.values()) w.raw(b); w.raw(Uint8Array.of(0x7f)); }));
      out.push(...e.equip.values(), ...e.effects.values());
      if (e.props) out.push(e.props);
      if (e.attach) out.push(e.attach);
      if (e.velocity) out.push(e.velocity);
    }
    const hiddenRows = [...this.tab.entries()].filter(([u, row]) => !row.present && spawnedUuids.has(u));
    if (hiddenRows.length) out.push(packet(P.PLAYER_LIST, w => { w.varint(4); w.varint(hiddenRows.length); for (const [u] of hiddenRows) w.raw(Buffer.from(u, 'hex')); }));
    if (this.latest.has(P.HEADER_FOOTER)) out.push(this.latest.get(P.HEADER_FOOTER));
    return out;
  }
}

function isPrivateChat(rec, bodyAt, end) {
  try {
    const r = new Reader(rec, bodyAt, end);
    const json = r.str(); const pos = r.pos < r.end ? r.i8() : 0;
    if (pos === 2) return false;
    return PRIVATE_CHAT.test(chatText(json).trim());
  } catch { return false; }
}

/**
 * A zip (what .mcpr files are) of { name: bytes }, deflated by Node's zlib.
 * (fflate's zip deflate stalls on big runs of chunk data.)
 */
function zipFiles(files) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = zlib.crc32(raw) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, packed);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dirSize, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...central, end]));
}

/** Packets -> recording.tmcpr bytes. items: [[t, Uint8Array]] */
function writeRecording(items) {
  let len = 0;
  for (const [, b] of items) len += 8 + b.length;
  const out = new Uint8Array(len); const dv = new DataView(out.buffer);
  let o = 0;
  for (const [t, b] of items) { dv.setInt32(o, t); dv.setInt32(o + 4, b.length); out.set(b, o + 8); o += 8 + b.length; }
  return out;
}

/**
 * One .mcpr per window. windows: [{ from, to, focus: {x,y,z}|null,
 * marker: 'Final kill' }] in replay ms. Returns [{ bytes, durationMs }].
 */
function cutClips(recording, windows, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { rec, n, t: T, id: ID, at: A, body: B, end: E, meta } = recording;
  const order = windows.map((w, i) => ({ ...w, i, from: Math.max(0, Math.round(w.from)), to: Math.round(w.to) })).sort((a, b) => a.from - b.from);
  const results = new Array(windows.length);
  const state = new WorldState(rec);
  const open = [];
  let next = 0;
  const startWindow = (w) => {
    const items = state.snapshot(w.focus, o.radiusChunks).map(b => [0, b]);
    open.push({ w, items });
  };
  const finish = (x) => {
    const durationMs = x.w.to - x.w.from;
    const tmcpr = writeRecording(x.items);
    const m = { ...(meta || {}), duration: durationMs, date: (Number(meta && meta.date) || 0) + x.w.from };
    m.generator = 'Prism Proxy (clip)';
    const files = { 'recording.tmcpr': tmcpr, 'metaData.json': Buffer.from(JSON.stringify(m)) };
    if (x.w.marker) files['markers.json'] = Buffer.from(JSON.stringify([{ realTimestamp: Math.max(0, Math.round(x.w.markAt - x.w.from)), value: { name: x.w.marker } }]));
    results[x.w.i] = { bytes: zipFiles(files), durationMs };
  };
  for (let k = 0; k < n; k++) {
    const t = T[k]; const id = ID[k];
    while (next < order.length && order[next].from <= t) startWindow(order[next++]);
    for (let q = open.length - 1; q >= 0; q--) if (t > open[q].w.to) { finish(open[q]); open.splice(q, 1); }
    if (open.length && !DROP_IN_WINDOW.has(id) && !(id === P.CHAT && isPrivateChat(rec, B[k], E[k]))) {
      const raw = rec.subarray(A[k], E[k]);
      for (const x of open) x.items.push([t - x.w.from, raw]);
    }
    try { state.apply(id, A[k], B[k], E[k]); } catch { /* skip an odd packet */ }
    if (next >= order.length && !open.length) break;
  }
  while (next < order.length) startWindow(order[next++]);
  for (const x of open) finish(x);
  return results;
}

/** Windows for the moments that passed, ready for cutClips. */
function windowsFor(moments, options = {}) {
  const o = { ...DEFAULTS, ...options };
  return moments.filter(m => m.ok).map(m => {
    const [before, after, marker] = m.kind === 'final' ? [o.finalBeforeMs, o.finalAfterMs, 'Final kill']
      : m.kind === 'bed' ? [o.bedBeforeMs, o.bedAfterMs, 'Bed break'] : [o.manualBeforeMs, o.manualAfterMs, 'Clip'];
    return { from: m.t - before, to: m.t + after, focus: m.focus, markAt: m.t, marker };
  });
}

module.exports = { readRecording, findMoments, cutClips, windowsFor, chatText, DEFAULTS, P, packet, writeRecording, zipFiles };
