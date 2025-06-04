FROM node:18-bullseye

# Установка FFmpeg и зависимостей для OpenGL
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libx11-dev \
  libxi-dev \
  libgl1-mesa-dev \
  libgl1-mesa-glx \
  libglu1-mesa-dev \
  libxext-dev \
  libxrandr-dev \
  libxss1 \
  libgconf-2-4 \
  libxtst6 \
  libxrandr2 \
  libasound2-dev \
  libpangocairo-1.0-0 \
  libatk1.0-0 \
  libcairo-gobject2 \
  libgtk-3-0 \
  libgdk-pixbuf2.0-0 \
  xvfb \
  python3 \
  make \
  g++ \
  pkg-config \
  && ln -s /usr/bin/python3 /usr/bin/python \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Создание виртуального дисплея для headless режима
ENV DISPLAY=:99

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

# Создание директории для медиа файлов
RUN mkdir -p /app/media

ENV PORT=3000

# Запуск с виртуальным дисплеем
CMD ["sh", "-c", "Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 & npm start"]
