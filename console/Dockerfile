# Multi-stage: the final image carries only the compiled backend JS, its
# production dependencies, and the frontend's static build output -- no
# TypeScript source, no dev tooling (tsc, eslint, vitest, vite), keeping
# the shipped artifact minimal. Never carries any secret either way --
# credentials are provisioned into the cluster by this service at
# runtime, never baked into what this build produces.
# The build stages run on the building machine's own platform
# ($BUILDPLATFORM): what they make is JavaScript and static files, the same
# on any CPU, and a cross-build then never runs npm under emulation (which
# on Apple silicon has miscomputed floating-point and broken npm). The one
# native dependency, argon2, ships prebuilt binaries for every platform and
# loads the right one at run time.
# The base is pinned by digest, as the kernel's and gateway's are
# (Dependabot proposes newer ones).
FROM --platform=$BUILDPLATFORM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json frontend/vite.config.ts ./
COPY frontend/public ./public
COPY frontend/src ./src
RUN npm run build

FROM --platform=$BUILDPLATFORM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM --platform=$BUILDPLATFORM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# Security fixes released since the base image was published; CI's image
# scan fails on any high or critical one that has a fix. They make each
# build's packages differ, so a release scans the image it pushed.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
# npm isn't needed once dependencies are installed, and its own bundled
# packages are a steady source of CVEs in an image that never runs it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
# db/migrate.ts resolves "./src/db/migrations" relative to the process's
# cwd (WORKDIR /app here) -- tsc only compiles .ts to dist/, it doesn't
# copy the raw .sql files or drizzle-kit's own meta/_journal.json, so
# without this the migration Job crashes the moment it actually runs
# against a fresh database (caught by installing this chart for real,
# not just running the built server against an already-migrated one).
COPY src/db/migrations ./src/db/migrations
# The in-app Docs page: the guides for platform teams, shipped with the code
# they describe (see src/routes/docs.ts).
COPY docs ./docs

# Not root: the base image's `node` user, by uid so a pod's runAsNonRoot can
# verify it.
USER 1000

EXPOSE 8080
CMD ["node", "dist/index.js"]
