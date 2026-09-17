# Same shape as chomptron's Dockerfile (matches package.json engines >=24)
FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
