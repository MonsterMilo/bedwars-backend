// Party chat relay: line format, packing, and the bot's posts.
const test = require('node:test');
const assert = require('node:assert/strict');
const setupPartyChat = require('../party-chat');
const { lineOf, pack } = setupPartyChat;

function fakeHttp() {
  const calls = [];
  const client = { post: async (url, body) => { calls.push({ url, body }); return { data: { id: '1' } }; } };
  return { calls, create: () => client };
}

test('a line: bold rank and name, markdown and pings shown as typed', () => {
  assert.equal(lineOf({ rank: '[MVP+]', name: 'Frost_Byte', text: 'gg' }), '**\\[MVP+\\] Frost\\_Byte**: gg');
  assert.equal(lineOf({ name: 'Bob', text: '*hi* @everyone' }), '**Bob**: \\*hi\\* @​everyone');
  assert.equal(lineOf({ name: '§bBob', text: '§fhey' }), '**Bob**: hey');
});

test('lines pack into as few messages as fit', () => {
  assert.deepEqual(pack(['a', 'b']), ['a\nb']);
  assert.deepEqual(pack(['a'.repeat(1000), 'b'.repeat(1000), 'c']).map(s => s.length), [1000, 1002]);
});

test('lines close together go out as one message, nobody pinged, no previews', async () => {
  process.env.DISCORD_BOT_TOKEN = 'x';
  process.env.PARTY_CHAT_CHANNEL_ID = '424242';
  const http = fakeHttp();
  const relay = setupPartyChat({ http, gapMs: 0 });
  assert.equal(relay.add([{ name: 'A', text: 'one' }, { name: 'B', rank: '[VIP]', text: 'two' }, { name: 'C', text: '   ' }]), 2);
  await relay._idle();
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/channels/424242/messages');
  assert.deepEqual(http.calls[0].body, { content: '**A**: one\n**\\[VIP\\] B**: two', allowed_mentions: { parse: [] }, flags: 4 });
});

test('off without a bot token or with "off"', () => {
  process.env.DISCORD_BOT_TOKEN = 'x';
  process.env.PARTY_CHAT_CHANNEL_ID = 'off';
  assert.equal(setupPartyChat({ http: fakeHttp() }).on, false);
  delete process.env.PARTY_CHAT_CHANNEL_ID;
  assert.equal(setupPartyChat({ http: fakeHttp() }).channelId, '1436857345509691504');
  delete process.env.DISCORD_BOT_TOKEN;
  assert.equal(setupPartyChat({ http: fakeHttp() }).on, false);
});
