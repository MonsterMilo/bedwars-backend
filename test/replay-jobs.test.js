// Replay jobs (replay-jobs.js): one replay in memory at a time, read in a
// worker that's stopped after, and games too long for the server skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const jobs = require('../replay-jobs');
const { game, SWEAT } = require('./game-fixture');

test('jobs take turns, in order, even when one fails', async () => {
  const log = [];
  const slow = (name, ms, fail) => jobs.exclusive(async () => {
    log.push(name + ' start');
    await new Promise(r => setTimeout(r, ms));
    log.push(name + ' end');
    if (fail) throw new Error(name + ' failed');
    return name;
  });
  const a = slow('a', 30);
  const b = slow('b', 5, true);
  const c = slow('c', 1);
  assert.equal(jobs.state().waiting + jobs.state().running, 3);
  assert.equal(await a, 'a');
  await assert.rejects(b, /b failed/);
  assert.equal(await c, 'c');
  assert.deepEqual(log, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  await jobs.idle();
  assert.deepEqual(jobs.state(), { running: 0, waiting: 0 });
});

test('things that can let go of memory are asked to first', async () => {
  let asked = 0;
  jobs.beforeEach(() => { asked++; });
  jobs.beforeEach(() => { throw new Error('never blocks a job'); });
  assert.equal(await jobs.exclusive(async () => asked), 1);
});

test('the unpacked size comes from the zip, and long games are skipped', () => {
  const file = Buffer.from(game());
  const size = jobs.recordingSize(file);
  assert.ok(size > 1000);
  assert.equal(jobs.checkSize(file), size);
  assert.throws(() => jobs.checkSize(file, size - 1), /too long to read on the server/);
  // A zip of something else: no size, nothing refused.
  assert.equal(jobs.recordingSize(Buffer.from(zipSync({ 'other.txt': new Uint8Array(5) }))), null);
  assert.equal(jobs.recordingSize(Buffer.from('not a zip at all, just some text')), null);
});

test('a clip job runs in a worker of its own, and the worker stops after', async () => {
  const out = await jobs.run({ kind: 'clips', bytes: Buffer.from(game()), players: [{ uuid: SWEAT, username: 'Sweaty' }], manual: [] }, { inProcess: false });
  assert.ok(out.moments.some(m => m.ok && m.username === 'Sweaty'));
  assert.equal(out.cuts.length, out.moments.filter(m => m.ok).length);
  assert.ok(out.cuts.every(c => c.bytes.length > 0 && c.durationMs > 0));
  // A broken file is an error from the worker, not a crash.
  await assert.rejects(jobs.run({ kind: 'clips', bytes: Buffer.from('nope'), players: [] }, { inProcess: false }));
  await assert.rejects(jobs.run({ kind: 'what' }, { inProcess: false }), /Unknown replay job/);
});

test('the card worker stops when idle, and starts again for the next card', async () => {
  const cards = require('../cards');
  const card = () => cards.render(cards.sweatCard({ username: `Idle${Math.random()}`, star: 1, fkdr: 1, wlr: 1 }, cards.THEME_IDS[0], { footer: ['a'] }));
  assert.equal((await card()).subarray(1, 4).toString(), 'PNG');
  assert.equal(cards.stopIdleWorker(), true);
  assert.equal(cards.stopIdleWorker(), false); // nothing left to stop
  assert.equal((await card()).subarray(1, 4).toString(), 'PNG');
  cards.stopIdleWorker();
});

test('reading a replay piece by piece gives the same packets, clips and maps as unpacking it whole', () => {
  const { zipSync } = require('fflate');
  const stream = require('../tmcpr-stream');
  const clipper = require('../clipper');
  const file = Buffer.from(game());
  const whole = clipper.readRecording(file);
  // Tiny pieces, so packets are split across them; and a stored (unpacked) zip.
  const stored = Buffer.from(zipSync({ 'recording.tmcpr': whole.rec, 'metaData.json': Buffer.from(JSON.stringify(whole.meta)) }, { level: 0 }));
  for (const [zip, piece] of [[file, 7], [file, 64 * 1024], [stored, 5]]) {
    const seen = [];
    stream.eachRecord(zip, (t, b) => { seen.push([t, Buffer.from(b).toString('hex')]); }, { piece });
    assert.equal(seen.length, whole.n);
    for (let k = 0; k < whole.n; k++) {
      assert.equal(seen[k][0], whole.t[k]);
      assert.equal(seen[k][1], Buffer.from(whole.rec.subarray(whole.at[k], whole.end[k])).toString('hex'));
    }
  }
  // Stops when asked.
  let count = 0;
  stream.eachRecord(file, () => ++count < 3);
  assert.equal(count, 3);

  const tracked = [{ uuid: SWEAT, username: 'Sweaty' }];
  const opened = clipper.openRecording(file);
  assert.deepEqual(opened.meta, whole.meta);
  const a = clipper.findMoments(whole, tracked, { manual: [34000] });
  const b = clipper.findMoments(opened, tracked, { manual: [34000] });
  assert.deepEqual(b, a);
  const ca = clipper.cutClips(whole, clipper.windowsFor(a.moments));
  const cb = clipper.cutClips(opened, clipper.windowsFor(b.moments));
  assert.equal(cb.length, ca.length);
  for (let i = 0; i < ca.length; i++) assert.ok(Buffer.from(cb[i].bytes).equals(Buffer.from(ca[i].bytes)), `clip ${i}`);
});
