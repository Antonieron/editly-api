// enhanced server.js with FIXED audio support and duration measurement
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
  
  // Ограничиваем количество логов (последние 100)
  const logs = JOB_LOGS.get(jobId);
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
      return 4; // Fallback to 4 seconds
    }
    
    logToJob(jobId, `🎵 Audio duration: ${duration.toFixed(2)}s for ${path.basename(audioPath)}`);
    return duration;
  } catch (error) {
    logToJob(jobId, `❌ Failed to get audio duration for ${audioPath}: ${error.message}`, 'error');
    return 4; // Fallback to 4 seconds
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
const downloadAllFiles = async (requestId, supabaseBaseUrl, supabaseData, music, jobId) => {
  logToJob(jobId, `Starting downloads for request: ${requestId}`);
  
  const results = {
    music: false,
    slides: []
  };
  
  // Скачиваем музыку
  if (music) {
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    logToJob(jobId, `Downloading background music: ${musicUrl}`);
    results.music = await downloadFile(musicUrl, musicPath);
    logToJob(jobId, `Background music download result: ${results.music ? 'SUCCESS' : 'FAILED'}`);
  } else {
    logToJob(jobId, 'No background music provided');
  }
  
  // Скачиваем файлы для каждого слайда
  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];
    const slideResult = { index: i, image: false, audio: false, text: false };
    
    logToJob(jobId, `Processing slide ${i}:`);
    
    // Скачиваем изображение
    if (slide.image) {
      const imageUrl = `${supabaseBaseUrl}${slide.image}`;
      const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
      logToJob(jobId, `  - Image: ${imageUrl}`);
      slideResult.image = await downloadFile(imageUrl, imagePath);
      logToJob(jobId, `  - Image result: ${slideResult.image ? 'SUCCESS' : 'FAILED'}`);
    } else {
      logToJob(jobId, `  - Image: NOT PROVIDED`);
    }
    
    // Скачиваем аудио
    if (slide.audio) {
      const audioUrl = `${supabaseBaseUrl}${slide.audio}`;
      const audioPath = path.join('media', requestId, 'audio', `${i}.mp3`);
      logToJob(jobId, `  - Audio: ${audioUrl}`);
      slideResult.audio = await downloadFile(audioUrl, audioPath);
      logToJob(jobId, `  - Audio result: ${slideResult.audio ? 'SUCCESS' : 'FAILED'}`);
    } else {
      logToJob(jobId, `  - Audio: NOT PROVIDED`);
    }
    
    // Скачиваем текст
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
    
    // Загружаем через REST API
    const fileName = `${requestId}/final.mp4`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/videos/${fileName}`;
    
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true' // перезаписываем если файл уже существует
      },
      body: videoBuffer
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logToJob(jobId, `Supabase upload error: ${response.status} - ${errorText}`, 'error');
      throw new Error(`Upload failed: ${response.status} - ${errorText}`);
    }
    
    // Получаем публичную ссылку
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

    // Проверяем существование файлов
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

    // Читаем текстовый файл
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

    // Получаем длительность аудио если оно есть
    let clipDuration = 4; // Default duration
    if (audioExists) {
      clipDuration = await getAudioDuration(audioPath, jobId);
    }

    // Создаем слои для клипа
    const layers = [
      { type: 'image', path: imagePath }
    ];

    if (textLayer) {
      layers.push(textLayer);
    }

    // ИСПРАВЛЕНО: Правильная структура клипа с фиксированной длительностью
    const clipConfig = {
      layers,
      duration: clipDuration // ВАЖНО: устанавливаем точную длительность
    };

    // Добавляем аудио как отдельную дорожку
    if (audioExists) {
      clipConfig.audioTracks = [{
        path: audioPath,
        start: 0,
        mixVolume: 1.0 // Полная громкость для озвучки
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

  // Базовая конфигурация для editly
  const spec = {
    outPath,
    width: 854,
    height: 480,
    fps: 24,
    clips,
    // Простые переходы для стабильности
    defaults: {
      transition: { name: 'fade', duration: 0.3 }
    },
    // Включаем подробное логирование
    enableFfmpegLog: true,
    verbose: true,
    // ВАЖНО: Отключаем нормализацию аудио чтобы сохранить исходную громкость
    audioNorm: {
      enable: false
    }
  };

  // Проверяем и добавляем фоновую музыку
  let musicExists = false;
  try {
    await fs.access(musicPath);
    musicExists = true;
    logToJob(jobId, '🎵 Background music file found');
    
    // Добавляем фоновую музыку как глобальную дорожку
    spec.audioTracks = [{
      path: musicPath,
      mixVolume: 0.15, // Еще тише чтобы не заглушать голос
      start: 0,
      // Зацикливаем музыку если видео длиннее
      cutFrom: 0
    }];
    
    logToJob(jobId, '🎵 Background music track added to spec (volume: 0.15)');
  } catch (e) {
    logToJob(jobId, '❌ Background music file not found, proceeding without it', 'warn');
  }

  // Подсчитаем общую длительность видео
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  logToJob(jobId, `📊 Total video duration: ${totalDuration.toFixed(2)}s (${Math.round(totalDuration/60)}:${String(Math.round(totalDuration%60)).padStart(2, '0')})`);

  logToJob(jobId, `Edit spec created successfully:`);
  logToJob(jobId, `  - Clips: ${clips.length}`);
  logToJob(jobId, `  - Background music: ${musicExists ? 'YES' : 'NO'}`);
  logToJob(jobId, `  - Output: ${outPath}`);
  
  // Подробная информация о каждом клипе для отладки
  clips.forEach((clip, index) => {
    const hasAudio = clip.audioTracks && clip.audioTracks.length > 0;
    const hasText = clip.layers.some(layer => layer.type === 'title');
    logToJob(jobId, `  - Clip ${index}: ${hasAudio ? '🔊' : '🔇'} ${hasText ? '📝' : '  '} ${clip.duration.toFixed(2)}s`);
  });

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
    logToJob(jobId, `Slides to process: ${numSlides}`);
    logToJob(jobId, `Background music: ${music ? 'PROVIDED' : 'NOT PROVIDED'}`);

    // Скачиваем все файлы из Supabase
    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    logToJob(jobId, 'Starting file downloads from Supabase');
    const downloadResults = await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    
    // Проверяем что скачалось
    const successfulSlides = downloadResults.slides.filter(slide => slide.image).length;
    const slidesWithAudio = downloadResults.slides.filter(slide => slide.audio).length;
    
    logToJob(jobId, `Download completed: ${successfulSlides}/${numSlides} slides with images, ${slidesWithAudio} with audio`);
    
    if (successfulSlides === 0) {
      throw new Error('No slides with images were downloaded successfully');
    }
    
    // Обновляем статус
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    logToJob(jobId, 'Downloads completed, starting video processing');
    
    // Создаем видео
    const spec = await buildEditSpec(requestId, numSlides, jobId);
    logToJob(jobId, 'Starting video creation with editly...');
    
    // Добавляем обработчик прогресса editly если возможно
    const editlyOptions = {
      ...spec,
      onProgress: (progress) => {
        logToJob(jobId, `Video rendering progress: ${Math.round(progress * 100)}%`);
      }
    };
    
    await editly(editlyOptions);
    logToJob(jobId, '🎉 Video creation completed successfully!');
    
    // Проверяем что файл действительно создался
    try {
      const stats = await fs.stat(spec.outPath);
      logToJob(jobId, `Video file size: ${Math.round(stats.size / (1024 * 1024) * 100) / 100}MB`);
    } catch (e) {
      throw new Error('Video file was not created successfully');
    }
    
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
      timestamp: new Date().toISOString(),
      stats: {
        slidesProcessed: successfulSlides,
        slidesWithAudio: slidesWithAudio,
        hasBackgroundMusic: downloadResults.music
      }
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
    logToJob(jobId, `🎊 Job completed successfully! Video: ${uploadResult.publicUrl}`);

    // Очищаем временные файлы (теперь можно быстрее, так как видео уже в облаке)
    setTimeout(() => cleanupFiles(requestId), 30000); // 30 секунд

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
    supabaseUrl: supabaseUrl
  });
});

// Endpoint для отладки - показать детали последней задачи
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
  console.log(`🐛 Debug endpoint: http://localhost:${port}/debug/last-job`);
  console.log(`📊 Node.js version: ${process.version}`);
  console.log(`☁️  Supabase URL: ${supabaseUrl}`);
});
