// server.js
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import editly from 'editly';

const app = express();
const port = process.env.PORT || 3000;

const JOBS = new Map();

app.use(express.json());

const ensureDirs = async () => {
  await fs.mkdir('images', { recursive: true });
  await fs.mkdir('output', { recursive: true });
};

// Загружаем картинки по URL
const downloadImages = async (supabaseData, jobId) => {
  const dir = `images/${jobId}`;
  await fs.mkdir(dir, { recursive: true });

  const files = [];
  for (let i = 0; i < supabaseData.length; i++) {
    const { image_url, text = '' } = supabaseData[i];
    const res = await fetch(image_url);
    const buffer = await res.buffer();
    const filePath = `${dir}/img${i}.jpg`;
    await fs.writeFile(filePath, buffer);
    files.push({ path: filePath, text });
  }
  return files;
};

// Создание видео через editly
const generateEditlyVideo = async (slides, jobId) => {
  const outputPath = `output/${jobId}.mp4`;

  const clips = slides.map(({ path, text }) => ({
    duration: 3,
    transition: { name: 'fade', duration: 1 },
    layers: [
      { type: 'image', path },
      ...(text ? [{ type: 'title', text }] : [])
    ]
  }));

  await editly({
    width: 1280,
    height: 720,
    fps: 30,
    outPath: outputPath,
    clips
  });

  return outputPath;
};

// Основной endpoint
app.post('/register-job', async (req, res) => {
  const { supabaseData, webhookUrl } = req.body;
  if (!Array.isArray(supabaseData) || !webhookUrl) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'processing', createdAt: new Date() });
  res.json({ success: true, jobId });

  try {
    const slides = await downloadImages(supabaseData, jobId);
    const videoPath = await generateEditlyVideo(slides, jobId);
    const videoBuffer = await fs.readFile(videoPath);
    const base64 = videoBuffer.toString('base64');

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: true, videoBase64: base64 })
    });

    JOBS.set(jobId, { status: 'completed' });
    await fs.unlink(videoPath);
  } catch (err) {
    console.error('Job error:', err);
    JOBS.set(jobId, { status: 'failed', error: err.message });

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: false, error: err.message })
    });
  }
});

// Проверка статуса
app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// Запуск сервера
ensureDirs().then(() => {
  app.listen(port, () => {
    console.log(`🎬 Editly server running on port ${port}`);
  });
});
