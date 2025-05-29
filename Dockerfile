FROM node:18

# Установка зависимостей для сборки native модулей
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  && apt-get clean

# Создаём рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем остальной код
COPY . .

# Приложение слушает порт 3000
EXPOSE 3000

# Команда запуска
CMD ["npm", "start"]
