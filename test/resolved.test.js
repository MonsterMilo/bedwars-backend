// Resolved nicks channel: new and reconfirmed denicks both get posted.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const setupResolved = require('../resolved');

let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('resolvedtest'));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

function fakeHttp() {
  const calls = [];
  let n = 500;
  const client = {
    post: async (url, body) => { calls.push({ method: 'post', url, body }); return { data: { id: String(++n) } }; },
    patch: async (url, body) => { calls.push({ method: 'patch', url, body }); return { data: {} }; },
    delete: async url => { calls.push({ method: 'delete', url }); return { data: {} }; }
  };
  return { calls, create: () => client };
}
const waitFor = async (fn, ms = 8000) => {
  for (let t = 0; t < ms && !fn(); t += 25) await new Promise(r => setTimeout(r, 25));
  assert.ok(fn(), 'timed out');
};

test('a reconfirmed denick is posted again, a quiet load or an instant repeat is not', async () => {
  process.env.DISCORD_BOT_TOKEN = 'x';
  process.env.RESOLVED_NICKS_CHANNEL_ID = '777';
  process.env.RESOLVED_NICKS_CATCHUP = 'off';
  const http = fakeHttp();
  const resolved = setupResolved({ mongoose, http });
  const posts = () => http.calls.filter(c => c.method === 'post');
  const uuid = 'abcdefabcdefabcdefabcdefabcdef12';
  const t0 = Date.now() - 10 * 3600e3;

  await resolved.record([{ nick: 'SkinNick', player: 'Real', uuid, source: 'Cosmetics', seenAt: t0 }]);
  await waitFor(() => posts().length === 1);
  assert.match(posts()[0].body.embeds[0].title, /🔓/);

  // Seen again a minute later: too soon, stays quiet.
  await resolved.record([{ nick: 'SkinNick', player: 'Real', uuid, source: 'Proxy', seenAt: t0 + 60e3 }]);
  // A gist load: quiet.
  await resolved.record([{ nick: 'SkinNick', player: 'Real', uuid, source: 'Diamond Dome', seenAt: t0 + 3 * 3600e3 }], { quiet: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(posts().length, 1);

  // Reconfirmed hours later by another denick: a fresh post, the old one taken out.
  await resolved.record([{ nick: 'SkinNick', player: 'Real', uuid, source: 'Cosmetics', seenAt: t0 + 6 * 3600e3 }]);
  await waitFor(() => posts().length === 2 && http.calls.some(c => c.method === 'delete'));
  const embed = posts()[1].body.embeds[0];
  assert.match(embed.title, /✅/);
  assert.match(embed.description, /reconfirmed/);
});

test('a nick only ever taken in quietly is posted once a live denick confirms it', async () => {
  const http = fakeHttp();
  delete require.cache[require.resolve('../resolved')];
  const resolved = require('../resolved')({ mongoose, http });
  const posts = () => http.calls.filter(c => c.method === 'post');
  const t0 = Date.now() - 3600e3;
  await resolved.record([{ nick: 'GistNick', player: 'Someone', source: 'Diamond Dome', seenAt: t0 }], { quiet: true });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(posts().length, 0);
  await resolved.record([{ nick: 'GistNick', player: 'Someone', source: 'Cosmetics', seenAt: t0 + 60e3 }]);
  await waitFor(() => posts().length === 1);
});
