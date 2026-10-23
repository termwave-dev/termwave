
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip ffmpeg ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir \
       -U yt-dlp bgutil-ytdlp-pot-provider \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["sh", "-c", "node /opt/bgutil-provider/server/build/main.js --host 127.0.0.1 --port 4416 & exec npm start"]
