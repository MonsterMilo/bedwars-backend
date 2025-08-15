// server.js
require('dotenv').config();
console.log('MONGODB_URI:', process.env.MONGODB_URI);
console.log('HYPIXEL_API_KEY:', process.env.HYPIXEL_API_KEY);

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const MONGODB_URI = process.env.MONGODB_URI;
const HYPIXEL_API_KEY = process.env.HYPIXEL_API_KEY;
const URCHIN_KEY = process.env.URCHIN_KEY;
const PORT = process.env.PORT || 3000;

if (!MONGODB_URI) console.warn('Warning: MONGODB_URI not set.');
if (!HYPIXEL_API_KEY) console.warn('Warning: HYPIXEL_API_KEY not set.');
if (!URCHIN_KEY) console.warn('Warning: URCHIN_KEY not set.');

// --- MongoDB setup ---
mongoose.set('strictQuery', false);
mongoose.connect(MONGODB_URI || 'mongodb://localhost:27017/bedwars', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('Connected to MongoDB'))
  .catch(err => console.warn('MongoDB connection error:', err.message));

const sweatSchema = new mongoose.Schema({
  username: { type: String, required: true },
  uuid: String,
  star: Number,
  fkdr: Number,
  wlr: Number,
  bblr: Number,
  kdr: Number,
  finals: Number,
  finalDeaths: Number,
  beds: Number,
  bedsLost: Number,
  kills: Number,
  deaths: Number,
  milo: { type: Boolean, default: false },
  potat: { type: Boolean, default: false },
  aballs: { type: Boolean, default: false },
  zoiv: { type: Boolean, default: false },
  dateAdded: String,
  createdAt: { type: Date, default: Date.now },
  urchinTag: String
});

const Sweat = mongoose.model('Sweat', sweatSchema);

// --- Health ---
app.get('/ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Mojang proxy ---
app.get('/mojang/:username', async (req, res) => {
  try {
    const username = req.params.username;
    const mojangRes = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, { timeout: 10_000 });
    return res.json(mojangRes.data);
  } catch (err) {
    if (err.response?.status === 204 || err.response?.status === 404) return res.status(404).json({ error: 'Not found' });
    console.error('/mojang error', err.message);
    return res.status(500).json({ error: 'Mojang proxy error', details: err.message });
  }
});

// --- Hypixel proxy ---
app.get('/player/:uuid', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    if (!HYPIXEL_API_KEY) return res.status(500).json({ error: 'HYPIXEL_API_KEY not configured' });

    const hypRes = await axios.get('https://api.hypixel.net/player', {
      params: { key: HYPIXEL_API_KEY, uuid },
      timeout: 15_000
    });
    return res.json(hypRes.data);
  } catch (err) {
    console.error('/player error', err.message);
    return res.status(500).json({ error: 'Hypixel proxy error', details: err.message });
  }
});

// --- Urchin API proxy ---
app.get('/urchin/:username', async (req, res) => {
  try {
    const username = req.params.username;
    if (!URCHIN_KEY) return res.status(500).json({ error: 'URCHIN_KEY not configured' });

    const response = await fetch(`https://urchin.ws/player/${username}?key=${URCHIN_KEY}&sources=MANUAL`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('/urchin error', err.message);
    return res.status(500).json({ error: 'Urchin proxy error', details: err.message });
  }
});

// --- GET all sweats ---
app.get('/sweats', async (req, res) => {
  try {
    const docs = await Sweat.find({}).sort({ createdAt: -1 }).lean();
    return res.json(docs); // Already stored tag, no external fetch
  } catch (err) {
    console.error('/sweats GET error', err);
    return res.status(500).json({ error: 'DB read error' });
  }
});

// --- POST add a sweat ---
app.post('/sweats', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.username) return res.status(400).json({ error: 'username required' });

    const dateAdded = body.dateAdded || (new Date().toISOString().slice(0, 10));

    // Fetch Urchin tag using Axios
    let urchinTag = null;
    try {
      const response = await axios.get(`https://urchin.ws/player/${body.username}`, {
        params: { key: URCHIN_KEY, sources: 'MANUAL' },
        timeout: 10000
      });
      const data = response.data;
      if (data.tags?.length > 0) {
        urchinTag = data.tags.map(tag => tag.type).join(", ");
      }
    } catch (err) {
      console.warn(`Failed to fetch Urchin tag for ${body.username}:`, err.message);
    }

    const doc = new Sweat({
      username: body.username,
      uuid: body.uuid || null,
      star: body.star || 0,
      fkdr: body.fkdr || 0,
      wlr: body.wlr || 0,
      bblr: body.bblr || 0,
      kdr: body.kdr || 0,
      finals: body.finals || 0,
      finalDeaths: body.finalDeaths || 0,
      beds: body.beds || 0,
      bedsLost: body.bedsLost || 0,
      kills: body.kills || 0,
      deaths: body.deaths || 0,
      milo: !!body.milo,
      potat: !!body.potat,
      aballs: !!body.aballs,
      zoiv: !!body.zoiv,
      dateAdded,
      urchinTag
    });

    const saved = await doc.save();
    return res.status(201).json(saved);
  } catch (err) {
    console.error('/sweats POST error', err);
    return res.status(500).json({ error: 'DB write error' });
  }
});

// --- DELETE a sweat ---
app.delete('/sweats/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const deleted = await Sweat.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error('/sweats DELETE error', err);
    return res.status(500).json({ error: 'DB delete error' });
  }
});

// --- PATCH update flags ---
app.patch('/sweats/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};
    const allowed = ['milo','potat','aballs','zoiv','urchinTag'];
    const set = {};
    allowed.forEach(k => { if (k in updates) set[k] = updates[k]; });
    const updated = await Sweat.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    return res.json(updated);
  } catch (err) {
    console.error('/sweats PATCH error', err);
    return res.status(500).json({ error: 'DB update error' });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
