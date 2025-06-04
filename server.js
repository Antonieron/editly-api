const downloadAssets = async (supabaseData, musicUrl, requestId, supabaseBaseUrl) => {
  const basePath = `media/${requestId}`;
  await fs.mkdir(basePath, { recursive: true });

  const audioDir = `${basePath}/audio`;
  const imageDir = `${basePath}/images`;
  const textDir = `${basePath}/text`;
  await Promise.all([fs.mkdir(audioDir), fs.mkdir(imageDir), fs.mkdir(textDir)]);

  const slides = [];

  for (let i = 0; i < supabaseData.length; i++) {
    const slide = supabaseData[i];

    const imagePath = `${imageDir}/${i}.jpg`;
    const audioPath = `${audioDir}/${i}.mp3`;
    const textPath = `${textDir}/${i}.json`;

    await Promise.all([
      downloadFile(`${supabaseBaseUrl}${slide.image}`, imagePath),
      downloadFile(`${supabaseBaseUrl}${slide.audio}`, audioPath),
      downloadFile(`${supabaseBaseUrl}${slide.text}`, textPath),
    ]);

    const textData = JSON.parse(await fs.readFile(textPath, 'utf-8'));
    slides.push({
      imagePath,
      audioPath,
      subtitles: textData.subtitles || []
    });
  }

  const musicPath = `${audioDir}/music.mp3`;
  await downloadFile(musicUrl, musicPath);

  return { slides, musicPath, outputPath: `${basePath}/final.mp4` };
};
