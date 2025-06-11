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
app.use(express.json({ limit: '50mb' }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Validation constants
const MAX_SLIDES = 50;
const MAX_DURATION_PER_SLIDE = 30;
const MAX_TEXT_LENGTH = 500;

// In-memory job storage
const JOBS = new Map();
const JOB_LOGS = new Map();

// Cleanup old jobs (run every hour)
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [jobId, job] of JOBS.entries()) {
    if (job.createdAt && job.createdAt < oneHourAgo) {
      JOBS.delete(jobId);
      JOB_LOGS.delete(jobId);
    }
  }
}, 60 * 60 * 1000);

// Logging helper
const logToJob = (jobId, message, type = 'info') => {
  if (!JOB_LOGS.has(jobId)) JOB_LOGS.set(jobId, []);
  JOB_LOGS.get(jobId).push({ timestamp: new Date().toISOString(), type, message });
  console.log(`[${jobId.slice(-8)}] ${type.toUpperCase()}: ${message}`);
};

// Text utils
const getTextLines = (text, maxWords = 8) => {
  if (!text || typeof text !== 'string') return [''];
  const words = text.trim().split(/\s+/);
  const lines = [];
  for (let i = 0; i < words.length; i += maxWords) {
    lines.push(words.slice(i, i + maxWords).join(' '));
  }
  return lines.length > 0 ? lines : [''];
};

const getFontSize = length => {
  if (length > 200) return '20px';
  if (length > 100) return '24px';
  if (length > 50) return '28px';
  return '32px';
};

// Validation helpers
const validateRequest = (req) => {
  const { requestId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData } = req.body;
  
  if (!requestId || typeof requestId !== 'string') {
    throw new Error('requestId is required and must be a string');
  }
  
  if (!numSlides || typeof numSlides !== 'number' || numSlides < 1 || numSlides > MAX_SLIDES) {
    throw new Error(`numSlides must be between 1 and ${MAX_SLIDES}`);
  }
  
  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('http')) {
    throw new Error('webhookUrl is required and must be a valid URL');
  }
  
  if (!supabaseBaseUrl || typeof supabaseBaseUrl !== 'string') {
    throw new Error('supabaseBaseUrl is required');
  }
  
  if (!Array.isArray(supabaseData) || supabaseData.length !== numSlides) {
    throw new Error('supabaseData must be an array with length equal to numSlides');
  }
};

// Directories
const ensureDirs = async (requestId) => {
  const base = path.join('media', requestId);
  const dirs = ['audio', 'images', 'text', 'frames', 'video'];
  
  for (const dir of dirs) {
    await fs.mkdir(path.join(base, dir), { recursive: true });
  }
  
  return base;
};

// Download helper with better error handling
const downloadFile = async (url, dest, jobId, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { 
        headers: { 'Authorization': `Bearer ${supabaseKey}` },
        timeout: 30000 // 30 second timeout
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const buf = await res.buffer();
      await fs.writeFile(dest, buf);
      logToJob(jobId, `Downloaded ${path.basename(dest)} (${buf.length} bytes)`);
      return true;
    } catch (error) {
      logToJob(jobId, `Download attempt ${attempt}/${retries} failed for ${path.basename(dest)}: ${error.message}`, 'warn');
      if (attempt === retries) {
        logToJob(jobId, `Failed to download ${path.basename(dest)} after ${retries} attempts`, 'error');
        return false;
      }
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return false;
};

// Fetch all media with improved error handling
const downloadAll = async (requestId, baseUrl, slidesData, music, jobId) => {
  const result = { music: false, slides: [] };
  
  // Download music if provided
  if (music && typeof music === 'string') {
    try {
      const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
      result.music = await downloadFile(`${baseUrl}${music}`, musicPath, jobId);
    } catch (error) {
      logToJob(jobId, `Music download error: ${error.message}`, 'warn');
    }
  }
  
  // Download slide assets
  for (let i = 0; i < slidesData.length; i++) {
    const slide = slidesData[i];
    const slideInfo = {};
    
    // Download image
    if (slide.image) {
      try {
        const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
        slideInfo.image = await downloadFile(`${baseUrl}${slide.image}`, imagePath, jobId) ? imagePath : null;
      } catch (error) {
        logToJob(jobId, `Image ${i} download error: ${error.message}`, 'warn');
      }
    }
    
    // Download text
    if (slide.text) {
      try {
        const textPath = path.join('media', requestId, 'text', `${i}.json`);
        if (await downloadFile(`${baseUrl}${slide.text}`, textPath, jobId)) {
          slideInfo.text = textPath;
        }
      } catch (error) {
        logToJob(jobId, `Text ${i} download error: ${error.message}`, 'warn');
      }
    }
    
    // Download and convert audio
    if (slide.audio) {
      try {
        const mp3Path = path.join('media', requestId, 'audio', `${i}.mp3`);
        if (await downloadFile(`${baseUrl}${slide.audio}`, mp3Path, jobId)) {
          const wavPath = path.join('media', requestId, 'audio', `${i}.wav`);
          await execAsync(`ffmpeg -y -i "${mp3Path}" -c:a pcm_s16le -ar 44100 -ac 2 "${wavPath}"`);
          await fs.unlink(mp3Path); // Clean up original mp3
          slideInfo.audio = wavPath;
          logToJob(jobId, `Converted audio ${i} to WAV`);
        }
      } catch (error) {
        logToJob(jobId, `Audio ${i} processing error: ${error.message}`, 'warn');
      }
    }
    
    result.slides.push(slideInfo);
  }
  
  return result;
};

// Audio duration with better error handling
const getDuration = async (file) => {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${file}"`);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 4.0 : Math.min(duration, MAX_DURATION_PER_SLIDE);
  } catch (error) {
    console.warn(`Could not get duration for ${file}: ${error.message}`);
    return 4.0;
  }
};

// Improved audio mixing
const createMasterAudio = async (requestId, slides, jobId) => {
  const outputPath = path.join('media', requestId, 'audio', 'master.wav');
  const inputs = [];
  const filterParts = [];
  let inputIndex = 0;
  let totalDuration = 0;
  
  // Process slide audio files
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (slide.audio) {
      try {
        const duration = await getDuration(slide.audio);
        inputs.push(`-i "${slide.audio}"`);
        filterParts.push(`[${inputIndex}:a]adelay=${totalDuration * 1000}|${totalDuration * 1000}[delayed${inputIndex}];`);
        totalDuration += duration;
        inputIndex++;
      } catch (error) {
        logToJob(jobId, `Error processing audio for slide ${i}: ${error.message}`, 'warn');
      }
    }
  }
  
  if (inputs.length === 0) {
    logToJob(jobId, 'No audio files to process');
    return null;
  }
  
  // Add background music if available
  const musicPath = path.join('media', requestId, 'audio', 'music.mp3');
  let hasMusicInput = false;
  
  try {
    await fs.access(musicPath);
    inputs.push(`-i "${musicPath}"`);
    filterParts.push(`[${inputIndex}:a]volume=0.2,aloop=loop=-1:size=2e+09,atrim=duration=${totalDuration}[music];`);
    hasMusicInput = true;
    inputIndex++;
  } catch {
    // Music file doesn't exist, continue without it
    logToJob(jobId, 'No background music found');
  }
  
  // Build the filter complex
  const delayedInputs = [...Array(inputIndex - (hasMusicInput ? 1 : 0)).keys()].map(i => `[delayed${i}]`);
  const allInputs = hasMusicInput ? [...delayedInputs, '[music]'] : delayedInputs;
  const mixFilter = `${allInputs.join('')}amix=inputs=${allInputs.length}:duration=longest[out]`;
  const fullFilter = `${filterParts.join('')}${mixFilter}`;
  
  try {
    const ffmpegCmd = `ffmpeg -y ${inputs.join(' ')} -filter_complex "${fullFilter}" -map "[out]" -c:a pcm_s16le -ar 44100 -ac 2 "${outputPath}"`;
    await execAsync(ffmpegCmd);
    logToJob(jobId, `Master audio created with duration: ${totalDuration}s`);
    return outputPath;
  } catch (error) {
    logToJob(jobId, `Error creating master audio: ${error.message}`, 'error');
    return null;
  }
};

// Build clips with validation
const buildClips = async (requestId, numSlides, jobId) => {
  const clips = [];
  
  for (let i = 0; i < numSlides; i++) {
    const imagePath = path.join('media', requestId, 'images', `${i}.jpg`);
    
    // Check if image exists
    try {
      await fs.access(imagePath);
    } catch {
      logToJob(jobId, `Image ${i} not found, skipping slide`, 'warn');
      continue;
    }
    
    // Load text if available
    let text = '';
    const textPath = path.join('media', requestId, 'text', `${i}.json`);
    try {
      await fs.access(textPath);
      const textData = JSON.parse(await fs.readFile(textPath, 'utf8'));
      text = (textData.text || '').substring(0, MAX_TEXT_LENGTH); // Limit text length
    } catch {
      logToJob(jobId, `No text found for slide ${i}`);
    }
    
    // Determine duration
    const audioPath = path.join('media', requestId, 'audio', `${i}.wav`);
    let duration = 4.0; // default
    
    try {
      await fs.access(audioPath);
      duration = Math.max(await getDuration(audioPath), 2.0); // minimum 2 seconds
    } catch {
      logToJob(jobId, `No audio found for slide ${i}, using default duration`);
    }
    
    clips.push({
      imagePath,
      text,
      duration,
      fontSize: getFontSize(text.length)
    });
  }
  
  if (clips.length === 0) {
    throw new Error('No valid clips found - no images were successfully downloaded');
  }
  
  logToJob(jobId, `Created ${clips.length} clips from ${numSlides} slides`);
  return clips;
};

// HTML template with base64 embedded image
const compileSceneHtmlWithBase64 = (imageBase64, imageMimeType, text, fontSize) => {
  const escapedText = text.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const textLines = getTextLines(escapedText);
  
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            margin: 0; 
            overflow: hidden; 
            background: #000; 
            width: 1280px; 
            height: 720px;
            font-family: 'Arial', sans-serif;
        }
        img { 
            width: 100%; 
            height: 100%; 
            object-fit: cover; 
            display: block;
        }
        .text-overlay { 
            position: absolute; 
            bottom: 8%; 
            left: 5%;
            right: 5%;
            text-align: center; 
            color: #fff; 
            font-size: ${fontSize}; 
            font-weight: bold;
            text-shadow: 2px 2px 8px rgba(0,0,0,0.8);
            background: rgba(0,0,0,0.3);
            padding: 20px;
            border-radius: 10px;
            line-height: 1.4;
        }
    </style>
</head>
<body>
    <img src="data:${imageMimeType};base64,${imageBase64}" alt="Slide image">
    ${text ? `<div class="text-overlay">${textLines.join('<br>')}</div>` : ''}
</body>
</html>`;
};

// Improved HTML template with better styling
const compileSceneHtml = (imagePath, text, fontSize) => {
  const escapedText = text.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const textLines = getTextLines(escapedText);
  
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            margin: 0; 
            overflow: hidden; 
            background: #000; 
            width: 1280px; 
            height: 720px;
            font-family: 'Arial', sans-serif;
        }
        img { 
            width: 100%; 
            height: 100%; 
            object-fit: cover; 
            display: block;
        }
        .text-overlay { 
            position: absolute; 
            bottom: 8%; 
            left: 5%;
            right: 5%;
            text-align: center; 
            color: #fff; 
            font-size: ${fontSize}; 
            font-weight: bold;
            text-shadow: 2px 2px 8px rgba(0,0,0,0.8);
            background: rgba(0,0,0,0.3);
            padding: 20px;
            border-radius: 10px;
            line-height: 1.4;
        }
    </style>
</head>
<body>
    <img src="file://${imagePath}" alt="Slide image">
    ${text ? `<div class="text-overlay">${textLines.join('<br>')}</div>` : ''}
</body>
</html>`;
};

// Improved video rendering with HTML content instead of file URLs
const renderVideo = async (requestId, clips, jobId) => {
  const width = 1280;
  const height = 720;
  const fps = 30;
  const framesDir = path.join('media', requestId, 'frames');
  
  logToJob(jobId, `Starting video render: ${clips.length} clips, ${fps} fps`);
  
  const browser = await puppeteer.launch({ 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    
    let totalFrameCount = 0;
    
    for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
      const clip = clips[clipIndex];
      const framesForThisClip = Math.ceil(clip.duration * fps);
      
      logToJob(jobId, `Rendering clip ${clipIndex + 1}/${clips.length}: ${framesForThisClip} frames (${clip.duration}s)`);
      
      // Read image as base64 and create HTML with embedded image
      const imageBuffer = await fs.readFile(clip.imagePath);
      const imageBase64 = imageBuffer.toString('base64');
      const imageMimeType = 'image/jpeg'; // assuming all images are JPG
      
      const html = compileSceneHtmlWithBase64(imageBase64, imageMimeType, clip.text, clip.fontSize);
      
      // Set HTML content directly instead of using file:// URL
      await page.setContent(html, { waitUntil: 'networkidle0' });
      
      // Render frames for this clip
      for (let frameInClip = 0; frameInClip < framesForThisClip; frameInClip++) {
        const framePath = path.join(framesDir, `frame-${String(totalFrameCount).padStart(6, '0')}.png`);
        await page.screenshot({ 
          path: framePath,
          type: 'png',
          fullPage: false
        });
        totalFrameCount++;
      }
    }
    
    logToJob(jobId, `Rendered ${totalFrameCount} total frames`);
    
  } finally {
    await browser.close();
  }
  
  // Create video from frames
  const rawVideoPath = path.join('media', requestId, 'video', 'raw.mp4');
  const framePattern = path.join(framesDir, 'frame-%06d.png');
  
  try {
    await execAsync(`ffmpeg -y -framerate ${fps} -i "${framePattern}" -c:v libx264 -pix_fmt yuv420p -crf 23 "${rawVideoPath}"`);
    logToJob(jobId, 'Raw video created successfully');
    
    // Clean up frame files to save space
    const frameFiles = await fs.readdir(framesDir);
    for (const file of frameFiles) {
      if (file.endsWith('.png')) {
        await fs.unlink(path.join(framesDir, file));
      }
    }
    
    return rawVideoPath;
  } catch (error) {
    throw new Error(`Failed to create video from frames: ${error.message}`);
  }
};

// Merge audio with video
const addAudioToVideo = async (videoPath, audioPath, outputPath, jobId) => {
  try {
    const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`;
    await execAsync(cmd);
    logToJob(jobId, 'Audio successfully merged with video');
  } catch (error) {
    throw new Error(`Failed to merge audio with video: ${error.message}`);
  }
};

// Upload with better error handling
const uploadVideoToSupabase = async (filePath, requestId, jobId) => {
  try {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = `${requestId}/final.mp4`;
    
    logToJob(jobId, `Uploading video (${fileBuffer.length} bytes) to Supabase...`);
    
    const response = await fetch(`${supabaseUrl}/storage/v1/object/videos/${fileName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true'
      },
      body: fileBuffer
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed with status ${response.status}: ${errorText}`);
    }
    
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/videos/${fileName}`;
    logToJob(jobId, `Video uploaded successfully: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    throw new Error(`Failed to upload video: ${error.message}`);
  }
};

// Cleanup function
const cleanupJobFiles = async (requestId, jobId) => {
  try {
    const mediaPath = path.join('media', requestId);
    await fs.rm(mediaPath, { recursive: true, force: true });
    logToJob(jobId, 'Temporary files cleaned up');
  } catch (error) {
    logToJob(jobId, `Cleanup warning: ${error.message}`, 'warn');
  }
};

// Send webhook notification
const sendWebhookNotification = async (webhookUrl, payload, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000
      });
      
      if (response.ok) {
        return true;
      } else {
        throw new Error(`Webhook returned status ${response.status}`);
      }
    } catch (error) {
      console.warn(`Webhook attempt ${attempt}/${retries} failed:`, error.message);
      if (attempt === retries) {
        console.error('All webhook attempts failed');
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return false;
};

// Main endpoint
app.post('/register-job', async (req, res) => {
  let jobId;
  let requestId;
  
  try {
    // Validate request
    validateRequest(req);
    
    const { requestId: reqId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData, music } = req.body;
    requestId = reqId;
    jobId = uuidv4();
    
    // Initialize job
    JOBS.set(jobId, { 
      status: 'started', 
      createdAt: Date.now(),
      requestId,
      progress: 0
    });
    
    logToJob(jobId, `Job started for request ${requestId} with ${numSlides} slides`);
    
    // Return job ID immediately
    res.json({ jobId, status: 'started' });
    
    // Process asynchronously
    processVideoJob(jobId, requestId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData, music);
    
  } catch (error) {
    const errorJobId = jobId || uuidv4();
    logToJob(errorJobId, `Validation error: ${error.message}`, 'error');
    
    if (jobId) {
      JOBS.set(jobId, { status: 'failed', error: error.message, createdAt: Date.now() });
    }
    
    res.status(400).json({ 
      error: error.message, 
      jobId: errorJobId 
    });
  }
});

// Async job processing function
const processVideoJob = async (jobId, requestId, numSlides, webhookUrl, supabaseBaseUrl, supabaseData, music) => {
  try {
    // Step 1: Setup directories
    JOBS.set(jobId, { ...JOBS.get(jobId), status: 'setting_up', progress: 10 });
    await ensureDirs(requestId);
    logToJob(jobId, 'Directories created');
    
    // Step 2: Download all media
    JOBS.set(jobId, { ...JOBS.get(jobId), status: 'downloading', progress: 20 });
    const downloadedMedia = await downloadAll(requestId, supabaseBaseUrl, supabaseData, music, jobId);
    logToJob(jobId, 'Media download completed');
    
    // Step 3: Build clips
    JOBS.set(jobId, { ...JOBS.get(jobId), status: 'processing_clips', progress: 40 });
    const clips = await buildClips(requestId, numSlides, jobId);
    
    // Step 4: Create master audio
    JOBS.set(jobId, { ...JOBS.get(jobId), status: 'processing_audio', progress: 50 });
    const masterAudio = await createMasterAudio(requestId, downloadedMedia.slides, jobId);
    
    // Step 5: Render video
    JOBS.set(jobId, { ...JOBS.get(jobId), status: 'rendering_video', progress: 60 });
    const rawVideo = await renderVideo(requestId, clips, jobId);
    
    // Step 6: Merge audio if available
    let finalVideo = rawVideo;
    if (masterAudio) {
      JOBS.set(jobId, { ...JOBS.get(jobId), status: 'merging_audio', progress: 80 });
      finalVideo = path.join('media', requestId, 'video', 'final.mp4');
      await addAudioToVideo(rawVideo, masterAudio, finalVideo, jobId);
    }
    
    // Step 7: Upload to Supabase
    JOBS.set(jobId, { ...JOBS.get(jobId), status: 'uploading', progress: 90 });
    const videoUrl = await uploadVideoToSupabase(finalVideo, requestId, jobId);
    
    // Step 8: Complete
    JOBS.set(jobId, { 
      status: 'completed', 
      videoUrl, 
      progress: 100,
      completedAt: Date.now(),
      requestId
    });
    
    logToJob(jobId, `Job completed successfully: ${videoUrl}`);
    
    // Send success webhook
    await sendWebhookNotification(webhookUrl, {
      jobId,
      success: true,
      videoUrl,
      requestId
    });
    
    // Cleanup files after successful upload
    setTimeout(() => cleanupJobFiles(requestId, jobId), 5000);
    
  } catch (error) {
    logToJob(jobId, `Job failed: ${error.message}`, 'error');
    
    JOBS.set(jobId, { 
      status: 'failed', 
      error: error.message,
      failedAt: Date.now(),
      requestId
    });
    
    // Send failure webhook
    await sendWebhookNotification(webhookUrl, {
      jobId,
      success: false,
      error: error.message,
      requestId
    });
    
    // Cleanup files after failure
    setTimeout(() => cleanupJobFiles(requestId, jobId), 5000);
  }
};

// Status endpoint
app.get('/check-job/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  const logs = JOB_LOGS.get(req.params.jobId) || [];
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json({ 
    job, 
    logs: logs.slice(-50) // Return only last 50 log entries
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    activeJobs: JOBS.size,
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
