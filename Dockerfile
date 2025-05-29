FROM node:18

# Установка зависимостей сборки
RUN apt-get update && apt-get install -y \
  libxi-dev libx11-dev libxext-dev pkg-config python3 make g++ \
  && ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app
COPY . .

RUN npm install

CMD ["npm", "start"]
