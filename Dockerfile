FROM node:22-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY skill/ ./skill/

ENV INVOICECLAW_DATA=/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.mjs"]
