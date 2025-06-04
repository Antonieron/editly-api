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

const ensureDirs = async () => {
  await fs.mkdir('media', { recursive: true });
};

const downloadFile = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}`);
  const buffer = await res.buffer();
  await fs.writeFile(dest, buffer);
};

const downloadAssets = async (supabaseData, musicUrl, requestId, supabaseBaseUrl) => {
  const basePath = `media/${requestId}`;
  await fs.mkdir(basePath, { recursive: true });

  const audioDir = `${basePath}/audio`;
  const imageDir = `${basePath}/images`;
  const textDir = `${basePath}/text`;
  await Promise.all([fs.mkdir(audioDir), fs.mkdir(imageDir), fs.mkdir(textDir)]);

  const slides = [];

  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];

    const imagePath = `${imageDir}/${i}.jpg`;
    const audioPath = `${audioDir}/${i}.mp3`;
    const textPath = `${textDir}/${i}.json`;

    await Promise.all([
      downloadFile(new URL(slide.image, supabaseBaseUrl).href, imagePath),
      downloadFile(new URL(slide.audio, supabaseBaseUrl).href, audioPath),
      downloadFile(new URL(slide.text, supabaseBaseUrl).href, textPath),
    ]);

    const textData = JSON.parse(await fs.readFile(textPath, 'utf-8'));
    slides.push({
      imagePath,
      audioPath,
      subtitles: textData.subtitles || [],
    });
  }

  const musicPath = `${audioDir}/music.mp3`;
  await downloadFile(new URL(musicUrl, supabaseBaseUrl).href, musicPath);

  return { slides, musicPath, outputPath: `${basePath}/final.mp4` };
};

const createEditlyConfig = ({ slides, musicPath, outputPath }) => ({
  outPath: outputPath,
  width: 720,
  height: 1280,
  fps: 30,
  audioFilePath: musicPath,
  clips: slides.map((slide) => ({
    duration: 4,
    layers: [
      { type: 'image', path: slide.imagePath, zoomDirection: 'in' },
      ...(slide.subtitles.length > 0
        ? slide.subtitles.map((sub) => ({
            type: 'title',
            text: sub.text,
            position: 'bottom',
            fontSize: 36,
            start: sub.start,
            stop: sub.end,
          }))
        : []),
      { type: 'audio', path: slide.audioPath },
    ],
  })),
});

app.post('/register-job', async (req, res) => {
  const { requestId, webhookUrl, supabaseData, supabaseBaseUrl, music } = req.body;

  if (!requestId || !webhookUrl || !Array.isArray(supabaseData) || !supabaseBaseUrl || !music) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  JOBS.set(requestId, { status: 'pending', createdAt: new Date() });
  res.json({ success: true, requestId });

  try {
    const musicUrl = music;
    const assets = await downloadAssets(supabaseData, musicUrl, requestId, supabaseBaseUrl);

    const config = createEditlyConfig(assets);
    await editly(config);

    const videoBuffer = await fs.readFile(assets.outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, success: true, videoBase64 }),
    });

    JOBS.set(requestId, { status: 'completed', createdAt: new Date() });
  } catch (err) {
    console.error(err);
    JOBS.set(requestId, { status: 'failed', error: err.message });
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, success: false, error: err.message }),
    });
  }
});

app.get('/check-job/:requestId', (req, res) => {
  const job = JOBS.get(req.params.requestId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

ensureDirs().then(() => {
  app.listen(port, () => console.log(`🎬 Editly server running on port ${port}`));
});
