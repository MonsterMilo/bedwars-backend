// The Atlas worker (see atlas.js): reading a recording means unpacking
// ~50 MB and going through every packet, which would hold up the server's
// other requests for a few seconds on Render's small CPU, so it runs here.
// Gets { id, kind: 'replay' | 'capture', bytes, map, source, fallbackName }
// (map: the current map file or null) and answers
// { id, file, preview, summary } or { id, error }.
const { parentPort } = require('worker_threads');
const { extractCapture, readCapture, mergeCapture, encodeMap, decodeMap, previewOf } = require('./atlas-core');

parentPort.on('message', ({ id, kind, bytes, map, source, fallbackName }) => {
  try {
    const capture = kind === 'capture' ? readCapture(Buffer.from(bytes)) : extractCapture(Buffer.from(bytes));
    if (!capture.map) capture.map = fallbackName || null;
    if (!capture.map) throw new Error('Which map this is isn\'t in the recording');
    if (!capture.columns.size) throw new Error('No map blocks in the recording');
    const merged = mergeCapture(map ? decodeMap(Buffer.from(map)) : null, capture, source);
    const file = encodeMap(merged);
    const preview = previewOf(merged);
    parentPort.postMessage({
      id, file, preview,
      summary: { name: merged.name, slug: merged.slug, modes: merged.modes, stats: merged.stats, sources: merged.sources, captureMap: capture.map, started: capture.started, captureColumns: capture.columns.size }
    });
  } catch (err) {
    parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
});
