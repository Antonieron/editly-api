FROM node:18-bullseye

# Устанавливаем зависимости, включая OpenGL и ffmpeg
RUN apt-get update && apt-get install -y \
  ffmpeg libx11-dev libxi-dev libgl1-mesa-dev libxext-dev \
  python3 make g++ pkg-config curl wget git \
  && ln -s /usr/bin/python3 /usr/bin/python

# Рабочая директория
WORKDIR /app

# Копируем зависимости
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Копируем исходники
COPY . .

# Устанавливаем порт
ENV PORT=3000

# Запускаем сервер
CMD ["node", "server.js"]
