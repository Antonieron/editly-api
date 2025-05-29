FROM node:18-bullseye

# Установка системных зависимостей для gl и editly
RUN apt-get update && apt-get install -y \
  libx11-dev \
  libxi-dev \
  libgl1-mesa-dev \
  libgl1-mesa-glx \
  libxext-dev \
  pkg-config \
  python3 \
  make \
  g++ \
  && ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./

# Установка зависимостей с подробным логированием
RUN npm install --legacy-peer-deps --verbose

COPY . .

CMD ["npm", "start"]
