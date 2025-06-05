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

// Supabase конфигурация
const supabaseUrl = process.env.SUPABASE_URL || 'https://qpwsccpzxohrtvjrrncq.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwd3NjY3B6eG9ocnR2anJybmNxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Nzc1OTE4NSwiZXhwIjoyMDYzMzM1MTg1fQ.bCGkuo-VM0w_J7O0-tDeZ_hCTr6VxqvR8ARUjgZz9UQ';

const JOBS = new Map();
const JOB_LOGS = new Map();

// Функция для логирования с сохранением в память
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
  
  const logs = JOB_LOGS.get(jobId); // Исправлено: добавлено определение logs
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100);
  }
  
  console.log(`[${jobId.slice(-8)}] ${message}`);
};

// Функция для получения длительности аудиофайла через ffprobe
const getAudioDuration = async (audioPath, jobId) => {
  try {
    const command = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`;
    const { stdout } = await execAsync(command);
    const duration = parseFloat(stdout.trim());
    
    if (isNaN(duration) || duration <= 0) {
      logToJob(jobId, `⚠️ Invalid audio duration for ${audioPath}: ${stdout.trim()}`, 'warn');
      return 4;
    }
    
    logToJob(jobId, `🎵 Audio duration: ${duration.toFixed(2)}s for ${path.basename(audioPath)}`);
    return duration;
  } catch (error) {
    logToJob(jobId, `❌ Failed to get audio duration for ${audioPath}: ${error.message}`, 'error');
    return 4;
  }
};

const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  await fs.mkdir(path.join(base, 'audio'), { recursive: true });
  await fs.mkdir(path.join(base, 'images'), { recursive: true });
  await fs.mkdir(path.join(base, 'text'), { recursive: true });
  await fs.mkdir(path.join(base, 'video'), { recursive: true });
};

// Функция для скачивания файла из Supabase
const downloadFile = async (url, localPath, timeout = 30000) => {
  try {
    console.log(`⬇️ Downloading: ${url}`);
    
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
    
    const contentLength = response.headers.get('content-length');
    console.log(`📦 Content-Length: ${contentLength ? `${Math.round(contentLength/1024)}KB` : 'unknown'}`);
    
    const buffer = await response.buffer();
    await fs.writeFile(localPath, buffer);
    
    console.log(`✅ Downloaded: ${path.basename(localPath)} (${Math.round(buffer.length/1024)}KB)`);
    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`⏰ Download timeout: ${url}`);
    } else {
      console.error(`❌ Download failed: ${url} - ${error.message}`);
    }
    return false;
  }
};

// Функция для загрузки всех файлов из Supabase
const downloadAllFiles = async (requestId, supabaseBaseUrl, supabaseData, music, jobId) => {
  logToJob(jobId, `Starting downloads for request: ${requestId}`);
  
  const results = {
    music: false,
    slides: []
  };
  
  if (music) {
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    logToJob(jobId, `Downloading background music: ${musicUrl}`);
    results.music = await downloadFile(musicUrl, musicPath);
    logToJob(jobId, `Background music download result: ${results.music ? 'SUCCESS' : 'FAILED'}`);
  } else {
    logToJob(jobId, 'No background music provided');
  }
  
  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];
    const slideResult = { index: i, image: false, audio: false, text: false };
    
    logToJob(jobId, `Processing slide ${i}:`);
    
    if (slide.image) {
      const imageUrl = `${supabaseBaseUrl}${slide.image}`; // Исправлено: формируем imageUrl
      const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
      logToJob(jobId, `  - Image: ${imageUrl}`); // Исправлено: логируем отдельно
      slideResult.image = await downloadFile(imageUrl, imagePath);
      logToJob(jobId, `  - Image result: ${slideResult.image ? 'SUCCESS' : 'FAILED'}`);
    } else {
      logToJob(jobId, `  - Image: NOT PROVIDED`);
    }
    
    if (slide.audio) {
      const audioUrl = `${supabaseBaseUrl}${slide.audio}`;
      const audioPath = path.join('media', requestId, 'audio', `${i}.mp3`);
      logToJob(jobId, `  - Audio: ${audioUrl}`);
      slideResult.audio = await downloadFile(audioUrl, audioPath);
      logToJob(jobId, `  - Audio result: ${slideResult.audio ? 'SUCCESS' : 'FAILED'}`);
    } else {
      logToJob(jobId, `  - Audio: NOT PROVIDED`);
    }
    
    if (slide.text) {
      const textUrl = `${supabaseBaseUrl}${slide.text}`;
      const textPath = path.join('media', requestId, 'text', `${i}.json`);
      logToJob(jobId, `  - Text: ${textUrl}`);
      slideResult.text = await downloadFile(textUrl, textPath);
      logToJob(jobId, `  - Text result: ${slideResult.text ? 'SUCCESS' : 'FAILED'}`);
    } else {
      logToJob(jobId, `  - Text: NOT PROVIDED`);
    }
    
    results.slides.push(slideResult);
  }
  
  logToJob(jobId, `Download summary: Music=${results.music}, Slides processed=${results.slides.length}`);
  return results;
};

// Функция для загрузки видео в Supabase через REST API
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
      logToJob(jobId, `Supabase upload error: ${response.status} - ${errorText}`, 'error');
      throw new Error(`Upload failed: ${response.status} - ${errorText}`);
    }
    
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${fileName}`;
    logToJob(jobId, `Video uploaded successfully: ${publicUrl}`);
    
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
  const textDir = path.join('media', requestId, 'text');
  const clips = [];

  logToJob(jobId, `Building edit spec for ${numSlides} slides`);

  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join(imageDir, `${i}.jpg`);
    const audioPath = path.join(audioDir, `${i}.mp3`);
    const textPath = path.join(textDir, `${i}.json`);

    let imageExists = false;
    let audioExists = false;
    
    try {
      await fs.access(imagePath);
      imageExists = true;
      logToJob(jobId, `✅ Image exists for slide ${i}`);
    } catch (e) {
      logToJob(jobId, `❌ Image file missing for slide ${i}`, 'error');
    }
    
    try {
      await fs.access(audioPath);
      audioExists = true;
      logToJob(jobId, `✅ Audio exists for slide ${i}`);
    } catch (e) {
      logToJob(jobId, `❌ Audio file missing for slide ${i}`, 'warn');
    }

    if (!imageExists) {
      logToJob(jobId, `Skipping slide ${i} - missing image`, 'error');
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
        logToJob(jobId, `✅ Text layer added for slide ${i}: "${textData.text.substring(0, 30)}..."`);
      }
    } catch (e) {
      logToJob(jobId, `❌ Text file missing/invalid for slide ${i}`, 'warn');
    }

    let clipDuration = 4;
    if (audioExists) {
      clipDuration = await getAudioDuration(audioPath, jobId);
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

    if (audioExists) {
      clipConfig.audioTracks = [{
        path: audioPath,
        start: 0,
        mixVolume: 1.0
      }];
      logToJob(jobId, `🔊 Audio track added for slide ${i} (${clipDuration.toFixed(2)}s)`);
    } else {
      logToJob(jobId, `⏱️ Silent slide ${i} (${clipDuration}s)`);
    }

    clips.push(clipConfig);
    logToJob(jobId, `Added slide ${i} to clips (${audioExists ? 'with audio' : 'silent'}, ${clipDuration.toFixed(2)}s)`);
  }

  if (clips.length === 0) {
    throw new Error('No valid clips were created - all slides are missing required files');
  }

  const musicPath = path.join(audioDir, 'music.mp3');
  const outPath = path.join('media', requestId, 'video', 'final.mp4');

  const spec = {
    outPath,
    width: 854,
    height: 480,
    fps: 24,
    clips,
    defaults: {
      transition: { name: 'fade', duration: 0.3 }
    },
    enableFfmpegLog: true,
    verbose: true,
    audioNorm: {
      enable: false
    }
  };

  let musicExists = false;
  try {
    await fs.access(musicPath);
    musicExists = true;
    logToJob(jobId, '🎵 Background music file found');
    
    spec.audioTracks = [{
      path: musicPath,
      mixVolume: 0.15,
      start: 0,
      cutFrom: 0
    }];
    
    logToJob(jobId, '🎵 Background music track added to spec (volume: 0.15)');
  } catch (e) {
    logToJob(jobId, '❌ Background music file not found, proceeding without it', 'warn');
  }

  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  logToJob(jobId, `📊 Total video duration: ${totalDuration.toFixed(2)}s (${Math.round(totalDuration/60)}:${String(Math.round(totalDuration%60)).padStart(2, '0')})`);

  logToJob(jobId, `Edit spec created successfully:`);
  logToJob(jobId, `  - Clips: ${clips.length}`);
  logToJob(jobId, `  - Background music: ${musicExists ? 'YES' : 'NO'}`);
  logToJob(jobId, `  - Output: ${outPath}`);
  
  clips.forEach((clip, index) => {
    const hasAudio = clip.audioTracks && clip.audioTracks.length > 0;
    const hasText = clip.layers.some(layer => layer.type === 'title');
    logToJob(jobId, `  - Clip ${index}: ${hasAudio ? '🔊' : '🔇'} ${hasText ? '📝' : '  '} ${clip.duration.toFixed(2)}s`);
  });

  return spec;
};

// Функция очистки временных файлов
const cleanupFiles = async (requestId) => {
  if (requestId === '85dca25d-fc8a-45df-81d2-7698b0364ea1') {
    console.log(`🛑 Cleanup skipped for request: ${requestId}`);
    return;
  }
  try {
    const mediaPath = path.join('media', requestId);
    await fs.rm(mediaPath, { recursive: true, force: true });
    console.log(`🗑️ Cleaned up files for request: ${requestId}`);
  } catch (error) {
    console.warn(`Failed to cleanup files: ${error.message}`);
  }
};

// Эндпоинт для скачивания видео
app.get('/download-video/:requestId', async (req, res) => {
  const { requestId } = req.params;
  const videoPath = path.join('media', requestId, 'video', 'final.mp4');

  try {
    await fs.access(videoPath);
    
    const stats = await fs.stat(videoPath);
    const videoSizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
    logToJob(requestId, `Downloading video: ${videoPath} (${videoSizeMB}MB)`);

    res.setHeader('Content-Disposition', `attachment; filename="final_${requestId}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    
    const videoStream = fs.createReadStream(videoPath);
    videoStream.pipe(res);
    
    logToJob(requestId, `Video download started for ${requestId}`);
  } catch (error) {
    logToJob(requestId, `Error downloading video: ${error.message}`, 'error');
    res.status(404).json({ error: 'Видео не найдено или уже удалено' });
  }
});

app.post('/register-job', async (req, res) => {
  const { requestId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData, music } = req.body;
  
  if (!requestId || !numSlides || !webhookUrl) {
    return res.status(400).json({ error: 'Missing required fields: requestId, numSlides, webhookUrl' });
  }

  if (!supabaseBaseUrl || !supabaseData) {
    return res.status(400).json({ error: 'Missing Supabase data: supabaseBaseUrl, supabaseData' });
  }

  const jobId = uuidv4();
  
  try {
    await ensureDirs(requestId);
    JOBS.set(jobId, { status: 'started', createdAt: new Date(), requestId });
    res.json({ success: true, jobId });

    console.log(`🎬 Job ${jobId} started for request ${requestId}`);
    logToJob(jobId, `Job started for request ${requestId}`);
    logToJob(jobId, `Slides to process: ${numSlides}`);
    logToJob(jobId, `Background music: ${music ? 'PROVIDED' : 'NOT PROVIDED'}`);

    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    logToJob(jobId, 'Starting file downloads from Supabase');
    const downloadResults = await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    
    const successfulSlides = downloadResults.slides.filter(slide => slide.image).length;
    const slidesWithAudio = downloadResults.slides.filter(slide => slide.audio).length;
    
    logToJob(jobId, `Download completed: ${successfulSlides}/${numSlides} slides with images, ${slidesWithAudio} with audio`);
    
    if (successfulSlides === 0) {
      throw new Error('No slides with images were downloaded successfully');
    }
    
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    logToJob(jobId, 'Downloads completed, starting video processing');
    
    const spec = await buildEditSpec(requestId, numSlides, jobId);
    logToJob(jobId, 'Starting video creation with editly...');
    
    const editlyOptions = {
      ...spec,
      onProgress: (progress) => {
        logToJob(jobId, `Video rendering progress: ${Math.round(progress * 100)}%`);
      }
    };
    
    await editly(editlyOptions);
    logToJob(jobId, '🎉 Video creation completed successfully!');
    
    try {
      const stats = await fs.stat(spec.outPath);
      logToJob(jobId, `Video file size: ${Math.round(stats.size / (1024 * 1024) * 100) / 100}MB`);
    } catch (e) {
      throw new Error('Video file was not created successfully');
    }
    
    JOBS.set(jobId, { status: 'uploading', createdAt: new Date(), requestId });
    const uploadResult = await uploadVideoToSupabase(spec.outPath, requestId, jobId);
    
    const webhookPayload = {
      jobId,
      success: true,
      requestId,
      videoUrl: uploadResult.publicUrl,
      videoPath: uploadResult.path,
      videoSize: uploadResult.size,
      timestamp: new Date().toISOString(),
      stats: {
        slidesProcessed: successfulSlides,
        slidesWithAudio: slidesWithAudio,
        hasBackgroundMusic: downloadResults.music
      }
    };

    logToJob(jobId, 'Sending webhook with video URL');
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload)
    });

    if (!webhookResponse.ok) {
      logToJob(jobId, `Webhook response not OK: ${webhookResponse.status}`, 'warn');
    } else {
      logToJob(jobId, 'Webhook sent successfully');
    }

    JOBS.set(jobId, { 
      status: 'completed', 
      createdAt: new Date(), 
      requestId,
      videoUrl: uploadResult.publicUrl 
    });
    logToJob(jobId, `🎊 Job completed successfully! Video: ${uploadResult.publicUrl}`);

    setTimeout(() => cleanupFiles(requestId), 30000);
  } catch (err) {
    console.error(`💥 Job ${jobId} failed:`, err.message);
    console.error('Stack trace:', err.stack);
    
    logToJob(jobId, `❌ Job failed: ${err.message}`, 'error');
    logToJob(jobId, `Stack trace: ${err.stack}`, 'error');
    
    JOBS.set(jobId, { 
      status: 'failed', 
      error: err.message, 
      stack: err.stack,
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
      logToJob(jobId, `Failed to send error webhook: ${webhookError.message}`, 'error');
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
    nodeVersion: process.version,
    supabaseUrl: supabaseUrl
  });
});

app.get('/debug/last-job', (req, res) => {
  const jobs = Array.from(JOBS.entries()).sort((a, b) => b[1].createdAt - a[1].createdAt);
  if (jobs.length === 0) {
    return res.json({ message: 'No jobs found' });
  }
  
  const [jobId, job] = jobs[0];
  const logs = JOB_LOGS.get(jobId) || [];
  
  res.json({
    jobId,
    job,
    logs: logs,
    totalJobs: JOBS.size
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
  console.log(`🎬 Editly server running on port ${port}`);
  console.log(`🏥 Health check: http://localhost:${port}/health`);
  console.log(`🐛 Debug endpoint: http://localhost:${port}/debug/last-job`);
  console.log(`📊 Node.js version: ${process.version}`);
  console.log(`☁️ Supabase URL: ${supabaseUrl}`);
});
