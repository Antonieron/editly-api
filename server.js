import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import ffmpeg from 'fluent-ffmpeg'; // npm install fluent-ffmpeg

const app = express();
const port = process.env.PORT || 3000;

// Store for pending jobs
const pendingJobs = new Map();

app.use(express.json({ limit: '10mb' }));

const ensureDirectories = async () => {
  try {
    await fs.mkdir('uploads', { recursive: true });
    await fs.mkdir('output', { recursive: true });
    console.log('Directories created successfully');
  } catch (error) {
    console.error('Error creating directories:', error);
  }
};

const upload = multer({ dest: 'uploads/' });

// Function to create video using FFmpeg
async function createVideoWithFFmpeg(clips, outputPath) {
  return new Promise((resolve, reject) => {
    // Create a temporary file list for FFmpeg
    const fileListPath = `uploads/filelist_${Date.now()}.txt`;
    
    // Generate file list content
    const fileListContent = clips.map(clip => {
      const imagePath = clip.layers[0].path;
      return `file '${path.resolve(imagePath)}'
duration 3`;
    }).join('\n') + '\nfile \'' + path.resolve(clips[clips.length - 1].layers[0].path) + '\'';
    
    // Write file list
    fs.writeFile(fileListPath, fileListContent)
      .then(() => {
        // Use FFmpeg to create video
        ffmpeg()
          .input(fileListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions([
            '-c:v', 'libx264',
            '-r', '30',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1280:720'
          ])
          .output(outputPath)
          .on('start', (commandLine) => {
            console.log('FFmpeg command:', commandLine);
          })
          .on('progress', (progress) => {
            console.log('Processing: ' + progress.percent + '% done');
          })
          .on('end', async () => {
            console.log('FFmpeg processing finished');
            // Cleanup file list
            try {
              await fs.unlink(fileListPath);
            } catch (e) {
              console.error('Error cleaning up file list:', e);
            }
            resolve();
          })
          .on('error', async (err) => {
            console.error('FFmpeg error:', err);
            // Cleanup file list
            try {
              await fs.unlink(fileListPath);
            } catch (e) {
              console.error('Error cleaning up file list:', e);
            }
            reject(err);
          })
          .run();
      })
      .catch(reject);
  });
}

// Helper function to create a simple fallback image
async function createFallbackImage(jobId, index) {
  try {
    // Create a simple SVG as fallback
    const svgContent = `
      <svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
        <rect width="1280" height="720" fill="#${Math.floor(Math.random()*16777215).toString(16)}"/>
        <text x="640" y="360" font-family="Arial" font-size="48" fill="white" text-anchor="middle" dy=".3em">
          Slide ${index + 1}
        </text>
      </svg>
    `;
    
    const fallbackPath = path.resolve('uploads', `${jobId}_fallback_${index}.svg`);
    await fs.writeFile(fallbackPath, svgContent);
    console.log(`Created fallback image: ${fallbackPath}`);
    return fallbackPath;
  } catch (error) {
    console.error('Error creating fallback image:', error);
    // If even SVG creation fails, return null and let editly handle it
    return null;
  }
}

// Helper function to download remote images
async function downloadImage(url, filepath) {
  try {
    console.log(`Downloading image from: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.buffer();
    await fs.writeFile(filepath, buffer);
    
    // Verify file was created and has content
    const stats = await fs.stat(filepath);
    console.log(`Image saved to: ${filepath}, size: ${stats.size} bytes`);
    
    if (stats.size === 0) {
      throw new Error(`Downloaded file is empty: ${filepath}`);
    }
    
    return filepath;
  } catch (error) {
    console.error(`Error downloading image ${url}:`, error);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'Editly API is working',
    endpoints: ['/generate', '/generate-json', '/process-video', '/check-job']
  });
});

// === NEW: Endpoint for n8n to register a video processing job ===
app.post('/register-job', async (req, res) => {
  try {
    const { youtubeUrl, webhookUrl, supabaseData } = req.body;
    
    if (!youtubeUrl || !webhookUrl) {
      return res.status(400).json({ error: 'Missing youtubeUrl or webhookUrl' });
    }

    const jobId = uuidv4();
    
    // Store job details
    pendingJobs.set(jobId, {
      youtubeUrl,
      webhookUrl,
      supabaseData: supabaseData || [],
      status: 'registered',
      createdAt: new Date()
    });

    console.log(`Job registered: ${jobId} for URL: ${youtubeUrl}`);
    
    // Start processing in background
    processVideoJob(jobId);
    
    res.json({ 
      success: true, 
      jobId,
      message: 'Job registered and processing started'
    });
    
  } catch (error) {
    console.error('Register job error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Background job processor ===
async function processVideoJob(jobId) {
  const downloadedFiles = []; // Track downloaded files for cleanup
  
  try {
    const job = pendingJobs.get(jobId);
    if (!job) {
      console.error(`Job ${jobId} not found`);
      return;
    }

    job.status = 'processing';
    console.log(`Processing job ${jobId}...`);

    // If we have supabase data, use it directly
    let videoData = job.supabaseData;
    
    // If no supabase data, you could fetch it here
    if (!videoData || videoData.length === 0) {
      console.log('No supabase data provided, using placeholder');
      videoData = [
        { image_url: 'https://via.placeholder.com/1280x720/ff0000/ffffff?text=Slide+1' },
        { image_url: 'https://via.placeholder.com/1280x720/00ff00/ffffff?text=Slide+2' }
      ];
    }

    // Download all remote images first
    console.log('Downloading remote images...');
    const clips = [];
    
    for (let i = 0; i < videoData.length; i++) {
      const item = videoData[i];
      let imagePath = item.image_url;
      
      // Check if it's a remote URL
      if (item.image_url && item.image_url.startsWith('http')) {
        try {
          // Create unique filename with absolute path
          const extension = path.extname(new URL(item.image_url).pathname) || '.jpg';
          const localPath = path.resolve('uploads', `${jobId}_${i}${extension}`);
          
          console.log(`Processing image ${i}: ${item.image_url}`);
          console.log(`Will save to: ${localPath}`);
          
          // Download the image
          imagePath = await downloadImage(item.image_url, localPath);
          downloadedFiles.push(localPath); // Track for cleanup
          
          // Double-check file exists
          const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);
          if (!fileExists) {
            throw new Error(`File was not created: ${imagePath}`);
          }
          
          console.log(`✅ Image ${i} ready: ${imagePath}`);
        } catch (downloadError) {
          console.error(`❌ Failed to download image ${i}:`, downloadError);
          
          // Create a simple colored rectangle as fallback
          imagePath = await createFallbackImage(jobId, i);
          downloadedFiles.push(imagePath);
        }
      } else if (imagePath) {
        // Check if local file exists
        const fileExists = await fs.access(imagePath).then(() => true).catch(() => false);
        if (!fileExists) {
          console.error(`❌ Local file doesn't exist: ${imagePath}`);
          imagePath = await createFallbackImage(jobId, i);
          downloadedFiles.push(imagePath);
        }
      } else {
        // No image provided, create fallback
        imagePath = await createFallbackImage(jobId, i);
        downloadedFiles.push(imagePath);
      }
      
      clips.push({
        duration: 3,
        layers: [
          {
            type: 'image',
            path: imagePath
          }
        ]
      });
    }

    // Create video using FFmpeg instead of editly
    const outputPath = `output/${jobId}.mp4`;
    
    console.log('Creating video with FFmpeg...');
    console.log(`Images to process: ${clips.length}`);
    
    await createVideoWithFFmpeg(clips, outputPath);
    
    job.status = 'completed';
    job.videoPath = outputPath;
    
    console.log(`Video generated successfully: ${outputPath}`);
    
    // Send result back to n8n
    await notifyN8n(job, outputPath);
    
    // Cleanup downloaded images
    await cleanupFiles(downloadedFiles);
    
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    const job = pendingJobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error.message;
      
      // Still notify n8n about the failure
      await notifyN8n(job, null, error);
    }
    
    // Cleanup downloaded images even on error
    await cleanupFiles(downloadedFiles);
  }
}

// Helper function to cleanup files
async function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
      console.log(`Cleaned up downloaded file: ${filePath}`);
    } catch (cleanupError) {
      console.error(`Error cleaning up file ${filePath}:`, cleanupError);
    }
  }
}

// === Notify n8n webhook ===
async function notifyN8n(job, videoPath, error = null) {
  try {
    let payload;
    
    if (error) {
      payload = {
        success: false,
        jobId: job.jobId,
        error: error.message,
        status: 'failed'
      };
    } else {
      // Read video file and convert to base64
      const videoBuffer = await fs.readFile(videoPath);
      const videoBase64 = videoBuffer.toString('base64');
      
      payload = {
        success: true,
        jobId: job.jobId,
        status: 'completed',
        videoBase64,
        videoSize: videoBuffer.length,
        videoPath: path.basename(videoPath)
      };
    }

    console.log(`Notifying n8n webhook: ${job.webhookUrl}`);
    
    const response = await fetch(job.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log('Successfully notified n8n');
      
      // Cleanup video file after successful notification
      if (videoPath) {
        try {
          await fs.unlink(videoPath);
          console.log(`Cleaned up video file: ${videoPath}`);
        } catch (cleanupError) {
          console.error('Cleanup error:', cleanupError);
        }
      }
    } else {
      console.error('Failed to notify n8n:', response.status, response.statusText);
    }
    
  } catch (notifyError) {
    console.error('Error notifying n8n:', notifyError);
  }
}

// === Job status endpoint ===
app.get('/check-job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = pendingJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json({
    jobId,
    status: job.status,
    createdAt: job.createdAt,
    error: job.error || null
  });
});

// === Keep your existing endpoints ===
app.post('/generate', upload.single('image'), async (req, res) => {
  // ... your existing generate code
});

app.post('/generate-json', async (req, res) => {
  // ... your existing generate-json code
});

// Cleanup old jobs periodically
setInterval(() => {
  const now = new Date();
  for (const [jobId, job] of pendingJobs.entries()) {
    const ageMinutes = (now - job.createdAt) / (1000 * 60);
    if (ageMinutes > 30) { // Remove jobs older than 30 minutes
      pendingJobs.delete(jobId);
      console.log(`Cleaned up old job: ${jobId}`);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: err.message 
  });
});

const startServer = async () => {
  await ensureDirectories();
  
  app.listen(port, '0.0.0.0', () => {
    console.log(`Editly API server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/`);
  });
};

startServer().catch(console.error);
