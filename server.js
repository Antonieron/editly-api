// Editly API Server for Image-to-Video Jobs
import express from 'express';
import multer from 'multer';
import editly from 'editly';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;

const pendingJobs = new Map();

app.use(express.json({ limit: '10mb' }));

const ensureDirectories = async () => {
  await fs.mkdir('uploads', { recursive: true });
  await fs.mkdir('output', { recursive: true });
};

const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Editly API is working',
    endpoints: ['/register-job', '/check-job/:jobId']
  });
});

app.post('/register-job', async (req, res) => {
  try {
    const { youtubeUrl, webhookUrl, supabaseData } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'Missing webhookUrl' });

    const jobId = uuidv4();

    const job = {
      jobId,
      youtubeUrl: youtubeUrl || 'n/a',
      webhookUrl,
      supabaseData: supabaseData || [],
      status: 'registered',
      createdAt: new Date()
    };

    pendingJobs.set(jobId, job);
    processVideoJob(jobId);

    res.json({ success: true, jobId, message: 'Job registered and started' });
  } catch (err) {
    console.error('Register job error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function processVideoJob(jobId) {
  const job = pendingJobs.get(jobId);
  if (!job) return;
  job.status = 'processing';

  let videoData = job.supabaseData;
  if (!videoData || !videoData.length) {
    videoData = [
      { image_url: 'https://via.placeholder.com/1280x720/ff0000/ffffff?text=Slide+1' },
      { image_url: 'https://via.placeholder.com/1280x720/00ff00/ffffff?text=Slide+2' }
    ];
  }

  const outPath = `output/${jobId}.mp4`;
  const editlySpec = {
    width: 1280,
    height: 720,
    fps: 30,
    outPath,
    clips: videoData.map((item, i) => ({
      duration: 3,
      layers: [{ type: 'image', path: item.image_url }]
    }))
  };

  try {
    await editly(editlySpec);
    job.status = 'completed';
    job.videoPath = outPath;
    await notifyN8n(job, outPath);
    await fs.unlink(outPath).catch(() => {});
  } catch (err) {
    console.error(`Error processing job ${jobId}:`, err);
    job.status = 'failed';
    job.error = err.message;
    await notifyN8n(job, null, err);
  }
}

async function notifyN8n(job, videoPath, error = null) {
  const payload = error ? {
    success: false,
    jobId: job.jobId,
    status: 'failed',
    error: error.message
  } : {
    success: true,
    jobId: job.jobId,
    status: 'completed',
    videoBase64: (await fs.readFile(videoPath)).toString('base64'),
    videoPath: path.basename(videoPath)
  };

  try {
    const response = await fetch(job.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.error('n8n webhook failed:', response.status);
  } catch (err) {
    console.error('Webhook error:', err);
  }
}

app.get('/check-job/:jobId', (req, res) => {
  const job = pendingJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of pendingJobs.entries()) {
    if ((now - new Date(job.createdAt).getTime()) > 30 * 60 * 1000) {
      pendingJobs.delete(jobId);
    }
  }
}, 5 * 60 * 1000);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

ensureDirectories().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Editly API running at http://localhost:${port}/`);
  });
});
