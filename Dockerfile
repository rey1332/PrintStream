# ETNA as a container image (Linux). Used by deploy/docker/compose.yml; see
# docs/INSTALL-LINUX.md. The same image runs the app (default command), the
# TERMINAL worker and the one-time setup / migrations:
#
#   node scripts/server/env-run.mjs /config/etna.env app
#   node scripts/server/env-run.mjs /config/etna.env worker
#   sh deploy/docker/setup.sh
#
# Settings and keys live in the /config volume (etna.env, written by the setup
# step), uploaded documents and company folders in the /data volume.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx --no-install next build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ETNA_HOST=0.0.0.0 \
    ETNA_PORT=4028 \
    ETNA_DATA_ROOT=/data
WORKDIR /app
# The app is read-only for the user that runs it.
COPY --from=build /app /app
# Next.js keeps its image cache in .next/cache: the one writable place in /app.
RUN rm -rf /app/.next/cache && mkdir -p /config /data /app/.next/cache \
 && chown node:node /config /data /app/.next/cache
USER node
VOLUME ["/config", "/data"]
EXPOSE 4028
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4028/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "scripts/server/env-run.mjs", "/config/etna.env", "app"]
