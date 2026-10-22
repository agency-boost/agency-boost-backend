# syntax=docker/dockerfile:1
#
# The AgencyBoost API image (P18.7-T3, ADR-0152).
#
#   docker build --target runtime -t agencyboost-api .   # what the VM runs
#   docker build --target tools   -t agencyboost-tools . # the same tree with dev dependencies, for the seed
#
# `runtime` is the last stage, so a bare `docker build .` builds it.
#
# **The base is pinned by digest, not only by tag.** `node:24-bookworm-slim` moves every week, and
# staging and production each build their own image of the same source (deploy.yml: production never
# runs an image another environment built). A floating base would let those two builds run different
# Node and Debian patches; pinned, with the frozen lockfile, they get the same ones. To move it deliberately:
#
#   docker pull node:24-bookworm-slim
#   docker inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim
#
# **bookworm (glibc), not alpine.** argon2 is in `pnpm.ignoredBuiltDependencies`: nothing compiles it,
# and it loads the prebuilt glibc binary it ships. On musl there is no such binary and login would
# fail at the first password hash, not at build time.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
# pnpm from npm, at the version package.json#packageManager names (D7). Not corepack: it is no longer
# bundled with Node from 25 on, and on first use it downloads pnpm at run time, which an image should
# have done at build time.
RUN npm install --global pnpm@10.33.0 && npm cache clean --force
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# ---------------------------------------------------------------------------------------------------
# Every dependency, dev included: what `pnpm build` and the seed need. Only the manifest and the
# lockfile are copied, so a source change does not invalidate this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

# ---------------------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------------------------------
# The seed runs from TypeScript source (tsconfig.build.json leaves src/seed out of dist/), so it needs
# ts-node and the dev dependencies: this is the build stage as it stands. Transpile-only because the
# type check already ran in CI, and checking 3,500 lines of fixtures on a VM is minutes for nothing.
FROM build AS tools
ENV TS_NODE_TRANSPILE_ONLY=1
USER node
CMD ["pnpm", "seed:demo"]

# ---------------------------------------------------------------------------------------------------
# Production dependencies only. A separate install rather than `pnpm prune --prod` on the build
# stage: the result is a function of the lockfile alone, so it caches independently of the source.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm-store

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Owned by root and only readable by the process: the API never writes to its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# No NODE_ENV here. The environment file on the VM states it (staging or production), and an image
# that bakes one in is an image that can boot as production by accident.
USER node
EXPOSE 3001

# Readiness, not liveness: `/api/health/ready` answers 503 while the database is unreachable
# (P18.7-T1), and this is what `deploy.sh` waits on before it calls a deploy good. Node's own fetch,
# because the slim image has no curl and installing one for a probe is attack surface for nothing.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
