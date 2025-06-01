import express from 'express';
import multer from 'multer';
import editly from 'editly';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch'; // npm install node-fetch

const app = express();
const port = process.env.PORT || 3000;
const pendingJobs = new Map();

app.use(express.json({ limit: '10mb' }));
const upload = multer({ dest: 'uploads/' });

const ensureDirectories = async () => {
  await fs.mkdir('uploads', { recursive: true });
  await fs.mkdir('output', { recursive: true });
};

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Editly API is working',
    endpoints: ['/register-job', '/check-job/:jobId'],
  });
});

app.post('/register-job', async (req, res) => {
  const { youtubeUrl = 'n/a', webhookUrl, supabaseData = [] } = req.body;
  if (!webhookUrl) {
    return res.status(400).json({ error: 'Missing webhookUrl' });
  }

  const jobId = uuidv4();
  pendingJobs.set(jobId, {
    jobId,
    youtubeUrl,
    webhookUrl,
    supabaseData,
    status: 'registered',
    createdAt: new Date(),
  });

  processVideoJob(jobId);
  res.json({ success: true, jobId, message: 'Job registered' });
});

async function processVideoJob(jobId) {
  const job = pendingJobs.get(jobId);
  if (!job) return;

  job.status = 'processing';

  let videoData = job.supabaseData;
  if (!videoData || videoData.length === 0) {
    videoData = [
      { image_url: 'https://via.placeholder.com/1280x720/000000/ffffff?text=Slide+1' },
      { image_url: 'https://via.placeholder.com/1280x720/111111/ffffff?text=Slide+2' },
    ];
  }

  const clips = [];
  const tempFiles = [];

  try {
    for (let i = 0; i < videoData.length; i++) {
      const imageUrl = videoData[i].image_url;
      const localPath = `uploads/slide-${jobId}-${i}.jpg`;

      const response = await fetch(imageUrl);
      const buffer = await response.buffer();
      await fs.writeFile(localPath, buffer);
      tempFiles.push(localPath);

      clips.push({
        duration: 3,
        layers: [{ type: 'image', path: localPath }],
      });
    }

    const outPath = `output/${jobId}.mp4`;
    const spec = {
      width: 1280,
      height: 768,
      fps: 30,
      outPath,
      clips,
    };

    console.log(`Creating video for job ${jobId}...`);
    await editly(spec);

    job.status = 'completed';
    job.videoPath = outPath;

    await notifyN8n(job, outPath);

    // Cleanup temp images
    for (const file of tempFiles) await fs.unlink(file).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  } catch (err) {
    console.error('Video generation error:', err);
    job.status = 'failed';
    job.error = err.message;

    await notifyN8n(job, null, err);

    for (const file of tempFiles) await fs.unlink(file).catch(() => {});
  }
}

async function notifyN8n(job, videoPath, error = null) {
  const payload = error
    ? { success: false, jobId: job.jobId, error: error.message, status: 'failed' }
    : {
        success: true,
        jobId: job.jobId,
        status: 'completed',
        videoPath: path.basename(videoPath),
        videoBase64: (await fs.readFile(videoPath)).toString('base64'),
      };

  try {
    const response = await fetch(job.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    console.log(
      response.ok
        ? `✅ Webhook notified successfully: ${job.webhookUrl}`
        : `❌ Webhook failed: ${response.statusText}`
    );
  } catch (err) {
    console.error('Error sending webhook:', err.message);
  }
}

app.get('/check-job/:jobId', (req, res) => {
  const job = pendingJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

ensureDirectories().then(() =>
  app.listen(port, '0.0.0.0', () =>
    console.log(`🎬 Editly API running on http://localhost:${port}`)
  )
);
