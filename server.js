const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// In-memory job storage
const jobs = new Map();

// Helper function to log job progress
const logToJob = (jobId, message) => {
  const job = jobs.get(jobId);
  if (job) {
    job.logs.push(`${new Date().toISOString()}: ${message}`);
    console.log(`[${jobId}] ${message}`);
  }
};

// Helper function to run FFmpeg commands
const runFFmpeg = (args, description) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });
    
    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed (${description}): ${stderr}`));
      }
    });
  });
};

// Download file helper
const downloadFile = async (url, filePath) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  
  const buffer = await response.buffer();
  await fs.writeFile(filePath, buffer);
  return buffer.length;
};

// Convert MP3 to WAV
const convertToWav = async (inputPath, outputPath) => {
  const args = ['-i', inputPath, '-acodec', 'pcm_s16le', '-ar', '44100', '-y', outputPath];
  await runFFmpeg(args, `Converting ${inputPath} to WAV`);
};

// Get audio duration
const getAudioDuration = async (audioPath) => {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      audioPath
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        resolve(duration);
      } else {
        reject(new Error(`Failed to get duration for ${audioPath}`));
      }
    });
  });
};

// Create clips with duration
const createClips = async (slides, requestId, jobId) => {
  logToJob(jobId, `Analyzing audio durations...`);
  
  const clips = [];
  for (let i = 0; i < slides.length; i++) {
    const wavPath = path.join('media', requestId, `${i}.wav`);
    const duration = await getAudioDuration(wavPath);
    
    clips.push({
      index: i,
      text: slides[i].text || 'No text available', // Extract text from JSON
      duration: duration
    });
    
    logToJob(jobId, `Clip ${i}: ${duration.toFixed(2)}s - "${slides[i].text ? slides[i].text.substring(0, 30) : 'No text'}..."`);
  }
  
  return clips;
};

// Check FFmpeg capabilities
const checkFFmpegCapabilities = async (jobId) => {
  logToJob(jobId, `🔍 Checking FFmpeg capabilities...`);
  
  try {
    // Check if drawtext filter is available
    const { stdout } = await execPromise('ffmpeg -hide_banner -filters 2>/dev/null | grep drawtext || echo "NO_DRAWTEXT"');
    logToJob(jobId, `FFmpeg drawtext support: ${stdout.trim()}`);
    
    // Check FFmpeg version and build info
    const { stdout: version } = await execPromise('ffmpeg -version 2>/dev/null | head -3');
    logToJob(jobId, `FFmpeg version info: ${version.replace(/\n/g, ' | ')}`);
    
    return stdout.includes('drawtext');
  } catch (error) {
    logToJob(jobId, `FFmpeg check failed: ${error.message}`);
    return false;
  }
};
const addTextToImages = async (clips, requestId, jobId) => {
  logToJob(jobId, `Adding animated multi-line text overlays`);
  
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const inputPath = path.join('media', requestId, `${i}.jpg`);
    const outputPath = path.join('media', requestId, `${i}_with_text.jpg`);
    
    // Debug: Check if text exists
    if (!clip.text || clip.text.trim() === '') {
      logToJob(jobId, `WARNING: No text found for clip ${i}, using image without text`);
      await fs.copyFile(inputPath, outputPath);
      continue;
    }
    
    logToJob(jobId, `Processing text for image ${i}: "${clip.text.substring(0, 50)}..."`);
    
    // Split text into lines (max 40 chars per line for horizontal video)
    const words = clip.text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      if ((currentLine + ' ' + word).length <= 40) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    
    // Limit to 3 lines max
    const displayLines = lines.slice(0, 3);
    logToJob(jobId, `Split into ${displayLines.length} lines for image ${i}`);
    
    // Clean each line for FFmpeg - более агрессивная очистка
    const cleanLines = displayLines.map(line => 
      line.replace(/['"]/g, '')        // Удаляем все кавычки
          .replace(/[:;]/g, '')        // Удаляем двоеточия и точки с запятой
          .replace(/[[\]]/g, '')       // Удаляем квадратные скобки
          .replace(/,/g, '')           // Удаляем запятые
          .replace(/—/g, '-')          // Заменяем длинные тире на обычные
          .replace(/'/g, '')           // Удаляем апострофы
          .replace(/"/g, '')           // Удаляем кавычки
          .replace(/[^\w\s\-\.]/g, '') // Оставляем только буквы, цифры, пробелы, тире и точки
          .trim()
    );
    
    logToJob(jobId, `Cleaned lines: ${cleanLines.map(l => `"${l}"`).join(', ')}`);
    
    // Попробуем ОЧЕНЬ заметный текст с большим контрастом
    const simpleText = cleanLines.join(' ').substring(0, 80); // Сократим текст
    logToJob(jobId, `Trying BIG visible text: "${simpleText}"`);
    
    // Создаем ОЧЕНЬ заметный текст - большой, яркий, с контрастным фоном
    const bigTextArgs = [
      '-i', inputPath,
      '-vf', `drawbox=x=50:y=900:w=1800:h=120:color=black@0.8,drawtext=text='${simpleText}':fontsize=48:fontcolor=yellow:x=60:y=930:shadowcolor=red:shadowx=4:shadowy=4`,
      '-y', outputPath
    ];
    
    try {
      await runFFmpeg(bigTextArgs, `Adding BIG visible text to image ${i}`);
      logToJob(jobId, `✅ SUCCESS: Added BIG visible text to image ${i}`);
      continue;
    } catch (bigError) {
      logToJob(jobId, `Big text failed: ${bigError.message}`);
    }
    
    // Fallback: простой черный фон с белым текстом
    const fallbackArgs = [
      '-i', inputPath,
      '-vf', `drawbox=x=0:y=0:w=iw:h=100:color=black,drawtext=text='${simpleText}':fontsize=36:fontcolor=white:x=20:y=30`,
      '-y', outputPath
    ];
    
    try {
      await runFFmpeg(fallbackArgs, `Adding fallback text to image ${i}`);
      logToJob(jobId, `✅ Added fallback text to image ${i}`);
      continue;
    } catch (fallbackError) {
      logToJob(jobId, `Fallback failed: ${fallbackError.message}`);
    }
    
    // Если простой текст не сработал, пробуем многострочный
    const textFilters = cleanLines.map((line, lineIndex) => {
      const yPosition = 80 + (lineIndex * 40);
      return `drawtext=text='${line}':fontsize=22:fontcolor=white:x=30:y=${yPosition}:shadowcolor=black:shadowx=2:shadowy=2`;
    });
    
    const backgroundFilter = `drawbox=x=0:y=60:w=iw:h=${cleanLines.length * 40 + 40}:color=black@0.7`;
    const filterString = [backgroundFilter, ...textFilters].join(',');
    
    const multiArgs = [
      '-i', inputPath,
      '-vf', filterString,
      '-y', outputPath
    ];
    
    try {
      await runFFmpeg(multiArgs, `Adding multi-line text to image ${i}`);
      logToJob(jobId, `Successfully added multi-line text to image ${i}`);
    } catch (multiError) {
      logToJob(jobId, `All text methods failed for image ${i}, using image without text`);
      await fs.copyFile(inputPath, outputPath);
    }
  }
};

// Create master audio track with background music
const createMasterAudio = async (clips, requestId, jobId) => {
  logToJob(jobId, `Creating master audio track with background music`);
  
  const mediaDir = path.join('media', requestId);
  const musicPath = path.join(mediaDir, 'music.mp3');
  const masterAudioPath = path.join(mediaDir, 'master_audio.wav');
  
  // Calculate total duration
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  logToJob(jobId, `Total video duration: ${totalDuration}s`);
  
  // First, concatenate all speech audio
  const speechInputs = [];
  const speechFilters = [];
  
  for (let i = 0; i < clips.length; i++) {
    speechInputs.push('-i', path.join(mediaDir, `${i}.wav`));
    speechFilters.push(`[${i + 1}:a]`); // +1 because music is input 0
  }
  
  const speechConcat = speechFilters.join('') + `concat=n=${clips.length}:v=0:a=1[speech]`;
  
  // Mix speech with background music
  // Music at 15% volume, looped to match duration
  // Speech at 100% volume on top
  const mixFilter = `[0:a]volume=0.15,aloop=loop=-1:size=2e+09,atrim=duration=${totalDuration}[bg];[speech][bg]amix=inputs=2:duration=shortest:dropout_transition=2[out]`;
  
  const args = [
    '-i', musicPath,          // Input 0: background music
    ...speechInputs,          // Input 1+: speech files
    '-filter_complex', `${speechConcat};${mixFilter}`,
    '-map', '[out]',
    '-t', totalDuration.toString(),
    '-ar', '44100',
    '-ac', '2',
    '-y', masterAudioPath
  ];
  
  await runFFmpeg(args, 'Creating master audio with background music');
  logToJob(jobId, `Master audio created with background music mixed`);
  
  return masterAudioPath;
};

// Create horizontal video from images
const createVideoFromImages = async (clips, requestId, jobId) => {
  logToJob(jobId, `Creating horizontal video from images WITH TEXT`);
  
  const mediaDir = path.join('media', requestId);
  const videoPath = path.join(mediaDir, 'video_only.mp4');
  
  // Calculate total duration
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  
  // Verify that all images with text exist and are different from originals
  for (let i = 0; i < clips.length; i++) {
    const originalPath = path.join(mediaDir, `${i}.jpg`);
    const textImagePath = path.join(mediaDir, `${i}_with_text.jpg`);
    
    try {
      await fs.access(textImagePath);
      
      // Check file sizes to verify text was added
      const originalStats = await fs.stat(originalPath);
      const textStats = await fs.stat(textImagePath);
      
      logToJob(jobId, `📊 Image ${i}: Original=${originalStats.size} bytes, WithText=${textStats.size} bytes`);
      
      if (Math.abs(originalStats.size - textStats.size) < 1000) {
        logToJob(jobId, `⚠️  WARNING: Image ${i} with text is very similar size to original - text might not have been added`);
      } else {
        logToJob(jobId, `✅ Image ${i} with text is different from original - text successfully added`);
      }
      
    } catch (error) {
      logToJob(jobId, `❌ Missing ${i}_with_text.jpg, copying original`);
      await fs.copyFile(originalPath, textImagePath);
    }
  }
  
  // Create input list for concat demuxer with precise timing
  const listPath = path.join(mediaDir, 'video_list.txt');
  const listContent = clips.map((clip, i) => {
    // ВАЖНО: используем изображения С ТЕКСТОМ (_with_text.jpg)
    return `file '${i}_with_text.jpg'\nduration ${clip.duration}`;
  }).join('\n') + '\n' + `file '${clips.length - 1}_with_text.jpg'`; // Last frame
  
  await fs.writeFile(listPath, listContent);
  logToJob(jobId, `Created video list using images WITH TEXT`);
  logToJob(jobId, `Video list content: ${listContent.replace(/\n/g, ' | ')}`);
  
  // DEBUG: Проверим что файлы действительно существуют
  const listLines = listContent.split('\n').filter(line => line.startsWith('file'));
  for (const line of listLines) {
    const filename = line.match(/'([^']+)'/)?.[1];
    if (filename) {
      const fullPath = path.join(mediaDir, filename);
      try {
        const stats = await fs.stat(fullPath);
        logToJob(jobId, `📁 File ${filename} exists: ${stats.size} bytes`);
      } catch (error) {
        logToJob(jobId, `❌ File ${filename} NOT FOUND!`);
      }
    }
  }
  
  // Create horizontal video (16:9 aspect ratio, 1920x1080)
  // ДОБАВИМ более подробное логирование FFmpeg
  const args = [
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-y', videoPath
  ];
  
  logToJob(jobId, `FFmpeg command: ffmpeg ${args.join(' ')}`);
  
  try {
    await runFFmpeg(args, 'Creating horizontal video from images WITH TEXT');
    logToJob(jobId, `✅ Horizontal video created (1920x1080) using images with text overlays`);
  } catch (error) {
    logToJob(jobId, `❌ Concat method failed: ${error.message}`);
    logToJob(jobId, `Trying alternative method: individual images`);
    
    // Alternative method: create video from individual images with explicit durations
    let filterParts = [];
    let inputParts = [];
    
    for (let i = 0; i < clips.length; i++) {
      inputParts.push('-loop', '1', '-t', clips[i].duration.toString(), '-i', `${i}_with_text.jpg`);
      filterParts.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30[v${i}]`);
    }
    
    const concatFilter = filterParts.join(';') + ';' + filterParts.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[out]`;
    
    const altArgs = [
      ...inputParts,
      '-filter_complex', concatFilter,
      '-map', '[out]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-y', videoPath
    ];
    
    logToJob(jobId, `Alternative FFmpeg command: ffmpeg ${altArgs.join(' ')}`);
    await runFFmpeg(altArgs, 'Creating video using alternative method');
    logToJob(jobId, `✅ Alternative method successful`);
  }
  return videoPath;
};

// Merge video with audio
const mergeVideoWithAudio = async (videoPath, audioPath, requestId, jobId) => {
  logToJob(jobId, `Merging video with audio`);
  
  const finalVideoPath = path.join('media', requestId, 'final_video.mp4');
  
  const args = [
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    '-y', finalVideoPath
  ];
  
  await runFFmpeg(args, 'Merging video and audio');
  logToJob(jobId, `Final video created`);
  
  return finalVideoPath;
};

// Upload video to Supabase
const uploadVideoToSupabase = async (videoPath, requestId, jobId) => {
  logToJob(jobId, `Uploading video to Supabase...`);
  
  const videoBuffer = await fs.readFile(videoPath);
  const fileName = `${requestId}/final_video.mp4`;
  
  const { data, error } = await supabase.storage
    .from('media')
    .upload(fileName, videoBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });
  
  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }
  
  const { data: urlData } = supabase.storage
    .from('media')
    .getPublicUrl(fileName);
  
  const videoUrl = urlData.publicUrl;
  logToJob(jobId, `Video uploaded successfully`);
  
  return videoUrl;
};

// Cleanup files
const cleanupFiles = async (requestId, jobId) => {
  try {
    const mediaDir = path.join('media', requestId);
    await fs.rm(mediaDir, { recursive: true, force: true }); // Fixed deprecated method
    logToJob(jobId, `Temporary files cleaned up`);
  } catch (error) {
    logToJob(jobId, `Cleanup warning: ${error.message}`);
  }
};

// Main video processing function
const processVideoJob = async (requestId, numSlides, musicUrl, jobId) => {
  try {
    logToJob(jobId, `Job started for request ${requestId} with ${numSlides} slides`);
    
    const mediaDir = path.join('media', requestId);
    await fs.mkdir(mediaDir, { recursive: true });
    logToJob(jobId, `Directories created`);
    
    // Download music
    const musicPath = path.join(mediaDir, 'music.mp3');
    const musicSize = await downloadFile(musicUrl, musicPath);
    logToJob(jobId, `Downloaded music.mp3 (${musicSize} bytes)`);
    
    // Download slides
    const allSlides = [];
    for (let i = 0; i < numSlides; i++) {
      const slideData = {
        imageUrl: `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/images/${i}.jpg`,
        jsonUrl: `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/text/${i}.json`,
        audioUrl: `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/audio/${i}.mp3`
      };
      
      // Download image
      const imagePath = path.join(mediaDir, `${i}.jpg`);
      const imageSize = await downloadFile(slideData.imageUrl, imagePath);
      logToJob(jobId, `Downloaded ${i}.jpg (${imageSize} bytes)`);
      
      // Download JSON metadata
      const jsonPath = path.join(mediaDir, `${i}.json`);
      const jsonSize = await downloadFile(slideData.jsonUrl, jsonPath);
      logToJob(jobId, `Downloaded ${i}.json (${jsonSize} bytes)`);
      
      // Parse JSON
      const jsonContent = await fs.readFile(jsonPath, 'utf8');
      const slideMetadata = JSON.parse(jsonContent);
      allSlides.push(slideMetadata);
      
      logToJob(jobId, `Slide ${i} text: "${slideMetadata.text.substring(0, 50)}..."`);
      
      // Download audio
      const audioPath = path.join(mediaDir, `${i}.mp3`);
      const audioSize = await downloadFile(slideData.audioUrl, audioPath);
      logToJob(jobId, `Downloaded ${i}.mp3 (${audioSize} bytes)`);
      
      // Convert to WAV
      const wavPath = path.join(mediaDir, `${i}.wav`);
      await convertToWav(audioPath, wavPath);
      logToJob(jobId, `Converted audio ${i} to WAV`);
    }
    
    logToJob(jobId, `Media download completed`);
    
    // Create clips with accurate duration
    const clips = await createClips(allSlides, requestId, jobId);
    
    // Add text overlays to images
    await addTextToImages(clips, requestId, jobId);
    
    // Create master audio track
    const audioPath = await createMasterAudio(clips, requestId, jobId);
    
    // Create video from images
    const videoPath = await createVideoFromImages(clips, requestId, jobId);
    
    // Merge video with audio
    const finalVideoPath = await mergeVideoWithAudio(videoPath, audioPath, requestId, jobId);
    
    // Upload to Supabase
    const videoUrl = await uploadVideoToSupabase(finalVideoPath, requestId, jobId);
    
    // Update job status
    const job = jobs.get(jobId);
    job.status = 'completed';
    job.result = { videoUrl };
    job.completedAt = new Date().toISOString();
    
    logToJob(jobId, `Job completed successfully! Video URL: ${videoUrl}`);
    
    // Cleanup
    await cleanupFiles(requestId, jobId);
    
  } catch (error) {
    logToJob(jobId, `ERROR: Job failed: ${error.message}`);
    
    // Don't log full stack trace to job logs, but log to console
    console.error(`[${jobId}] Full error:`, error);
    
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date().toISOString();
    }
    
    await cleanupFiles(requestId, jobId);
  }
};

// Routes
app.post('/register-job', async (req, res) => {
  try {
    console.log('Received request body:', JSON.stringify(req.body, null, 2));
    
    let requestId, numSlides, musicUrl;
    
    if (Array.isArray(req.body) && req.body.length > 0) {
      const firstItem = req.body[0];
      
      if (firstItem.request_id && firstItem.audio_url) {
        // V3 format - direct slide objects
        requestId = firstItem.request_id;
        numSlides = req.body.length;
        
        const firstAudioUrl = firstItem.audio_url;
        if (firstAudioUrl.includes('/audio/')) {
          const pathParts = firstAudioUrl.split('/');
          pathParts[pathParts.length - 1] = 'music.mp3';
          const musicPath = pathParts.join('/');
          musicUrl = `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/${musicPath}`;
        } else {
          return res.status(400).json({ 
            error: 'Invalid audio URL format',
            audioUrl: firstAudioUrl
          });
        }
      } else {
        // V2 format
        const data = req.body[0];
        requestId = data.requestId;
        numSlides = data.numSlides;
        musicUrl = data.musicUrl || `${data.supabaseBaseUrl}${data.music}`;
      }
    } else if (req.body && typeof req.body === 'object') {
      // V1 format
      requestId = req.body.requestId;
      numSlides = req.body.numSlides;
      musicUrl = req.body.musicUrl || `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/audio/music.mp3`;
    } else {
      return res.status(400).json({ 
        error: 'Invalid request format',
        body: req.body
      });
    }
    
    console.log('Extracted values:', { requestId, numSlides, musicUrl });
    
    if (!requestId || !numSlides || !musicUrl) {
      return res.status(400).json({ 
        error: 'Missing required fields: requestId, numSlides, musicUrl',
        received: { 
          requestId: !!requestId, 
          numSlides: !!numSlides, 
          musicUrl: !!musicUrl 
        }
      });
    }
    
    const jobId = uuidv4().slice(0, 8);
    
    jobs.set(jobId, {
      id: jobId,
      requestId,
      status: 'processing',
      createdAt: new Date().toISOString(),
      logs: []
    });
    
    // Start processing
    processVideoJob(requestId, numSlides, musicUrl, jobId);
    
    res.json({ 
      success: true, 
      jobId,
      message: 'Job registered and processing started'
    });
    
  } catch (error) {
    console.error('Error in /register-job:', error);
    res.status(500).json({ 
      error: error.message
    });
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`Supabase Key: ${process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET'}`);
});
