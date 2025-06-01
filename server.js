// Add this to your Express server
app.post('/process-n8n-data', async (req, res) => {
  try {
    const { supabaseData, n8nWebhookUrl } = req.body;
    
    // Process the video generation
    const editlySpec = {
      width: 1280,
      height: 768,
      fps: 30,
      clips: supabaseData.map(item => ({
        duration: 3,
        layers: [{
          type: "image",
          path: item.image_url
        }]
      }))
    };
    
    const outputPath = `output/${uuidv4()}.mp4`;
    editlySpec.outPath = outputPath;
    
    await editly(editlySpec);
    
    // Send result back to n8n webhook
    const videoBuffer = await fs.readFile(outputPath);
    
    // Send to n8n webhook with the video data
    await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        videoPath: outputPath,
        // Or base64 encode the video if needed
        videoBase64: videoBuffer.toString('base64')
      })
    });
    
    res.json({ success: true, message: 'Video generated and sent to n8n' });
    
  } catch (error) {
    console.error('Process error:', error);
    res.status(500).json({ error: error.message });
  }
});
