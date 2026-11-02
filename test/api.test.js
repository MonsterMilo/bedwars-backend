// API tests: start the real server against an in-memory MongoDB and check
// the access rules over HTTP. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { MongoMemoryServer } = require('mongodb-memory-server-core');

const PORT = 3990 + Math.floor(Math.random() * 9);
const base = `http://127.0.0.1:${PORT}`;
let mongo, server;

async function call(method, url, { key, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MONGODB_URI: mongo.getUri('apitest'), KEY_MILO: 'milo-key', KEY_POTAT: 'potat-key', KEY_ADMIN: 'admin-key',
      DISCORD_APP_ID: '', DISCORD_BOT_TOKEN: '', HYPIXEL_API_KEY: '', DENICKER_API_KEY: '', BEDLIFY_API_KEY: '', URCHIN_KEY: '', B2_KEY_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.resume();
  server.stderr.resume();
  for (let i = 0; i < 100; i++) {
    try { if ((await call('GET', '/health')).status === 200) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  if (mongo) await mongo.stop();
});

test('errors are JSON, never stack traces', async () => {
  const cors = await call('GET', '/ping', { headers: { origin: 'https://evil.example' } });
  assert.equal(cors.status, 403);
  assert.ok(cors.json && cors.json.error);
  const bad = await call('POST', '/sweats', { key: 'milo-key', body: '{bad' });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.text, /at |node_modules/);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('writes need a key; sweats can be added and read', async () => {
  assert.equal((await call('POST', '/sweats', { body: { username: 'Steve' } })).status, 401);
  const add = await call('POST', '/sweats', { key: 'potat-key', body: { username: 'Steve', fkdr: 3, note: 'hi' } });
  assert.equal(add.status, 201);
  assert.equal(add.json.addedBy, 'potat');
  const list = await call('GET', '/sweats?paged=1');
  assert.equal(list.json.total, 1);
});

test('personal keys edit only their own notes; full access edits any', async () => {
  const add = await call('POST', '/sweats', { key: 'milo-key', body: { username: 'Alex', note: 'milo note' } });
  const id = add.json._id;
  const note = add.json.notes[0]._id;
  assert.equal((await call('PATCH', `/sweats/${id}/notes/${note}`, { key: 'potat-key', body: { text: 'x' } })).status, 403);
  const mine = await call('POST', `/sweats/${id}/notes`, { key: 'potat-key', body: { text: 'potat note' } });
  const own = mine.json.notes[1]._id;
  assert.equal((await call('PATCH', `/sweats/${id}/notes/${own}`, { key: 'potat-key', body: { text: 'edited' } })).status, 200);
  assert.equal((await call('PATCH', `/sweats/${id}/notes/${own}`, { key: 'milo-key', body: { text: 'edited by milo' } })).status, 200);
});

test('only the admin key reads the Activity log', async () => {
  assert.equal((await call('GET', '/activity', { key: 'milo-key' })).status, 403);
  const log = await call('GET', '/activity', { key: 'admin-key' });
  assert.equal(log.status, 200);
  assert.ok(log.json.entries.length > 0);
});

test('guest denick reports are capped at 5 a minute and expire', async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call('POST', '/activity/denick', { body: { mode: 'nick', query: 'abc' } })).status);
  assert.deepEqual(codes, [204, 204, 204, 204, 204, 429]);
  assert.equal((await call('POST', '/activity/denick', { key: 'potat-key', body: { mode: 'nick', query: 'abc' } })).status, 204);
  const log = await call('GET', '/activity?action=denick.search&limit=1', { key: 'admin-key' });
  assert.ok(new Date(log.json.entries[0].expiresAt) > new Date(Date.now() + 300 * 86400000));
});

test('the resolved nicks export and replay uploads are full-access only', async () => {
  assert.equal((await call('GET', '/resolved-nicks/export')).status, 401);
  assert.equal((await call('GET', '/resolved-nicks/export', { key: 'potat-key' })).status, 403);
  assert.equal((await call('GET', '/resolved-nicks/export', { key: 'milo-key' })).status, 200);
  const body = { sizeBytes: 1000, players: [{ uuid: 'a'.repeat(32), username: 'Steve' }] };
  assert.equal((await call('POST', '/replays', { key: 'potat-key', body })).status, 403);
});

test('health reports the database', async () => {
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.db, 'connected');
});
