// Tracked list channel: the one-line message, pings, and nick updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupTrackedList = require('../tracked-list');
const { lineOf } = setupTrackedList;
const setupResolved = require('../resolved');

const ROSTER = ['milo', 'potat', 'aballs'];
let mongo;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('trackedtest'));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

// A fake Discord: records calls, hands out message ids.
function fakeHttp() {
  const calls = [];
  let n = 100;
  const client = {
    post: async (url, body) => { calls.push({ method: 'post', url, body }); return { data: { id: String(++n) } }; },
    patch: async (url, body) => { calls.push({ method: 'patch', url, body }); return { data: {} }; },
    delete: async url => { calls.push({ method: 'delete', url }); return { data: {} }; }
  };
  return { calls, create: () => client };
}

test('the line: name, stats, nicks, pings', () => {
  const idOf = f => ({ milo: '111111' }[f] || null);
  const s = { username: 'Some_Guy', star: 312.7, fkdr: 8.4213, wlr: 3.1, milo: true, potat: true, cheating: true };
  assert.equal(lineOf(s, ['NickA', 'Nick_B'], idOf, ROSTER),
    '**Some\\_Guy** · 312✫ · 8.42 FKDR · 3.10 WLR · ⚠️ cheating · 🎭 NickA, Nick\\_B · ⚔️ <@111111> Potat');
  assert.equal(lineOf({ ...s, deletedAt: new Date(), milo: false, potat: false, cheating: false }, [], idOf, ROSTER),
    '~~**Some\\_Guy** · 312✫ · 8.42 FKDR · 3.10 WLR~~ (removed)');
  assert.match(lineOf(s, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], idOf, ROSTER), /🎭 a, b, c, d, e \+2/);
});

test('posts with pings, edits on a change and when a nick resolves', async () => {
  process.env.DISCORD_BOT_TOKEN = 'x';
  process.env.TRACKED_LIST_CHANNEL_ID = '999999';
  const Sweat = mongoose.model('TSweat', new mongoose.Schema({
    username: String, uuid: String, star: Number, fkdr: Number, wlr: Number,
    milo: Boolean, potat: Boolean, aballs: Boolean, cheating: Boolean, boosting: Boolean,
    deletedAt: Date, trackedPost: mongoose.Schema.Types.Mixed
  }));
  const resolvedHttp = fakeHttp();
  delete process.env.RESOLVED_NICKS_CHANNEL_ID;
  const resolved = setupResolved({ mongoose, http: resolvedHttp });
  const http = fakeHttp();
  const list = setupTrackedList({ Sweat, ROSTER_FIELDS: ROSTER, resolved, http, gapMs: 0, roster: new Map([['111111', 'milo'], ['222222', 'potat']]) });

  const uuid = '0123456789abcdef0123456789abcdef';
  await resolved.record([{ nick: 'OldNick', player: 'Victim', uuid, source: 'Proxy', seenAt: Date.now() - 1000 }]);
  const s = await Sweat.create({ username: 'Victim', uuid: '01234567-89ab-cdef-0123-456789abcdef', star: 500, fkdr: 10, wlr: 4, milo: true, potat: true });
  await list.post(s.toObject());
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/channels/999999/messages');
  assert.deepEqual(http.calls[0].body.allowed_mentions, { users: ['111111', '222222'] });
  assert.equal(http.calls[0].body.content, '**Victim** · 500✫ · 10.00 FKDR · 4.00 WLR · 🎭 OldNick · ⚔️ <@111111> <@222222>');
  const saved = await Sweat.findById(s._id).lean();
  assert.equal(saved.trackedPost.messageId, '101');

  // Nothing changed: no edit.
  await list.refresh(saved);
  assert.equal(http.calls.length, 1);

  // A nick resolves later: the line is edited, without pinging again.
  await resolved.record([{ nick: 'NewNick', player: 'Victim', uuid, source: 'Proxy', seenAt: Date.now() }]);
  await resolved._idle();
  for (let i = 0; i < 50 && http.calls.length < 2; i++) await new Promise(r => setTimeout(r, 20));
  await list._idle();
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[1].method, 'patch');
  assert.equal(http.calls[1].url, '/channels/999999/messages/101');
  assert.deepEqual(http.calls[1].body.allowed_mentions, { parse: [] });
  assert.match(http.calls[1].body.content, /🎭 NewNick, OldNick/);

  // Someone else takes OldNick over: it leaves Victim's line.
  await resolved.record([{ nick: 'OldNick', player: 'Other', source: 'Proxy', seenAt: Date.now() + 5 }]);
  await resolved._idle();
  for (let i = 0; i < 50 && http.calls.length < 3; i++) await new Promise(r => setTimeout(r, 20));
  await list._idle();
  assert.equal(http.calls.length, 3);
  assert.match(http.calls[2].body.content, /🎭 NewNick · ⚔️/);

  // Removed: struck through.
  const removed = await Sweat.findByIdAndUpdate(s._id, { $set: { deletedAt: new Date() } }, { new: true }).lean();
  await list.refresh(removed);
  assert.match(http.calls[3].body.content, /^~~.*~~ \(removed\)$/);
});
