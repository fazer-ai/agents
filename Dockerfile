FROM oven/bun:1.4.2-alpine

WORKDIR /app

# curl: the platform (Coolify) injects a curl-based healthcheck for Dockerfile builds, but the
# alpine bun image ships wget only. Install curl so that probe works (we also declare a wget-based
# HEALTHCHECK below; whichever the platform uses, it succeeds).
RUN apk add --no-cache curl

# Cache packages installation
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source files
COPY . .

ENV NODE_ENV=production

ARG BUN_PUBLIC_CDN_URL=""
ENV BUN_PUBLIC_CDN_URL=$BUN_PUBLIC_CDN_URL

# @edition-arg
ARG BUN_PUBLIC_EDITION="free"
ENV BUN_PUBLIC_EDITION=$BUN_PUBLIC_EDITION

# Generate Prisma client. The dummy DATABASE_URL is scoped to this RUN only (NOT an ENV), so it is
# never baked into the runtime image where a real DATABASE_URL must be provided.
RUN DATABASE_URL="postgres://postgres:postgres@localhost:5432/dummy" bun prisma generate

# Build frontend assets (Tailwind CSS + React)
RUN bun run build

# NOTE: We intentionally do NOT use `bun build --compile` here. The standalone-compiled binary
# (and any `bun build` bundle) segfaults at boot on this app: bundling triggers a Bun heap-corruption
# bug, pinned to executing `@elysiajs/static`'s staticPlugin in the bundled build. The interpreted
# source (`bun src/index.ts`) is immune. Full investigation + repro: docs/bun-compile-segfault.md.
# Revisit `--compile` once the Bun bug is fixed or staticPlugin is replaced.

# stdio MCP launchers (gated by MCP_STDIO_ENABLED). `bunx` is native to the Bun base image; `uvx`
# (from uv, a statically-linked binary) runs Python MCP servers. We pre-install a musl CPython into
# uv's default dir under root's HOME so the spawned MCP process finds it without extra env vars (the
# MCP stdio transport only forwards a safe env subset such as HOME/PATH, so UV_* dirs would not
# propagate). NOTE: musl Python builds are x86_64-only today (aarch64-musl cannot yet install Python
# via uv). Pin uv by tag; bump deliberately.
COPY --from=ghcr.io/astral-sh/uv:0.11.23 /uv /uvx /usr/local/bin/
RUN uv python install 3.12

RUN mkdir -p /app/logs && chown -R bun:bun /app/logs

EXPOSE 3000

# Container healthcheck on /api/health using wget (always present in the bun:alpine image). With a
# HEALTHCHECK declared, the platform uses the container's own probe instead of injecting one.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

# Default boot: provision the runtime role (idempotent), migrate as the owner, then run the server
# interpreted (see the --compile NOTE above). Requires MIGRATION_DATABASE_URL (superuser) +
# DATABASE_URL (runtime role). Orchestrators (e.g. docker-compose.coolify.yml) may override this
# command, e.g. to run migrate as a one-shot pre-deploy step on platforms with rolling deploys.
CMD ["sh", "-c", "bun scripts/db-bootstrap.ts && bun prisma migrate deploy && exec bun src/index.ts"]
