// Clips (clips.js) end to end: a replay finishes uploading, its clips are
// cut and stored, and the site's routes list and serve them. In-memory
// MongoDB and a fake B2 that keeps files in a Map.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupReplays = require('../replays');
const setupClips = require('../clips');
const { readRecording } = require('../clipper');
const { game, SWEAT, FAR } = require('./game-fixture');

const env = { B2_KEY_ID: 'k', B2_APP_KEY: 's', B2_BUCKET: 'b', B2_ENDPOINT: 's3.us-west-004.backblazeb2.com', CLIPS_BACKFILL: 'off' };
const keyOf = url => decodeURIComponent(new URL(url).pathname.slice(1));
const store = new Map();
const http = {
  get: async (url) => (store.has(keyOf(url)) ? { status: 200, data: store.get(keyOf(url)) } : { status: 404, data: Buffer.alloc(0) }),
  head: async (url) => (store.has(keyOf(url)) ? { status: 200, headers: { 'content-length': String(store.get(keyOf(url)).length) } } : { status: 404, headers: {} }),
  put: async (url, body) => { store.set(keyOf(url), Buffer.from(body)); return { status: 200 }; },
  delete: async (url) => { store.delete(keyOf(url)); return { status: 204 }; }
};
const quiet = { warn() {}, error() {}, log() {} };
let mongo, server, base, replays, clips;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('clipstest'));
  const app = express();
  app.use(express.json());
  const pass = (req, res, next) => { req.keyOwner = req.get('x-admin-key') || null; return req.keyOwner ? next() : res.status(401).json({ error: 'key' }); };
  const open = (req, res, next) => next();
  const opts = { app, mongoose, requireWriteKey: pass, writeLimiter: open, proxyLimiter: open, hasFullAccess: o => o === 'milo', env, http };
  replays = setupReplays({ ...opts, keyOwner: () => null, UUID_RE: /^[0-9a-f]{32}$/, NAME_RE: /^\w{1,16}$/ });
  clips = setupClips({ ...opts, Replay: replays.Replay, log: quiet });
  replays.onReady = (id) => clips.enqueue(id);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
});

const call = async (method, url, { key = 'milo', body } = {}) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) }, body: body && JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* a file */ }
  return { status: res.status, json, buf };
};

test('a finished upload is clipped, and the clips are listed and served', async () => {
  const file = Buffer.from(game());
  const made = await call('POST', '/replays', { body: { sizeBytes: file.length, players: [{ uuid: SWEAT, username: 'Sweaty' }, { uuid: FAR, username: 'Faraway' }], map: 'Lighthouse', mode: 'Doubles', playedAt: '2026-11-03T20:00:00Z' } });
  assert.equal(made.status, 201);
  store.set(keyOf(made.json.uploadUrl), file);
  assert.equal((await call('POST', `/replays/${made.json.id}/done`)).status, 200);
  // The clipping runs after the answer; wait for it.
  await new Promise(r => setTimeout(r, 50));
  await clips.enqueue(made.json.id);

  const summary = await call('GET', `/replays/${made.json.id}/clips`);
  assert.equal(summary.status, 200);
  assert.equal(summary.json.note.clips, 3);
  assert.equal(summary.json.note.error, null);
  assert.deepEqual(summary.json.note.moments.filter(m => !m.ok).map(m => [m.kind, m.username, m.reason]), [['final', 'Faraway', 'too far']]);

  const list = await call('GET', `/clips?uuid=${SWEAT}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.clips.map(c => c.kind).sort(), ['bed', 'final']);
  const final = list.json.clips.find(c => c.kind === 'final');
  assert.equal(final.by, 'Milo');
  assert.equal(final.markAt, 12000);
  assert.equal(final.map, 'Lighthouse');
  assert.equal(new Date(final.playedAt).toISOString(), '2026-11-03T20:00:23.000Z');

  const file1 = await call('GET', `/clips/${final.id}/file`);
  assert.equal(file1.status, 200);
  assert.equal(readRecording(file1.buf).meta.duration, 15000);
  assert.equal((await call('GET', `/clips/${final.id}/file`, { key: null })).status, 401);
  assert.match((await call('GET', `/clips/${final.id}/link`)).json.url, /clips%2F|clips\//);

  // Clipping again replaces the old clips instead of adding more.
  const again = await call('POST', `/replays/${made.json.id}/clips`);
  assert.equal(again.json.note.clips, 3);
  assert.equal([...store.keys()].filter(k => k.startsWith('clips/')).length, 3);

  // The clips stay when the full replay is deleted.
  const del = await call('DELETE', `/replays/${made.json.id}`); assert.equal(del.status, 200, JSON.stringify(del.json));
  const kept = (await call('GET', `/clips?uuid=${SWEAT}`)).json.clips;
  assert.equal(kept.length, 2);

  // Only Milo can delete a clip.
  assert.equal((await call('DELETE', `/clips/${kept[0].id}`, { key: 'potat' })).status, 403);
  assert.equal((await call('DELETE', `/clips/${kept[0].id}`)).status, 200);
  assert.equal((await call('GET', `/clips?uuid=${SWEAT}`)).json.clips.length, 1);
});

test('the backfill clips replays uploaded before clips existed', async () => {
  const file = Buffer.from(game());
  const doc = await replays.Replay.create({ key: 'replays/old.mcpr', status: 'ready', sizeBytes: file.length, players: [{ uuid: SWEAT, username: 'Sweaty' }], playedAt: new Date('2026-11-01T10:00:00Z') });
  store.set('replays/old.mcpr', file);
  assert.equal(await clips.backfill(), 1);
  const after = await replays.Replay.findById(doc._id).lean();
  assert.equal(after.clips.clips, 2);
  assert.equal(await clips.backfill(), 0);
});

test('/clip: a game with no tracked player goes up, and its clip shows on whoever was in it', async () => {
  const file = Buffer.from(game());
  const made = await call('POST', '/replays', { body: { sizeBytes: file.length, players: [], clips: [{ at: 34000 }], map: 'Aquarium' } });
  assert.equal(made.status, 201);
  assert.equal((await call('POST', '/replays', { body: { sizeBytes: file.length, players: [] } })).status, 400);
  store.set(keyOf(made.json.uploadUrl), file);
  await call('POST', `/replays/${made.json.id}/done`);
  await new Promise(r => setTimeout(r, 50));
  await clips.enqueue(made.json.id);
  const note = (await call('GET', `/replays/${made.json.id}/clips`)).json;
  assert.equal(note.clips.length, 1);
  assert.deepEqual(note.clips[0].people.map(p => p.name), ['Sweaty', 'Mate']);
  // By uuid, or by the name they had (tracked later under a real name).
  const byUuid = (await call('GET', `/clips?uuid=${SWEAT}`)).json.clips.filter(c => c.kind === 'manual');
  assert.equal(byUuid.length, 1);
  assert.equal(byUuid[0].durationMs, 21000);
  const byName = (await call('GET', `/clips?uuid=${'f'.repeat(32)}&name=sweaty`)).json.clips;
  assert.deepEqual(byName.map(c => c.kind), ['manual']);
  assert.equal((await call('GET', `/clips?uuid=${FAR}`)).json.clips.filter(c => c.kind === 'manual').length, 0);
});

test('a broken replay is noted, not retried forever', async () => {
  const doc = await replays.Replay.create({ key: 'replays/broken.mcpr', status: 'ready', sizeBytes: 10, players: [{ uuid: SWEAT, username: 'Sweaty' }] });
  store.set('replays/broken.mcpr', Buffer.from('not a zip'));
  await clips.enqueue(doc._id);
  const after = await replays.Replay.findById(doc._id).lean();
  assert.ok(after.clips.error);
  assert.equal(await clips.backfill(), 0);
});
