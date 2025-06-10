FROM node:18-bullseye

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
  wget \
  xvfb && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99
WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN mkdir -p /app/media

ENV PORT=3000

CMD ["sh", " -c", "Xvfb :99 -screen 0 1920x1080x24 & npm start"]
