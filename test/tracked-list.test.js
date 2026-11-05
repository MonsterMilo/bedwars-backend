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
  const a = { username: 'Frost_Byte', star: 642.7, fkdr: 9.871, wlr: 4.12, milo: true };
  const b = { username: 'PixelReaper', star: 1103, fkdr: 14.2, wlr: 6.55, milo: true, potat: true, cheating: true };
  assert.equal(messageOf([{ sweat: a, nicks: ['xXShadowXx'], monthly: 23.4 }, { sweat: b, nicks: ['Lunar_Wolf'], monthly: 12 }], idOf, ROSTER), [
    '**Frost\\_Byte** · 642✫ · 9.87 FKDR · 23.40 MFKDR',
    '**PixelReaper** · 1103✫ · 14.20 FKDR · cheating',
    'Nicks: xXShadowXx (Frost\\_Byte), Lunar\\_Wolf (PixelReaper)',
    'Beaten by <@111111> Potat'
  ].join('\n'));
  // One player: nicks without the name; none: no nick line.
  assert.equal(messageOf([{ sweat: a, nicks: ['N1', 'N2'] }], idOf, ROSTER), '**Frost\\_Byte** · 642✫ · 9.87 FKDR\nNicks: N1, N2\nBeaten by <@111111>');
  assert.equal(messageOf([{ sweat: { ...a, milo: false }, nicks: [] }], idOf, ROSTER), '**Frost\\_Byte** · 642✫ · 9.87 FKDR');
  assert.equal(lineOf({ ...a, deletedAt: new Date() }), '~~**Frost\\_Byte** · 642✫ · 9.87 FKDR~~ (removed)');
  assert.match(messageOf([{ sweat: a, nicks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }], idOf, ROSTER), /Nicks: a, b, c, d, e \+2/);
});

test('a party shares one message; edits and resolved nicks redraw it', async () => {
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
    Sweat, ROSTER_FIELDS: ROSTER, resolved, http, gapMs: 0, groupMs: 60000,
    roster: new Map([['111111', 'milo'], ['222222', 'potat']]),
    monthlyFkdr: async id => (id === uuid ? 31.5 : 3)
  });

  await resolved.record([{ nick: 'OldNick', player: 'Victim', uuid, source: 'Proxy', seenAt: Date.now() - 1000 }]);
  const s1 = await Sweat.create({ username: 'Victim', uuid: '01234567-89ab-cdef-0123-456789abcdef', star: 500, fkdr: 10, wlr: 4, milo: true });
  const s2 = await Sweat.create({ username: 'Mate', uuid: 'ffffffffffffffffffffffffffffffff', star: 300, fkdr: 5, wlr: 2, potat: true });
  list.post(s1.toObject());
  list.post(s2.toObject());
  await list.flush();
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/channels/999999/messages');
  assert.deepEqual(http.calls[0].body.allowed_mentions, { users: ['111111', '222222'] });
  assert.equal(http.calls[0].body.content, [
    '**Victim** · 500✫ · 10.00 FKDR · 31.50 MFKDR',
    '**Mate** · 300✫ · 5.00 FKDR',
    'Nicks: OldNick (Victim)',
    'Beaten by <@111111> <@222222>'
  ].join('\n'));
  const saved = await Sweat.findById(s1._id).lean();
  assert.equal(saved.trackedPost.messageId, '101');
  assert.equal(saved.trackedPost.monthly, 31.5);

  // Nothing changed: no edit.
  await list.refresh(saved);
  assert.equal(http.calls.length, 1);

  // A nick resolves later: edited, without pinging again; monthly kept.
  await resolved.record([{ nick: 'NewNick', player: 'Victim', uuid, source: 'Proxy', seenAt: Date.now() }]);
  await resolved._idle();
  for (let i = 0; i < 50 && http.calls.length < 2; i++) await new Promise(r => setTimeout(r, 20));
  await list._idle();
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[1].method, 'patch');
  assert.equal(http.calls[1].url, '/channels/999999/messages/101');
  assert.deepEqual(http.calls[1].body.allowed_mentions, { parse: [] });
  assert.match(http.calls[1].body.content, /31\.50 MFKDR/);
  assert.match(http.calls[1].body.content, /Nicks: NewNick, OldNick \(Victim\)/);

  // Mate removed: struck through, and their beater leaves the ping line.
  const removed = await Sweat.findByIdAndUpdate(s2._id, { $set: { deletedAt: new Date() } }, { new: true }).lean();
  await list.refresh(removed);
  assert.match(http.calls[2].body.content, /^~~\*\*Mate\*\*.*~~ \(removed\)$/m);
  assert.match(http.calls[2].body.content, /Beaten by <@111111>$/);
});
