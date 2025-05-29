FROM node:18

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

# Устанавливаем зависимости отдельно, чтобы использовать кеш, и с legacy-peer-deps
RUN npm install --legacy-peer-deps

COPY . .

CMD ["npm", "start"]
