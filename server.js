import express from 'express';
import multer from 'multer';
import cors from 'cors';
import editly from 'editly';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Создание необходимых директорий
const dirs = ['uploads', 'outputs', 'temp'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(mp4|mov|avi|mkv|webm|jpg|jpeg|png|gif|mp3|wav|aac|m4a)$/i;
    if (allowedTypes.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  }
});

// Утилита для очистки временных файлов
const cleanupFile = (filePath) => {
  setTimeout(() => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }, 300000); // Удаляем файл через 5 минут
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Editly API for n8n',
    timestamp: new Date().toISOString()
  });
});

// API документация
app.get('/', (req, res) => {
  res.json({
    service: 'Editly API for n8n Integration',
    version: '1.0.0',
    endpoints: {
      'POST /upload': 'Upload media files',
      'POST /create-video': 'Create video from edit specification',
      'POST /simple-video': 'Create simple video from files',
      'POST /slideshow': 'Create slideshow from images',
      'GET /download/:filename': 'Download created video',
      'GET /health': 'Health check'
    },
    examples: {
      simple_video: {
        method: 'POST',
        url: '/simple-video',
        body: {
          clips: [
            { type: 'video', path: 'path/to/video1.mp4', duration: 5 },
            { type: 'image', path: 'path/to/image1.jpg', duration: 3 }
          ],
          audio: 'path/to/audio.mp3',
          output: 'my-video.mp4'
        }
      }
    }
  });
});

// Загрузка файлов
app.post('/upload', upload.array('files'), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const files = req.files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      path: file.path,
      mimetype: file.mimetype,
      size: file.size,
      url: `/uploads/${file.filename}`
    }));

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Создание видео по полной спецификации Editly
app.post('/create-video', async (req, res) => {
  try {
    const { editSpec, outputName } = req.body;
    
    if (!editSpec) {
      return res.status(400).json({ success: false, error: 'editSpec is required' });
    }

    const outputFileName = outputName || `video-${Date.now()}.mp4`;
    const outputPath = join('outputs', outputFileName);
    
    const spec = {
      ...editSpec,
      outPath: outputPath,
      fast: true,
      enableFfmpegLog: false
    };
    
    console.log('Creating video with spec:', JSON.stringify(spec, null, 2));
    
    await editly(spec);
    
    // Планируем очистку файла
    cleanupFile(outputPath);
    
    res.json({ 
      success: true, 
      outputFile: outputFileName,
      downloadUrl: `/download/${outputFileName}`,
      filePath: outputPath
    });
  } catch (error) {
    console.error('Error creating video:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Простое создание видео из файлов
app.post('/simple-video', async (req, res) => {
  try {
    const { clips, audio, title, outputName, settings = {} } = req.body;
    
    if (!clips || clips.length === 0) {
      return res.status(400).json({ success: false, error: 'clips array is required' });
    }

    const outputFileName = outputName || `simple-video-${Date.now()}.mp4`;
    const outputPath = join('outputs', outputFileName);
    
    const editlyClips = [];
    
    // Добавляем заголовок если указан
    if (title) {
      editlyClips.push({
        duration: settings.titleDuration || 3,
        layers: [
          { 
            type: 'title', 
            text: title,
            textColor: settings.titleColor || '#ffffff'
          }
        ]
      });
    }
    
    // Обрабатываем клипы
    clips.forEach(clip => {
      const layer = {
        type: clip.type || 'video',
        path: clip.path
      };
      
      // Добавляем дополнительные параметры если есть
      if (clip.cutFrom) layer.cutFrom = clip.cutFrom;
      if (clip.cutTo) layer.cutTo = clip.cutTo;
      if (clip.resizeMode) layer.resizeMode = clip.resizeMode;
      
      editlyClips.push({
        duration: clip.duration || 4,
        layers: [layer]
      });
    });
    
    const spec = {
      outPath: outputPath,
      clips: editlyClips,
      fast: true,
      width: settings.width || 1280,
      height: settings.height || 720,
      fps: settings.fps || 30,
      enableFfmpegLog: false
    };
    
    // Добавляем аудио если указано
    if (audio) {
      spec.audioFilePath = audio;
      spec.loopAudio = settings.loopAudio || false;
    }
    
    console.log('Creating simple video with spec:', JSON.stringify(spec, null, 2));
    
    await editly(spec);
    
    // Планируем очистку файла
    cleanupFile(outputPath);
    
    res.json({ 
      success: true, 
      outputFile: outputFileName,
      downloadUrl: `/download/${outputFileName}`,
      filePath: outputPath
    });
  } catch (error) {
    console.error('Error creating simple video:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Создание слайдшоу из изображений
app.post('/slideshow', async (req, res) => {
  try {
    const { images, audio, title, outputName, settings = {} } = req.body;
    
    if (!images || images.length === 0) {
      return res.status(400).json({ success: false, error: 'images array is required' });
    }

    const outputFileName = outputName || `slideshow-${Date.now()}.mp4`;
    const outputPath = join('outputs', outputFileName);
    
    const clips = [];
    
    // Заголовок
    if (title) {
      clips.push({
        duration: settings.titleDuration || 3,
        layers: [
          { 
            type: 'title', 
            text: title,
            textColor: settings.titleColor || '#ffffff'
          }
        ]
      });
    }
    
    // Добавляем изображения
    images.forEach((image, index) => {
      clips.push({
        duration: settings.imageDuration || 4,
        layers: [
          {
            type: 'image',
            path: typeof image === 'string' ? image : image.path,
            zoomDirection: settings.kenBurns ? (index % 2 === 0 ? 'in' : 'out') : null,
            zoomAmount: settings.zoomAmount || 0.1
          }
        ]
      });
    });
    
    const spec = {
      outPath: outputPath,
      clips: clips,
      fast: true,
      width: settings.width || 1920,
      height: settings.height || 1080,
      fps: settings.fps || 30,
      enableFfmpegLog: false,
      defaults: {
        transition: {
          name: settings.transition || 'fade',
          duration: settings.transitionDuration || 0.5
        }
      }
    };
    
    if (audio) {
      spec.audioFilePath = audio;
      spec.loopAudio = true;
    }
    
    console.log('Creating slideshow with spec:', JSON.stringify(spec, null, 2));
    
    await editly(spec);
    
    // Планируем очистку файла
    cleanupFile(outputPath);
    
    res.json({ 
      success: true, 
      outputFile: outputFileName,
      downloadUrl: `/download/${outputFileName}`,
      filePath: outputPath
    });
  } catch (error) {
    console.error('Error creating slideshow:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Скачивание файлов
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = join('outputs', filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, filename, (err) => {
      if (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Download failed' });
      }
    });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Получение информации о файле
app.get('/info/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = join('outputs', filename);
  
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    res.json({
      filename: filename,
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime
    });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Статические файлы uploads
app.use('/uploads', express.static('uploads'));

// Обработка ошибок
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found',
    availableEndpoints: ['/health', '/upload', '/create-video', '/simple-video', '/slideshow']
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🎬 Editly API server running on port ${port}`);
  console.log(`📡 Ready for n8n integration`);
});
