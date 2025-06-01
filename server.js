// server.js
import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
process.env.FFMPEG_PATH = ffmpegPath;


ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const JOBS = new Map();

const ensureDirs = async () => {
  await fs.mkdir('images', { recursive: true });
  await fs.mkdir('output', { recursive: true });
};

const downloadImages = async (supabaseData, jobId) => {
  const dir = `images/${jobId}`;
  await fs.mkdir(dir, { recursive: true });
  const files = [];

  for (let i = 0; i < supabaseData.length; i++) {
    const url = supabaseData[i].image_url;
    const res = await fetch(url);
    const buffer = await res.buffer();
    const filename = `${dir}/img${i}.jpg`;
    await fs.writeFile(filename, buffer);
    files.push(filename);
  }
  return files;
};

const generateFfmpegVideo = async (files, jobId) => {
  const listPath = `images/${jobId}/input.txt`;
  const content = files.map(f => `file '${path.resolve(f)}'\nduration 3`).join('\n') + `\nfile '${path.resolve(files.at(-1))}'`;
  await fs.writeFile(listPath, content);

  const outPath = `output/${jobId}.mp4`;
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-vf scale=1280:720', '-pix_fmt yuv420p'])
      .output(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .run();
  });
};

app.post('/register-job', async (req, res) => {
  const { supabaseData, webhookUrl } = req.body;

  if (!Array.isArray(supabaseData) || !webhookUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'pending', createdAt: new Date() });
  res.json({ success: true, jobId });

  try {
    const files = await downloadImages(supabaseData, jobId);
    const videoPath = await generateFfmpegVideo(files, jobId);
    const videoBuffer = await fs.readFile(videoPath);
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

ensureDirs().then(() => {
  app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
});
