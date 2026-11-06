// Prism Atlas (atlas-core.js, atlas.js): maps rebuilt from made-up
// recordings that act like Hypixel's, against an in-memory MongoDB and a
// fake B2.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const A = require('../atlas-core');
const setupAtlas = require('../atlas');

// --- A tiny .mcpr writer ---
const varint = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const pos = (x, y, z) => { const b = Buffer.alloc(8); const v = (BigInt(x & 0x3ffffff) << 38n) | (BigInt(y & 0xfff) << 26n) | BigInt(z & 0x3ffffff); b.writeBigUInt64BE(v); return b; };
const block = (id, meta = 0) => (id << 4) | meta;

/** A chunk column packet: blocks = [[x, y, z, state]] inside chunk (cx, cz). */
function chunk(cx, cz, blocks, full = true) {
  const sections = new Map();
  for (const [x, y, z, v] of blocks) {
    const sy = y >> 4;
    if (!sections.has(sy)) sections.set(sy, new Uint16Array(4096));
    sections.get(sy)[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = v;
  }
  let mask = 0; const data = [];
  for (let sy = 0; sy < 16; sy++) {
    if (!sections.has(sy)) continue;
    mask |= 1 << sy;
    const b = Buffer.alloc(8192); const s = sections.get(sy);
    for (let k = 0; k < 4096; k++) b.writeUInt16LE(s[k], k * 2);
    data.push(b);
  }
  const n = data.length;
  const body = Buffer.concat([...data, Buffer.alloc(n * 2048 * 2), Buffer.alloc(full ? 256 : 0)]);
  return Buffer.concat([varint(0x21), i32(cx), i32(cz), Buffer.from([full ? 1 : 0]), u16(mask), varint(body.length), body]);
}
const blockChange = (x, y, z, v) => Buffer.concat([varint(0x23), pos(x, y, z), varint(v)]);
const chat = (text) => Buffer.concat([varint(0x02), str(JSON.stringify({ text })), Buffer.from([0])]);
const team = (name, prefix, suffix) => Buffer.concat([varint(0x3e), str(name), Buffer.from([0]), str(name), str(prefix), str(suffix), Buffer.from([0]), str('always'), Buffer.from([15]), varint(0)]);

function zip(files, deflate = true) {
  const locals = []; const central = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); central.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function mcpr(packets, { date = Date.parse('2026-11-03T20:00:00Z'), deflate = true } = {}) {
  const rec = Buffer.concat(packets.map(([t, p]) => Buffer.concat([i32(t), i32(p.length), p])));
  return zip({ 'metaData.json': Buffer.from(JSON.stringify({ date, duration: 60000 })), 'recording.tmcpr': rec }, deflate);
}

const WOOL = block(35, 14); const STONE = block(1); const PLANKS = block(5); const BED = block(26); const GOLD = block(41);
const LOCRAW = '{"server":"mini1A","gametype":"BEDWARS","mode":"BEDWARS_FOUR_FOUR","map":"Test Isle"}';

/** A game like Hypixel's: map + lobby sent pre-game, lobby gone and a topper added at the start, then play. */
function game({ start = 20000, extraPregame = [], late = [] } = {}) {
  return mcpr([
    [10, team('team_9', 'Map: §aTest', ' Isle')],
    [20, chunk(0, 0, [[1, 64, 1, STONE], [2, 64, 2, WOOL], [3, 65, 3, BED]])],
    [20, chunk(1, 0, [[0, 64, 0, STONE]])],
    [20, chunk(0, 1, [[5, 120, 5, PLANKS], [6, 120, 6, PLANKS]])], // the waiting lobby
    [500, chat(LOCRAW)],
    ...extraPregame,
    [start, chat('     Protect your bed and destroy the enemy beds.')],
    [start + 50, blockChange(5, 120, 21, 0)], // lobby removed (chunk 0,1: z 16-31)
    [start + 50, blockChange(6, 120, 22, 0)],
    [start + 60, blockChange(4, 66, 4, GOLD)], // a topper
    [start + 9000, blockChange(7, 64, 7, WOOL)], // a player bridging
    [start + 9500, blockChange(1, 64, 1, 0)], // a player mining the map
    [start + 20000, chunk(0, 0, [[1, 64, 1, STONE], [2, 64, 2, WOOL], [3, 65, 3, BED], [8, 64, 8, WOOL]])], // resent with a player block
    ...late
  ]);
}
const at = (c, x, y, z) => { const col = c.columns.get(`${x >> 4},${z >> 4}`); const s = col && col.sections[y >> 4]; return s ? s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : 0; };

test('a capture is the map just before the start, without the lobby, toppers or player blocks', () => {
  const c = A.extractCapture(game());
  assert.equal(c.map, 'Test Isle');
  assert.equal(c.mode, 'BEDWARS_FOUR_FOUR');
  assert.equal(c.started, true);
  assert.equal(c.startedAt, new Date(Date.parse('2026-11-03T20:00:00Z') + 20000).toISOString());
  assert.equal(at(c, 1, 64, 1), STONE); // mined later: still there
  assert.equal(at(c, 2, 64, 2), WOOL); // the map's own wool stays
  assert.equal(at(c, 3, 65, 3), BED);
  assert.equal(at(c, 16, 64, 0), STONE);
  assert.equal(at(c, 4, 66, 4), 0); // topper
  assert.equal(at(c, 7, 64, 7), 0); // bridge
  assert.equal(at(c, 8, 64, 8), 0); // in the resent chunk
  assert.equal(c.columns.has('0,1'), false); // only the lobby was there: an empty column, dropped
  for (const col of c.columns.values()) assert.equal(col.kind, A.KIND.pregame);
});

test('the map name comes from the sidebar when /locraw is missing, and stored zips work too', () => {
  const file = mcpr([[10, team('team_9', 'Map: §aSide', 'bar Peak')], [20, chunk(0, 0, [[0, 64, 0, STONE]])], [3000, chat('Protect your bed and destroy the enemy beds.')]], { deflate: false });
  const c = A.extractCapture(file);
  assert.equal(c.map, 'Sidebar Peak');
  assert.equal(c.columns.size, 1);
});

test('a lobby\'s /locraw ("map":"Base") never names the map', () => {
  const lobby = '{"server":"dynamiclobby5","gametype":"BEDWARS","lobbyname":"bedwarslobby23","map":"Base"}'
  const c = A.extractCapture(mcpr([[0, chat(lobby)], [10, team('team_9', 'Map: §aLight', 'house')], [20, chunk(0, 0, [[0, 64, 0, STONE]])], [3000, chat('Protect your bed and destroy the enemy beds.')]]))
  assert.equal(c.map, 'Lighthouse')
})

test('chunks first seen mid-game: unsure on their own, dropped once the pre-game map is there', () => {
  // A recording that began mid-game (a rejoin): all it has, marked unsure.
  const rejoin = A.extractCapture(mcpr([[0, chat(LOCRAW)], [10, chunk(0, 0, [[1, 64, 1, STONE]])], [10, chunk(5, 5, [[80, 70, 80, WOOL]])]]));
  let map = A.mergeCapture(null, rejoin, { id: 'r', playedAt: '2026-11-01T00:00:00Z' });
  assert.equal(map.stats.complete, false);
  assert.equal(map.stats.midgameColumns, 2);
  // A game from before its start: the whole map. The rejoin's chunk out past
  // it (5,5: empty before the start, so player blocks) goes.
  const b = A.extractCapture(game());
  map = A.mergeCapture(map, b, { id: 'b', playedAt: '2026-11-02T00:00:00Z' });
  assert.equal(map.stats.complete, true);
  assert.equal(map.stats.midgameColumns, 0);
  assert.equal(map.columns.has('5,5'), false);
  assert.equal(at(map, 2, 64, 2), WOOL);
  assert.equal(map.sources.length, 2);
  // A played game that loaded a chunk mid-game adds nothing there.
  const late = A.extractCapture(game({ late: [[60000, chunk(6, 6, [[100, 70, 100, WOOL]])]] }));
  assert.equal(late.columns.get('6,6').kind, A.KIND.midgame);
  map = A.mergeCapture(map, late, { id: 'c', playedAt: '2026-11-03T00:00:00Z' });
  assert.equal(map.columns.has('6,6'), false);
  assert.equal(map.stats.complete, true);
  // The same game again changes nothing.
  assert.equal(A.mergeCapture(map, b, { id: 'b' }).sources.length, 3);
});

test('the newest game wins between equals (Hypixel rebuilt the map)', () => {
  const old = A.extractCapture(game());
  const rebuilt = A.extractCapture(game({ extraPregame: [[100, blockChange(9, 64, 9, GOLD)]] }));
  let map = A.mergeCapture(null, rebuilt, { id: 'new', playedAt: '2026-11-03T00:00:00Z' });
  map = A.mergeCapture(map, old, { id: 'old', playedAt: '2026-10-01T00:00:00Z' });
  assert.equal(at(map, 9, 64, 9), GOLD);
  assert.equal(map.sources.find(s => s.id === 'old').used, 0);
});

test('map files round-trip, and a one-game file reads back as a capture', () => {
  const c = A.extractCapture(game());
  const map = A.mergeCapture(null, c, { id: 'x', playedAt: c.startedAt });
  const file = A.encodeMap(map);
  const back = A.decodeMap(file);
  assert.equal(back.name, 'Test Isle');
  assert.equal(back.slug, 'test-isle');
  assert.deepEqual(back.stats, map.stats);
  assert.equal(at(back, 3, 65, 3), BED);
  const cap = A.readCapture(file);
  assert.equal(cap.map, 'Test Isle');
  assert.equal(cap.started, true);
  assert.equal(at(cap, 2, 64, 2), WOOL);
  assert.throws(() => A.decodeMap(zlib.gzipSync(Buffer.from('nope'))), /Not a map file/);
});

test('a recording that began mid-game gives mid-game chunks only', () => {
  const c = A.extractCapture(mcpr([[0, chat(LOCRAW)], [10, chunk(0, 0, [[1, 64, 1, STONE]])]]));
  assert.equal(c.started, false);
  assert.equal(c.columns.get('0,0').kind, A.KIND.midgame);
});

// --- atlas.js: the job and the routes ---
const env = { B2_KEY_ID: 'k', B2_APP_KEY: 's', B2_BUCKET: 'b', B2_ENDPOINT: 's3.us-west-004.backblazeb2.com' };
const files = new Map();
const http = { get: async (url) => { const key = decodeURIComponent(new URL(url).pathname.slice(1)); return files.has(key) ? { status: 200, data: files.get(key) } : { status: 404, data: Buffer.alloc(0) }; } };
let mongo; let atlas; let Replay; let server; let base;
const KEYS = { 'milo-key': 'milo', 'potat-key': 'potat' };
const requireWriteKey = (req, res, next) => { const o = KEYS[req.get('x-admin-key')]; if (!o) return res.status(401).json({ error: 'key' }); req.keyOwner = o; next(); };
const pass = (req, res, next) => next();

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('atlastest'));
  Replay = mongoose.model('Replay', new mongoose.Schema({ key: String, map: String, playedAt: Date, status: String }));
  const app = express();
  atlas = setupAtlas({ app, mongoose, Replay, requireWriteKey, writeLimiter: pass, proxyLimiter: pass, hasFullAccess: o => o === 'milo', env, http, inProcess: true });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test('replays in B2 become maps, each read once; the routes need a key', async () => {
  const r1 = await Replay.create({ key: 'replays/a.mcpr', map: 'Test Isle', playedAt: new Date('2026-11-01T00:00:00Z'), status: 'ready' });
  await Replay.create({ key: 'replays/missing.mcpr', map: 'Gone', playedAt: new Date('2026-11-02T00:00:00Z'), status: 'ready' });
  await Replay.create({ key: 'replays/pending.mcpr', status: 'pending' });
  files.set('replays/a.mcpr', game());
  const run = await atlas.runOnce();
  assert.equal(run.read, 1);
  assert.equal((await atlas.runOnce()).read, 0); // nothing new

  assert.equal((await fetch(base + '/maps')).status, 401);
  assert.deepEqual(await (await fetch(base + '/maps/count')).json(), { maps: 1 }); // the count alone is public
  const list = await (await fetch(base + '/maps', { headers: { 'x-admin-key': 'potat-key' } })).json();
  assert.equal(list.maps.length, 1);
  assert.equal(list.maps[0].name, 'Test Isle');
  assert.equal(list.maps[0].games, 1);
  assert.equal(list.maps[0].stats.complete, true);
  assert.equal(list.replays.total, 2);
  assert.equal(list.replays.waiting, 0);
  assert.equal(list.replays.failed.length, 1);
  assert.match(list.replays.failed[0].error, /404/);

  const file = await fetch(base + '/maps/test-isle/file', { headers: { 'x-admin-key': 'potat-key' } });
  assert.equal(file.status, 200);
  const map = A.decodeMap(Buffer.from(await file.arrayBuffer()));
  assert.equal(map.sources[0].id, String(r1._id));
  const pv = await (await fetch(base + '/maps/previews', { headers: { 'x-admin-key': 'potat-key' } })).json();
  const raw = zlib.gunzipSync(Buffer.from(pv.previews['test-isle'], 'base64'));
  const w = raw.readUInt16BE(0); const h = raw.readUInt16BE(2);
  assert.equal(raw.readInt32BE(4), 0); assert.equal(raw[12], 2);
  assert.equal(raw.length, 13 + w * h * 3);
  // (2, 2) is the wool at y 64: index (1, 1) in a step-2 preview.
  assert.equal(raw.readUInt16LE(13 + (1 * w + 1) * 2), WOOL);
  assert.equal(raw[13 + w * h * 2 + 1 * w + 1], 64);
  assert.equal((await fetch(base + '/maps/nope/file', { headers: { 'x-admin-key': 'potat-key' } })).status, 404);
  assert.equal((await fetch(base + '/maps/..%2Fx/file', { headers: { 'x-admin-key': 'potat-key' } })).status, 400);
});

test('the proxy can send a game\'s map on its own (Milo\'s key only); rebuilds keep it', async () => {
  const one = A.encodeMap(A.mergeCapture(null, A.extractCapture(game({ extraPregame: [[30, chunk(3, 3, [[50, 70, 50, GOLD]])]] })), { id: 'g1', playedAt: '2026-11-03T00:00:00Z' }));
  const send = (key, body, id = 'game-1') => fetch(base + '/maps/captures?id=' + id, { method: 'POST', headers: { 'x-admin-key': key, 'content-type': 'application/octet-stream' }, body });
  assert.equal((await send('potat-key', one)).status, 403);
  assert.equal((await send('milo-key', Buffer.from('junk'))).status, 400);
  const ok = await send('milo-key', one);
  assert.equal(ok.status, 201);
  const okJson = await ok.json();
  assert.equal(okJson.map, 'Test Isle');
  assert.equal(okJson.games, 2);
  assert.equal((await (await send('milo-key', one)).json()).duplicate, true);

  const rebuild = await fetch(base + '/maps/rebuild', { method: 'POST', headers: { 'x-admin-key': 'milo-key' } });
  assert.equal(rebuild.status, 200);
  await atlas.kick();
  const doc = await atlas.AtlasMap.findOne({ slug: 'test-isle' }).lean();
  assert.equal(doc.games, 2);
  assert.equal(at(A.decodeMap(Buffer.from(doc.file.buffer)), 50, 70, 50), GOLD);
});

test('a replay that began mid-game is not used, and a removed map goes with its games', async () => {
  const late = await Replay.create({ key: 'replays/late.mcpr', map: 'Late Isle', playedAt: new Date('2026-11-04T00:00:00Z'), status: 'ready' });
  files.set('replays/late.mcpr', mcpr([[0, chat(LOCRAW.replace('Test Isle', 'Late Isle'))], [10, chunk(0, 0, [[1, 64, 1, GOLD]])]]));
  await atlas.runOnce();
  assert.equal(await atlas.AtlasMap.exists({ slug: 'late-isle' }), null);
  const read = await atlas.AtlasRead.findOne({ source: String(late._id) }).lean();
  assert.match(read.error, /joined late/);

  // A "Base" map from before the fix: removed, and its game read again.
  const one = A.encodeMap(A.mergeCapture(null, A.extractCapture(game()), { id: String(late._id) }));
  await atlas.AtlasMap.create({ slug: 'base', name: 'Base', version: atlas.EXTRACT_VERSION, file: one, sources: [{ id: String(late._id) }] });
  await atlas.runOnce();
  assert.equal(await atlas.AtlasMap.exists({ slug: 'base' }), null);
  assert.match((await atlas.AtlasRead.findOne({ source: String(late._id) }).lean()).error, /joined late/);
});

test('the proxy sets the rotation from Hypixel\'s map selector (Milo\'s key); anyone can read it', async () => {
  const send = (key, body) => fetch(base + '/maps/rotation', { method: 'POST', headers: { 'x-admin-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const eight = ['Acropolis', 'Ambush', 'Beldam', 'Darkened', 'Lighthouse', 'Ambush'];
  assert.equal((await fetch(base + '/maps/rotation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await send('potat-key', { teams: 8, maps: eight })).status, 403);
  assert.equal((await send('milo-key', { teams: 2, maps: eight })).status, 400);
  assert.equal((await send('milo-key', { teams: 8, maps: ['Acropolis'] })).status, 400);
  const ok = await send('milo-key', { teams: 8, maps: eight, title: 'Bed Wars Solo' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).maps, 5); // the repeat is dropped
  await send('milo-key', { teams: 8, maps: ['Acropolis', 'Ambush', 'Beldam', 'Lighthouse', 'Orbit'] }); // the newest wins
  const got = await (await fetch(base + '/maps/rotation')).json();
  assert.equal(got.rotation.length, 1);
  assert.equal(got.rotation[0].teams, 8);
  assert.deepEqual(got.rotation[0].maps, ['Acropolis', 'Ambush', 'Beldam', 'Lighthouse', 'Orbit']);
});

test('maps built before the change lose their mid-game chunks on the next run', async () => {
  const rejoin = A.extractCapture(mcpr([[0, chat(LOCRAW.replace('Test Isle', 'Old Isle'))], [10, chunk(5, 5, [[80, 70, 80, WOOL]])]]));
  const good = A.extractCapture(game());
  good.map = 'Old Isle';
  // As the old code left it: both kinds side by side.
  const map = A.mergeCapture(null, good, { id: 'g', playedAt: '2026-11-01T00:00:00Z' });
  map.columns.set('5,5', { ...rejoin.columns.get('5,5'), src: 0 });
  map.stats = { ...map.stats, midgameColumns: 1, complete: false };
  await atlas.AtlasMap.create({ slug: 'old-isle', name: 'Old Isle', version: atlas.EXTRACT_VERSION, file: A.encodeMap(map), games: 1, sources: map.sources, stats: map.stats });
  await atlas.runOnce();
  const doc = await atlas.AtlasMap.findOne({ slug: 'old-isle' }).lean();
  assert.equal(doc.stats.complete, true);
  assert.equal(doc.stats.midgameColumns, 0);
  assert.equal(A.decodeMap(Buffer.from(doc.file.buffer)).columns.has('5,5'), false);
});
