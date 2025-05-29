FROM node:18

WORKDIR /app

COPY . .

RUN apt-get update && apt-get install -y python-is-python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN npm install

EXPOSE 3000

CMD ["npm", "start"]
