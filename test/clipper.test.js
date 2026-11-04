// Clip tests: a small made-up Bed Wars game (game-fixture.js), read back,
// searched for moments and cut. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readRecording, findMoments, cutClips, windowsFor, P } = require('../clipper');
const { game, ME, MATE, SWEAT, FAR } = require('./game-fixture');

const tracked = [{ uuid: SWEAT, username: 'Sweaty' }, { uuid: FAR, username: 'Faraway' }];

test('findMoments keeps close final kills and bed breaks by your team', () => {
  const rec = readRecording(game());
  const { self, moments } = findMoments(rec, tracked);
  assert.deepEqual(self, { name: 'Milo', team: 'Blue', uuid: ME });
  const byKey = Object.fromEntries(moments.map(m => [`${m.kind}:${m.username}`, m]));
  assert.equal(moments.length, 4);
  // The sweat's bed (broken by a teammate, close by) and their final kill.
  assert.equal(byKey['bed:Sweaty'].ok, true);
  assert.equal(byKey['bed:Sweaty'].by, 'Mate');
  assert.equal(byKey['final:Sweaty'].ok, true);
  assert.equal(byKey['final:Sweaty'].by, 'Milo');
  // Closest across the ground in the 3 s before (they were walking away).
  assert.equal(byKey['final:Sweaty'].distance, 30);
  assert.equal(byKey['final:Sweaty'].inView, 1);
  // You broke the far player's bed yourself: that one counts.
  assert.equal(byKey['bed:Faraway'].ok, true);
  // Their final kill was 150 blocks away: skipped.
  assert.equal(byKey['final:Faraway'].ok, false);
  assert.equal(byKey['final:Faraway'].reason, 'too far');
});

test('moments that are not your team\'s, or not tracked, are not clipped', () => {
  const rec = readRecording(game());
  const { moments } = findMoments(rec, [{ uuid: MATE, username: 'Mate' }]);
  assert.equal(moments.length, 0);
  // A teammate's break counts only close to you; your own kills only need
  // the player in view.
  const strict = findMoments(rec, tracked, { maxDistance: 1 }).moments;
  const bed = strict.find(m => m.kind === 'bed' && m.username === 'Sweaty');
  assert.equal(bed.ok, false);
  assert.equal(bed.reason, 'too far');
  assert.equal(strict.find(m => m.kind === 'final' && m.username === 'Sweaty').ok, true);
});

test('cutClips writes a clip that starts with the world as it stood', () => {
  const rec = readRecording(game());
  const { moments } = findMoments(rec, tracked);
  const final = moments.find(m => m.kind === 'final' && m.username === 'Sweaty');
  const [clip] = cutClips(rec, windowsFor([final]));
  assert.equal(clip.durationMs, 15000);
  const out = readRecording(clip.bytes);
  assert.equal(out.meta.duration, 15000);
  assert.equal(out.meta.date, 1762000000000 + 23000);
  const at0 = []; const later = [];
  for (let k = 0; k < out.n; k++) (out.t[k] === 0 ? at0 : later).push(k);
  const ids0 = at0.map(k => out.id[k]);
  // Join, tab list, teams, chunks, then the players (spawn + teleport).
  assert.equal(ids0[0], P.JOIN);
  assert.ok(ids0.indexOf(P.PLAYER_LIST) < ids0.indexOf(P.SPAWN_PLAYER));
  assert.equal(ids0.filter(id => id === P.SPAWN_PLAYER).length, 4);
  // Only the map around the moment: 7 chunks each way of x=10 -> cx -7..7 (x 3 rows... 5 rows).
  assert.equal(ids0.filter(id => id === P.CHUNK).length, (7 - -7 + 1) * 5);
  // The sweat walked 1/16 block per packet, 459 packets before the window.
  const tp = at0.filter(k => out.id[k] === P.TELEPORT).map(k => {
    const dv = new DataView(out.rec.buffer, out.rec.byteOffset);
    return { eid: out.rec[out.body[k]], x: dv.getInt32(out.body[k] + 1) / 32 };
  }).find(x => x.eid === 3);
  assert.equal(tp.x, 10 - 459 * 2 / 32);
  // Merged metadata: the crouch from t=5s is there.
  assert.ok(ids0.includes(P.METADATA));
  // The window itself, shifted to start at 0; no keepalives, no party chat.
  assert.ok(later.every(k => out.t[k] > 0 && out.t[k] <= 15000));
  assert.ok(!later.some(k => out.id[k] === P.KEEPALIVE));
  const chats = later.filter(k => out.id[k] === P.CHAT).map(k => Buffer.from(out.rec.subarray(out.body[k], out.end[k])).toString('utf8'));
  assert.equal(chats.length, 4);
  assert.ok(!chats.some(c => /Party/.test(c)));
});

test('a clip window before any packet still has a valid start', () => {
  const rec = readRecording(game());
  const [clip] = cutClips(rec, [{ from: 0, to: 2000, focus: null }]);
  const out = readRecording(clip.bytes);
  assert.equal(out.id[0], P.JOIN);
  assert.ok(out.n > 10);
});

test('a tracked player who played under a nick is found by it', () => {
  const rec = readRecording(game());
  const { moments } = findMoments(rec, [{ uuid: 'e'.repeat(32), username: 'RealName', nick: 'Sweaty' }]);
  const final = moments.find(m => m.kind === 'final');
  assert.equal(final.username, 'RealName');
  assert.equal(final.victim, 'Sweaty');
  assert.equal(final.ok, true);
});

test('/clip: the 20 s before, with everyone who came near you', () => {
  const rec = readRecording(game());
  const { moments } = findMoments(rec, [], { manual: [34000] });
  assert.equal(moments.length, 1);
  const m = moments[0];
  assert.equal(m.kind, 'manual');
  assert.equal(m.ok, true);
  assert.equal(m.follow, 'Milo');
  // Opponents first; the far player wasn't near.
  assert.deepEqual(m.people.map(p => p.name), ['Sweaty', 'Mate']);
  const [w] = windowsFor(moments);
  assert.deepEqual([w.from, w.to, w.marker], [14000, 35000, 'Clip']);
});
