# Spool edit render worker. Build from the REPO ROOT (context) so the worker can
# import the repo's own src/render, src/vo, src/share as libraries:
#   docker build -f worker/Dockerfile -t spool-render .
FROM node:20-bookworm-slim

# ffmpeg + Remotion's headless-chromium shared libs (Debian) + fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates fonts-liberation \
    libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
    libxshmfence1 libx11-6 libxcb1 libxext6 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps against the lockfile first (cached until package files change).
COPY package.json package-lock.json ./
RUN npm ci

# Pre-download Remotion's chrome-headless-shell into the image so the first render
# doesn't fetch it at runtime.
RUN node -e "import('@remotion/renderer').then(m=>m.ensureBrowser()).then(()=>console.log('browser ok')).catch(e=>{console.error(e);process.exit(1)})"

# App source: the worker plus the render/vo/share libs it imports.
COPY src ./src
COPY assets ./assets
COPY bin ./bin
COPY templates ./templates
COPY worker ./worker

ENV NODE_ENV=production
# Cap Remotion render concurrency: os.cpus() sees host cores in a container, so the
# default over-subscribes RAM. Overridable at deploy (fly.toml sets it per VM size).
ENV SPOOL_RENDER_CONCURRENCY=2
CMD ["node", "worker/index.mjs"]
