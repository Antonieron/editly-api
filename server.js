import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// In-memory job storage
const JOBS = new Map();
const JOB_LOGS = new Map();

// Logging helper
const logToJob = (jobId, message, type = 'info') => {
  if (!JOB_LOGS.has(jobId)) JOB_LOGS.set(jobId, []);
  JOB_LOGS.get(jobId).push({ timestamp: new Date().toISOString(), type, message });
  console.log(`[${jobId.slice(-8)}] ${message}`);
};

// Text utils
const getTextLines = (text, maxWords = 8) => {
  const words = text.split(' ');
  const lines = [];
  for (let i = 0; i < words.length; i += maxWords) {
    lines.push(words.slice(i, i + maxWords).join(' '));
  }
  return lines;
};
const getFontSize = length => length > 100 ? '24px' : length > 50 ? '28px' : '32px';

// Directories
const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  for (const dir of ['audio', 'images', 'text', 'frames', 'video']) {
    await fs.mkdir(path.join(base, dir), { recursive: true });
  }
};

// Download helper
const downloadFile = async (url, dest, jobId) => {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${supabaseKey}` } });
  if (!res.ok) { logToJob(jobId, `Download failed: ${res.status}`, 'error'); return false; }
  const buf = await res.buffer();
  await fs.writeFile(dest, buf);
  logToJob(jobId, `Downloaded ${path.basename(dest)}`);
  return true;
};

// Fetch all media
const downloadAll = async (requestId, baseUrl, slidesData, music, jobId) => {
  const result = { music: false, slides: [] };
  if (music) {
    const mpath = path.join('media', requestId, 'audio', 'music.mp3');
    result.music = await downloadFile(`${baseUrl}${music}`, mpath, jobId);
  }
  for (let i = 0; i < slidesData.length; i++) {
    const slide = slidesData[i];
    const info = {};
    if (slide.image) {
      const img = path.join('media', requestId, 'images', `${i}.jpg`);
      info.image = await downloadFile(`${baseUrl}${slide.image}`, img, jobId) ? img : null;
    }
    if (slide.text) {
      const txt = path.join('media', requestId, 'text', `${i}.json`);
      if (await downloadFile(`${baseUrl}${slide.text}`, txt, jobId)) info.text = txt;
    }
    if (slide.audio) {
      const mp3 = path.join('media', requestId, 'audio', `${i}.mp3`);
      if (await downloadFile(`${baseUrl}${slide.audio}`, mp3, jobId)) {
        const wav = path.join('media', requestId, 'audio', `${i}.wav`);
        await execAsync(`ffmpeg -y -i "${mp3}" -c:a pcm_s16le -ar 44100 -ac 2 "${wav}"`);
        await fs.unlink(mp3);
        info.audio = wav;
      }
    }
    result.slides.push(info);
  }
  return result;
};

// Audio duration
const getDuration = async file => {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${file}"`);
    return parseFloat(stdout.trim());
  } catch {
    return 4.0;
  }
};

// Mix audio
const createMasterAudio = async (requestId, slides, jobId) => {
  const out = path.join('media', requestId, 'audio', 'master.wav');
  const inputs = [];
  const parts = [];
  let idx = 0, offset = 0;
  for (const s of slides) {
    if (s.audio) {
      const d = await getDuration(s.audio);
      inputs.push(`-i "${s.audio}"`);
      parts.push(`[${idx}:a]adelay=${offset*1000}|${offset*1000}[v${idx}];`);
      offset += d; idx++;
    }
  }
  const mfile = path.join('media', requestId, 'audio', 'music.mp3');
  if (await fs.access(mfile).then(()=>true).catch(()=>false)) {
    inputs.push(`-i "${mfile}"`);
    parts.push(`[${idx}:a]volume=0.2,aloop=loop=-1:size=2e+09,atrim=duration=${offset}[m${idx}];`);
    idx++;
  }
  if (!inputs.length) return null;
  const mix = `${parts.join('')}[${[...Array(idx).keys()].map(i=>i<idx-1?`v${i}`:`m${i}`).join('')} ]amix=inputs=${idx}:duration=longest[out]`;
  await execAsync(`ffmpeg -y ${inputs.join(' ')} -filter_complex "${mix}" -map "[out]" -c:a pcm_s16le -ar 44100 -ac 2 "${out}"`);
  logToJob(jobId, 'Master audio created');
  return out;
};

// Build clips
const buildClips = async (requestId, num, jobId) => {
  const clips = [];
  for (let i = 0; i < num; i++) {
    const img = path.join('media', requestId, 'images', `${i}.jpg`);
    if (!await fs.access(img).then(()=>true).catch(()=>false)) continue;
    let text = '';
    const txt = path.join('media', requestId, 'text', `${i}.json`);
    if (await fs.access(txt).then(()=>true).catch(()=>false)) {
      text = JSON.parse(await fs.readFile(txt,'utf8')).text || '';
    }
    const audio = path.join('media', requestId, 'audio', `${i}.wav`);
    const duration = await fs.access(audio).then(async()=>Math.max(await getDuration(audio),2)).catch(()=>4);
    clips.push({ imagePath: img, text, duration, fontSize: getFontSize(text.length) });
  }
  if (!clips.length) throw new Error('No valid clips');
  return clips;
};

// HTML template
const compileSceneHtml = (img, text, font) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;overflow:hidden;background:#000}img{width:100%;height:100%;object-fit:cover}.txt{position:absolute;bottom:5%;width:100%;text-align:center;color:#fff;font-size:${font};font-family:sans-serif;text-shadow:2px 2px 4px #000}</style></head><body><img src="file://${img}"><div class="txt">${getTextLines(text).join('<br/>')}</div></body></html>`;

// Render video
const renderVideo = async (requestId, clips, jobId) => {
  const w=1280,h=720,fps=30, dir=path.join('media',requestId,'frames');
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  let idx = 0;
  for (const clip of clips) {
    const html = compileSceneHtml(clip.imagePath, clip.text, clip.fontSize);
    const tmp = path.join(dir, `scene-${idx}.html`);
    await fs.writeFile(tmp, html);
    await page.goto(`file://${tmp}`, { waitUntil: 'networkidle0' });
    for (let f = 0; f < clip.duration * fps; f++) {
      await page.screenshot({ path: path.join(dir, `frame-${String(idx).padStart(6,'0')}.png`) });
      idx++;
    }
  }
  await browser.close();
  const raw = path.join('media', requestId, 'video', 'raw.mp4');
  await execAsync(`ffmpeg -y -framerate ${fps} -i "${dir}/frame-%06d.png" -c:v libx264 -pix_fmt yuv420p "${raw}"`);
  logToJob(jobId, 'Raw video created');
  return raw;
};

// Merge audio
const addAudioToVideo = async (video, audio, out, jobId) => {
  await execAsync(`ffmpeg -y -i "${video}" -i "${audio}" -c:v copy -c:a aac -b:a 192k -shortest "${out}"`);
  logToJob(jobId, 'Audio merged');
};

// Upload
const uploadVideoToSupabase = async (file, requestId, jobId) => {
  const buf = await fs.readFile(file);
  const name = `${requestId}/final.mp4`;
  const res = await fetch(`${supabaseUrl}/storage/v1/object/videos/${name}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: buf
  });
  if (!res.ok) throw new Error('Upload failed');
  return `${supabaseUrl}/storage/v1/object/public/videos/${name}`;
};

// Endpoints
app.post('/register-job', async (req, res) => {
  const { requestId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData, music } = req.body;
  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'started' });
  logToJob(jobId, 'Job started');
  res.json({ jobId });
  try {
    await ensureDirs(requestId);
    const dl = await downloadAll(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    const clips = await buildClips(requestId, numSlides, jobId);
    const masterAudio = await createMasterAudio(requestId, dl.slides, jobId);
    const rawVideo = await renderVideo(requestId, clips, jobId);
    let final = rawVideo;
    if (masterAudio) {
      final = path.join('media', requestId, 'video', 'final.mp4');
      await addAudioToVideo(rawVideo, masterAudio, final, jobId);
    }
    const url = await uploadVideoToSupabase(final, requestId, jobId);
    logToJob(jobId, `Completed ${url}`);
    JOBS.set(jobId, { status: 'completed', videoUrl: url });
    await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, success: true, videoUrl: url }) });
  } catch (err) {
    logToJob(jobId, err.message, 'error');
    JOBS.set(jobId, { status: 'failed', error: err.message });
    await fetch(req.body.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, success: false, error: err.message }) });
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({ job, logs });
});

app.listen(port, () => console.log(`Server running on port ${port}`));
