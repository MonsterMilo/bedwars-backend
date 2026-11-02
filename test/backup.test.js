// Daily database backup (backup.js), against an in-memory MongoDB and a
// fake B2 that keeps the uploaded files in a Map.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupBackups = require('../backup');

const env = { B2_KEY_ID: 'k', B2_APP_KEY: 's', B2_BUCKET: 'b', B2_ENDPOINT: 's3.us-west-004.backblazeb2.com' };
const keyOf = url => decodeURIComponent(new URL(url).pathname.slice(1));
const store = new Map();
let failPuts = false;
const http = {
  put: async (url, body) => { if (failPuts) throw new Error('B2 down'); store.set(keyOf(url), Buffer.from(body)); return { status: 200 }; },
  delete: async url => { store.delete(keyOf(url)); return { status: 204 }; }
};
const at = s => new Date(s).getTime();
let mongo;
let t = at('2026-11-02T09:00:00Z');
let b;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('backuptest'));
  b = setupBackups({ mongoose, env, http, now: () => t });
});
test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test('copies every collection once a day, exactly, and keeps 14 days', async () => {
  const db = mongoose.connection.db;
  const id = new mongoose.Types.ObjectId();
  const when = new Date('2026-10-01T12:34:56.789Z');
  await db.collection('sweats').insertMany([{ _id: id, username: 'Steve', addedAt: when, fkdr: 1.5 }, { username: 'Alex', n: 7 }]);
  await db.collection('notes').insertOne({ text: 'hi' });

  t = at('2026-11-02T07:00:00Z');
  assert.equal(await b.check(), null, 'waits for the quiet hour');

  t = at('2026-11-02T09:00:00Z');
  const r = await b.check();
  assert.deepEqual(r.collections.map(c => [c.name, c.count]), [['notes', 1], ['sweats', 2]]);
  assert.ok(store.has('backups/2026-11-02/manifest.json'));
  assert.equal(await b.check(), null, 'only once a day');

  const { EJSON } = mongoose.mongo.BSON;
  const lines = zlib.gunzipSync(store.get('backups/2026-11-02/sweats.ndjson.gz')).toString().split('\n').filter(Boolean);
  const back = lines.map(l => EJSON.parse(l, { relaxed: false }));
  assert.ok(back[0]._id.equals(id), 'ObjectId comes back');
  assert.equal(back[0].addedAt.getTime(), when.getTime(), 'date comes back');
  assert.ok(!store.has('backups/2026-11-02/backupruns.ndjson.gz'), 'its own list is left out');
  assert.equal((await b.latest())._id, '2026-11-02');

  for (let d = 1; d <= 15; d++) {
    t = at('2026-11-02T09:00:00Z') + d * 86400000;
    await b.check();
  }
  const days = [...new Set([...store.keys()].map(k => k.split('/')[1]))].sort();
  assert.equal(days.length, 14);
  assert.equal(days[0], '2026-11-04');
  assert.equal(days[13], '2026-11-17');
});

test('a failed copy is tried again on the next check', async () => {
  t = at('2026-12-01T09:00:00Z');
  failPuts = true;
  assert.equal(await b.check(), null);
  failPuts = false;
  t += 3600000;
  const r = await b.check();
  assert.ok(r && r.collections.length === 2);
  assert.equal((await b.latest())._id, '2026-12-01');
});

test('off without B2 settings', () => {
  assert.equal(setupBackups({ mongoose, env: {}, http }).configured(), false);
});
