FROM node:18-bookworm

# Установка системных зависимостей (без Chrome)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libx11-dev \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libgbm-dev \
  libnss3 \
  libglib2.0-0 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcairo2 \
  libdrm2 \
  libpangocairo-1.0-0 \
  libasound2 \
  libxss1 \
  libxtst6 \
  libgtk-3-0 \
  libgdk-pixbuf2.0-0 \
  fonts-liberation \
  libappindicator3-1 \
  wget \
  xvfb \
  ca-certificates && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# Настройка переменных окружения для Puppeteer
ENV DISPLAY=:99
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

WORKDIR /app

# Копирование и установка зависимостей
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Копирование кода
COPY . .

# Создание директории для медиафайлов
RUN mkdir -p /app/media

# Порт
EXPOSE 3000
ENV PORT=3000

# Запуск
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp & npm start"]
