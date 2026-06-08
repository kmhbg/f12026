# Azure Container Apps kräver linux/amd64. På Apple Silicon:
#   docker build --platform linux/amd64 -t <acr>.azurecr.io/f12026:test .
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY data ./data

ENV NODE_ENV=production
EXPOSE 3000

USER node

CMD ["node", "server.js"]
