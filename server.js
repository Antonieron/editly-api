// enhanced server.js for Railway deployment
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

const getMediaPath = (requestId, type, filename) => path.join('media', requestId, type, filename);

const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  await fs.mkdir(path.join(base, 'audio'), { recursive: true });
  await fs.mkdir(path.join(base, 'images'), { recursive: true });
  await fs.mkdir(path.join(base, 'text'), { recursive: true });
  await fs.mkdir(path.join(base, 'video'), { recursive: true });
};

// Функция для скачивания файла из Supabase
const downloadFile = async (url, localPath) => {
  try {
    console.log(`Downloading: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.buffer();
    await fs.writeFile(localPath, buffer);
    console.log(`✓ Downloaded: ${path.basename(localPath)}`);
    return true;
  } catch (error) {
    console.error(`✗ Error downloading ${url}:`, error.message);
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

const buildEditSpec = async (requestId, numSlides) => {
  const imageDir = path.join('media', requestId, 'images');
  const audioDir = path.join('media', requestId, 'audio');
  const textDir = path.join('media', requestId, 'text');
  const clips = [];

  console.log(`Building edit spec for ${numSlides} slides`);

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
      console.warn(`⚠️  Image file missing for slide ${i}`);
    }
    
    try {
      await fs.access(audioPath);
      audioExists = true;
    } catch (e) {
      console.warn(`⚠️  Audio file missing for slide ${i}`);
    }

    if (!imageExists) {
      console.error(`❌ Skipping slide ${i} - missing image`);
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
      console.warn(`⚠️  Text file missing/invalid for slide ${i}`);
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
    console.log(`✓ Added slide ${i} to clips`);
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
    console.log('✓ Background music added');
  } catch (e) {
    console.warn('⚠️  Background music not found, proceeding without it');
  }

  console.log(`Edit spec created with ${clips.length} clips`);
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

    // Скачиваем все файлы из Supabase
    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music);
    
    // Обновляем статус
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    
    // Создаем видео
    const spec = await buildEditSpec(requestId, numSlides);
    console.log('🎥 Starting video creation...');
    
    await editly(spec);
    console.log('✅ Video creation completed');
    
    // Читаем результат
    const buffer = await fs.readFile(spec.outPath);
    const base64 = buffer.toString('base64');

    // Отправляем результат
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, success: true, videoBase64: base64 })
    });

    if (!webhookResponse.ok) {
      console.warn(`Webhook response not OK: ${webhookResponse.status}`);
    }

    JOBS.set(jobId, { status: 'completed', createdAt: new Date(), requestId });
    console.log(`🎉 Job ${jobId} completed successfully`);

    // Очищаем временные файлы
    setTimeout(() => cleanupFiles(requestId), 60000); // Очистка через 1 минуту

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
  res.json(job);
});

// Endpoint для проверки здоровья сервиса
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeJobs: JOBS.size,
    nodeVersion: process.version
  });
});

// Очистка старых задач каждые 10 минут
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 минут
  
  for (const [jobId, job] of JOBS.entries()) {
    if (now - job.createdAt.getTime() > maxAge) {
      JOBS.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

app.listen(port, () => {
  console.log(`🎬 Editly server running on port ${port}`);
  console.log(`🏥 Health check: http://localhost:${port}/health`);
  console.log(`📊 Node.js version: ${process.version}`);
});
