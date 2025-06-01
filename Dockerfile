FROM node:18-bullseye

# Устанавливаем OpenGL-зависимости для editly
RUN apt-get update && apt-get install -y \
  libx11-dev libxi-dev libgl1-mesa-dev libxext-dev \
  python3 make g++ pkg-config curl wget git \
  && ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Копируем только для установки сначала зависимости
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --legacy-peer-deps

# Копируем весь остальной код
COPY . .

# Railway иногда не подставляет PORT, задаём по умолчанию
ENV PORT=3000

# Слушаем 0.0.0.0 для внешнего доступа
CMD ["node", "server.js"]
