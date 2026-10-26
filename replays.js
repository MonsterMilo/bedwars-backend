// --- Replays: recorded games, kept in Backblaze B2 ---
// The Starfish proxy records Milo's games (ReplayMod .mcpr files). When he
// tracks a player during a game, the plugin uploads that game here so it
// shows on the player's popup on the website.
//
// The file itself never passes through this server (Render's free plan
// keeps nothing on disk and has little memory): the plugin asks for an
// upload link, sends the file straight to B2, then says it's done. Downloads
// work the same way, through a link that's good for a few minutes. The
// bucket stays private; only this server can make links.
//
// Needs B2_KEY_ID, B2_APP_KEY, B2_BUCKET and B2_ENDPOINT
// (e.g. s3.us-west-004.backblazeb2.com) - B2's S3-compatible API.

const crypto = require('crypto');
const axios = require('axios');

const UPLOAD_LINK_SECONDS = 15 * 60;
const DOWNLOAD_LINK_SECONDS = 10 * 60;
const MAX_BYTES = 400 * 1024 * 1024;
const PLAYERS_MAX = 16;
const LIST_MAX = 50;

/** An S3 (SigV4) presigned URL: method on bucket/key, good for `expires` s.
 *  Virtual-hosted style: https://<bucket>.<endpoint>/<key>. */
function presign({ method, bucket, endpoint, region, keyId, secret, key, expires, extra = {}, now = new Date() }) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const host = `${bucket}.${endpoint}`;
  const uri = '/' + String(key).split('/').map(enc).join('/');
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${keyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
    ...extra
  };
  const query = Object.keys(params).sort().map(k => `${enc(k)}=${enc(params[k])}`).join('&');
  const canonical = [method, uri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secret, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  return `https://${host}${uri}?${query}&X-Amz-Signature=${signature}`;
}

module.exports = function setupReplays({
  app, mongoose, requireWriteKey, writeLimiter, proxyLimiter, keyOwner, UUID_RE, NAME_RE,
  env = process.env, http = axios
}) {
  const config = () => {
    const endpoint = String(env.B2_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const region = (endpoint.match(/^s3\.([a-z0-9-]+)\./) || [])[1];
    if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET || !endpoint || !region) return null;
    return { keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY, bucket: env.B2_BUCKET, endpoint, region };
  };
  const link = (method, key, expires, extra) => presign({ method, key, expires, extra, ...config() });

  const Replay = mongoose.model('Replay', new mongoose.Schema({
    key: { type: String, required: true },
    name: String,
    sizeBytes: Number,
    durationMs: Number,
    playedAt: Date,
    mode: String,
    map: String,
    // The tracked players it's for (uuid without dashes, lower case).
    players: [{ uuid: { type: String, index: true }, username: String }],
    uploadedBy: String,
    status: { type: String, default: 'pending' } // 'pending' until the file is in B2, then 'ready'
  }, { timestamps: true }));

  const plainUuid = (u) => String(u || '').replace(/-/g, '').toLowerCase();
  const publicReplay = (r) => ({
    id: r._id, name: r.name, sizeBytes: r.sizeBytes, durationMs: r.durationMs, playedAt: r.playedAt,
    mode: r.mode || null, map: r.map || null, players: (r.players || []).map(p => ({ uuid: p.uuid, username: p.username })),
    uploadedBy: r.uploadedBy || null
  });

  // The plugin: "a game for these players" -> an upload link for it.
  app.post('/replays', requireWriteKey, writeLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    const b = req.body || {};
    const sizeBytes = Number(b.sizeBytes);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_BYTES) return res.status(400).json({ error: 'Bad file size' });
    const players = (Array.isArray(b.players) ? b.players : []).slice(0, PLAYERS_MAX)
      .map(p => ({ uuid: plainUuid(p?.uuid), username: String(p?.username || '') }))
      .filter(p => UUID_RE.test(p.uuid) && NAME_RE.test(p.username));
    if (!players.length) return res.status(400).json({ error: 'Which tracked players is it for?' });
    const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    const playedAt = new Date(b.playedAt);
    try {
      const doc = new Replay({
        key: 'pending',
        name: text(b.name, 80), sizeBytes, durationMs: Number(b.durationMs) || 0,
        playedAt: isNaN(playedAt) ? new Date() : playedAt,
        mode: text(b.mode, 30), map: text(b.map, 40), players, uploadedBy: req.keyOwner
      });
      doc.key = `replays/${doc._id}.mcpr`;
      await doc.save();
      return res.status(201).json({ id: doc._id, uploadUrl: link('PUT', doc.key, UPLOAD_LINK_SECONDS) });
    } catch (err) {
      console.error('/replays POST error', err);
      return res.status(500).json({ error: 'DB write error' });
    }
  });

  // The plugin: "it's uploaded" -> checked in B2, then it shows on the site.
  app.post('/replays/:id/done', requireWriteKey, writeLimiter, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const doc = await Replay.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'No such replay' });
      const head = await http.head(link('HEAD', doc.key, 60), { validateStatus: () => true, timeout: 10000 });
      if (head.status !== 200) return res.status(409).json({ error: `The file isn't in storage (${head.status})` });
      doc.status = 'ready';
      doc.sizeBytes = Number(head.headers['content-length']) || doc.sizeBytes;
      await doc.save();
      return res.json(publicReplay(doc));
    } catch (err) {
      console.error('/replays done error', err.message);
      return res.status(500).json({ error: 'Check failed' });
    }
  });

  // The site: a player's replays (keys only - they show other people too).
  app.get('/replays', requireWriteKey, proxyLimiter, async (req, res) => {
    const uuid = plainUuid(req.query.uuid);
    if (!UUID_RE.test(uuid)) return res.status(400).json({ error: 'Invalid uuid' });
    try {
      const docs = await Replay.find({ 'players.uuid': uuid, status: 'ready' }).sort({ playedAt: -1 }).limit(LIST_MAX).lean();
      return res.json({ replays: docs.map(publicReplay) });
    } catch (err) {
      console.error('/replays GET error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  // The site's Download button: a short-lived link to the file.
  app.get('/replays/:id/link', requireWriteKey, proxyLimiter, async (req, res) => {
    if (!config()) return res.status(503).json({ error: 'Replay storage is not set up on the server' });
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const doc = await Replay.findById(req.params.id).lean();
      if (!doc || doc.status !== 'ready') return res.status(404).json({ error: 'No such replay' });
      const name = (doc.name || `${doc._id}.mcpr`).replace(/[^A-Za-z0-9_.-]/g, '_');
      // (Downloads under its own name, not the storage id.)
      return res.json({ url: link('GET', doc.key, DOWNLOAD_LINK_SECONDS, { 'response-content-disposition': `attachment; filename="${name}"` }), name });
    } catch (err) {
      console.error('/replays link error', err);
      return res.status(500).json({ error: 'DB read error' });
    }
  });

  return { Replay, configured: () => !!config() };
};

module.exports.presign = presign;
