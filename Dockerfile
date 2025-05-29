# Используем официальный Node.js образ с поддержкой Alpine Linux
FROM node:18-alpine

# Устанавливаем системные зависимости включая FFmpeg
RUN apk add --no-cache \
    ffmpeg \
    ffprobe \
    python3 \
    make \
    g++ \
    pkgconfig \
    cairo-dev \
    pango-dev \
    libjpeg-turbo-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev

# Создаем рабочую директорию
WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install

# Копируем файлы сервера
COPY server.js package*.json ./

# Создаем необходимые директории
RUN mkdir -p uploads outputs temp

# Устанавливаем права на выполнение
RUN chmod +x /usr/bin/ffmpeg /usr/bin/ffprobe

# Открываем порт
EXPOSE 3000

# Переменные окружения
ENV NODE_ENV=production
ENV PORT=3000

# Запускаем приложение
CMD ["npm", "start"]
