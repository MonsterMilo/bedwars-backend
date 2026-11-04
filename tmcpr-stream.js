// --- Reading a replay's packets without unpacking it whole ---
// A replay (.mcpr, a zip) packs ~30 to 1: a 15-minute game is ~3 MB in B2 and
// ~95 MB unpacked. The clips (clipper.js) and the Atlas (atlas-core.js) go
// through the packets in order, so they can read them piece by piece: the
// recording is unpacked a bit at a time and each packet is handed over as it
// comes; the readers copy the few packets they keep. Memory
// then grows with what's kept (the map, the players), not with how long the
// game was.
//
// recording.tmcpr is a list of records: [time ms: int32][length: int32][packet].

const { Inflate, unzipSync } = require('fflate');

const PIECE = 16 * 1024; // packed bytes unpacked at a time (~0.5 MB out)

/** The zip's files: [{ name, method, packed, size, dataAt }]. */
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken zip directory');
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (local + 30 > buf.length) throw new Error('Broken zip entry');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, method, packed, size, dataAt });
  }
  return out;
}

const asBuffer = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** metaData.json of a replay, or {}. */
function readMeta(bytes) {
  try {
    const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { filter: f => f.name === 'metaData.json' });
    return files['metaData.json'] ? JSON.parse(Buffer.from(files['metaData.json']).toString('utf8')) : {};
  } catch { return {}; }
}

/** Whether the zip has a recording.tmcpr (throws if it isn't a zip). */
function hasRecording(bytes) {
  return entries(asBuffer(bytes)).some(e => e.name === 'recording.tmcpr');
}

/**
 * Calls fn(t, packet) for each record in the replay's recording.tmcpr, in
 * order. packet is a Buffer (the packet id first) that's only good during the
 * call: it's a view into the piece being read, so whatever is kept has to be
 * copied (see own() in clipper.js). fn can return false to stop. Stops at a
 * broken or cut-off record, like the readers did.
 */
function eachRecord(bytes, fn, { piece = PIECE } = {}) {
  const buf = asBuffer(bytes);
  const e = entries(buf).find(x => x.name === 'recording.tmcpr');
  if (!e) throw new Error('No recording.tmcpr in the file');
  const data = buf.subarray(e.dataAt, e.dataAt + e.packed);
  let stop = false;
  let carry = null; // the start of a record cut off at the end of the last piece

  const take = (chunk) => {
    if (stop || !chunk.length) return;
    let b = chunk;
    if (carry) { b = new Uint8Array(carry.length + chunk.length); b.set(carry); b.set(chunk, carry.length); carry = null; }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 0;
    while (i + 8 <= b.length) {
      const len = dv.getInt32(i + 4);
      if (len < 0) { stop = true; return; }
      if (i + 8 + len > b.length) break;
      const t = dv.getInt32(i);
      const view = Buffer.from(b.buffer, b.byteOffset + i + 8, len);
      i += 8 + len;
      if (fn(t, view) === false) { stop = true; return; }
    }
    if (i < b.length) carry = b.slice(i);
  };

  if (e.method === 0) {
    for (let at = 0; at < data.length && !stop; at += piece) take(data.subarray(at, Math.min(data.length, at + piece)));
  } else if (e.method === 8) {
    const inf = new Inflate((chunk) => take(chunk));
    for (let at = 0; at < data.length && !stop; at += piece) {
      const end = Math.min(data.length, at + piece);
      inf.push(data.subarray(at, end), end === data.length);
    }
  } else {
    throw new Error(`Unsupported zip compression (${e.method})`);
  }
}

module.exports = { entries, eachRecord, readMeta, hasRecording };
