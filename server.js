import express from 'express';
import multer from 'multer';
import editly from 'editly';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch'; // Make sure to install: npm install node-fetch

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

    // Create editly spec
    const editlySpec = {
      width: 1280,
      height: 768,
      fps: 30,
      clips: videoData.map((item, index) => ({
        duration: 3,
        layers: [
          {
            type: 'image',
            path: item.image_url || `https://via.placeholder.com/1280x720?text=Slide+${index + 1}`
          }
        ]
      })),
      outPath: `output/${jobId}.mp4`
    };

    console.log('Generating video with spec:', JSON.stringify(editlySpec, null, 2));
    
    await editly(editlySpec);
    
    job.status = 'completed';
    job.videoPath = editlySpec.outPath;
    
    console.log(`Video generated successfully: ${editlySpec.outPath}`);
    
    // Send result back to n8n
    await notifyN8n(job, editlySpec.outPath);
    
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    const job = pendingJobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error.message;
      
      // Still notify n8n about the failure
      await notifyN8n(job, null, error);
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
