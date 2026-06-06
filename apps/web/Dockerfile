# syntax=docker/dockerfile:1.7
#
# Production image for the Next.js dashboard (@copilot/web).
#
# IMPORTANT: build context must be the REPO ROOT (not apps/web), because the
# web app depends on the `@copilot/shared` workspace package and the pnpm
# lockfile lives at the root. docker-compose sets `context: .` accordingly.

FROM node:20-slim AS base
WORKDIR /app
ENV CI=true
RUN corepack enable

# 1) Install dependencies first (cached unless a manifest/lockfile changes).
#    All JS workspace manifests are copied so `--frozen-lockfile` can validate
#    the workspace against the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/extension/package.json ./apps/extension/package.json
RUN pnpm install --frozen-lockfile --filter @copilot/web...

# 2) Build the Next.js production bundle.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN pnpm build

# 3) Runtime: serve the compiled app.
FROM build AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
