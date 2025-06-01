FROM node:18-bullseye

# Устанавливаем OpenGL-зависимости
RUN apt-get update && apt-get install -y \
  libx11-dev libxi-dev libgl1-mesa-dev libxext-dev \
  python3 make g++ pkg-config curl wget git \
  && ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

# Прописываем ENV, если Railway его не подставляет
ENV PORT=3000

# ВАЖНО: слушать 0.0.0.0 для Railway
CMD ["node", "server.js"]
