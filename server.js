import express from 'express';
import multer from 'multer';
import editly from 'editly';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

// Увеличиваем лимит для JSON
app.use(express.json({ limit: '10mb' }));

// Создаем необходимые папки при запуске
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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'Editly API is working',
    endpoints: ['/generate', '/generate-json']
  });
});

// === POST /generate (загрузка изображения вручную) ===
app.post('/generate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const imagePath = req.file.path;
    const outputPath = `output/${uuidv4()}.mp4`;
    
    const editSpec = {
      outPath: outputPath,
      width: 1280,
      height: 720,
      fps: 30,
      clips: [
        {
          layers: [
            {
              type: 'image',
              path: imagePath,
              zoomDirection: 'in',
              zoomAmount: 0.1,
              pan: 'left',
            },
            {
              type: 'title',
              text: 'Hello from Editly!',
            }
          ],
          duration: 5,
        }
      ]
    };

    console.log('Starting video generation with spec:', JSON.stringify(editSpec, null, 2));
    
    await editly(editSpec);
    
    res.download(outputPath, async (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Cleanup files
      try {
        await fs.unlink(imagePath);
        await fs.unlink(outputPath);
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// === POST /generate-json для n8n и JSON-конфига ===
app.post('/generate-json', async (req, res) => {
  try {
    console.log('Received request body:', JSON.stringify(req.body, null, 2));
    
    const { editlySpec } = req.body;
    
    if (!editlySpec) {
      return res.status(400).json({ error: 'Missing editlySpec in request body' });
    }

    let config;
    try {
      // Если editlySpec уже объект, используем как есть
      if (typeof editlySpec === 'object') {
        config = editlySpec;
      } else {
        // Если строка, парсим JSON
        config = JSON.parse(editlySpec);
      }
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return res.status(400).json({ 
        error: 'Invalid JSON in editlySpec', 
        details: parseError.message 
      });
    }

    // Устанавливаем выходной путь
    const outputPath = `output/${uuidv4()}.mp4`;
    config.outPath = outputPath;

    // Добавляем дефолтные значения если не указаны
    if (!config.width) config.width = 1280;
    if (!config.height) config.height = 720;
    if (!config.fps) config.fps = 30;

    console.log('Processing editly config:', JSON.stringify(config, null, 2));

    // Проверяем наличие clips
    if (!config.clips || !Array.isArray(config.clips) || config.clips.length === 0) {
      return res.status(400).json({ error: 'No clips provided in editlySpec' });
    }

    await editly(config);
    
    console.log('Video generated successfully:', outputPath);
    
    res.download(outputPath, async (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Cleanup
      try {
        await fs.unlink(outputPath);
        console.log('Cleanup completed for:', outputPath);
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    });
    
  } catch (err) {
    console.error('Generate-json error:', err);
    res.status(500).json({ 
      error: err.message, 
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: err.message 
  });
});

// Инициализация
const startServer = async () => {
  await ensureDirectories();
  
  app.listen(port, '0.0.0.0', () => {
    console.log(`Editly API server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/`);
  });
};

startServer().catch(console.error);
