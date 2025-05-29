import express from 'express';
import multer from 'multer';
import editly from 'editly';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const app = express();
const port = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });

app.use(express.json());

// === POST /generate (загрузка изображения вручную) ===
app.post('/generate', upload.single('image'), async (req, res) => {
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

  try {
    await editly(editSpec);
    res.download(outputPath, () => {
      fs.unlinkSync(imagePath);
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// === ✅ Новый POST /generate-json для n8n и JSON-конфига ===
app.post('/generate-json', async (req, res) => {
  try {
    const { editlySpec } = req.body;

    if (!editlySpec) {
      return res.status(400).json({ error: 'Missing editlySpec' });
    }

    const config = JSON.parse(editlySpec);
    const outputPath = `output/${uuidv4()}.mp4`;
    config.outPath = outputPath;

    await editly(config);

    res.download(outputPath, () => {
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    console.error('Editly error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Editly API server running on port ${port}`);
});
