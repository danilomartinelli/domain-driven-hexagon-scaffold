ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
ARG APPLICATION
RUN bun --no-env-file scripts/distribute.ts ${APPLICATION} --output=/artifact

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
COPY --from=build --chown=bun:bun /artifact/ ./
USER bun
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "--no-env-file"]
CMD ["app/main.ts"]
