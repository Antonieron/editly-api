import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import editly from 'editly';
import ffmpegPath from 'ffmpeg-static';

process.env.FFMPEG_PATH = ffmpegPath;

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const JOBS = new Map();

const downloadFile = async (url, localPath) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}`);
  const buffer = await res.arrayBuffer();
  await fs.writeFile(localPath, Buffer.from(buffer));
};

const downloadAssets = async (data, jobId) => {
  const baseUrl = data.supabaseBaseUrl;
  const dir = `media/${jobId}`;
  await fs.mkdir(`${dir}/images`, { recursive: true });
  await fs.mkdir(`${dir}/audio`, { recursive: true });
  await fs.mkdir(`${dir}/text`, { recursive: true });

  const promises = data.supabaseData.map(async (slide, index) => {
    await downloadFile(`${baseUrl}${slide.image}`, `${dir}/images/${index}.jpg`);
    await downloadFile(`${baseUrl}${slide.audio}`, `${dir}/audio/${index}.mp3`);
    await downloadFile(`${baseUrl}${slide.text}`, `${dir}/text/${index}.json`);
  });

  await Promise.all(promises);

  if (data.music) {
    await downloadFile(`${baseUrl}${data.music}`, `${dir}/audio/music.mp3`);
  }

  return dir;
};

const generateVideo = async (jobId, numSlides) => {
  const dir = `media/${jobId}`;
  const slides = [];

  for (let i = 0; i < numSlides; i++) {
    const image = `${dir}/images/${i}.jpg`;
    const audio = `${dir}/audio/${i}.mp3`;
    const textPath = `${dir}/text/${i}.json`;

    let title = '';
    try {
      const json = JSON.parse(await fs.readFile(textPath, 'utf-8'));
      title = json.text || '';
    } catch (e) {
      console.warn(`Missing or invalid text for slide ${i}`);
    }

    slides.push({
      duration: 4,
      layers: [
        { type: 'image', path: image },
        { type: 'subtitle', text: title },
        { type: 'audio', path: audio }
      ]
    });
  }

  const outPath = `${dir}/final.mp4`;

  await editly({
    outPath,
    width: 1280,
    height: 720,
    fps: 30,
    audioFilePath: `${dir}/audio/music.mp3`,
    clips: slides
  });

  return outPath;
};

app.post('/register-job', async (req, res) => {
  const data = req.body;

  if (!data.requestId || !data.supabaseBaseUrl || !data.supabaseData || !data.webhookUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const jobId = data.requestId;
  JOBS.set(jobId, { status: 'pending', createdAt: new Date() });
  res.json({ success: true, jobId });

  try {
    const localDir = await downloadAssets(data, jobId);
    const videoPath = await generateVideo(jobId, data.numSlides);
    const videoBuffer = await fs.readFile(videoPath);
    const videoBase64 = videoBuffer.toString('base64');

    await fetch(data.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: true, videoBase64 })
    });

    JOBS.set(jobId, { status: 'completed', createdAt: new Date() });
  } catch (err) {
    console.error(err);
    JOBS.set(jobId, { status: 'failed', error: err.message });
    await fetch(data.webhookUrl, {
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
  console.log(`🎬 Editly server running on port ${port}`);
});
