# No browser in this image. WhatsApp and Telegram presence both speak their
# protocol over a socket, so what used to be a Chromium install (plus fonts,
# NSS, GBM, ALSA and the rest of a rendering stack) is simply gone — along with
# the ~840MB of RSS each linked WhatsApp account used to hold.
FROM node:22-bookworm-slim AS deps
# Prisma sniffs the openssl version to pick a query engine; without it here the
# generated client targets the wrong one and is missing at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# procps stays: the pool reads process state. Everything else the old image
# pulled in existed only to let Chromium paint a page it never showed anyone.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates openssl procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Generate here rather than copying the build stage's client: the engine is
# chosen from the openssl present when generate runs, so doing it in the image
# that will actually execute removes the guesswork entirely.
RUN npx prisma generate

# WhatsApp credentials live under .wwebjs_auth/baileys and Telegram's in the
# database. The directory name is inherited from the old driver and kept on
# purpose: it is what the existing deploy volume is mounted at, so renaming it
# would silently strand every linked account.
RUN mkdir -p /app/.wwebjs_auth /app/uploads && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start -- -p 3000 -H 0.0.0.0"]
