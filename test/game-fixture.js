// A small made-up Bed Wars game, written as a real .mcpr (for the clip tests).
const { zipSync } = require('fflate');
const { packet, writeRecording, P } = require('../clipper');

const ME = 'aaaaaaaaaaaa4aaaaaaaaaaaaaaaaaaa';
const MATE = 'bbbbbbbbbbbb4bbbbbbbbbbbbbbbbbbb';
const SWEAT = 'cccccccccccc4ccccccccccccccccccc';
const FAR = 'dddddddddddd4ddddddddddddddddddd';

const str = (w, s) => { const b = Buffer.from(s, 'utf8'); w.varint(b.length); w.raw(b); };
const u16 = (w, v) => w.raw(Uint8Array.of(v >> 8, v & 0xff));
const uuid = (w, u) => w.raw(Buffer.from(u, 'hex'));
const i8 = (v) => Math.max(-128, Math.min(127, Math.round(v)));

const PREFIX = { Red: '§c§lR §r§c', Blue: '§9§lB §r§9', Green: '§a§lG §r§a', Yellow: '§e§lY §r§e' };

const pk = {
  join: (eid) => packet(P.JOIN, w => { w.i32(eid); w.i8(0); w.i8(0); w.i8(0); w.i8(16); str(w, 'default'); w.bool(false); }),
  tabAdd: (rows) => packet(P.PLAYER_LIST, w => { w.varint(0); w.varint(rows.length); for (const [u, name] of rows) { uuid(w, u); str(w, name); w.varint(0); w.varint(0); w.varint(1); w.bool(false); } }),
  // The prefix is what shows in game ("§c§lR "); Hypixel's team name may not match it.
  team: (name, members, prefix = PREFIX[name.replace(/\d+$/, '')] || '') => packet(P.TEAMS, w => { str(w, name); w.i8(0); str(w, name); str(w, prefix); str(w, ''); w.i8(0); str(w, 'always'); w.i8(12); w.varint(members.length); for (const m of members) str(w, m); }),
  // One full chunk column: a floor of stone at y 64 (the players stand on it).
  chunk: (cx, cz) => packet(P.CHUNK, w => {
    w.i32(cx); w.i32(cz); w.bool(true); u16(w, 1 << 4);
    const data = new Uint8Array(8192 + 2048 + 2048 + 256);
    for (let k = 0; k < 256; k++) { data[k * 2] = (1 << 4) & 0xff; data[k * 2 + 1] = (1 << 4) >> 8; }
    w.varint(data.length); w.raw(data);
  }),
  unload: (cx, cz) => packet(P.CHUNK, w => { w.i32(cx); w.i32(cz); w.bool(true); u16(w, 0); w.varint(0); }),
  spawn: (eid, u, x, y, z) => packet(P.SPAWN_PLAYER, w => { w.varint(eid); uuid(w, u); w.i32(x * 32); w.i32(y * 32); w.i32(z * 32); w.i8(0); w.i8(0); w.raw(Uint8Array.of(0, 0)); w.raw(Uint8Array.of(0x7f)); }),
  move: (eid, dx, dy, dz) => packet(P.REL_MOVE, w => { w.varint(eid); w.i8(i8(dx * 32)); w.i8(i8(dy * 32)); w.i8(i8(dz * 32)); w.bool(true); }),
  meta: (eid, flags) => packet(P.METADATA, w => { w.varint(eid); w.i8(0); w.i8(flags); w.raw(Uint8Array.of(0x7f)); }),
  destroy: (...eids) => packet(P.DESTROY, w => { w.varint(eids.length); for (const e of eids) w.varint(e); }),
  chat: (text) => packet(P.CHAT, w => { str(w, JSON.stringify({ text })); w.i8(0); }),
  keepalive: () => packet(P.KEEPALIVE, w => w.varint(7))
};

/** A 40 s game: you (Blue) and a teammate fight a tracked sweat (Red) near
 *  you, and a second tracked player (Green) far away. `teamNames` renames
 *  the scoreboard teams the way Hypixel sometimes does (the Red players in
 *  "Blue7"), keeping each team's prefix. */
function game({ teamNames = {} } = {}) {
  const items = [];
  const at = (t, b) => items.push([t, b]);
  at(0, pk.join(1));
  at(0, pk.tabAdd([[ME, 'Milo'], [MATE, 'Mate'], [SWEAT, 'Sweaty'], [FAR, 'Faraway']]));
  const team = (name, members) => pk.team(teamNames[name] || name, members, PREFIX[name.replace(/\d+$/, '')]);
  at(0, team('Blue1', ['Milo', 'Mate']));
  at(0, team('Red1', ['Sweaty']));
  at(0, team('Green1', ['Faraway']));
  for (let cx = -12; cx <= 12; cx++) for (let cz = -2; cz <= 2; cz++) at(0, pk.chunk(cx, cz));
  at(0, pk.spawn(1, ME, 0, 65, 0));
  at(0, pk.spawn(2, MATE, 2, 65, 0));
  at(0, pk.spawn(3, SWEAT, 10, 65, 0));
  at(0, pk.spawn(4, FAR, 150, 65, 0));
  for (let t = 50; t <= 40000; t += 50) {
    at(t, pk.move(3, -2 / 32, 0, 0));
    if (t % 1000 === 0) at(t, pk.keepalive());
  }
  at(5000, pk.meta(3, 0x02)); // crouching
  at(6000, pk.unload(12, 0));
  at(20000, pk.chat('Party > Mate: go mid'));
  at(30000, pk.chat('BED DESTRUCTION > Red Bed was destroyed by Mate!'));
  at(31000, pk.chat('BED DESTRUCTION > Green Bed was destroyed by Milo!'));
  at(35000, pk.chat('Sweaty was killed by Milo. FINAL KILL!'));
  at(35050, pk.destroy(3));
  at(36000, pk.chat('Faraway was knocked into the void by Mate. FINAL KILL!'));
  items.sort((a, b) => a[0] - b[0]);
  const meta = { singleplayer: false, serverName: 'mc.hypixel.net', duration: 40000, date: 1762000000000, mcversion: '1.8.9', fileFormat: 'MCPR', fileFormatVersion: 14, protocol: 47, generator: 'test', selfId: 1, players: [] };
  return zipSync({ 'recording.tmcpr': writeRecording(items), 'metaData.json': Buffer.from(JSON.stringify(meta)) });
}


module.exports = { game, ME, MATE, SWEAT, FAR, pk };
