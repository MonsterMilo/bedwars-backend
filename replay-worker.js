// The replay worker (see replay-jobs.js): unpacks a recorded game and reads
// it, one at a time. Gets { id, msg } and answers { id, out } or { id, error }:
//
//   { kind: 'clips', bytes, players, manual }
//     -> { moments, cuts: [{ bytes, durationMs }] }   (clipper.js)
//   { kind: 'summary', bytes } -> { summary }           (game-summary.js)
//   { kind: 'cut', bytes, from, to, follow, title }
//     -> { bytes, durationMs, people }                  (one clip, clipper.js)
//   { kind: 'replay' | 'capture', bytes, map, source, fallbackName }
//     -> { file, preview, summary }                   (atlas-core.js)
//
// handle() is also used directly by the tests (REPLAY_JOBS_IN_PROCESS=1).
const { parentPort, isMainThread } = require('worker_threads');

const asBuffer = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function clips(msg) {
  const clipper = require('./clipper');
  // Read piece by piece, never unpacked whole (tmcpr-stream.js).
  const rec = clipper.openRecording(asBuffer(msg.bytes));
  const found = clipper.findMoments(rec, msg.players || [], { manual: msg.manual || [] });
  const good = found.moments.filter(m => m.ok);
  const cuts = good.length ? clipper.cutClips(rec, clipper.windowsFor(good)) : [];
  return { moments: found.moments, cuts, summary: found.summary };
}

// Only the game summary (game-summary.js), for replays clipped before it
// existed.
function summary(msg) {
  const clipper = require('./clipper');
  const rec = clipper.openRecording(asBuffer(msg.bytes));
  return { summary: clipper.findMoments(rec, []).summary };
}

// One window cut on request (a clip made on the website): who was near the
// followed player in it, and the clip file.
function cut(msg) {
  const clipper = require('./clipper');
  const rec = clipper.openRecording(asBuffer(msg.bytes));
  const from = Math.max(0, Math.round(msg.from)); const to = Math.round(msg.to);
  const found = clipper.findMoments(rec, [], { manual: [to], manualBeforeMs: to - from, manualAfterMs: 0, focusName: msg.follow || null });
  const m = found.moments.find(x => x.kind === 'manual');
  const [clip] = clipper.cutClips(rec, [{ from, to, focus: (m && m.focus) || msg.focus || null, markAt: from, marker: msg.title || 'Clip' }]);
  return { people: m ? m.people : [], followUuid: m ? m.followUuid : null, self: found.self, ...clip };
}

function atlas(msg) {
  const { extractCapture, readCapture, mergeCapture, encodeMap, decodeMap, previewOf } = require('./atlas-core');
  const bytes = asBuffer(msg.bytes);
  msg.bytes = null;
  const capture = msg.kind === 'capture' ? readCapture(bytes) : extractCapture(bytes);
  if (!capture.map) capture.map = msg.fallbackName || null;
  if (!capture.map) throw new Error('Which map this is isn\'t in the recording');
  if (!capture.columns.size) throw new Error('No map blocks in the recording')
  // A replay that began after the start (a rejoin) only saw the map with
  // toppers and player blocks on it: no use to the Atlas (Milo 2026-11-05).
  if (msg.kind === 'replay' && !capture.started) throw new Error('The game\'s start isn\'t in this recording (joined late)');
  const merged = mergeCapture(msg.map ? decodeMap(asBuffer(msg.map)) : null, capture, msg.source);
  return {
    file: encodeMap(merged),
    preview: previewOf(merged),
    summary: { name: merged.name, slug: merged.slug, modes: merged.modes, stats: merged.stats, sources: merged.sources, captureMap: capture.map, started: capture.started, captureColumns: capture.columns.size }
  };
}

function handle(msg) {
  if (msg.kind === 'clips') return clips(msg);
  if (msg.kind === 'summary') return summary(msg);
  if (msg.kind === 'cut') return cut(msg);
  if (msg.kind === 'replay' || msg.kind === 'capture') return atlas(msg);
  throw new Error(`Unknown replay job (${msg.kind})`);
}

module.exports = { handle };

if (!isMainThread && parentPort) {
  // After each replay: let go of it now, not whenever the next one needs room.
  let gc = null;
  try { require('v8').setFlagsFromString('--expose-gc'); gc = require('vm').runInNewContext('gc'); } catch { /* fine without */ }
  parentPort.on('message', ({ id, msg }) => {
    let reply;
    try {
      reply = { id, out: handle(msg) };
    } catch (err) {
      reply = { id, error: err && err.message ? err.message : String(err) };
    }
    parentPort.postMessage(reply);
    reply = null; msg = null;
    if (gc) gc();
  });
}
