FROM node:18-bullseye

# Устанавливаем системные библиотеки
RUN apt-get update && apt-get install -y \
  libx11-dev libxi-dev libgl1-mesa-dev libxext-dev \
  python3 make g++ pkg-config \
  libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev \
  libglu1-mesa-dev freeglut3-dev mesa-common-dev \
  libosmesa6-dev libgl1-mesa-glx xvfb ffmpeg \
  && ln -s /usr/bin/python3 /usr/bin/python \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Рабочая директория
WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps --verbose

COPY . .

# Порт
EXPOSE 3000

CMD ["npm", "start"]
