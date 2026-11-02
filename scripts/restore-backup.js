// Puts a daily database copy (backup.js) back into MongoDB.
//
//   node scripts/restore-backup.js                 list the copies in B2
//   node scripts/restore-backup.js 2026-11-02      show what that copy holds
//   node scripts/restore-backup.js 2026-11-02 --yes [--only sweats,notes] [--db name]
//
// With --yes, each collection in the copy REPLACES the one in the database
// (it's emptied first). --only limits it to some collections. --db restores
// into another database on the same server instead, to look before replacing.
// Reads MONGODB_URI and the B2_* settings from .env, like the server.

require('dotenv').config();
const zlib = require('zlib');
const axios = require('axios');
const mongoose = require('mongoose');
const { presign, b2Config } = require('../replays');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : null; };
const day = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const yes = args.includes('--yes');
const only = flag('--only') ? flag('--only').split(',').map(s => s.trim()).filter(Boolean) : null;
const dbName = flag('--db');

const config = b2Config(process.env);
if (!config) { console.error('Set B2_KEY_ID, B2_APP_KEY, B2_BUCKET and B2_ENDPOINT first.'); process.exit(1); }
const link = (key, extra) => presign({ method: 'GET', key, expires: 600, extra, ...config });
const get = (key, type = 'arraybuffer') => axios.get(link(key), { responseType: type, timeout: 120000 }).then(r => r.data);

async function listDays() {
  // ListObjectsV2 with a delimiter gives one "folder" per day.
  const xml = await axios.get(presign({ method: 'GET', key: '', expires: 600, extra: { 'list-type': '2', prefix: 'backups/', delimiter: '/' }, ...config }), { timeout: 30000 }).then(r => String(r.data));
  return [...xml.matchAll(/<Prefix>backups\/(\d{4}-\d{2}-\d{2})\/<\/Prefix>/g)].map(m => m[1]).sort();
}

(async () => {
  if (!day) {
    const days = await listDays();
    console.log(days.length ? `Copies in B2:\n  ${days.join('\n  ')}` : 'No copies in B2 yet.');
    return;
  }
  const manifest = JSON.parse(Buffer.from(await get(`backups/${day}/manifest.json`)).toString('utf8'));
  const wanted = manifest.collections.filter(c => !only || only.includes(c.name));
  console.log(`Copy from ${manifest.at}:`);
  for (const c of wanted) console.log(`  ${c.name}: ${c.count} documents`);
  if (!yes) { console.log('\nNothing changed. Add --yes to restore (it replaces those collections).'); return; }
  if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI first.'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI, dbName ? { dbName } : {});
  const db = mongoose.connection.db;
  const { EJSON } = mongoose.mongo.BSON;
  for (const c of wanted) {
    const text = zlib.gunzipSync(Buffer.from(await get(`backups/${day}/${c.name}.ndjson.gz`))).toString('utf8');
    const docs = text.split('\n').filter(Boolean).map(line => EJSON.parse(line, { relaxed: false }));
    const col = db.collection(c.name);
    await col.deleteMany({});
    for (let i = 0; i < docs.length; i += 1000) await col.insertMany(docs.slice(i, i + 1000), { ordered: false });
    console.log(`  ${c.name}: restored ${docs.length}`);
  }
  console.log(`Done${dbName ? ` (into database "${dbName}")` : ''}.`);
  await mongoose.disconnect();
})().catch(err => { console.error('Restore failed:', err.message); process.exit(1); });
