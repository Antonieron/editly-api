// enhanced server.js for Railway deployment with Supabase upload
import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import editly from 'editly';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// Инициализация Supabase клиента
const supabaseUrl = process.env.SUPABASE_URL || 'https://qpwsccpzxohrtvjrrncq.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'ваш-ключ-здесь';
const supabase = createClient(supabaseUrl, supabaseKey);

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
  
  // Ограничиваем количество логов (последние 100)
  const logs = JOB_LOGS.get(jobId);
  if (logs.length > 100) {
    logs.splice(0, logs.length - 100);
  }
  
  console.log(`[${jobId.slice(-8)}] ${message}`);
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
    console.log(`⬇️  Downloading: ${url}`);
    
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
const downloadAllFiles = async (requestId, supabaseBaseUrl, supabaseData, music) => {
  console.log(`Starting downloads for request: ${requestId}`);
  
  const results = {
    music: false,
    slides: []
  };
  
  // Скачиваем музыку
  if (music) {
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    results.music = await downloadFile(musicUrl, musicPath);
  }
  
  // Скачиваем файлы для каждого слайда
  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];
    const slideResult = { index: i, image: false, audio: false, text: false };
    
    // Скачиваем изображение
    if (slide.image) {
      const imageUrl = `${supabaseBaseUrl}${slide.image}`;
      const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
      slideResult.image = await downloadFile(imageUrl, imagePath);
    }
    
    // Скачиваем аудио
    if (slide.audio) {
      const audioUrl = `${supabaseBaseUrl}${slide.audio}`;
      const audioPath = path.join('media', requestId, 'audio', `${i}.mp3`);
      slideResult.audio = await downloadFile(audioUrl, audioPath);
    }
    
    // Скачиваем текст
    if (slide.text) {
      const textUrl = `${supabaseBaseUrl}${slide.text}`;
      const textPath = path.join('media', requestId, 'text', `${i}.json`);
      slideResult.text = await downloadFile(textUrl, textPath);
    }
    
    results.slides.push(slideResult);
  }
  
  console.log('Download results:', results);
  return results;
};

// Функция для загрузки видео в Supabase
const uploadVideoToSupabase = async (videoPath, requestId, jobId) => {
  try {
    logToJob(jobId, 'Starting video upload to Supabase');
    
    const videoBuffer = await fs.readFile(videoPath);
    const videoSizeMB = Math.round(videoBuffer.length / (1024 * 1024) * 100) / 100;
    logToJob(jobId, `Uploading video: ${videoSizeMB}MB`);
    
    // Загружаем в bucket 'videos'
    const fileName = `${requestId}/final.mp4`;
    const { data, error } = await supabase.storage
      .from('videos') // убедитесь что у вас есть bucket 'videos'
      .upload(fileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true // перезаписываем если файл уже существует
      });
    
    if (error) {
      logToJob(jobId, `Supabase upload error: ${error.message}`, 'error');
      throw error;
    }
    
    // Получаем публичную ссылку
    const { data: publicUrlData } = supabase.storage
      .from('videos')
      .getPublicUrl(fileName);
    
    const publicUrl = publicUrlData.publicUrl;
    logToJob(jobId, `Video uploaded successfully: ${publicUrl}`);
    
    return {
      success: true,
      path: data.path,
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

    // Проверяем существование файлов
    let imageExists = false;
    let audioExists = false;
    
    try {
      await fs.access(imagePath);
      imageExists = true;
    } catch (e) {
      logToJob(jobId, `Image file missing for slide ${i}`, 'warn');
    }
    
    try {
      await fs.access(audioPath);
      audioExists = true;
    } catch (e) {
      logToJob(jobId, `Audio file missing for slide ${i}`, 'warn');
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
          fontSize: textData.fontSize || 48
        };
      }
    } catch (e) {
      logToJob(jobId, `Text file missing/invalid for slide ${i}`, 'warn');
    }

    const layers = [
      { type: 'image', path: imagePath }
    ];

    if (textLayer) {
      layers.push(textLayer);
    }

    const clipConfig = {
      duration: 4,
      layers
    };

    // Добавляем аудио только если файл существует
    if (audioExists) {
      clipConfig.audio = { path: audioPath };
    }

    clips.push(clipConfig);
    logToJob(jobId, `Added slide ${i} to clips`);
  }

  if (clips.length === 0) {
    throw new Error('No valid clips were created - all slides are missing required files');
  }

  const musicPath = path.join(audioDir, 'music.mp3');
  const outPath = path.join('media', requestId, 'video', 'final.mp4');

  const spec = {
    outPath,
    width: 1280,
    height: 720,
    fps: 30,
    clips,
    // Отключаем GL переходы для избежания проблем с OpenGL
    defaults: {
      transition: { name: 'fade', duration: 0.5 }
    }
  };

  // Добавляем фоновую музыку только если файл существует
  try {
    await fs.access(musicPath);
    spec.audio = { path: musicPath, mixVolume: 0.3 };
    logToJob(jobId, 'Background music added');
  } catch (e) {
    logToJob(jobId, 'Background music not found, proceeding without it', 'warn');
  }

  logToJob(jobId, `Edit spec created with ${clips.length} clips`);
  return spec;
};

// Функция очистки временных файлов
const cleanupFiles = async (requestId) => {
  try {
    const mediaPath = path.join('media', requestId);
    await fs.rm(mediaPath, { recursive: true, force: true });
    console.log(`🗑️  Cleaned up files for request: ${requestId}`);
  } catch (error) {
    console.warn(`Failed to cleanup files: ${error.message}`);
  }
};

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

    // Скачиваем все файлы из Supabase
    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    logToJob(jobId, 'Starting file downloads from Supabase');
    await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music);
    
    // Обновляем статус
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    logToJob(jobId, 'Downloads completed, starting video processing');
    
    // Создаем видео
    const spec = await buildEditSpec(requestId, numSlides, jobId);
    logToJob(jobId, 'Starting video creation with editly');
    
    await editly(spec);
    logToJob(jobId, 'Video creation completed successfully');
    
    // Загружаем видео в Supabase
    JOBS.set(jobId, { status: 'uploading', createdAt: new Date(), requestId });
    const uploadResult = await uploadVideoToSupabase(spec.outPath, requestId, jobId);
    
    // Подготавливаем данные для webhook
    const webhookPayload = {
      jobId,
      success: true,
      requestId,
      videoUrl: uploadResult.publicUrl,
      videoPath: uploadResult.path,
      videoSize: uploadResult.size,
      timestamp: new Date().toISOString()
    };

    // Отправляем результат через webhook
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
    logToJob(jobId, `Job completed successfully. Video available at: ${uploadResult.publicUrl}`);

    // Очищаем временные файлы (теперь можно быстрее, так как видео уже в облаке)
    setTimeout(() => cleanupFiles(requestId), 30000); // 30 секунд

  } catch (err) {
    console.error(`💥 Job ${jobId} failed:`, err.message);
    console.error('Stack trace:', err.stack);
    
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
        body: JSON.stringify({ jobId, success: false, error: err.message })
      });
    } catch (webhookError) {
      console.error('Failed to send error webhook:', webhookError.message);
    }

    // Очищаем временные файлы даже при ошибке
    setTimeout(() => cleanupFiles(requestId), 5000);
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({
    ...job,
    logs: logs.slice(-10), // Последние 10 логов
    totalLogs: logs.length
  });
});

// Endpoint для получения всех логов
app.get('/job-logs/:jobId', (req, res) => {
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  res.json({ logs, total: logs.length });
});

// Endpoint для получения ссылки на видео
app.get('/video-url/:requestId', (req, res) => {
  const { requestId } = req.params;
  
  // Ищем завершенную задачу с этим requestId
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

// Endpoint для проверки здоровья сервиса
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeJobs: JOBS.size,
    nodeVersion: process.version,
    supabaseConnected: !!supabase
  });
});

// Очистка старых задач каждые 10 минут
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 минут
  
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
  console.log(`📊 Node.js version: ${process.version}`);
  console.log(`☁️  Supabase connected: ${!!supabase}`);
});
