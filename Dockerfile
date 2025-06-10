FROM node:18-bullseye

# Установка системных зависимостей
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
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Установка Google Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list && \
    apt-get update && \
    apt-get install -y google-chrome-stable && \
    rm -rf /var/lib/apt/lists/*

# Создание пользователя для безопасности
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser && \
    mkdir -p /home/pptruser/Downloads && \
    chown -R pptruser:pptruser /home/pptruser

WORKDIR /app

# Копирование package files и установка зависимостей
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Копирование исходного кода
COPY . .

# Создание необходимых директорий с правильными правами
RUN mkdir -p /app/media && \
    chown -R pptruser:pptruser /app

# Переключение на непривилегированного пользователя
USER pptruser

# Настройка портов
EXPOSE 3000
ENV PORT=3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Запуск приложения
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp & npm start"]
