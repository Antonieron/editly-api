FROM node:18-bullseye

# Установка зависимостей для node-canvas, puppeteer и ffmpeg
RUN apt-get update && apt-get install -y \
  libx11-dev libxi-dev libgl1-mesa-dev libxext-dev \
  python3 make g++ pkg-config \
  libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev \
  ffmpeg \
  && ln -s /usr/bin/python3 /usr/bin/python \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Создание рабочей директории
WORKDIR /app

# Установка зависимостей
COPY package*.json ./
RUN npm install --legacy-peer-deps --verbose

# Копирование исходников
COPY . .

# Экспонируем порт
EXPOSE 3000

# Запуск
CMD ["npm", "start"]
