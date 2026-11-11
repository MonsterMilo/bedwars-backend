// The Games page (games.js), game summaries (game-summary.js) and clips made
// on the website (clips.js). In-memory MongoDB and a fake B2 in a Map.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupReplays = require('../replays');
const setupClips = require('../clips');
const setupMatchStats = require('../match-stats');
const setupGames = require('../games');
const { readRecording } = require('../clipper');
const { summarizeGame } = require('../game-summary');
const { game, SWEAT, MATE } = require('./game-fixture');

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
let mongo, server, base, replays, clips, matchStats;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('gamestest'));
  const app = express();
  app.use(express.json());
  const pass = (req, res, next) => { req.keyOwner = req.get('x-admin-key') || null; return req.keyOwner ? next() : res.status(401).json({ error: 'key' }); };
  const open = (req, res, next) => next();
  const opts = { app, mongoose, requireWriteKey: pass, writeLimiter: open, proxyLimiter: open, hasFullAccess: o => o === 'milo', env, http, UUID_RE: /^[0-9a-f]{32}$/, NAME_RE: /^\w{1,16}$/ };
  replays = setupReplays({ ...opts, keyOwner: () => null });
  clips = setupClips({ ...opts, Replay: replays.Replay, log: quiet });
  matchStats = setupMatchStats(opts);
  // The resolved nicks list (resolved.js): 'Sweaty' is RealSweat's nick.
  const owners = { sweaty: { player: 'RealSweat', uuid: 'dddddddddddd4ddddddddddddddddddd' } };
  const resolved = { ownerOf: async (nick) => owners[String(nick).toLowerCase()] || null };
  setupGames({ ...opts, Replay: replays.Replay, Clip: clips.Clip, MatchStat: matchStats.MatchStat, resolved, log: quiet });
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

async function upload(name, players, extra = {}) {
  const file = Buffer.from(game());
  const made = await call('POST', '/replays', { body: { name, sizeBytes: file.length, players, map: 'Lighthouse', mode: 'Doubles', playedAt: '2026-11-03T20:00:00Z', ...extra } });
  assert.equal(made.status, 201);
  store.set(keyOf(made.json.uploadUrl), file);
  assert.equal((await call('POST', `/replays/${made.json.id}/done`)).status, 200);
  await clips.enqueue(made.json.id);
  return made.json.id;
}

test('summarizeGame: kills, finals, beds, who won', () => {
  const names = new Map([['a', 'Milo'], ['b', 'Mate'], ['c', 'Sweaty'], ['d', 'Lobby']]);
  const teamOf = new Map([['milo', 'Blue'], ['mate', 'Blue'], ['sweaty', 'Red']]);
  const s = summarizeGame({
    names, teamOf, self: { name: 'Milo', team: 'Blue' }, startT: 1000, endT: 90000,
    lines: [
      { t: 500, text: 'Sweaty was killed by Milo.' }, // before the start: ignored
      { t: 2000, text: 'Milo has enabled private game modifiers!' },
      { t: 3000, text: 'Sweaty: gg ez' },
      { t: 4000, text: 'Sweaty had a small brain moment while fighting Mate.' }, // cosmetic wording
      { t: 5000, text: 'Milo fell into the void.' },
      { t: 6000, text: 'BED DESTRUCTION > Red Bed was destroyed by Milo!' },
      { t: 7000, text: 'Sweaty was knocked into the void by Milo. FINAL KILL!' }
    ]
  });
  const row = (n) => s.teams.flatMap(t => t.players).find(p => p.name === n);
  assert.deepEqual([row('Milo').kills, row('Milo').finals, row('Milo').deaths, row('Milo').beds], [1, 1, 1, 1]);
  assert.deepEqual([row('Mate').kills, row('Sweaty').deaths, row('Sweaty').finalDeath], [1, 2, true]);
  assert.equal(s.winner, 'Blue');
  assert.equal(s.result, 'win');
  assert.deepEqual(s.totals, { kills: 3, finals: 1, beds: 1 });
  assert.deepEqual(s.events.map(e => e.kind), ['kill', 'kill', 'bed', 'final']);
  assert.equal(s.events[0].firstBlood, true);
  assert.ok(!s.teams.some(t => t.players.some(p => p.name === 'Lobby')));
});

test('a clipped replay gets its summary, and shows on the Games list and page', async () => {
  const id = await upload('2026-11-03_20-00-00_game.mcpr', [{ uuid: SWEAT, username: 'Sweaty' }]);
  // Uploaded again for another tracked player: still one game.
  const id2 = await upload('2026-11-03_20-00-00_game.mcpr', [{ uuid: MATE, username: 'Mate' }]);
  const rep = await replays.Replay.findById(id).lean();
  assert.equal(rep.summary.winner, 'Blue');
  assert.equal(rep.summary.self.name, 'Milo');

  await call('POST', '/match-stats', { body: { name: '2026-11-03_20-00-00_game.mcpr', players: [{ uuid: SWEAT, username: 'Sweaty' }], stats: { team: 'Blue', result: 'win', players: [{ name: 'Milo', me: true, kills: 1, finals: 1, beds: 1, dia: 4 }] } } });

  const list = await call('GET', '/games');
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  const g = list.json.games[0];
  assert.deepEqual(g.replayIds.sort(), [id, id2].sort());
  assert.deepEqual(g.tracked.map(p => p.username).sort(), ['Mate', 'Sweaty']);
  assert.equal(g.summary.totals.finals, 2);
  assert.equal(g.result, 'win');
  assert.equal(g.matchStats, true);
  assert.equal(g.clips, 2);
  assert.equal(g.summary.events, undefined);

  assert.equal((await call('GET', '/games?q=sweat')).json.total, 1);
  assert.equal((await call('GET', '/games?q=lighthouse')).json.total, 1);
  assert.equal((await call('GET', '/games?q=nobody')).json.total, 0);
  assert.equal((await call('GET', '/games', { key: null })).status, 401);

  const page = await call('GET', `/games/${id2}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.summary.events.length, 4);
  assert.equal(page.json.matchStats.players[0].dia, 4);
  assert.deepEqual(page.json.clips.map(c => c.kind).sort(), ['bed', 'final']);
});

test('a clip made on the website is cut, listed on who is in it, and kept when clipping again', async () => {
  const id = await upload('2026-11-04_10-00-00_game.mcpr', [{ uuid: SWEAT, username: 'Sweaty' }], { map: 'Aquarium' });
  assert.equal((await call('POST', `/replays/${id}/site-clips`, { key: 'potat', body: { from: 10000, to: 9000 } })).status, 400);
  assert.equal((await call('POST', `/replays/${id}/site-clips`, { key: 'potat', body: { from: 0, to: 70000 } })).status, 400);
  const made = await call('POST', `/replays/${id}/site-clips`, { key: 'potat', body: { from: 20000, to: 34000, title: 'Mid fight', follow: 'Sweaty' } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.title, 'Mid fight');
  assert.equal(made.json.source, 'site');
  assert.equal(made.json.follow, 'Sweaty');
  assert.equal(made.json.durationMs, 14000);
  assert.ok(made.json.people.some(p => p.name === 'Milo'));
  assert.equal(readRecording((await call('GET', `/clips/${made.json.id}/file`)).buf).meta.duration, 14000);
  // It shows on the followed player.
  const theirs = (await call('GET', `/clips?uuid=${SWEAT}`)).json.clips.filter(c => c.source === 'site');
  assert.equal(theirs.length, 1);
  // Only its maker (or Milo) renames it.
  assert.equal((await call('PATCH', `/clips/${made.json.id}`, { key: 'aboi', body: { title: 'x' } })).status, 403);
  assert.equal((await call('PATCH', `/clips/${made.json.id}`, { key: 'potat', body: { title: 'Bridge fight' } })).json.title, 'Bridge fight');
  // Clipping the replay again replaces the automatic clips only.
  await call('POST', `/replays/${id}/clips`);
  assert.equal((await clips.Clip.find({ replayId: id, source: 'site' })).length, 1);
});

test('replays clipped before summaries existed get one from the backfill', async () => {
  const id = await upload('2026-11-05_10-00-00_game.mcpr', [{ uuid: SWEAT, username: 'Sweaty' }]);
  await replays.Replay.updateOne({ _id: id }, { $unset: { summary: 1 } });
  assert.equal(await clips.backfill(), 1);
  assert.equal((await replays.Replay.findById(id).lean()).summary.winner, 'Blue');
  assert.equal(await clips.backfill(), 0);
});

test('a tracked player who was nicked is matched to their nick in the game', async () => {
  const name = '2026-11-04_21-00-00_game.mcpr';
  // Known only from the resolved nicks list.
  await upload(name, [{ uuid: 'dddddddddddd4ddddddddddddddddddd', username: 'RealSweat' }], { playedAt: '2026-11-04T21:00:00Z' });
  // The plugin knew this one's nick; a stale nick not in the game is dropped.
  await upload(name, [{ uuid: 'eeeeeeeeeeee4eeeeeeeeeeeeeeeeeee', username: 'Hidden', nick: 'Mate' }, { uuid: 'ffffffffffff4fffffffffffffffffff', username: 'Elsewhere', nick: 'NotHere' }], { playedAt: '2026-11-04T21:00:00Z' });
  const g = (await call('GET', '/games')).json.games.find(x => x.name === name);
  const by = Object.fromEntries(g.tracked.map(p => [p.username, p.nick || null]));
  assert.deepEqual(by, { RealSweat: 'Sweaty', Hidden: 'Mate', Elsewhere: null });
  const page = await call('GET', `/games/${g.id}`);
  assert.equal(page.json.tracked.find(p => p.username === 'RealSweat').nick, 'Sweaty');
});
