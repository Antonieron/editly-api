// server.js
import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import editly from 'editly';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const JOBS = new Map();

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const downloadFile = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}`);
  const buffer = await res.buffer();
  await ensureDir(path.dirname(dest));
  await fs.writeFile(dest, buffer);
};

const downloadAssets = async (baseUrl, requestId, supabaseData, musicPath) => {
  const base = `media/${requestId}`;
  const files = [];

  for (const [index, item] of supabaseData.entries()) {
    const imagePath = `${base}/${item.image}`;
    const audioPath = `${base}/${item.audio}`;
    const textPath = `${base}/${item.text}`;

    await downloadFile(baseUrl + item.image, imagePath);
    await downloadFile(baseUrl + item.audio, audioPath);
    await downloadFile(baseUrl + item.text, textPath);

    files.push({ image: imagePath, audio: audioPath, text: textPath });
  }

  const musicLocal = `${base}/${musicPath}`;
  await downloadFile(baseUrl + musicPath, musicLocal);

  return { slides: files, music: musicLocal };
};

const parseTextJson = async (textPath) => {
  try {
    const data = await fs.readFile(textPath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.warn(`❌ Failed to parse text JSON at ${textPath}`);
    return null;
  }
};

const buildEditSpec = async (slides, musicPath, outputPath) => {
  const clips = [];

  for (const [index, slide] of slides.entries()) {
    if (!fssync.existsSync(slide.image) || !fssync.existsSync(slide.audio) || !fssync.existsSync(slide.text)) {
      console.warn(`❌ Missing file for slide ${index}`);
      continue;
    }

    const textData = await parseTextJson(slide.text);
    if (!textData || !Array.isArray(textData.subtitles)) {
      console.warn(`❌ Invalid text for slide ${index}`);
      continue;
    }

    clips.push({
      duration: 4,
      audio: { path: slide.audio },
      layers: [
        { type: 'image', path: slide.image },
        ...textData.subtitles.map(txt => ({ type: 'title', text: txt.text, position: txt.position || 'bottom' }))
      ]
    });
  }

  return {
    outPath: outputPath,
    width: 1280,
    height: 720,
    fps: 30,
    audioFilePath: musicPath,
    clips
  };
};

app.post('/register-job', async (req, res) => {
  const { requestId, webhookUrl, supabaseBaseUrl, music, supabaseData } = req.body;

  if (!requestId || !webhookUrl || !supabaseBaseUrl || !music || !Array.isArray(supabaseData)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'pending', createdAt: new Date() });
  res.json({ success: true, jobId });

  try {
    const { slides, music: musicPath } = await downloadAssets(supabaseBaseUrl, requestId, supabaseData, music);
    const outputPath = `media/${requestId}/video/final.mp4`;
    const editSpec = await buildEditSpec(slides, musicPath, outputPath);

    await editly(editSpec);
    const videoBuffer = await fs.readFile(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: true, videoBase64 })
    });

    JOBS.set(jobId, { status: 'completed', createdAt: new Date() });
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

app.listen(port, () => {
  console.log(`🎬 Server running on port ${port}`);
});
