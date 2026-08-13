# check=skip=SecretsUsedInArgOrEnv
# (Parser directive, must stay on line 1. BuildKit flags every VITE_* ARG/ENV
# below as a possible leaked secret. The Firebase *web* config is public by
# design — it ships inside the JavaScript bundle either way — so the warning is
# a false positive here. The private service account key is server-side only
# and never enters a build stage.)

# Tally — one image serving the Express API and the built PWA.
#
# Stages: deps (full tree) → build (shared, server, web) → prod-deps (runtime
# tree only) → runtime. Coolify builds this from the repo on push.
#
# The single most important thing in this file is the VITE_* block in the web
# build stage. Vite inlines those values into the JavaScript bundle at BUILD
# time; setting them only as runtime environment ships a frontend with undefined
# Firebase config and nothing works. They must be build arguments.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# base — shared settings for every Node stage
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

# ---------------------------------------------------------------------------
# deps — the full dependency tree, including devDependencies for the compilers.
# Only the manifests are copied so this layer is cached until the lockfile moves.
# NODE_ENV is deliberately NOT production here, or npm would omit devDependencies
# and there would be nothing to build with.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

# ---------------------------------------------------------------------------
# build — compile shared, then the server, then the web bundle
# ---------------------------------------------------------------------------
FROM deps AS build
COPY shared/ shared/
COPY server/ server/
COPY web/ web/

RUN npm run build -w @tally/shared \
 && npm run build -w @tally/server

# VITE_* are inlined into the bundle here and cannot be changed afterwards.
# In Coolify these must be set as *build* variables, not just runtime env.
# They are public values by design (Firebase web config); the service account
# private key is server-side only and must never appear in this stage.
ARG VITE_FIREBASE_API_KEY=""
ARG VITE_FIREBASE_AUTH_DOMAIN=""
ARG VITE_FIREBASE_PROJECT_ID=""
ARG VITE_FIREBASE_APP_ID=""
ENV VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY} \
    VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN} \
    VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID} \
    VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID}

# A build with no Firebase config is still a valid build — it is how you get a
# reviewable image without secrets — but it produces an app nobody can sign in
# to, so say so loudly rather than letting it be discovered in production.
RUN if [ -z "$VITE_FIREBASE_API_KEY" ] || [ -z "$VITE_FIREBASE_PROJECT_ID" ]; then \
      echo '################################################################'; \
      echo '# WARNING: building the PWA with no Firebase config.'; \
      echo '# VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID are empty.'; \
      echo '# Vite inlines these at build time, so this image can never'; \
      echo '# sign anyone in. Pass them as --build-arg / Coolify build vars.'; \
      echo '################################################################'; \
    fi \
 && npm run build -w @tally/web

# ---------------------------------------------------------------------------
# prod-deps — runtime dependency tree only.
# Scoped to the server workspace so the browser packages (react, firebase) are
# not dragged into the runtime image; they are already inside web/dist.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --include-workspace-root --workspace @tally/server \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

# NODE_ENV=production is a security control, not a performance setting: the
# development auth bypass in server/src/firebase.ts is gated on it. It is baked
# into the image so a deployed container is production by default.
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_ROOT=/app/web/dist

# Workspace layout is preserved because node_modules/@tally/shared is a symlink
# to ../shared, and server/dist/migrate.js finds migrations at ../migrations.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist

COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations

COPY --from=build /app/web/dist web/dist

# Non-root. Everything above stays root-owned and world-readable, so the running
# process can read its own code but cannot rewrite it.
USER node

EXPOSE 8080

# Mirrored in docker-compose.yml so Coolify shows it; keep the two in step.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run inside this process before the port opens (server/src/index.ts),
# so there is deliberately no separate migration step or entrypoint script.
CMD ["node", "server/dist/index.js"]
