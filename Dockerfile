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
# TEMPORARY ONE-TIME BASELINE (P3005: prod DB has tables but no _prisma_migrations).
# Marks all 30 existing migrations as applied WITHOUT executing their SQL (resolve only records names).
# Safe here: prod schema was built from this exact history (old app ran on it), incl. seed data.
# AFTER a successful deploy ("No pending migrations", healthy /api/v1/health): REMOVE the resolve loop and redeploy.
CMD ["sh", "-c", "for m in 20260317191146_init 20260317191255_postgis 20260317191801 20260317191934_gist_indexes 20260317200122_catalog 20260317204459_seed_catalog 20260319082419_settings_profiles_security_reviews 20260319120000_seed_more_catalog 20260319122150_service_type_composite_id 20260319131529_subcategory_pricing 20260319133000_seed_order_quote_service_types 20260319143000_ua_service_names 20260319182000_add_cultivation_inter_row 20260319210000_add_liqpay_provider 20260320202020_remove_postgis 20260329_add_name_ua_columns 20260329_add_specs_to_orders 20260329_create_legal_profiles_table 20260329_hierarchical_performer_services 20260329_migrate_service_ids 20260329_unify_legal_profile 20260329_update_performer_profile 20260329_update_service_structure 20260329214130_30_march 20260330_payments_escrow 20261003090000_add_avatar_url 20261005055443_add_order_media 20261005055505_backfill_order_media 20261005082439_add_early_start_requests 20261005084136_progress_reviews_arbitration; do ./node_modules/.bin/prisma migrate resolve --applied \"$m\" --config prisma.config.ts; done; for i in $(seq 1 30); do ./node_modules/.bin/prisma migrate deploy --config prisma.config.ts && break || { [ \"$i\" = 30 ] && exit 1; sleep 2; }; done; exec node server.js"]
