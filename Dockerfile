# F1 Betting – självhostad. Data (SQLite, backuper, OpenF1-cache) ligger på
# volymen /data så att den överlever uppgraderingar av containern.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY migrations ./migrations
COPY scripts ./scripts
COPY public ./public

RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
