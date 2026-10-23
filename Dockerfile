FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip ffmpeg ca-certificates git \
    && pip3 install --break-system-packages --no-cache-dir \
       "yt-dlp[default]" bgutil-ytdlp-pot-provider \
    && git clone --depth 1 \
       --single-branch --branch 2.0.2 \
       https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
       /opt/bgutil-provider \
    && cd /opt/bgutil-provider/server \
    && npm ci \
    && npm install --no-save --include=dev typescript \
    && ./node_modules/.bin/tsc \
    && test -f /opt/bgutil-provider/server/build/main.js \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000


CMD ["sh", "-c", "set -eu; node /opt/bgutil-provider/server/build/main.js --host 127.0.0.1 --port 4416 & PROVIDER_PID=$!; sleep 2; kill -0 \"$PROVIDER_PID\"; if [ ! -f /etc/secrets/youtube-cookies.txt ]; then echo 'ERROR: YouTube cookies secret is missing'; exit 1; fi; cp /etc/secrets/youtube-cookies.txt /tmp/youtube-cookies.txt; chmod 600 /tmp/youtube-cookies.txt; export YTDLP_COOKIES_FILE=/tmp/youtube-cookies.txt; echo \"Cookies copied to writable path: $YTDLP_COOKIES_FILE\"; exec npm start"]

