# Azure Container Apps kräver linux/amd64. På Apple Silicon:
#   docker build --platform linux/amd64 -t <acr>.azurecr.io/f12026:test .
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY data ./data

# Cache ska ligga på volym (/app/data/cache), men katalogen måste vara skrivbar av node.
RUN mkdir -p /app/data/cache/sessions \
  && chown -R node:node /app/data

ENV NODE_ENV=production
ENV CACHE_DIR=/app/data/cache
EXPOSE 3000

USER node

CMD ["node", "server.js"]
