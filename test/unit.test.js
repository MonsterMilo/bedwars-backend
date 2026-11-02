// Unit tests: run with `npm test` (node's built-in test runner).
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScraped, mergeEntries } = require('../denick');
const { recapSlot, previousSlot } = require('../discord');
const { presign } = require('../replays');
const { toMs } = require('../resolved');

test('parseScraped builds nick and player maps, newest first', () => {
  const data = parseScraped({ nicks: [
    ['NickA', [['Old', 1, 100, 200, 'Map (Solos)'], ['New', 2, 300, 400, 'Map (Doubles)', 'A'.repeat(32)]]],
    ['bad'], [5, []], ['Empty', []]
  ] });
  assert.equal(data.byNick.size, 1);
  const a = data.byNick.get('nicka');
  assert.equal(a.owners[0].player, 'New');
  assert.equal(a.owners[0].last, 400000);
  assert.equal(a.owners[0].uuid, 'a'.repeat(32));
  assert.equal(data.byPlayer.get('old')[0].nick, 'NickA');
  assert.equal(data.newest, 400000);
});

test('mergeEntries keeps the newest row per key and notes the other sources', () => {
  const out = mergeEntries([
    { username: 'Steve', nick: 'N', updated: 1, source: 'Diamond Dome' },
    { username: 'steve', nick: 'N', updated: 5, source: 'Denicker API' },
    { username: 'Alex', nick: 'N', updated: 3, source: 'Bedlify' }
  ], 'username');
  assert.deepEqual(out.map(e => [e.username, e.source, e.alsoIn]), [
    ['steve', 'Denicker API', ['Diamond Dome']],
    ['Alex', 'Bedlify', []]
  ]);
});

test('recap slots are Sunday 8pm New York, across both clock changes', () => {
  assert.equal(recapSlot(new Date('2026-11-02T06:00:00Z')).toISOString(), '2026-11-02T01:00:00.000Z'); // EST
  assert.equal(recapSlot(new Date('2026-11-02T00:59:00Z')).toISOString(), '2026-10-26T00:00:00.000Z'); // EDT
  assert.equal(recapSlot(new Date('2026-03-09T00:30:00Z')).toISOString(), '2026-03-09T00:00:00.000Z');
  assert.equal(previousSlot(new Date('2026-11-02T01:00:00Z')).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(previousSlot(new Date('2026-03-09T00:00:00Z')).toISOString(), '2026-03-02T01:00:00.000Z');
});

test('presign gives a SigV4 URL on the bucket host', () => {
  const url = new URL(presign({
    method: 'PUT', bucket: 'b', endpoint: 's3.us-west-004.backblazeb2.com', region: 'us-west-004',
    keyId: 'KEY', secret: 'SECRET', key: 'replays/x y.mcpr', expires: 900, now: new Date('2026-11-02T00:00:00Z')
  }));
  assert.equal(url.host, 'b.s3.us-west-004.backblazeb2.com');
  assert.equal(url.pathname, '/replays/x%20y.mcpr');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'KEY/20261102/us-west-004/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

test('toMs reads ms, Unix seconds and dates', () => {
  assert.equal(toMs(1700000000), 1700000000000);
  assert.equal(toMs(1700000000000), 1700000000000);
  assert.equal(toMs('2026-11-02T00:00:00Z'), Date.UTC(2026, 10, 2));
  assert.equal(toMs(undefined), 0);
});

test('every card theme draws a PNG (in the worker)', async () => {
  const cards = require('../cards');
  for (const theme of cards.THEME_IDS) {
    const png = await cards.render(cards.sweatCard({ username: `T${theme}`, star: 1234, fkdr: 5, wlr: 2, milo: true }, theme, { footer: ['a', 'b'] }));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', theme);
  }
});
