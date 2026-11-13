// Match stats from a replay (match-replay.js, through clipper.findMoments):
// a made-up 2v2 game with pickups, a push onto the enemy island and the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const { readRecording, findMoments, packet, writeRecording, P } = require('../clipper');
const { pk, ME, MATE, SWEAT, FAR } = require('./game-fixture');

const str = (w, s) => { const b = Buffer.from(s, 'utf8'); w.varint(b.length); w.raw(b); };
const i16 = (w, v) => w.raw(Uint8Array.of((v >> 8) & 0xff, v & 0xff));
const more = {
  // A dropped item (object type 2), then its stack in metadata entry 10.
  item: (eid, x, y, z) => packet(P.SPAWN_OBJECT, w => { w.varint(eid); w.i8(2); w.i32(x * 32); w.i32(y * 32); w.i32(z * 32); w.i8(0); w.i8(0); w.i32(1); i16(w, 0); i16(w, 0); i16(w, 0); }),
  stack: (eid, id, n) => packet(P.METADATA, w => { w.varint(eid); w.i8(0); w.i8(0); w.i8((5 << 5) | 10); i16(w, id); w.i8(n); i16(w, 0); w.i8(0); w.raw(Uint8Array.of(0x7f)); }),
  collect: (item, by) => packet(P.COLLECT, w => { w.varint(item); w.varint(by); }),
  title: (text) => packet(P.TITLE, w => { w.varint(0); str(w, JSON.stringify({ text })); }),
  teleport: (eid, x, y, z) => packet(P.TELEPORT, w => { w.varint(eid); w.i32(x * 32); w.i32(y * 32); w.i32(z * 32); w.i8(0); w.i8(0); w.bool(true); })
};

/** Milo + Mate (Blue, island at z -80) against Sweaty + Faraway (Red,
 *  island at x 80). Everyone waits on the platform over the middle, the
 *  start line comes at 2 s and they're moved to their islands 0.5 s later.
 *  Milo walks onto Red's island at 20 s and stands there with Sweaty until
 *  Red's bed goes at 35 s. */
function game({ end = null, late = false } = {}) {
  const items = [];
  const at = (t, b) => items.push([t, b]);
  at(0, pk.join(1));
  at(0, pk.tabAdd([[ME, 'Milo'], [MATE, 'Mate'], [SWEAT, 'Sweaty'], [FAR, 'Faraway']]));
  at(0, pk.team('Blue1', ['Milo', 'Mate']));
  at(0, pk.team('Red1', ['Sweaty', 'Faraway']));
  [[1, ME], [2, MATE], [3, SWEAT], [4, FAR]].forEach(([eid, u], k) => at(0, pk.spawn(eid, u, k, 120, 0)));
  if (!late) at(2000, pk.chat('Protect your bed and destroy the enemy beds.'));
  at(2500, more.teleport(1, 0, 65, -80));
  at(2500, more.teleport(2, 2, 65, -80));
  at(2500, more.teleport(3, 80, 65, 0));
  at(2500, more.teleport(4, 80, 65, 2));
  for (let t = 2600; t <= 5000; t += 200) { at(t, pk.move(1, 0, 0, 0.1)); at(t, pk.move(3, 0, 0, 0.1)); at(t, pk.move(4, 0, 0, 0.1)); }
  // Pickups: two diamonds and an iron for Milo, an emerald for Mate, gold for
  // Sweaty (not ours), and a diamond nobody's metadata named (skipped).
  at(6000, more.item(100, 0, 65, -82)); at(6000, more.stack(100, 264, 2)); at(6500, more.collect(100, 1));
  at(6000, more.item(101, 0, 65, -82)); at(6000, more.stack(101, 265, 1)); at(6600, more.collect(101, 1));
  at(7000, more.item(102, 2, 65, -82)); at(7000, more.stack(102, 388, 1)); at(7500, more.collect(102, 2));
  at(7000, more.item(103, 80, 65, 2)); at(7000, more.stack(103, 266, 3)); at(7500, more.collect(103, 3));
  at(8000, more.item(104, 0, 65, -82)); at(8500, more.collect(104, 1));
  // Milo walks over: on Red's island from 20 s to 35 s (bed gone), then back.
  at(20000, more.teleport(1, 75, 65, 0));
  for (let t = 20200; t <= 40000; t += 200) at(t, pk.move(1, 0, 0, 0));
  at(12000, pk.chat('Mate was knocked into the void by Sweaty.'));
  at(35000, pk.chat('BED DESTRUCTION > Red Bed was destroyed by Milo!'));
  at(38000, pk.chat('Sweaty was killed by Milo. FINAL KILL!'));
  if (end === 'win') { at(39000, pk.chat('Faraway was killed by Mate. FINAL KILL!')); at(39500, more.title('VICTORY!')); }
  at(40000, pk.keepalive());
  items.sort((a, b) => a[0] - b[0]);
  const meta = { serverName: 'mc.hypixel.net', duration: 40000, date: 1762000000000, protocol: 47, generator: 'test', selfId: 1, players: [] };
  return zipSync({ 'recording.tmcpr': writeRecording(items), 'metaData.json': Buffer.from(JSON.stringify(meta)) });
}

const row = (stats, name) => stats.players.find(p => p.name === name);

test('our team\'s stats come out of the replay', () => {
  const { stats } = findMoments(readRecording(game()), []);
  assert.equal(stats.team, 'Blue');
  assert.deepEqual(stats.players.map(p => p.name).sort(), ['Mate', 'Milo']);
  const milo = row(stats, 'Milo'); const mate = row(stats, 'Mate');
  assert.equal(milo.me, true);
  assert.deepEqual([milo.kills, milo.finals, milo.beds, milo.deaths], [0, 1, 1, 0]);
  assert.deepEqual([mate.deaths, mate.finalDeath], [1, false]);
  // Pickups: only resources whose stack was seen, by whoever picked them up.
  assert.deepEqual([milo.dia, milo.iron, milo.em, milo.gold], [2, 1, 0, 0]);
  assert.deepEqual([mate.em, mate.dia], [1, 0]);
  // On Red's island with Sweaty there, from 20 s until the bed went at 35 s.
  assert.ok(milo.pressureMs >= 14000 && milo.pressureMs <= 16000, String(milo.pressureMs));
  assert.equal(mate.pressureMs, 0);
  assert.equal(stats.durationMs, 38000);
  assert.deepEqual(stats.missing, []);
});

test('the result: a win, or left when the recording ends with the game on', () => {
  assert.equal(findMoments(readRecording(game()), []).stats.result, 'left');
  assert.equal(findMoments(readRecording(game({ end: 'win' })), []).stats.result, 'win');
});

test('a recording that began after the start (a rejoin) still has stats', () => {
  const { stats } = findMoments(readRecording(game({ late: true })), []);
  assert.equal(stats.joinedLate, true);
  assert.equal(row(stats, 'Milo').finals, 1);
  assert.equal(row(stats, 'Milo').dia, 2);
});
