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

// НОВЫЙ ПОДХОД: Сначала создаем мастер-аудио, потом видео без звука, затем объединяем
const createMasterAudio = async (requestId, clips, jobId) => {
  try {
    const masterAudioPath = path.join('media', requestId, 'audio', 'master.wav');
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    
    let hasMusic = false;
    try {
      await fs.access(musicPath);
      hasMusic = true;
      logToJob(jobId, 'Background music found');
    } catch (e) {
      logToJob(jobId, 'No background music found');
    }
    
    const voiceFiles = clips.filter(clip => clip.voiceAudio).map(clip => clip.voiceAudio);
    
    if (voiceFiles.length === 0 && !hasMusic) {
      logToJob(jobId, 'No audio files found', 'warning');
      return null;
    }
    
    // Создаем временный список для concat
    const concatListPath = path.join('media', requestId, 'audio', 'concat_list.txt');
    const silencePaths = [];
    const audioSegments = [];
    
    let currentTime = 0;
    
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      
      if (clip.voiceAudio) {
        // Добавляем тишину если нужно
        if (currentTime > 0) {
          const silencePath = path.join('media', requestId, 'audio', `silence_${i}.wav`);
          await execAsync(`ffmpeg -y -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t ${currentTime} "${silencePath}"`);
          silencePaths.push(silencePath);
          audioSegments.push(`file '${path.basename(silencePath)}'`);
        }
        
        audioSegments.push(`file '${path.basename(clip.voiceAudio)}'`);
        currentTime = 0; // Сбрасываем, так как добавили аудио
      } else {
        currentTime += clip.duration;
      }
    }
    
    // Если остались клипы без аудио в конце, добавляем тишину
    if (currentTime > 0) {
      const silencePath = path.join('media', requestId, 'audio', `silence_end.wav`);
      await execAsync(`ffmpeg -y -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t ${currentTime} "${silencePath}"`);
      silencePaths.push(silencePath);
      audioSegments.push(`file '${path.basename(silencePath)}'`);
    }
    
    if (audioSegments.length === 0) {
      logToJob(jobId, 'No audio segments to process');
      return null;
    }
    
    // Записываем список для concat
    await fs.writeFile(concatListPath, audioSegments.join('\n'));
    
    // Объединяем все аудио сегменты
    const voiceOnlyPath = path.join('media', requestId, 'audio', 'voice_only.wav');
    await execAsync(`cd "${path.dirname(concatListPath)}" && ffmpeg -y -f concat -safe 0 -i "${path.basename(concatListPath)}" -c copy "${path.basename(voiceOnlyPath)}"`);
    
    const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
    
    if (hasMusic) {
      // Микшируем голос с музыкой
      logToJob(jobId, 'Mixing voice with background music');
      const command = `ffmpeg -y -i "${voiceOnlyPath}" -i "${musicPath}" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.3,aloop=loop=-1:size=2e+09,atrim=duration=${totalDuration}[music];[voice][music]amix=inputs=2:duration=longest:weights=1,0.3" -c:a pcm_s16le -ar 44100 -ac 2 "${masterAudioPath}"`;
      await execAsync(command);
    } else {
      // Только голос
      logToJob(jobId, 'Using voice-only audio');
      await execAsync(`ffmpeg -y -i "${voiceOnlyPath}" -c:a pcm_s16le -ar 44100 -ac 2 "${masterAudioPath}"`);
    }
    
    // Очищаем временные файлы
    for (const silencePath of silencePaths) {
      try { await fs.unlink(silencePath); } catch (e) {}
    }
    try { await fs.unlink(concatListPath); } catch (e) {}
    try { await fs.unlink(voiceOnlyPath); } catch (e) {}
    
    // Проверяем результат
    await fs.access(masterAudioPath);
    const stats = await fs.stat(masterAudioPath);
    const audioDuration = await getAudioDuration(masterAudioPath);
    
    logToJob(jobId, `Master audio created: ${Math.round(stats.size / 1024)}KB, ${audioDuration.toFixed(2)}s`);
    return masterAudioPath;
    
  } catch (error) {
    logToJob(jobId, `Master audio creation failed: ${error.message}`, 'error');
    console.error('Master audio error:', error);
    return null;
  }
};

// Новая функция для добавления аудио к готовому видео
const addAudioToVideo = async (videoPath, audioPath, outputPath, jobId) => {
  try {
    logToJob(jobId, 'Adding audio to video with FFmpeg');
    
    // Получаем длительность видео
    const { stdout: videoInfo } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`);
    const videoDuration = parseFloat(videoInfo.trim());
    
    // Добавляем аудио к видео, обрезая аудио по длительности видео
    const command = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -ar 44100 -ac 2 -t ${videoDuration} -map 0:v:0 -map 1:a:0 "${outputPath}"`;
    
    logToJob(jobId, `FFmpeg command: ${command}`);
    await execAsync(command);
    
    // Проверяем результат
    await fs.access(outputPath);
    const stats = await fs.stat(outputPath);
    logToJob(jobId, `Final video with audio created: ${Math.round(stats.size / 1024 / 1024)}MB`);
    
    return true;
  } catch (error) {
    logToJob(jobId, `Failed to add audio to video: ${error.message}`, 'error');
    return false;
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
    logToJob(jobId, `Downloading background music: ${music}`);
    const musicUrl = `${supabaseBaseUrl}${music}`;
    const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
    results.music = await downloadFile(musicUrl, musicPath);
    logToJob(jobId, `Music download: ${results.music ? 'success' : 'failed'}`);
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
      logToJob(jobId, `Downloading audio for slide ${i}: ${slide.audio}`);
      const audioUrl = `${supabaseBaseUrl}${slide.audio}`;
      const audioPath = path.join('media', requestId, 'audio', `${i}.mp3`);
      slideResult.audio = await downloadFile(audioUrl, audioPath);
      
      // Конвертируем в WAV для лучшей совместимости
      if (slideResult.audio) {
        const wavPath = path.join('media', requestId, 'audio', `${i}.wav`);
        try {
          await execAsync(`ffmpeg -y -i "${audioPath}" -c:a pcm_s16le -ar 44100 -ac 2 "${wavPath}"`);
          await fs.unlink(audioPath); // Удаляем оригинальный MP3
          logToJob(jobId, `Converted slide ${i} audio to WAV`);
        } catch (e) {
          logToJob(jobId, `Failed to convert slide ${i} audio: ${e.message}`, 'error');
        }
      }
      
      logToJob(jobId, `Slide ${i} audio download: ${slideResult.audio ? 'success' : 'failed'}`);
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
    const voiceAudioPath = path.join(audioDir, `${i}.wav`); // Теперь ищем WAV
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
      logToJob(jobId, `Found voice audio for slide ${i}`);
    } catch (e) {
      logToJob(jobId, `No voice audio for slide ${i}`);
    }

    if (!imageExists) {
      logToJob(jobId, `Skipping slide ${i} - no image found`);
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
    } catch (e) {}

    let clipDuration = 4;
    if (voiceExists) {
      const audioDuration = await getAudioDuration(voiceAudioPath);
      if (audioDuration > 0) {
        clipDuration = Math.max(audioDuration, 2);
        logToJob(jobId, `Slide ${i} duration: ${clipDuration.toFixed(2)}s (from audio)`);
      }
    } else {
      logToJob(jobId, `Slide ${i} duration: ${clipDuration}s (default)`);
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

  // ВАЖНО: Создаем видео БЕЗ звука через Editly
  const silentVideoPath = path.join('media', requestId, 'video', 'silent.mp4');
  const finalVideoPath = path.join('media', requestId, 'video', 'final.mp4');

  const editlySpec = {
    outPath: silentVideoPath, // Сначала создаем беззвучное видео
    width: 1280,
    height: 720,
    fps: 30,
    clips: clips.map(clip => ({
      layers: clip.layers,
      duration: clip.duration
    })),
    defaults: { 
      transition: { name: 'fade', duration: 0.5 },
      layer: { resizeMode: 'contain' }
    },
    keepSourceAudio: false, // Отключаем звук полностью
    fast: false,
    verbose: true
    // НЕ добавляем audioFilePath - создаем беззвучное видео!
  };

  return { editlySpec, clips, silentVideoPath, finalVideoPath };
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

    logToJob(jobId, `Starting job for ${numSlides} slides`);
    JOBS.set(jobId, { status: 'downloading', createdAt: new Date(), requestId });
    const downloadResults = await downloadAllFiles(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    
    const successfulSlides = downloadResults.slides.filter(slide => slide.image).length;
    const audioSlides = downloadResults.slides.filter(slide => slide.audio).length;
    
    logToJob(jobId, `Downloaded ${successfulSlides} images, ${audioSlides} audio files`);
    
    if (successfulSlides === 0) throw new Error('No slides downloaded');
    
    JOBS.set(jobId, { status: 'processing', createdAt: new Date(), requestId });
    
    const { editlySpec, clips, silentVideoPath, finalVideoPath } = await buildEditSpec(requestId, numSlides, jobId);
    
    // ШАГ 1: Создаем мастер-аудио
    logToJob(jobId, 'Creating master audio track...');
    const masterAudioPath = await createMasterAudio(requestId, clips, jobId);
    
    // ШАГ 2: Создаем беззвучное видео через Editly
    logToJob(jobId, 'Creating silent video with Editly...');
    await editly(editlySpec);
    logToJob(jobId, 'Silent video created!');
    
    // ШАГ 3: Добавляем звук к видео через FFmpeg
    if (masterAudioPath) {
      logToJob(jobId, 'Adding audio to video...');
      const audioSuccess = await addAudioToVideo(silentVideoPath, masterAudioPath, finalVideoPath, jobId);
      
      if (!audioSuccess) {
        logToJob(jobId, 'Audio merge failed, using silent video', 'warning');
        await fs.copyFile(silentVideoPath, finalVideoPath);
      }
    } else {
      logToJob(jobId, 'No audio track, using silent video');
      await fs.copyFile(silentVideoPath, finalVideoPath);
    }
    
    // Проверяем финальное видео
    const videoStats = await fs.stat(finalVideoPath);
    logToJob(jobId, `Final video ready: ${Math.round(videoStats.size / 1024 / 1024)}MB`);
    
    JOBS.set(jobId, { status: 'uploading', createdAt: new Date(), requestId });
    const uploadResult = await uploadVideoToSupabase(finalVideoPath, requestId, jobId);
    
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

    logToJob(jobId, `Job completed successfully: ${uploadResult.publicUrl}`);
    setTimeout(() => cleanupFiles(requestId), 30000);

  } catch (err) {
    logToJob(jobId, `Job failed: ${err.message}`, 'error');
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
