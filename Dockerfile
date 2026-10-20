FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/server.js"]

