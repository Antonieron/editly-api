FROM node:18

# Create app directory
WORKDIR /app

# Copy app files
COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

CMD ["npm", "start"]
