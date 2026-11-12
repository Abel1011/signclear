# SignClear: production image (Next.js 15 + Prisma/SQLite).
# The SQLite file lives in /data. Mount a volume there so cases survive redeploys.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* values are inlined at build time: pass them as build args/env in your platform.
ARG NEXT_PUBLIC_PAYPAL_CLIENT_ID
ARG NEXT_PUBLIC_AG_GRID_LICENSE
ARG NEXT_PUBLIC_SANDBOX_BUYER_EMAIL
ARG NEXT_PUBLIC_SANDBOX_BUYER_PASSWORD
ENV NEXT_PUBLIC_PAYPAL_CLIENT_ID=$NEXT_PUBLIC_PAYPAL_CLIENT_ID \
    NEXT_PUBLIC_AG_GRID_LICENSE=$NEXT_PUBLIC_AG_GRID_LICENSE \
    NEXT_PUBLIC_SANDBOX_BUYER_EMAIL=$NEXT_PUBLIC_SANDBOX_BUYER_EMAIL \
    NEXT_PUBLIC_SANDBOX_BUYER_PASSWORD=$NEXT_PUBLIC_SANDBOX_BUYER_PASSWORD
RUN npx prisma generate && npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 DATABASE_URL="file:/data/signclear.db"
COPY --from=build /app ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx next start -p ${PORT:-3000}"]
