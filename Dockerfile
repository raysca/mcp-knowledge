FROM oven/bun:1.3.13 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY packages packages
RUN bun install --frozen-lockfile

FROM base AS release
ARG VCS_REF=unknown
ARG VERSION=local
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$VERSION
COPY --from=install /app/node_modules node_modules
COPY . .
RUN bun ui:css

ENV APP_PROFILE=local \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_PATH=/app/data \
    DATABASE_URL=file:/app/data/knowledge.db \
    EMBEDDING_MODEL_PATH=/app/models/default

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["bun", "scripts/healthcheck.ts"]

CMD ["sh", "-c", "bun packages/db/src/migrate.ts && exec bun apps/server/src/index.ts"]
