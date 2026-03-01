FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

COPY server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY skill/ ./skill/

ENV INVOICECLAW_DATA=/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.mjs"]
