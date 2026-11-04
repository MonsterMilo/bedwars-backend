// --- Daily database backup, kept in Backblaze B2 ---
// Once a day the server copies every MongoDB collection to the same private
// B2 bucket the replays use, under backups/<YYYY-MM-DD>/. Soft delete covers
// mistakes; this covers losing the database itself (Atlas free has no
// backups of its own).
//
// Each collection becomes <name>.ndjson.gz: one document per line in
// canonical Extended JSON, so ObjectIds and dates come back exactly.
// manifest.json lists the collections and their counts.
// scripts/restore-backup.js puts a day back.
//
// Only the newest BACKUP_KEEP_DAYS days are kept (default 14); older ones are
// deleted from B2. Uses the replays' B2 settings, so nothing new to set up.

const zlib = require('zlib');
const axios = require('axios');
const { presign, b2Config } = require('./replays');
const jobs = require('./replay-jobs');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;     // look every hour whether today's copy is done
const FIRST_CHECK_MS = 2 * 60 * 1000; // and shortly after start
const RUN_AFTER_UTC_HOUR = 8;         // ~3-4am US Eastern: a quiet time
const STUCK_MS = 60 * 60 * 1000;      // a "running" claim older than this was lost (crash, deploy)
const LINK_SECONDS = 10 * 60;
const META = 'backupruns';            // where finished copies are listed (not itself backed up)

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

module.exports = function setupBackups({ mongoose, env = process.env, http = axios, now = Date.now }) {
  const keepDays = Math.max(1, parseInt(env.BACKUP_KEEP_DAYS, 10) || 14);
  const config = () => b2Config(env);
  const link = (method, key) => presign({ method, key, expires: LINK_SECONDS, ...config() });
  const runs = () => mongoose.connection.db.collection(META);
  let running = null;

  async function put(key, body, type) {
    await http.put(link('PUT', key), body, {
      headers: { 'Content-Type': type, 'Content-Length': body.length },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000
    });
  }
  async function remove(key) {
    await http.delete(link('DELETE', key), { timeout: 30000, validateStatus: s => (s >= 200 && s < 300) || s === 404 });
  }

  // One collection -> gzipped NDJSON (one at a time keeps memory small).
  async function dumpCollection(name) {
    const { EJSON } = mongoose.mongo.BSON;
    const gzip = zlib.createGzip();
    const chunks = [];
    gzip.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject); });
    let count = 0;
    for await (const doc of mongoose.connection.db.collection(name).find({})) {
      if (!gzip.write(EJSON.stringify(doc, { relaxed: false }) + '\n')) await new Promise(r => gzip.once('drain', r));
      count++;
    }
    gzip.end();
    await done;
    return { count, body: Buffer.concat(chunks) };
  }

  async function backupNow(day = dayOf(now())) {
    const prefix = `backups/${day}`;
    const names = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray())
      .map(c => c.name).filter(n => n !== META && !n.startsWith('system.')).sort();
    const files = [];
    const collections = [];
    let bytes = 0;
    for (const name of names) {
      const { count, body } = await dumpCollection(name);
      const key = `${prefix}/${name}.ndjson.gz`;
      await put(key, body, 'application/gzip');
      files.push(key);
      collections.push({ name, count, bytes: body.length });
      bytes += body.length;
    }
    const manifest = Buffer.from(JSON.stringify({ day, at: new Date(now()).toISOString(), collections }, null, 2));
    await put(`${prefix}/manifest.json`, manifest, 'application/json');
    files.push(`${prefix}/manifest.json`);
    return { files, collections, bytes };
  }

  // Deletes copies older than keepDays from B2 and from the list.
  async function prune() {
    const cutoff = dayOf(now() - (keepDays - 1) * DAY_MS);
    const old = await runs().find({ _id: { $lt: cutoff } }).toArray();
    for (const run of old) {
      try {
        for (const key of run.files || []) await remove(key);
        await runs().deleteOne({ _id: run._id });
        console.log(`Backup: deleted the ${run._id} copy (keeping ${keepDays} days)`);
      } catch (err) {
        console.error(`Backup: deleting the ${run._id} copy failed, will retry`, err.message);
      }
    }
  }

  // Today's copy, if it isn't done yet and nobody else is making it.
  async function check({ force = false } = {}) {
    if (!config() || mongoose.connection.readyState !== 1 || running) return null;
    const t = now();
    if (!force && new Date(t).getUTCHours() < RUN_AFTER_UTC_HOUR) return null;
    const day = dayOf(t);
    // Claim the day, so two copies of the server (during a deploy) don't both run it.
    const claim = await runs().findOneAndUpdate(
      { _id: day, $or: [{ status: { $ne: 'done' }, startedAt: { $lt: new Date(t - STUCK_MS) } }, { status: 'failed' }] },
      { $set: { status: 'running', startedAt: new Date(t) } },
      { upsert: true, returnDocument: 'after' }
    ).catch(err => (err && err.code === 11000 ? null : Promise.reject(err)));
    if (!claim) return null; // done already, or another copy is running it
    running = (async () => {
      const t0 = Date.now();
      try {
        // Not while a replay is being read (replay-jobs.js): memory is tight.
        const r = await jobs.exclusive(() => backupNow(day));
        await runs().updateOne({ _id: day }, { $set: { status: 'done', at: new Date(now()), files: r.files, collections: r.collections, bytes: r.bytes } });
        console.log(`Backup: ${day} saved, ${r.collections.length} collections, ${(r.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        await prune();
        return r;
      } catch (err) {
        await runs().updateOne({ _id: day }, { $set: { status: 'failed', error: String(err.message || err).slice(0, 300) } }).catch(() => {});
        console.error(`Backup: ${day} failed, will try again within the hour`, err.message);
        return null;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // The newest finished copy, for /status.
  async function latest() {
    return runs().find({ status: 'done' }).sort({ _id: -1 }).limit(1).next();
  }

  if (config()) {
    mongoose.connection.once('open', () => setTimeout(() => check().catch(err => console.error('Backup check failed', err.message)), FIRST_CHECK_MS).unref());
    setInterval(() => check().catch(err => console.error('Backup check failed', err.message)), CHECK_MS).unref();
  }

  return { configured: () => !!config(), check, latest, prune, keepDays };
};

module.exports.dayOf = dayOf;
