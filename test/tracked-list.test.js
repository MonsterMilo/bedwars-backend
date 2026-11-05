// Tracked list channel: the one-line message, pings, and nick updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupTrackedList = require('../tracked-list');
const { lineOf, messageOf } = setupTrackedList;
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

test('the message: lines, then nicks, then one ping line', () => {
  const idOf = f => ({ milo: '111111' }[f] || null);
  const a = { username: 'Frost_Byte', star: 642.7, fkdr: 9.871, milo: true };
  const b = { username: 'PixelReaper', star: 1103, fkdr: 14.2, milo: true, potat: true, cheating: true };
  assert.equal(messageOf([{ sweat: a, monthly: 23.4, nick: 'xXShadowXx' }, { sweat: b, monthly: 12 }], [{ nick: 'Nicker_Nicker' }, { nick: 'Old', player: 'Real' }], idOf, ROSTER), [
    '**Frost\\_Byte** · 642✫ · 9.87 FKDR · 23.40 MFKDR',
    '**PixelReaper** · 1103✫ · 14.20 FKDR · cheating',
    'Nicks: Nicker\\_Nicker, Old (Real), xXShadowXx (Frost\\_Byte)',
    'Beaten by <@111111> Potat'
  ].join('\n'));
  assert.equal(messageOf([{ sweat: { ...a, milo: false } }], [], idOf, ROSTER), '**Frost\\_Byte** · 642✫ · 9.87 FKDR');
  // A nick on its own, with who beat it.
  assert.equal(messageOf([], [{ nick: 'Nick', beaten: ['milo'] }], idOf, ROSTER), 'Nicks: Nick\nBeaten by <@111111>');
  assert.equal(lineOf({ ...a, deletedAt: new Date() }), '~~**Frost\\_Byte** · 642✫ · 9.87 FKDR~~ (removed)');
});

test('a party with a nick shares one message; the nick resolves, then its player joins it', async () => {
  process.env.DISCORD_BOT_TOKEN = 'x';
  process.env.TRACKED_LIST_CHANNEL_ID = '999999';
  const Sweat = mongoose.model('TSweat', new mongoose.Schema({
    username: String, uuid: String, star: Number, fkdr: Number, wlr: Number,
    milo: Boolean, potat: Boolean, aballs: Boolean, cheating: Boolean, boosting: Boolean,
    deletedAt: Date, trackedPost: mongoose.Schema.Types.Mixed
  }));
  delete process.env.RESOLVED_NICKS_CHANNEL_ID;
  const resolved = setupResolved({ mongoose, http: fakeHttp() });
  const http = fakeHttp();
  const uuid = '0123456789abcdef0123456789abcdef';
  const list = setupTrackedList({
    mongoose, Sweat, ROSTER_FIELDS: ROSTER, resolved, http, gapMs: 0, groupMs: 60000,
    roster: new Map([['111111', 'milo'], ['222222', 'potat']]),
    monthlyFkdr: async id => (id === uuid ? 31.5 : 3)
  });
  const wait = async n => {
    for (let i = 0; i < 100 && http.calls.length < n; i++) await new Promise(r => setTimeout(r, 20));
    await list._idle();
  };

  // The victim has old nicks on the resolved list: they are NOT shown.
  await resolved.record([{ nick: 'AncientNick', player: 'Victim', uuid, source: 'Proxy', seenAt: Date.now() - 1e6 }]);
  const s1 = await Sweat.create({ username: 'Victim', uuid, star: 500, fkdr: 10, milo: true });
  await list.post(s1.toObject());
  await list.postNicks(['NickerNicker', 'bad name!'], ['milo', 'nobody']);
  await list.flush({ force: true });
  assert.equal(http.calls.length, 1);
  assert.deepEqual(http.calls[0].body.allowed_mentions, { users: ['111111'] });
  assert.equal(http.calls[0].body.content, [
    '**Victim** · 500✫ · 10.00 FKDR · 31.50 MFKDR',
    'Nicks: NickerNicker',
    'Beaten by <@111111>'
  ].join('\n'));

  // Nothing changed: no edit.
  await list.refresh(await Sweat.findById(s1._id).lean());
  assert.equal(http.calls.length, 1);

  // NickerNicker resolves: the real name goes next to it, no ping.
  await resolved.record([{ nick: 'NickerNicker', player: 'Sneaky', source: 'Proxy', seenAt: Date.now() }]);
  await resolved._idle();
  await wait(2);
  assert.equal(http.calls[1].method, 'patch');
  assert.equal(http.calls[1].url, '/channels/999999/messages/101');
  assert.deepEqual(http.calls[1].body.allowed_mentions, { parse: [] });
  assert.match(http.calls[1].body.content, /^Nicks: NickerNicker \(Sneaky\)$/m);

  // The proxy adds Sneaky as that nick: their line joins the same message.
  const s2 = await Sweat.create({ username: 'Sneaky', uuid: 'ffffffffffffffffffffffffffffffff', star: 300, fkdr: 5, milo: true });
  await list.post(s2.toObject(), { nick: 'NickerNicker' });
  await wait(3);
  assert.equal(http.calls.length, 3);
  assert.equal(http.calls[2].method, 'patch');
  assert.equal(http.calls[2].body.content, [
    '**Victim** · 500✫ · 10.00 FKDR · 31.50 MFKDR',
    '**Sneaky** · 300✫ · 5.00 FKDR',
    'Nicks: NickerNicker (Sneaky)',
    'Beaten by <@111111>'
  ].join('\n'));

  // Waiting things live in Mongo: a fresh instance (a restart) posts them;
  // a sweat removed while waiting is left out.
  const s3 = await Sweat.create({ username: 'Gone', star: 1, fkdr: 1 });
  const s4 = await Sweat.create({ username: 'Kept', star: 2, fkdr: 2, potat: true });
  await list.post(s3.toObject());
  await list.post(s4.toObject());
  await Sweat.updateOne({ _id: s3._id }, { $set: { deletedAt: new Date() } });
  const restarted = setupTrackedList({ mongoose, Sweat, ROSTER_FIELDS: ROSTER, resolved, http, gapMs: 0, groupMs: 0, roster: new Map([['222222', 'potat']]) });
  await restarted.flush();
  assert.equal(http.calls.length, 4);
  assert.equal(http.calls[3].body.content, '**Kept** · 2✫ · 2.00 FKDR\nBeaten by <@222222>');
  assert.equal((await Sweat.findById(s3._id).lean()).trackedPost, null);
  assert.equal((await Sweat.findById(s4._id).lean()).trackedPost.messageId, '102');
  http.calls.splice(3, 1);

  // Removed: struck through.
  const removed = await Sweat.findByIdAndUpdate(s2._id, { $set: { deletedAt: new Date() } }, { new: true }).lean();
  await list.refresh(removed);
  assert.match(http.calls[3].body.content, /^~~\*\*Sneaky\*\*.*~~ \(removed\)$/m);
  assert.doesNotMatch(http.calls[3].body.content, /Nicks:/);
});
