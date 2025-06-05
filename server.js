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
  if (!JOB_LOGS.has(jobId)) {
    JOB_LOGS.set(jobId, []);
  }
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    message
  };
  JOB_LOGS.get(jobId).push(logEntry);
  const logs = JOB_LOGS.get(jobId);
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100);
  }
  console.log(`[${jobId.slice(-8)}] ${message}`);
};

const getAudioDuration = async (audioPath) => {
  try {
    const command = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`;
    const { stdout } = await execAsync(command);
    return parseFloat(stdout.trim());
  } catch (error) {
    return 4.0;
  }
};

const createAudioMix = async (voiceAudioPath, backgroundMusicPath, outputPath, duration, jobId) => {
  try {
    logToJob(jobId, `Creating audio mix for ${duration}s`);
    
    let command = `ffmpeg -y -i "${voiceAudioPath}"`;
    
    let hasBackgroundMusic = false;
    try {
      await fs.access(backgroundMusicPath);
      hasBackgroundMusic = true;
      command += ` -i "${backgroundMusicPath}"`;
    } catch (e) {
      logToJob(jobId, 'No background music');
    }
    
    if (hasBackgroundMusic) {
      command += ` -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.2,aloop=loop=-1:size=2e+09[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=0" -t ${duration} -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
    } else {
      command += ` -filter_complex "[0:a]volume=1.0" -t ${duration} -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
    }
    
    await execAsync(command);
    
    try {
      await fs.access(outputPath);
      logToJob(jobId, 'Audio mix created successfully');
      return true;
    } catch (e) {
      throw new Error('Output file not created');
    }
    
  } catch (error) {
    logToJob(jobId, `Audio mix failed: ${error.message}`, 'error');
    
    try {
      const fallbackCommand = `ffmpeg -y -i "${voiceAudioPath}" -t ${duration} -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
      await execAsync(fallbackCommand);
      logToJob(jobId, 'Fallback to voice-only successful');
      return true;
    } catch (fallbackError) {
      logToJob(jobId, `Fallback failed: ${fallbackError.message}`, 'error');
      return false;
    }
  }
};

const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  await fs.mkdir(path.join(base, 'audio'), { recursive: true });
  await fs.mkdir(path.join(base, 'audio', 'mixed'), { recursive: true });
  await fs.mkdir(path.join(base, 'images'), { recursive: true });
  await fs.mkdir(path.join(base, 'text'), { recursive: true });
  await fs.mkdir(path.join(base, 'video'), { recursive: true });
};

const downloadFile = async (url, localPath, timeout = 30000) => {
  try {
    console.log(`Downloading: ${url}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VideoProcessor/1.0)'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const buffer = await response.buffer();
    await fs.writeFile(localPath, buffer);
    
    console.log(`Downloaded: ${path.basename(localPath)} (${Math.round(buffer.length/1024)}KB)`);
    return true;
  } catch (error) {
    console.error(`Download failed: ${url} - ${error.message}`);
    return false;
  }
};

const downloadAllFiles = async (requestId, supabaseBaseUrl, supabaseData, music, jobId) => {
  logToJob(jobId, `Starting downloads for request: ${requestId}`);
  
  const results = {
    music: false,
    slides: []
  };
  
  if (music) {
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    logToJob(jobId, `Downloading background music`);
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
  try {
    logToJob(jobId, 'Starting video upload to Supabase');
    
    const videoBuffer = await fs.readFile(videoPath);
    const videoSizeMB = Math.round(videoBuffer.length / (1024 * 1024) * 100) / 100;
    logToJob(jobId, `Uploading video: ${videoSizeMB}MB`);
    
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
      throw new Error(`Upload failed: ${response.status} - ${errorText}`);
    }
    
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${fileName}`;
    logToJob(jobId, `Video uploaded successfully`);
    
    return {
      success: true,
      path: fileName,
      publicUrl: publicUrl,
      size: videoBuffer.length
    };
    
  } catch (error) {
    logToJob(jobId, `Failed to upload video: ${error.message}`, 'error');
    throw error;
  }
};

const buildEditSpec = async (requestId, numSlides, jobId) => {
  const imageDir = path.join('media', requestId, 'images');
  const audioDir = path.join('media', requestId, 'audio');
  const mixedAudioDir = path.join('media', requestId, 'audio', 'mixed');
  const textDir = path.join('media', requestId, 'text');
  const musicPath = path.join(audioDir, 'music.mp3');
  const clips = [];

  logToJob(jobId, `Building edit spec for ${numSlides} slides`);

  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join(imageDir, `${i}.jpg`);
    const voiceAudioPath = path.join(audioDir, `${i}.mp3`);
    const mixedAudioPath = path.join(mixedAudioDir, `${i}.mp3`);
    const textPath = path.join(textDir, `${i}.json`);

    let imageExists = false;
    let voiceExists = false;
    
    try {
      await fs.access(imagePath);
      imageExists = true;
    } catch (e) {
      logToJob(jobId, `Image missing for slide ${i}`, 'error');
    }
    
    try {
      await fs.access(voiceAudioPath);
      voiceExists = true;
    } catch (e) {
      logToJob(jobId, `Voice audio missing for slide ${i}`, 'warn');
    }

    if (!imageExists) {
      continue;
    }

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
    } catch (e) {
      logToJob(jobId, `Text missing for slide ${i}`, 'warn');
    }

    let clipDuration = 4;
    let finalAudioPath = null;
    
    if (voiceExists) {
      const audioDuration = await getAudioDuration(voiceAudioPath);
      if (audioDuration > 0) {
        clipDuration = audioDuration;
        
        const mixSuccess = await createAudioMix(voiceAudioPath, musicPath, mixedAudioPath, clipDuration, jobId);
        
        if (mixSuccess) {
          finalAudioPath = mixedAudioPath;
          logToJob(jobId, `Using mixed audio for slide ${i} (${clipDuration.toFixed(2)}s)`);
        }
      }
    }

    const layers = [
      { type: 'image', path: imagePath }
    ];

    if (textLayer) {
      layers.push(textLayer);
    }

    const clipConfig = {
      layers,
      duration: clipDuration
    };

    if (finalAudioPath) {
      clipConfig.audioPath = finalAudioPath;
    }

    clips.push(clipConfig);
  }

  if (clips.length === 0) {
    throw new Error('No valid clips were created');
  }

  const outPath = path.join('media', requestId, 'video', 'final.mp4');

  const spec = {
    outPath,
    width: 1280,
    height: 720,
    fps: 30,
    clips,
    defaults: {
      transition: { name: 'fade', duration: 0.5 }
    },
    audioCodec: 'aac',
    audioBitrate: '128k',
    audioSampleRate: 44100,
    audioChannels: 2
  };

  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  logToJob(jobId, `Total video duration: ${totalDuration.toFixed(2)}s`);

  return spec;
};

const cleanupFiles = async (requestId) => {
  try {
    const mediaPath = path.join('media', requestId);
    await fs.rm(mediaPath, { recursive: true, force: true });
    console.log(`Cleaned up files for request: ${requestId}`);
  } catch (error) {
    console.warn(`Failed to cleanup files: ${error.message}`);
  }
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

    logToJob(jobId, `Job started for request ${requestId}`);

    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    const downloadResults = await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    
    const successfulSlides = downloadResults.slides.filter(slide => slide.image).length;
    
    if (successfulSlides === 0) {
      throw new Error('No slides with images were downloaded');
    }
    
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    
    const spec = await buildEditSpec(requestId, numSlides, jobId);
    logToJob(jobId, 'Starting video creation...');
    
    await editly(spec);
    logToJob(jobId, 'Video creation completed!');
    
    const stats = await fs.stat(spec.outPath);
    logToJob(jobId, `Video file size: ${Math.round(stats.size / (1024 * 1024) * 100) / 100}MB`);
    
    JOBS.set(jobId, { status: 'uploading', createdAt: new Date(), requestId });
    const uploadResult = await uploadVideoToSupabase(spec.outPath, requestId, jobId);
    
    const webhookPayload = {
      jobId,
      success: true,
      requestId,
      videoUrl: uploadResult.publicUrl,
      videoPath: uploadResult.path,
      videoSize: uploadResult.size,
      timestamp: new Date().toISOString()
    };

    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    });

    if (!webhookResponse.ok) {
      logToJob(jobId, `Webhook response not OK: ${webhookResponse.status}`, 'warn');
    }

    JOBS.set(jobId, { 
      status: 'completed', 
      createdAt: new Date(), 
      requestId,
      videoUrl: uploadResult.publicUrl 
    });
    logToJob(jobId, `Job completed! Video: ${uploadResult.publicUrl}`);

    setTimeout(() => cleanupFiles(requestId), 30000);

  } catch (err) {
    console.error(`Job ${jobId} failed:`, err.message);
    
    logToJob(jobId, `Job failed: ${err.message}`, 'error');
    
    JOBS.set(jobId, { 
      status: 'failed', 
      error: err.message,
      createdAt: new Date(),
      requestId 
    });
    
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          jobId, 
          success: false, 
          error: err.message,
          requestId,
          timestamp: new Date().toISOString()
        })
      });
    } catch (webhookError) {
      console.error('Failed to send error webhook:', webhookError.message);
    }

    setTimeout(() => cleanupFiles(requestId), 5000);
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({
    ...job,
    logs: logs.slice(-10),
    totalLogs: logs.length
  });
});

app.get('/job-logs/:jobId', (req, res) => {
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({ logs, total: logs.length });
});

app.get('/video-url/:requestId', (req, res) => {
  const { requestId } = req.params;
  
  for (const [jobId, job] of JOBS.entries()) {
    if (job.requestId === requestId && job.status === 'completed' && job.videoUrl) {
      return res.json({
        success: true,
        videoUrl: job.videoUrl,
        requestId,
        jobId
      });
    }
  }
  
  res.status(404).json({ error: 'Video not found or not ready' });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeJobs: JOBS.size,
    nodeVersion: process.version
  });
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
  console.log(`Editly server running on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
});
