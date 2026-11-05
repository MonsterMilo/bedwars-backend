// --- Prism Atlas: whole Bed Wars maps, rebuilt from recorded games ---
// Pure functions (no database, no network), used by atlas.js and its worker.
//
// What a recording shows (checked on real games, 2026-11-04): Hypixel sends
// the whole map while everyone waits in the pre-game lobby, before anyone can
// touch it. At the start ("Protect your bed and destroy the enemy beds"),
// in the same second, it
//   - removes the waiting lobby floating above the middle (always the same
//     877 blocks), and
//   - adds each team's island topper (a cosmetic someone picked).
// Chunks sent later in the game are the empty void around the map.
//
// So a game's "capture" is the map as it stood just before the start, with
// only the blocks that turned to air at the start taken away (the lobby);
// everything added then (toppers) and everything players do later is left
// out. A chunk first seen after the start (an edge of a map too big for the
// lobby's view, or a recording that began mid-game) is kept as a fallback,
// marked as such, because it may hold player blocks.
//
// Several captures of one map merge chunk by chunk: a pre-game chunk beats
// a later one, and between equals the newest game wins (Hypixel sometimes
// rebuilds a map).

const zlib = require('zlib');
const stream = require('./tmcpr-stream');

const FORMAT = 1;           // the map file layout below
const MAGIC = 'PATL';
const SECTION = 4096;       // blocks in a 16x16x16 section
// Biggest map file unpacked (a whole map is ~1-3 MB).
const MAX_MAP = 64 * 1024 * 1024;
const START_WINDOW_MS = { before: 1000, after: 1500 };
// Column kinds, best first.
const KIND = { pregame: 0, start: 1, midgame: 2 };
const KIND_NAMES = ['pregame', 'start', 'midgame'];

// --- Protocol 47 reading ---
function varint(b, pos) {
  let r = 0; let s = 0; let x;
  do { x = b[pos.i++]; r |= (x & 0x7f) << s; s += 7; } while ((x & 0x80) && s < 35);
  return r;
}
function str(b, pos) {
  const n = varint(b, pos);
  const s = b.toString('utf8', pos.i, pos.i + n);
  pos.i += n;
  return s;
}
function blockPos(b, pos) {
  const hi = b.readInt32BE(pos.i); const lo = b.readUInt32BE(pos.i + 4); pos.i += 8;
  return [hi >> 6, ((hi & 0x3f) << 6) | (lo >>> 26), (lo << 6) >> 6];
}
/** Plain text of a chat JSON message. */
function chatText(json) {
  let c;
  try { c = JSON.parse(json); } catch { return String(json); }
  let out = '';
  const walk = (n) => {
    if (n == null) return;
    if (typeof n === 'string') { out += n; return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.text) out += n.text;
    if (n.extra) n.extra.forEach(walk);
  };
  walk(c);
  return out.replace(/§./g, '');
}

const START_RE = /Protect your bed and destroy the enemy beds/;
const colKey = (x, z) => x + ',' + z;

/**
 * One recorded game -> its capture:
 * { map, mode, server, startedAt, columns: Map(key -> { x, z, kind, sections[16] }) }
 * sections are Uint16Array(4096) of (block id << 4 | meta), or null.
 */
function extractCapture(mcprBytes) {
  const zip = Buffer.isBuffer(mcprBytes) ? mcprBytes : Buffer.from(mcprBytes);
  // Read piece by piece (tmcpr-stream.js): the recording is never unpacked
  // whole, so a long game takes no more memory than a short one.
  if (!stream.hasRecording(zip)) throw new Error('No recording in this file');
  const meta = stream.readMeta(zip);

  // First pass: when the game started, and which map it is.
  let start = null; let info = {}; let boardMap = null;
  stream.eachRecord(zip, (t, rec) => {
    if (!rec.length) return false;
    const pos = { i: 0 };
    const id = varint(rec, pos);
    try {
      if (id === 0x02) {
        const text = chatText(str(rec, pos));
        if (start == null && START_RE.test(text)) start = t;
        // (A lobby's /locraw says "map":"Base": only a game's counts.)
        if (/^\{"server"/.test(text)) { try { const j = JSON.parse(text); if (j.map && !j.lobbyname) info = j; } catch { /* not /locraw */ } }
      } else if (id === 0x3e && boardMap == null) {
        // Pre-game sidebar line "Map: <name>", split over a team's prefix and suffix.
        str(rec, pos); const mode = rec[pos.i++];
        if (mode === 0 || mode === 2) {
          str(rec, pos); const prefix = str(rec, pos); const suffix = str(rec, pos);
          const m = (prefix + suffix).replace(/§./g, '').match(/^Map: (.+)$/);
          if (m) boardMap = m[1].trim();
        }
      }
    } catch { /* one odd packet doesn't matter */ }
  });

  const columns = new Map(); // key -> { x, z, kind, sections }
  const live = new Map();    // pre-game: the columns as they are now
  let snapshotTaken = false;
  const phaseAt = (t) => (start == null ? 'midgame' : t < start - START_WINDOW_MS.before ? 'pregame' : t <= start + START_WINDOW_MS.after ? 'start' : 'midgame');

  const takeSnapshot = () => {
    if (snapshotTaken) return;
    snapshotTaken = true;
    for (const [key, c] of live) columns.set(key, c);
  };
  const setBlock = (x, y, z, v, phase) => {
    if (y < 0 || y > 255) return;
    const c = (phase === 'pregame' ? live : columns).get(colKey(x >> 4, z >> 4));
    if (!c || c.kind === KIND.midgame) return;
    // At the start only removals count (the waiting lobby); additions then
    // are island toppers. Before it, everything counts.
    if (phase === 'start' && v !== 0) return;
    if (phase === 'midgame') return;
    let s = c.sections[y >> 4];
    if (!s) { if (!v) return; s = c.sections[y >> 4] = new Uint16Array(SECTION); }
    s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = v;
  };
  const readSections = (mask, b, at) => {
    const sections = new Array(16).fill(null);
    let p = at;
    for (let sy = 0; sy < 16; sy++) {
      if (!(mask & (1 << sy))) continue;
      const arr = new Uint16Array(SECTION);
      for (let k = 0; k < SECTION; k++) arr[k] = b[p + k * 2] | (b[p + k * 2 + 1] << 8);
      sections[sy] = arr;
      p += 8192;
    }
    return sections;
  };
  const loadColumn = (cx, cz, full, mask, b, at, phase) => {
    const key = colKey(cx, cz);
    if (phase === 'pregame') {
      const old = live.get(key);
      const sections = readSections(mask, b, at);
      if (!old || full) { live.set(key, { x: cx, z: cz, kind: KIND.pregame, sections }); return; }
      for (let sy = 0; sy < 16; sy++) if (sections[sy]) old.sections[sy] = sections[sy];
      return;
    }
    takeSnapshot();
    if (columns.has(key)) return; // already have it (later sends may hold player blocks)
    columns.set(key, { x: cx, z: cz, kind: phase === 'start' ? KIND.start : KIND.midgame, sections: readSections(mask, b, at) });
  };

  stream.eachRecord(zip, (t, rec) => {
    if (!rec.length) return false;
    const pos = { i: 0 };
    const phase = phaseAt(t);
    if (phase !== 'pregame') takeSnapshot();
    const id = varint(rec, pos);
    try {
      switch (id) {
        case 0x21: { // chunk
          const cx = rec.readInt32BE(pos.i); const cz = rec.readInt32BE(pos.i + 4); pos.i += 8;
          const full = rec[pos.i++] !== 0; const mask = rec.readUInt16BE(pos.i); pos.i += 2;
          varint(rec, pos);
          if (full && mask === 0) break; // an unload: keep what we have
          loadColumn(cx, cz, full, mask, rec, pos.i, phase);
          break;
        }
        case 0x26: { // chunk bulk
          const sky = rec[pos.i++] !== 0; const count = varint(rec, pos);
          const metas = [];
          for (let q = 0; q < count; q++) { metas.push([rec.readInt32BE(pos.i), rec.readInt32BE(pos.i + 4), rec.readUInt16BE(pos.i + 8)]); pos.i += 10; }
          for (const [cx, cz, mask] of metas) {
            let secs = 0; for (let m = mask; m; m >>= 1) secs += m & 1;
            loadColumn(cx, cz, true, mask, rec, pos.i, phase);
            pos.i += secs * 8192 + secs * 2048 + (sky ? secs * 2048 : 0) + 256;
          }
          break;
        }
        case 0x23: { // one block
          const [x, y, z] = blockPos(rec, pos);
          setBlock(x, y, z, varint(rec, pos), phase);
          break;
        }
        case 0x22: { // several blocks in one chunk
          const cx = rec.readInt32BE(pos.i); const cz = rec.readInt32BE(pos.i + 4); pos.i += 8;
          const cnt = varint(rec, pos);
          for (let q = 0; q < cnt; q++) {
            const h = rec[pos.i++]; const y = rec[pos.i++];
            setBlock((cx << 4) + (h >> 4), y, (cz << 4) + (h & 15), varint(rec, pos), phase);
          }
          break;
        }
      }
    } catch { /* one odd packet doesn't stop the capture */ }
  });
  takeSnapshot();

  // Drop empty sections and empty columns.
  for (const [key, c] of columns) {
    let any = false;
    c.sections = c.sections.map(s => (s && s.some(v => v !== 0) ? (any = true, s) : null));
    if (!any) columns.delete(key);
  }
  const map = cleanName(info.map || boardMap);
  return {
    map, mode: info.mode || null, server: info.server || null,
    startedAt: meta.date ? new Date(meta.date + (start || 0)).toISOString() : null,
    started: start != null,
    columns
  };
}

const cleanName = (s) => (typeof s === 'string' && s.trim() ? s.replace(/§./g, '').trim().slice(0, 40) : null);
/** "Hell Temple" -> "hell-temple". */
const slugOf = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// --- Merging ---
/**
 * Adds one capture to a map (or starts one). map: the decoded map file, or
 * null. source: { id, playedAt } of the game. Returns the new map.
 * A column is replaced when the new one is a better kind (pre-game beats
 * start beats mid-game), or the same kind from a newer game.
 */
function mergeCapture(map, capture, source) {
  const out = map
    ? { ...map, columns: new Map(map.columns), sources: map.sources.slice() }
    : { v: FORMAT, name: capture.map, slug: slugOf(capture.map), modes: [], columns: new Map(), sources: [] };
  if (capture.mode && !out.modes.includes(capture.mode)) out.modes = [...out.modes, capture.mode];
  if (out.sources.some(s => s.id === source.id)) return out; // already in
  const playedAt = source.playedAt || capture.startedAt || null;
  const time = (s) => (s && s.playedAt ? Date.parse(s.playedAt) || 0 : 0);
  const srcIndex = out.sources.length;
  out.sources.push({ id: String(source.id), playedAt, started: !!capture.started, used: 0 });
  const newTime = time(out.sources[srcIndex]);
  for (const [key, c] of capture.columns) {
    const old = out.columns.get(key);
    const better = !old || c.kind < old.kind || (c.kind === old.kind && newTime >= time(out.sources[old.src]));
    if (better) out.columns.set(key, { x: c.x, z: c.z, kind: c.kind, src: srcIndex, sections: c.sections });
  }
  return finish(out);
}

/** Recounts which games the columns come from, and the map's size. */
function finish(map) {
  for (const s of map.sources) s.used = 0;
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity; let minY = 256; let maxY = -1;
  const kinds = [0, 0, 0];
  for (const c of map.columns.values()) {
    map.sources[c.src].used++;
    kinds[c.kind]++;
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    c.sections.forEach((s, sy) => { if (s) { minY = Math.min(minY, sy * 16); maxY = Math.max(maxY, sy * 16 + 15); } });
  }
  map.stats = {
    columns: map.columns.size,
    pregameColumns: kinds[0], startColumns: kinds[1], midgameColumns: kinds[2],
    // Every chunk seen before anyone could build: nothing players placed.
    complete: map.columns.size > 0 && kinds[2] === 0,
    bounds: map.columns.size ? { minX: minX * 16, maxX: maxX * 16 + 15, minZ: minZ * 16, maxZ: maxZ * 16 + 15, minY, maxY } : null
  };
  return map;
}

// --- A top-down preview (for the map list) ---
// The top block of every other column: gzip of u16 w, u16 h, i32 minX,
// i32 minZ, u8 step, then w*h u16 LE block states and w*h u8 heights.
// Barriers (invisible) don't count as the top.
const BARRIER = 166;
function previewOf(map, step = 2) {
  const b = map.stats && map.stats.bounds;
  if (!b) return null;
  const w = Math.floor((b.maxX - b.minX) / step) + 1; const h = Math.floor((b.maxZ - b.minZ) / step) + 1;
  const head = Buffer.alloc(13);
  head.writeUInt16BE(w, 0); head.writeUInt16BE(h, 2); head.writeInt32BE(b.minX, 4); head.writeInt32BE(b.minZ, 8); head[12] = step;
  const states = Buffer.alloc(w * h * 2); const heights = Buffer.alloc(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = b.minX + i * step; const z = b.minZ + j * step;
      const c = map.columns.get(colKey(x >> 4, z >> 4));
      if (!c) continue;
      const lx = x & 15; const lz = z & 15;
      for (let sy = 15; sy >= 0; sy--) {
        const s = c.sections[sy]; if (!s) continue;
        let found = false;
        for (let ly = 15; ly >= 0; ly--) {
          const v = s[(ly << 8) | (lz << 4) | lx];
          if (v && (v >> 4) !== BARRIER) { states.writeUInt16LE(v, (j * w + i) * 2); heights[j * w + i] = sy * 16 + ly; found = true; break; }
        }
        if (found) break;
      }
    }
  }
  return zlib.gzipSync(Buffer.concat([head, states, heights]), { level: 9 });
}

// --- The map file ---
// gzip of: "PATL", u32 BE header length, header JSON, then for each column
// in header.columns order, each section its mask names: 4096 u16 LE.
function encodeMap(map) {
  const cols = [...map.columns.values()].sort((a, b) => a.x - b.x || a.z - b.z);
  const header = {
    v: FORMAT, name: map.name, slug: map.slug, modes: map.modes, builtAt: new Date().toISOString(),
    sources: map.sources, stats: map.stats,
    columns: cols.map(c => [c.x, c.z, c.sections.reduce((m, s, sy) => (s ? m | (1 << sy) : m), 0), c.kind, c.src])
  };
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const parts = [Buffer.from(MAGIC, 'latin1'), Buffer.alloc(4), head];
  parts[1].writeUInt32BE(head.length);
  for (const c of cols) {
    for (const s of c.sections) {
      if (!s) continue;
      const b = Buffer.alloc(8192);
      for (let k = 0; k < SECTION; k++) b.writeUInt16LE(s[k], k * 2);
      parts.push(b);
    }
  }
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function decodeMap(gz) {
  const buf = zlib.gunzipSync(gz, { maxOutputLength: MAX_MAP });
  if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('Not a map file');
  const n = buf.readUInt32BE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + n));
  if (header.v !== FORMAT) throw new Error(`Map file version ${header.v} (expected ${FORMAT})`);
  let p = 8 + n;
  const columns = new Map();
  for (const [x, z, mask, kind, src] of header.columns) {
    const sections = new Array(16).fill(null);
    for (let sy = 0; sy < 16; sy++) {
      if (!(mask & (1 << sy))) continue;
      const s = new Uint16Array(SECTION);
      for (let k = 0; k < SECTION; k++) s[k] = buf.readUInt16LE(p + k * 2);
      sections[sy] = s;
      p += 8192;
    }
    columns.set(colKey(x, z), { x, z, kind, src, sections });
  }
  return { v: header.v, name: header.name, slug: header.slug, modes: header.modes || [], builtAt: header.builtAt, sources: header.sources, stats: header.stats, columns };
}

/**
 * A capture sent as a map file (one game's map, encoded like any map: what
 * the proxy uploads for games that weren't kept as replays) -> a capture.
 */
function readCapture(gz) {
  const m = decodeMap(gz);
  if (m.sources.length !== 1) throw new Error('A capture holds one game');
  const s = m.sources[0];
  for (const c of m.columns.values()) {
    if (!(c.kind in KIND_NAMES)) throw new Error('Bad column kind');
    if (c.sections.length !== 16) throw new Error('Bad column');
  }
  return { map: cleanName(m.name), mode: (m.modes && m.modes[0]) || null, server: null, startedAt: s.playedAt || null, started: !!s.started, columns: m.columns };
}

module.exports = { extractCapture, readCapture, mergeCapture, previewOf, encodeMap, decodeMap, slugOf, chatText, FORMAT, KIND, KIND_NAMES };
