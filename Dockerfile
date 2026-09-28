FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npx playwright install --with-deps chromium && npm prune --omit=dev
ENV HEADLESS=true MCP_HTTP_PORT=3000 MIDAS_SESSION_DIR=/data/midas-session
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
