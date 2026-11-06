// Match stats (match-stats.js): the plugin sends a game's stats for the
// tracked players in it, the site lists them per player. In-memory MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupMatchStats = require('../match-stats');

const SWEAT = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
let mongo, server, base;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('matchstatstest'));
  const app = express();
  app.use(express.json());
  const pass = (req, res, next) => { req.keyOwner = req.get('x-admin-key') || null; return req.keyOwner ? next() : res.status(401).json({ error: 'key' }); };
  const open = (req, res, next) => next();
  setupMatchStats({ app, mongoose, requireWriteKey: pass, writeLimiter: open, proxyLimiter: open, hasFullAccess: o => o === 'milo', UUID_RE: /^[0-9a-f]{32}$/, NAME_RE: /^\w{1,16}$/ });
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
  return { status: res.status, json: await res.json() };
};

const stats = (kills) => ({
  team: 'Red', result: 'win', durationMs: 540000, mode: '4s', map: 'Fort Doon',
  players: [
    { name: 'Monster_Milo', me: true, kills, deaths: 2, finals: 4, beds: 1, iron: 158, gold: 11, dia: 3, em: 1, pressureMs: 13000, finalDeath: false },
    { name: 'roman666', kills: 0, deaths: 2, finals: 5, beds: 2, iron: 10, gold: 1, dia: 0, em: 0, pressureMs: 0 }
  ]
});

test('a game\'s stats are saved for each tracked player and listed', async () => {
  const sent = await call('POST', '/match-stats', { body: { name: 'game-1.mcpr', playedAt: '2026-11-03T19:50:52Z', mode: '4s', map: 'Fort Doon', players: [{ uuid: SWEAT, username: 'Sweaty', nick: 'NickedOne' }, { uuid: OTHER, username: 'Other' }], stats: stats(2) } });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.saved, 2);
  const list = await call('GET', `/match-stats?uuid=${SWEAT}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.games.length, 1);
  const g = list.json.games[0];
  assert.equal(g.map, 'Fort Doon');
  assert.equal(g.result, 'win');
  assert.equal(g.nick, 'NickedOne');
  assert.deepEqual(g.players.map(p => [p.name, p.kills, p.finals, p.pressureMs]), [['Monster_Milo', 2, 4, 13000], ['roman666', 0, 5, 0]]);
  assert.equal((await call('GET', `/match-stats?uuid=${OTHER}`)).json.games.length, 1);
});

test('the same game sent again replaces it instead of adding a row', async () => {
  await call('POST', '/match-stats', { body: { name: 'game-1.mcpr', players: [{ uuid: SWEAT, username: 'Sweaty' }], stats: stats(7) } });
  const games = (await call('GET', `/match-stats?uuid=${SWEAT}`)).json.games;
  assert.equal(games.length, 1);
  assert.equal(games[0].players[0].kills, 7);
});

test('only Milo\'s key can send, bad input is refused, and junk numbers are cleaned', async () => {
  assert.equal((await call('POST', '/match-stats', { key: 'friend', body: { name: 'g', players: [{ uuid: SWEAT }], stats: stats(1) } })).status, 403);
  assert.equal((await call('POST', '/match-stats', { body: { name: 'g', players: [], stats: stats(1) } })).status, 400);
  assert.equal((await call('POST', '/match-stats', { body: { name: 'g', players: [{ uuid: SWEAT }], stats: { players: [] } } })).status, 400);
  assert.equal((await call('GET', '/match-stats?uuid=nope')).status, 400);
  const junk = { players: [{ name: 'Monster_Milo', kills: -4, deaths: 'lots', dia: 1e12 }, { name: 'bad name!' }] };
  assert.equal((await call('POST', '/match-stats', { body: { name: 'junk', players: [{ uuid: OTHER }], stats: junk } })).status, 201);
  const row = (await call('GET', `/match-stats?uuid=${OTHER}`)).json.games.find(g => g.game === 'junk');
  assert.deepEqual(row.players.map(p => [p.name, p.kills, p.deaths, p.dia]), [['Monster_Milo', 0, 0, 100000]]);
});
