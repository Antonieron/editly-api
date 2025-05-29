FROM node:18

# Установка зависимостей сборки (для editly и gl)
RUN apt-get update && apt-get install -y \
  libxi-dev libx11-dev libxext-dev pkg-config python3 make g++ \
  && ln -sf /usr/bin/python3 /usr/bin/python \
  && apt-get clean

WORKDIR /app

COPY package*.json ./

# Устанавливаем зависимости с поддержкой старых peer deps
RUN npm install --legacy-peer-deps

# Копируем остальной код
COPY . .

CMD ["npm", "start"]
