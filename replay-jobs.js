// --- Replay jobs: one recorded game in memory at a time ---
// A replay is only 1-3 MB in B2, but unpacked it's ~6 MB per minute of game
// (a 15-minute game is ~95 MB), and Render's free plan has 512 MB for the
// whole server. Clips (clips.js) and the Atlas (atlas.js) both read replays
// (piece by piece, see tmcpr-stream.js), and they go through here:
//
//   exclusive(fn)  runs fn when no other replay job is running, server-wide
//                  (the download from B2 included). Jobs wait their turn in
//                  the order they asked.
//   run(msg)       does the unpacking and reading in a worker thread
//                  (replay-worker.js), off the server's main thread. The
//                  worker clears out after each replay and is stopped after
//                  a minute with nothing to read.
//   recordingSize(zip)  the unpacked size of a replay, read from the zip's
//                  directory without unpacking it, to skip odd files.

const path = require('path');
const { Worker } = require('worker_threads');

// Longest game read on the server (~60 minutes). Replays are read piece by
// piece (tmcpr-stream.js), so memory doesn't grow with the game's length;
// this only keeps one odd file from tying the worker up.
const MAX_RECORDING = 400 * 1024 * 1024;
const JOB_TIMEOUT_MS = 3 * 60 * 1000;
// The worker's own JavaScript heap. If a job needs more, the worker stops
// with an error, not the server.
const WORKER_HEAP_MB = 160;
const WORKER_IDLE_MS = 60 * 1000;

let chain = Promise.resolve();
let running = 0;
let waiting = 0;
// Called before each job: other things that can let go of memory first (the
// card drawing worker, when it's idle).
const beforeHooks = [];
const beforeEach = (fn) => { beforeHooks.push(fn); };

function exclusive(fn) {
  waiting++;
  const job = chain.then(() => {
    waiting--; running++;
    for (const h of beforeHooks) { try { h(); } catch { /* never blocks a job */ } }
    return fn();
  })
    .finally(() => { running--; });
  chain = job.then(() => {}, () => {});
  return job;
}

/** Resolves once no replay job is running or waiting. */
async function idle() {
  for (;;) {
    const c = chain;
    await c;
    if (c === chain) return;
  }
}

const state = () => ({ running, waiting });

/**
 * The unpacked size of one file in a zip (an .mcpr), from its central
 * directory, or null if it can't be read from there.
 */
function zipEntrySize(buf, wanted = 'recording.tmcpr') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let k = 0; k < count && p + 46 <= b.length; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) return size === 0xffffffff ? null : size;
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return null;
}
const recordingSize = (zip) => zipEntrySize(zip, 'recording.tmcpr');

/** Throws if a replay unpacks to more than the server reads. */
function checkSize(zip, max = MAX_RECORDING) {
  const size = recordingSize(zip);
  if (size != null && size > max) {
    const err = new Error(`Game too long to read on the server (${Math.round(size / 1048576)} MB unpacked, the most is ${Math.round(max / 1048576)} MB)`);
    err.tooBig = true;
    throw err;
  }
  return size;
}

// --- The worker ---
// One worker reads the replays, one at a time, and is stopped once it has had
// nothing to do for a minute. Kept between the replays of a backfill instead
// of a new one for each: every new thread gets its own pool of memory from
// the system, and on a long backfill those pools added up (measured: ~400 MB
// after 16 replays with a new worker each time, ~290 MB with one).
let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }
let idleTimer = null;

function stopWorker() {
  clearTimeout(idleTimer); idleTimer = null;
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
}
function failAll(err) {
  for (const [id, j] of pending) { clearTimeout(j.timer); pending.delete(id); j.reject(err); }
}
function getWorker() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'replay-worker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB }
  });
  w.on('message', ({ id, out, error }) => {
    const j = pending.get(id); if (!j) return;
    pending.delete(id); clearTimeout(j.timer);
    if (error != null) j.reject(new Error(error)); else j.resolve(out);
    if (!pending.size) { clearTimeout(idleTimer); idleTimer = setTimeout(stopWorker, WORKER_IDLE_MS); if (idleTimer.unref) idleTimer.unref(); }
  });
  w.on('error', (err) => {
    if (worker !== w) return;
    worker = null;
    failAll(err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('Reading the game needed too much memory') : err);
  });
  w.on('exit', (code) => {
    if (worker !== w) return;
    worker = null;
    failAll(new Error(`Replay worker stopped (${code})`));
  });
  w.unref(); // never keeps the process alive on shutdown
  worker = w;
  return w;
}

/**
 * Runs one job (see replay-worker.js) in the worker. msg.bytes (the .mcpr)
 * is copied over; it's small. With inProcess (tests), the same code runs on
 * this thread.
 */
function run(msg, { inProcess = process.env.REPLAY_JOBS_IN_PROCESS === '1', timeoutMs = JOB_TIMEOUT_MS } = {}) {
  if (inProcess) {
    const { handle } = require('./replay-worker');
    try { return Promise.resolve(handle(msg)); } catch (err) { return Promise.reject(err); }
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    clearTimeout(idleTimer);
    // Too slow: the worker is stopped (whatever it holds goes with it).
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Reading the game took too long'));
      stopWorker();
      failAll(new Error('Replay worker restarted'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { getWorker().postMessage({ id, msg }); } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
  });
}

module.exports = { exclusive, beforeEach, idle, state, run, stopWorker, recordingSize, zipEntrySize, checkSize, MAX_RECORDING };
