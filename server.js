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
      text: slides[i].text,
      duration: duration
    });
    
    logToJob(jobId, `Clip ${i}: ${duration.toFixed(2)}s`);
  }
  
  return clips;
};

// Add text to images with basic overlay
const addTextToImages = async (clips, requestId, jobId) => {
  logToJob(jobId, `Adding text overlays to images`);
  
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const inputPath = path.join('media', requestId, `${i}.jpg`);
    const outputPath = path.join('media', requestId, `${i}_with_text.jpg`);
    
    // Simple text overlay
    const displayText = clip.text.length > 150 ? 
      clip.text.substring(0, 147) + '...' : clip.text;
    
    const args = [
      '-i', inputPath,
      '-vf', `drawtext=text='${displayText.replace(/'/g, "\\'")}':fontsize=32:fontcolor=white:x=50:y=50:shadowcolor=black:shadowx=2:shadowy=2`,
      '-y', outputPath
    ];
    
    await runFFmpeg(args, `Adding text to image ${i}`);
    logToJob(jobId, `Added text overlay to image ${i}`);
  }
};

// Create master audio track
const createMasterAudio = async (clips, requestId, jobId) => {
  logToJob(jobId, `Creating master audio track`);
  
  const mediaDir = path.join('media', requestId);
  const masterAudioPath = path.join(mediaDir, 'master_audio.wav');
  
  const inputs = [];
  const filters = [];
  
  for (let i = 0; i < clips.length; i++) {
    inputs.push('-i', path.join(mediaDir, `${i}.wav`));
    filters.push(`[${i}:a]`);
  }
  
  const concatFilter = filters.join('') + `concat=n=${clips.length}:v=0:a=1[out]`;
  
  const args = [
    ...inputs,
    '-filter_complex', concatFilter,
    '-map', '[out]',
    '-y', masterAudioPath
  ];
  
  await runFFmpeg(args, 'Creating master audio');
  logToJob(jobId, `Master audio created`);
  
  return masterAudioPath;
};

// Create video from images
const createVideoFromImages = async (clips, requestId, jobId) => {
  logToJob(jobId, `Creating video from images`);
  
  const mediaDir = path.join('media', requestId);
  const videoPath = path.join(mediaDir, 'video_only.mp4');
  
  // Calculate total duration
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const fps = clips.length / totalDuration;
  
  logToJob(jobId, `Using FPS: ${fps.toFixed(2)} for ${totalDuration}s duration`);
  
  const args = [
    '-framerate', fps.toString(),
    '-i', path.join(mediaDir, '%d_with_text.jpg'),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-t', totalDuration.toString(),
    '-y', videoPath
  ];
  
  await runFFmpeg(args, 'Creating video from images');
  logToJob(jobId, `Video created`);
  
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
    await fs.rmdir(mediaDir, { recursive: true });
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
    
    const job = jobs.get(jobId);
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    
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
