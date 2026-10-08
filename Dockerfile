# ---- dependencies ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Prisma needs OpenSSL for version detection (silences "failed to detect libssl" warnings)
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/generated ./generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/next.config.ts ./next.config.ts
EXPOSE 3000
# One-time P3009 unblock: 20261009000000 failed on first attempt (unique indexes +
# ALTER TYPE inside tx); its SQL is now minimal specs-only. Mark the failed
# attempt as rolled back so deploy re-runs it. `|| true` keeps this a no-op
# once the migration is applied. Remove after a green deploy if desired.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate resolve --rolled-back \"20261009000000_repair_missing_specs_column\" --config prisma.config.ts || true; for i in $(seq 1 30); do ./node_modules/.bin/prisma migrate deploy --config prisma.config.ts && break || { [ \"$i\" = 30 ] && exit 1; sleep 2; }; done; exec node server.js"]
