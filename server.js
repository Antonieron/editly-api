import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '50mb' }));

// In-memory job storage
const jobs = new Map();

// Job logging
const logToJob = (jobId, message) => {
  console.log(`[${jobId}] ${message}`);
  if (jobs.has(jobId)) {
    jobs.get(jobId).logs.push(`${new Date().toISOString()}: ${message}`);
  }
};

// Get actual audio duration using ffprobe
const getAudioDuration = async (audioPath) => {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      audioPath
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`));
        return;
      }
      
      try {
        const info = JSON.parse(output);
        const duration = parseFloat(info.format.duration);
        resolve(duration);
      } catch (error) {
        reject(new Error(`Failed to parse ffprobe output: ${error.message}`));
      }
    });
    
    ffprobe.on('error', reject);
  });
};

// Download file from URL
const downloadFile = async (url, outputPath) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  const buffer = await response.buffer();
  await fs.writeFile(outputPath, buffer);
  return buffer.length;
};

// Convert MP3 to WAV using ffmpeg
const convertToWav = async (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-y', outputPath]);
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg conversion failed with code ${code}`));
      }
    });
    
    ffmpeg.on('error', reject);
  });
};

// Create clips from slides with accurate audio duration
const createClips = async (slides, requestId, jobId) => {
  const clips = [];
  
  logToJob(jobId, `Processing ${slides.length} slides for clips...`);
  
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const imagePath = path.join('media', requestId, `${i}.jpg`);
    const audioPath = path.join('media', requestId, `${i}.wav`);
    
    // Get actual audio duration using ffprobe
    let duration;
    try {
      duration = await getAudioDuration(audioPath);
      logToJob(jobId, `Slide ${i}: Actual audio duration = ${duration.toFixed(3)}s`);
    } catch (error) {
      logToJob(jobId, `Warning: Could not get audio duration for slide ${i}, using fallback: ${error.message}`);
      duration = slide.estimatedDuration || slide.duration || 5.0;
    }
    
    clips.push({
      imagePath,
      audioPath,
      text: slide.text || '',
      duration: duration
    });
  }
  
  const totalDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  logToJob(jobId, `Created ${clips.length} clips with total duration: ${totalDuration.toFixed(3)}s`);
  
  return clips;
};

// Add text overlay to images using FFmpeg
const addTextToImages = async (clips, requestId, jobId) => {
  logToJob(jobId, `Adding text overlays to ${clips.length} images...`);
  
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (!clip.text) continue;
    
    const inputPath = clip.imagePath;
    const outputPath = path.join('media', requestId, `text_${i}.jpg`);
    
    // Escape text for FFmpeg
    const escapedText = clip.text.replace(/[\\:]/g, '\\$&').replace(/'/g, "\\'");
    
    await new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-vf', `drawtext=text='${escapedText}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h-150:box=1:boxcolor=black@0.5:boxborderw=10`,
        '-y',
        outputPath
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          clip.imagePath = outputPath;
        } else {
          logToJob(jobId, `Warning: Text overlay failed for image ${i}, using original`);
        }
        resolve();
      });

      ffmpeg.on('error', () => resolve());
    });
  }
  
  logToJob(jobId, `Text overlays completed`);
};

// Create video directly from images using FFmpeg
const createVideoFromImages = async (clips, requestId, jobId) => {
  const outputPath = path.join('media', requestId, 'output.mp4');
  const tempDir = path.join('media', requestId, 'temp');
  await fs.mkdir(tempDir, { recursive: true });
  
  logToJob(jobId, `Creating video using FFmpeg direct image concatenation...`);
  
  // Create FFmpeg concat file
  const concatContent = clips.map((clip) => {
    return `file '${path.resolve(clip.imagePath)}'
duration ${clip.duration}`;
  }).join('\n') + '\n' + `file '${path.resolve(clips[clips.length - 1].imagePath)}'`;
  
  const concatFile = path.join(tempDir, 'concat.txt');
  await fs.writeFile(concatFile, concatContent);
  
  logToJob(jobId, `FFmpeg concat file created with ${clips.length} images`);
  
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black',
      '-c:v', 'libx264',
      '-r', '25',
      '-pix_fmt', 'yuv420p',
      '-y',
      outputPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        logToJob(jobId, `Video created successfully using direct image method`);
        resolve(outputPath);
      } else {
        logToJob(jobId, `FFmpeg error: ${stderr}`);
        reject(new Error(`FFmpeg failed with code ${code}`));
      }
    });

    ffmpeg.on('error', (error) => {
      reject(new Error(`FFmpeg spawn error: ${error.message}`));
    });
  });
};

// Create master audio track
const createMasterAudio = async (clips, requestId, jobId) => {
  const outputPath = path.join('media', requestId, 'master_audio.wav');
  const tempDir = path.join('media', requestId, 'temp');
  await fs.mkdir(tempDir, { recursive: true });
  
  // Create FFmpeg filter for concatenating audio clips
  const filterParts = clips.map((_, index) => `[${index}:0]`).join('');
  const concatFilter = `${filterParts}concat=n=${clips.length}:v=0:a=1[out]`;
  
  return new Promise((resolve, reject) => {
    const ffmpegArgs = ['-y'];
    
    // Add input files
    clips.forEach(clip => {
      ffmpegArgs.push('-i', clip.audioPath);
    });
    
    // Add filter and output
    ffmpegArgs.push('-filter_complex', concatFilter, '-map', '[out]', outputPath);
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Get duration of master audio
        getAudioDuration(outputPath)
          .then(duration => {
            logToJob(jobId, `Master audio created with duration: ${duration}s`);
            resolve(outputPath);
          })
          .catch(() => {
            logToJob(jobId, `Master audio created successfully`);
            resolve(outputPath);
          });
      } else {
        reject(new Error(`Audio concatenation failed with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
};

// Merge video with audio
const mergeVideoWithAudio = async (videoPath, audioPath, requestId, jobId) => {
  const outputPath = path.join('media', requestId, 'final_output.mp4');
  
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-strict', 'experimental',
      '-y',
      outputPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        logToJob(jobId, `Audio successfully merged with video`);
        resolve(outputPath);
      } else {
        reject(new Error(`Video/audio merge failed with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
};

// Upload video to Supabase
const uploadVideoToSupabase = async (videoPath, requestId, jobId) => {
  try {
    const videoBuffer = await fs.readFile(videoPath);
    const fileName = `${requestId}/output.mp4`;
    
    logToJob(jobId, `Uploading video (${videoBuffer.length} bytes) to Supabase...`);
    
    const supabaseUrl = process.env.SUPABASE_URL || 'https://qpwsccpzxohrtvjrrncq.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    const uploadUrl = `${supabaseUrl}/storage/v1/object/media/${fileName}`;
    
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
      throw new Error(`Supabase upload failed: ${response.status} - ${errorText}`);
    }
    
    logToJob(jobId, `Video uploaded successfully to: ${fileName}`);
    
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/media/${fileName}`;
    return publicUrl;
    
  } catch (error) {
    throw new Error(`Failed to upload video: ${error.message}`);
  }
};

// Clean up temporary files
const cleanupFiles = async (requestId, jobId) => {
  try {
    const mediaDir = path.join('media', requestId);
    await fs.rm(mediaDir, { recursive: true, force: true });
    logToJob(jobId, `Temporary files cleaned up`);
  } catch (error) {
    logToJob(jobId, `Cleanup warning: ${error.message}`);
  }
};

// New video processing function for updated N8N format
const processVideoJobV2 = async (requestId, numSlides, musicUrl, supabaseData, jobId) => {
  try {
    logToJob(jobId, `Job started for request ${requestId} with ${numSlides} slides (new format)`);
    
    // Create directories
    const mediaDir = path.join('media', requestId);
    await fs.mkdir(mediaDir, { recursive: true });
    logToJob(jobId, `Directories created`);
    
    // Download music
    const musicPath = path.join(mediaDir, 'music.mp3');
    const musicSize = await downloadFile(musicUrl, musicPath);
    logToJob(jobId, `Downloaded music.mp3 (${musicSize} bytes)`);
    
    // Download slides using new structure
    const allSlides = [];
    for (let i = 0; i < numSlides; i++) {
      const slideInfo = supabaseData[i];
      const baseUrl = 'https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/';
      
      const slideData = {
        imageUrl: `${baseUrl}${slideInfo.image}`,
        jsonUrl: `${baseUrl}${slideInfo.text}`,
        audioUrl: `${baseUrl}${slideInfo.audio}`
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
    
    // Create video directly from images (FAST!)
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
    
    // Cleanup on error
    await cleanupFiles(requestId, jobId);
  }
};

// Main video processing function (original format - kept for backward compatibility)
const processVideoJob = async (requestId, numSlides, musicUrl, jobId) => {
  try {
    logToJob(jobId, `Job started for request ${requestId} with ${numSlides} slides`);
    
    // Create directories
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
        imageUrl: `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/${i}.jpg`,
        jsonUrl: `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/${i}.json`,
        audioUrl: `https://qpwsccpzxohrtvjrrncq.supabase.co/storage/v1/object/public/media/${requestId}/${i}.mp3`
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
    
    // Create video directly from images (FAST!)
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
    
    // Cleanup on error
    await cleanupFiles(requestId, jobId);
  }
};

// Routes
app.post('/register-job', async (req, res) => {
  try {
    console.log('Received request body:', JSON.stringify(req.body, null, 2));
    
    // Handle both old and new N8N formats
    let requestId, numSlides, musicUrl, supabaseData;
    
    if (Array.isArray(req.body) && req.body.length > 0) {
      // New N8N format (array)
      const data = req.body[0];
      requestId = data.requestId;
      numSlides = data.numSlides;
      musicUrl = `${data.supabaseBaseUrl}${data.music}`;
      supabaseData = data.supabaseData;
    } else {
      // Old format (direct object)
      requestId = req.body.requestId;
      numSlides = req.body.numSlides;
      musicUrl = req.body.musicUrl;
    }
    
    console.log('Extracted values:', { requestId, numSlides, musicUrl });
    
    if (!requestId || !numSlides || !musicUrl) {
      console.log('Missing fields detected');
      return res.status(400).json({ 
        error: 'Missing required fields: requestId, numSlides, musicUrl',
        received: { requestId: !!requestId, numSlides: !!numSlides, musicUrl: !!musicUrl },
        body: req.body
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
    
    // Start processing asynchronously
    if (supabaseData) {
      // New format with explicit file paths
      processVideoJobV2(requestId, numSlides, musicUrl, supabaseData, jobId);
    } else {
      // Old format (fallback)
      processVideoJob(requestId, numSlides, musicUrl, jobId);
    }
    
    res.json({ 
      success: true, 
      jobId,
      message: 'Job registered and processing started'
    });
    
  } catch (error) {
    console.error('Error in /register-job:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/check-job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

app.get('/health', (req, res) => {
  const activeJobs = Array.from(jobs.values()).filter(job => job.status === 'processing').length;
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeJobs,
    uptime: process.uptime()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL || 'NOT SET - using fallback'}`);
  console.log(`Supabase Key: ${process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET'}`);
});
