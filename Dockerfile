FROM ghcr.io/puppeteer/puppeteer:21.11.0

# Переключиться на root для установки пакетов
USER root

# Установка ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копирование package.json и установка зависимостей
COPY package*.json ./
RUN npm install --production && npm cache clean --force

# Копирование исходного кода
COPY . .

# Создание директории для медиа
RUN mkdir -p /app/media && chown -R pptruser:pptruser /app

# Переключение обратно на pptruser
USER pptruser

EXPOSE 3000
ENV PORT=3000

# Запуск (без Xvfb, так как уже настроен в базовом образе)
CMD ["npm", "start"]
