// enhanced server.js for Railway deployment
import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import editly from 'editly';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const JOBS = new Map();

const getMediaPath = (requestId, type, filename) => path.join('media', requestId, type, filename);

const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  await fs.mkdir(path.join(base, 'audio'), { recursive: true });
  await fs.mkdir(path.join(base, 'images'), { recursive: true });
  await fs.mkdir(path.join(base, 'text'), { recursive: true });
  await fs.mkdir(path.join(base, 'video'), { recursive: true });
};

const buildEditSpec = async (requestId, numSlides) => {
  const imageDir = path.join('media', requestId, 'images');
  const audioDir = path.join('media', requestId, 'audio');
  const textDir = path.join('media', requestId, 'text');
  const clips = [];

  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join(imageDir, `${i}.jpg`);
    const audioPath = path.join(audioDir, `${i}.mp3`);
    const textPath = path.join(textDir, `${i}.json`);

    let textLayer = null;
    try {
      const textData = JSON.parse(await fs.readFile(textPath, 'utf-8'));
      textLayer = {
        type: 'title',
        text: textData.text,
        position: textData.position || 'center',
        color: textData.color || 'white',
        fontSize: textData.fontSize || 48
      };
    } catch {
      console.warn(`Missing or invalid text for slide ${i}`);
    }

    const layers = [
      { type: 'image', path: imagePath },
      ...(textLayer ? [textLayer] : [])
    ];

    clips.push({ duration: 4, audio: { path: audioPath }, layers });
  }

  const musicPath = path.join(audioDir, 'music.mp3');
  const outPath = path.join('media', requestId, 'video', 'final.mp4');

  return {
    outPath,
    width: 1280,
    height: 720,
    fps: 30,
    audio: { path: musicPath, mixVolume: 0.3 },
    clips
  };
};

app.post('/register-job', async (req, res) => {
  const { requestId, numSlides, webhookUrl } = req.body;
  if (!requestId || !numSlides || !webhookUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  await ensureDirs(requestId);
  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'started', createdAt: new Date(), requestId });
  res.json({ success: true, jobId });

  try {
    const spec = await buildEditSpec(requestId, numSlides);
    await editly(spec);
    const buffer = await fs.readFile(spec.outPath);
    const base64 = buffer.toString('base64');

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: true, videoBase64: base64 })
    });

    JOBS.set(jobId, { status: 'completed', createdAt: new Date(), requestId });
  } catch (err) {
    console.error(err);
    JOBS.set(jobId, { status: 'failed', error: err.message });
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: false, error: err.message })
    });
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

app.listen(port, () => console.log(`🎬 Editly server running on port ${port}`));
