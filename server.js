import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import editly from 'editly';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || 'https://qpwsccpzxohrtvjrrncq.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwd3NjY3B6eG9ocnR2anJybmNxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Nzc1OTE4NSwiZXhwIjoyMDYzMzM1MTg1fQ.bCGkuo-VM0w_J7O0-tDeZ_hCTr6VxqvR8ARUjgZz9UQ';

const JOBS = new Map();
const JOB_LOGS = new Map();

const logToJob = (jobId, message, type = 'info') => {
  if (!JOB_LOGS.has(jobId)) JOB_LOGS.set(jobId, []);
  JOB_LOGS.get(jobId).push({ timestamp: new Date().toISOString(), type, message });
  const logs = JOB_LOGS.get(jobId);
  if (logs.length > 100) logs.splice(0, logs.length - 100);
  console.log(`[${jobId.slice(-8)}] ${message}`);
};

const getAudioDuration = async (audioPath) => {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`);
    return parseFloat(stdout.trim());
  } catch (error) {
    return 4.0;
  }
};

const createMasterAudio = async (requestId, clips, jobId) => {
  try {
    const masterAudioPath = path.join('media', requestId, 'audio', 'master.mp3');
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    
    let hasMusic = false;
    try {
      await fs.access(musicPath);
      hasMusic = true;
    } catch (e) {}
    
    let filterComplex = '';
    let inputs = '';
    let currentTime = 0;
    
    for (let i = 0; i < clips.length; i++) {
      if (clips[i].voiceAudio) {
        inputs += ` -i "${clips[i].voiceAudio}"`;
      }
    }
    
    if (hasMusic) {
      inputs += ` -i "${musicPath}"`;
    }
    
    let voiceIndex = 0;
    for (let i = 0; i < clips.length; i++) {
      if (clips[i].voiceAudio) {
        filterComplex += `[${voiceIndex}:a]adelay=${Math.round(currentTime * 1000)}|${Math.round(currentTime * 1000)}[v${i}];`;
        voiceIndex++;
      }
      currentTime += clips[i].duration;
    }
    
    let mixInputs = '';
    for (let i = 0; i < clips.length; i++) {
      if (clips[i].voiceAudio) {
        mixInputs += `[v${i}]`;
      }
    }
    
    if (hasMusic) {
      const musicIndex = voiceIndex;
      filterComplex += `[${musicIndex}:a]volume=0.3,aloop=loop=-1:size=2e+09[bg];`;
      filterComplex += `${mixInputs}[bg]amix=inputs=${voiceIndex + 1}:duration=longest`;
    } else {
      filterComplex += `${mixInputs}amix=inputs=${voiceIndex}:duration=longest`;
    }
    
    const command = `ffmpeg -y${inputs} -filter_complex "${filterComplex}" -t ${currentTime} -c:a aac -b:a 128k -ar 44100 -ac 2 "${masterAudioPath}"`;
    
    logToJob(jobId, `Creating master audio: ${command}`);
    await execAsync(command);
    
    await fs.access(masterAudioPath);
    logToJob(jobId, 'Master audio created successfully');
    return masterAudioPath;
    
  } catch (error) {
    logToJob(jobId, `Master audio failed: ${error.message}`, 'error');
    return null;
  }
};

const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  await fs.mkdir(path.join(base, 'audio'), { recursive: true });
  await fs.mkdir(path.join(base, 'images'), { recursive: true });
  await fs.mkdir(path.join(base, 'text'), { recursive: true });
  await fs.mkdir(path.join(base, 'video'), { recursive: true });
};

const downloadFile = async (url, localPath, timeout = 30000) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VideoProcessor/1.0)' }
    });
    
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const buffer = await response.buffer();
    await fs.writeFile(localPath, buffer);
    return true;
  } catch (error) {
    console.error(`Download failed: ${url}`);
    return false;
  }
};

const downloadAllFiles = async (requestId, supabaseBaseUrl, supabaseData, music, jobId) => {
  const results = { music: false, slides: [] };
  
  if (music) {
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    results.music = await downloadFile(musicUrl, musicPath);
  }
  
  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];
    const slideResult = { index: i, image: false, audio: false, text: false };
    
    if (slide.image) {
      const imageUrl = `${supabaseBaseUrl}${slide.image}`;
      const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
      slideResult.image = await downloadFile(imageUrl, imagePath);
    }
    
    if (slide.audio) {
      const audioUrl = `${supabaseBaseUrl}${slide.audio}`;
      const audioPath = path.join('media', requestId, 'audio', `${i}.mp3`);
      slideResult.audio = await downloadFile(audioUrl, audioPath);
    }
    
    if (slide.text) {
      const textUrl = `${supabaseBaseUrl}${slide.text}`;
      const textPath = path.join('media', requestId, 'text', `${i}.json`);
      slideResult.text = await downloadFile(textUrl, textPath);
    }
    
    results.slides.push(slideResult);
  }
  
  return results;
};

const uploadVideoToSupabase = async (videoPath, requestId, jobId) => {
  const videoBuffer = await fs.readFile(videoPath);
  const fileName = `${requestId}/final.mp4`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${fileName}`;
  
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true'
    },
    body: videoBuffer
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed: ${response.status}`);
  }
  
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${fileName}`;
  return { success: true, path: fileName, publicUrl, size: videoBuffer.length };
};

const buildEditSpec = async (requestId, numSlides, jobId) => {
  const imageDir = path.join('media', requestId, 'images');
  const audioDir = path.join('media', requestId, 'audio');
  const textDir = path.join('media', requestId, 'text');
  const clips = [];

  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join(imageDir, `${i}.jpg`);
    const voiceAudioPath = path.join(audioDir, `${i}.mp3`);
    const textPath = path.join(textDir, `${i}.json`);

    let imageExists = false;
    let voiceExists = false;
    
    try {
      await fs.access(imagePath);
      imageExists = true;
    } catch (e) {}
    
    try {
      await fs.access(voiceAudioPath);
      voiceExists = true;
    } catch (e) {}

    if (!imageExists) continue;

    let textLayer = null;
    try {
      const textData = JSON.parse(await fs.readFile(textPath, 'utf-8'));
      if (textData.text && textData.text.trim()) {
        textLayer = {
          type: 'title',
          text: textData.text,
          position: textData.position || 'center',
          color: textData.color || 'white',
          fontSize: textData.fontSize || 48,
          fontFamily: 'Arial'
        };
      }
    } catch (e) {}

    let clipDuration = 4;
    if (voiceExists) {
      const audioDuration = await getAudioDuration(voiceAudioPath);
      if (audioDuration > 0) clipDuration = audioDuration;
    }

    const layers = [{ type: 'image', path: imagePath }];
    if (textLayer) layers.push(textLayer);

    const clipConfig = {
      layers,
      duration: clipDuration,
      voiceAudio: voiceExists ? voiceAudioPath : null
    };

    clips.push(clipConfig);
  }

  if (clips.length === 0) throw new Error('No valid clips created');

  const masterAudioPath = await createMasterAudio(requestId, clips, jobId);
  const outPath = path.join('media', requestId, 'video', 'final.mp4');

  const editlySpec = {
    outPath,
    width: 1280,
    height: 720,
    fps: 30,
    clips: clips.map(clip => ({
      layers: clip.layers,
      duration: clip.duration
    })),
    defaults: { transition: { name: 'fade', duration: 0.5 } },
    audioFilePath: masterAudioPath,
    keepSourceAudio: false
  };

  return editlySpec;
};

const cleanupFiles = async (requestId) => {
  try {
    await fs.rm(path.join('media', requestId), { recursive: true, force: true });
  } catch (error) {}
};

app.post('/register-job', async (req, res) => {
  const { requestId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData, music } = req.body;
  
  if (!requestId || !numSlides || !webhookUrl || !supabaseBaseUrl || !supabaseData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const jobId = uuidv4();
  
  try {
    await ensureDirs(requestId);
    JOBS.set(jobId, { status: 'started', createdAt: new Date(), requestId });
    res.json({ success: true, jobId });

    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    const downloadResults = await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    
    const successfulSlides = downloadResults.slides.filter(slide => slide.image).length;
    if (successfulSlides === 0) throw new Error('No slides downloaded');
    
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    
    const spec = await buildEditSpec(requestId, numSlides, jobId);
    logToJob(jobId, 'Starting video creation...');
    
    await editly(spec);
    logToJob(jobId, 'Video created!');
    
    JOBS.set(jobId, { status: 'uploading', createdAt: new Date(), requestId });
    const uploadResult = await uploadVideoToSupabase(spec.outPath, requestId, jobId);
    
    const webhookPayload = {
      jobId,
      success: true,
      requestId,
      videoUrl: uploadResult.publicUrl,
      timestamp: new Date().toISOString()
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    });

    JOBS.set(jobId, { 
      status: 'completed', 
      createdAt: new Date(), 
      requestId,
      videoUrl: uploadResult.publicUrl 
    });

    setTimeout(() => cleanupFiles(requestId), 30000);

  } catch (err) {
    JOBS.set(jobId, { status: 'failed', error: err.message, createdAt: new Date(), requestId });
    
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, success: false, error: err.message, requestId, timestamp: new Date().toISOString() })
      });
    } catch (webhookError) {}

    setTimeout(() => cleanupFiles(requestId), 5000);
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({ ...job, logs: logs.slice(-10), totalLogs: logs.length });
});

app.get('/job-logs/:jobId', (req, res) => {
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({ logs, total: logs.length });
});

app.get('/video-url/:requestId', (req, res) => {
  const { requestId } = req.params;
  for (const [jobId, job] of JOBS.entries()) {
    if (job.requestId === requestId && job.status === 'completed' && job.videoUrl) {
      return res.json({ success: true, videoUrl: job.videoUrl, requestId, jobId });
    }
  }
  res.status(404).json({ error: 'Video not found' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), activeJobs: JOBS.size });
});

setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000;
  for (const [jobId, job] of JOBS.entries()) {
    if (now - job.createdAt.getTime() > maxAge) {
      JOBS.delete(jobId);
      JOB_LOGS.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
