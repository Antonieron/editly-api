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

// Настройки по умолчанию
const DEFAULT_SETTINGS = {
  voiceVolume: 1.0,
  musicVolume: 0.2,
  fontSize: 40, // В пикселях для Editly
  fontColor: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 4,
  transitionName: 'fade', // Поддерживаемые Editly переходы
  transitionDuration: 0.5,
  enableKenBurns: true, // Эффект Ken Burns для изображений
  kenBurnsZoomAmount: 1.1, // Степень увеличения (1.1 = 10%)
  textPosition: { x: 0.5, y: 0.85 } // Позиция текста
};

// Поддерживаемые переходы Editly
const SUPPORTED_TRANSITIONS = [
  'fade', 'fadegrayscale', 'random',
  'directional-left', 'directional-right', 'directional-up', 'directional-down',
  'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
  'sliding-left', 'sliding-right', 'sliding-up', 'sliding-down'
];

// Функция для определения размера шрифта
const calculateFontSize = (settings, textLength) => {
  // Если передан конкретный размер, используем его
  if (typeof settings.fontSize === 'number') {
    return settings.fontSize;
  }
  
  // Динамический размер в зависимости от длины текста
  if (textLength > 100) return 30;
  if (textLength > 50) return 35;
  return 40;
};

// Добавленные функции для улучшения обработки текста титров
const getTextLines = (text, maxWordsPerLine) => {
  const words = text.split(' ');
  const lines = [];
  for (let i = 0; i < words.length; i += maxWordsPerLine) {
    lines.push(words.slice(i, i + maxWordsPerLine).join(' '));
  }
  return lines;
};

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

const createMasterAudio = async (requestId, clips, jobId, settings) => {
  try {
    const masterAudioPath = path.join('media', requestId, 'audio', 'master.wav');
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');

    let hasMusic = false;
    try {
      await fs.access(musicPath);
      hasMusic = true;
      logToJob(jobId, 'Background music found');
    } catch (e) {
      logToJob(jobId, 'No background music');
    }

    const audioInputs = [];
    const filterParts = [];
    let inputIndex = 0;

    let currentTime = 0;
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];

      if (clip.voiceAudio) {
        const audioDuration = await getAudioDuration(clip.voiceAudio);
        audioInputs.push(`-i "${clip.voiceAudio}"`);
        // Используем настройку громкости голоса
        filterParts.push(`[${inputIndex}:a]volume=${settings.voiceVolume},adelay=${Math.round(currentTime * 1000)}|${Math.round(currentTime * 1000)}[voice${inputIndex}]`);
        inputIndex++;
        currentTime += clip.duration;
      } else {
        currentTime += clip.duration;
      }
    }

    if (audioInputs.length === 0 && !hasMusic) {
      logToJob(jobId, 'No audio to process');
      return null;
    }

    const totalDuration = currentTime;

    if (hasMusic) {
      audioInputs.push(`-i "${musicPath}"`);
      // Используем настройку громкости музыки
      filterParts.push(`[${inputIndex}:a]volume=${settings.musicVolume},aloop=loop=-1:size=2e+09,atrim=duration=${totalDuration}[music]`);
    }

    let command;
    if (audioInputs.length > 0) {
      const voiceInputs = filterParts.filter(f => f.includes('voice')).map((_, i) => `[voice${i}]`).join('');
      const mixInputs = voiceInputs + (hasMusic ? '[music]' : '');
      const mixCount = (audioInputs.length - (hasMusic ? 1 : 0)) + (hasMusic ? 1 : 0);

      if (audioInputs.length === 1 && !hasMusic) {
        command = `ffmpeg -y ${audioInputs[0]} -filter:a "volume=${settings.voiceVolume}" -c:a pcm_s16le -ar 44100 -ac 2 "${masterAudioPath}"`;
      } else {
        // normalize=0 предотвращает автоматическое изменение громкости
        const filterComplex = filterParts.join(';') + `;${mixInputs}amix=inputs=${mixCount}:duration=longest:normalize=0[out]`;
        command = `ffmpeg -y ${audioInputs.join(' ')} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s16le -ar 44100 -ac 2 "${masterAudioPath}"`;
      }

      logToJob(jobId, `Creating master audio with voice volume: ${settings.voiceVolume}, music volume: ${settings.musicVolume}`);
      await execAsync(command);

      await fs.access(masterAudioPath);
      const stats = await fs.stat(masterAudioPath);
      logToJob(jobId, `Master audio: ${Math.round(stats.size / 1024)}KB`);
      return masterAudioPath;
    }

    return null;
  } catch (error) {
    logToJob(jobId, `Audio creation failed: ${error.message}`, 'error');
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
    logToJob(jobId, `Downloading music: ${music}`);
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

      if (slideResult.audio) {
        const wavPath = path.join('media', requestId, 'audio', `${i}.wav`);
        try {
          await execAsync(`ffmpeg -y -i "${audioPath}" -c:a pcm_s16le -ar 44100 -ac 2 "${wavPath}"`);
          await fs.unlink(audioPath);
        } catch (e) {
          logToJob(jobId, `Audio convert failed for slide ${i}`, 'error');
        }
      }
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
    throw new Error(`Upload failed: ${response.status}`);
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${fileName}`;
  return { success: true, path: fileName, publicUrl, size: videoBuffer.length };
};

const buildEditSpec = async (requestId, numSlides, jobId, settings) => {
  const imageDir = path.join('media', requestId, 'images');
  const audioDir = path.join('media', requestId, 'audio');
  const textDir = path.join('media', requestId, 'text');
  const clips = [];

  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join(imageDir, `${i}.jpg`);
    const voiceAudioPath = path.join(audioDir, `${i}.wav`);
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

    if (!imageExists) {
      logToJob(jobId, `Skip slide ${i} - no image`);
      continue;
    }

    let clipDuration = 4;
    if (voiceExists) {
      const audioDuration = await getAudioDuration(voiceAudioPath);
      if (audioDuration > 0) {
        clipDuration = Math.max(audioDuration, 2);
      }
    }

    const layers = [];
    
    // Слой изображения с эффектом Ken Burns (если включен)
    if (settings.enableKenBurns) {
      layers.push({
        type: 'image',
        path: imagePath,
        zoomDirection: i % 2 === 0 ? 'in' : 'out', // Чередуем направление зума
        zoomAmount: settings.kenBurnsZoomAmount
      });
    } else {
      layers.push({
        type: 'image',
        path: imagePath
      });
    }

    // Обработка текста
    try {
      const textData = JSON.parse(await fs.readFile(textPath, 'utf-8'));
      if (textData.text && textData.text.trim()) {
        const text = textData.text;
        const lines = getTextLines(text, 8);
        const fontSize = calculateFontSize(settings, text.length);

        // Добавляем фоновую подложку для текста
        layers.push({
          type: 'title-background',
          text: lines.join('\n'),
          position: settings.textPosition,
          fontSize: fontSize,
          color: 'rgba(0,0,0,0.7)', // Полупрозрачный черный фон
          padding: 10
        });

        // Добавляем сам текст
        layers.push({
          type: 'subtitle',
          text: lines.join('\n'),
          position: settings.textPosition,
          fontSize: fontSize,
          color: textData.color || settings.fontColor,
          fontFamily: textData.fontFamily || 'Arial',
          strokeWidth: settings.strokeWidth,
          strokeColor: settings.strokeColor
        });
      }
    } catch (e) {
      logToJob(jobId, `Failed to process text for slide ${i}: ${e.message}`);
    }

    clips.push({
      layers,
      duration: clipDuration,
      voiceAudio: voiceExists ? voiceAudioPath : null
    });
  }

  if (clips.length === 0) throw new Error('No valid clips');

  const finalVideoPath = path.join('media', requestId, 'video', 'final.mp4');

  // Проверяем, что переход поддерживается
  const transitionName = SUPPORTED_TRANSITIONS.includes(settings.transitionName) 
    ? settings.transitionName 
    : 'fade';

  const editlySpec = {
    outPath: finalVideoPath,
    width: 1280,
    height: 720,
    fps: 30,
    clips: clips.map(clip => ({
      layers: clip.layers,
      duration: clip.duration
    })),
    defaults: {
      transition: { 
        name: transitionName, 
        duration: settings.transitionDuration 
      },
      layer: { 
        resizeMode: 'contain'
      }
    },
    keepSourceAudio: false,
    fast: false
  };

  return { editlySpec, clips, finalVideoPath };
};

const cleanupFiles = async (requestId) => {
  try {
    await fs.rm(path.join('media', requestId), { recursive: true, force: true });
  } catch (error) {}
};

app.post('/register-job', async (req, res) => {
  const { 
    requestId, 
    numSlides, 
    webhookUrl, 
    supabaseBaseUrl, 
    supabaseData, 
    music,
    settings = {} 
  } = req.body;

  if (!requestId || !numSlides || !webhookUrl || !supabaseBaseUrl || !supabaseData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Объединяем переданные настройки с настройками по умолчанию
  const finalSettings = { ...DEFAULT_SETTINGS, ...settings };

  const jobId = uuidv4();

  try {
    await ensureDirs(requestId);
    JOBS.set(jobId, { status: 'started', createdAt: new Date(), requestId });
    res.json({ success: true, jobId });

    logToJob(jobId, `Processing ${numSlides} slides with settings: ${JSON.stringify(finalSettings)}`);
    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    const downloadResults = await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music, jobId);

    const successfulSlides = downloadResults.slides.filter(slide => slide.image).length;
    const audioSlides = downloadResults.slides.filter(slide => slide.audio).length;

    logToJob(jobId, `Downloaded ${successfulSlides} images, ${audioSlides} audio`);

    if (successfulSlides === 0) throw new Error('No slides downloaded');

    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });

    const { editlySpec, clips, finalVideoPath } = await buildEditSpec(requestId, numSlides, jobId, finalSettings);

    const masterAudioPath = await createMasterAudio(requestId, clips, jobId, finalSettings);

    if (masterAudioPath) {
      editlySpec.audioFilePath = masterAudioPath;
      editlySpec.keepSourceAudio = true;
    }

    logToJob(jobId, 'Creating video with Editly');
    await editly(editlySpec);
    logToJob(jobId, 'Video created');

    const videoStats = await fs.stat(finalVideoPath);
    logToJob(jobId, `Video ready: ${Math.round(videoStats.size / 1024 / 1024)}MB`);

    JOBS.set(jobId, { status: 'uploading', createdAt: new Date(), requestId });
    const uploadResult = await uploadVideoToSupabase(finalVideoPath, requestId, jobId);

    const webhookPayload = {
      jobId,
      success: true,
      requestId,
      videoUrl: uploadResult.publicUrl,
      timestamp: new Date().toISOString(),
      settings: finalSettings
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
      videoUrl: uploadResult.publicUrl,
      settings: finalSettings
    });

    logToJob(jobId, `Completed: ${uploadResult.publicUrl}`);
    setTimeout(() => cleanupFiles(requestId), 30000);

  } catch (err) {
    logToJob(jobId, `Failed: ${err.message}`, 'error');
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

// Эндпоинт для получения поддерживаемых настроек
app.get('/supported-settings', (req, res) => {
  res.json({
    transitions: SUPPORTED_TRANSITIONS,
    defaultSettings: DEFAULT_SETTINGS,
    info: {
      fontSize: "Number in pixels (e.g., 30, 40, 50)",
      voiceVolume: "Float value (e.g., 0.5, 1.0, 2.0)",
      musicVolume: "Float value (e.g., 0.1, 0.2, 0.5)",
      transitionDuration: "Duration in seconds (e.g., 0.5, 1.0)",
      kenBurnsZoomAmount: "Zoom factor (e.g., 1.1 = 10% zoom)"
    }
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
  console.log(`Server running on port ${port}`);
});
