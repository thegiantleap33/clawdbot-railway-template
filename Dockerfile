
FROM node:24-bookworm

ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Install the published OpenClaw release
RUN npm install -g openclaw@2026.9.7 \
  && openclaw --version

# Keep user-installed tools on Railway's persistent volume
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

# Install the existing Railway wrapper dependencies
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# Railway provides PORT automatically
EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
