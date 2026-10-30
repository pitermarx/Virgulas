# syntax=docker/dockerfile:1
#
# Virgulas on TrailBase — the self-hosting image. Builds the static app and
# serves it WITH TrailBase on one origin (the deployment shape the app's
# server resolution expects: the sync server is the origin serving the app).
#
# Published multi-arch image (built by the release workflow):
#   ghcr.io/pitermarx/virgulas-trailbase:<version>
#
# Build (from the repository root, so the context has source/ and scripts/):
#   docker build --build-arg APP_VERSION=4.0.1 \
#     -t virgulas-trailbase -f scripts/trailbase/Dockerfile .
#
# Run:
#   docker run -p 8080:4000 -e PUBLIC_URL=http://localhost:8080 \
#     -v trail-data:/app/traildepot/data virgulas-trailbase
#   → the app at http://localhost:8080
#
# - PUBLIC_URL must be the externally reachable origin: TrailBase embeds it in
#   the verification emails it sends on sign-up. Without it (or a mounted
#   config.textproto with email/SMTP settings) new accounts cannot verify and
#   sign-up fails with 424 — mount your own config to add SMTP:
#     -v ./config.textproto:/app/traildepot/config.textproto:ro
# - Data persists in the `trail-data` volume (only the SQLite data dir is
#   volume-mounted; the baked schema/config stay with the image).
# - The admin credentials are printed to the container logs on first boot.

FROM oven/bun:1 AS build
WORKDIR /app
# Release images pass the version resolved by the release workflow; local
# builds fall back to package.json.
ARG APP_VERSION
# No pre-registered service worker to bust inside a fresh image, and the bump
# script would fail on a partial source tree.
ENV SKIP_SW_BUMP=1
COPY package.json bun.lock ./
# scripts/ precedes install: its postinstall bump hook expects the scripts dir.
COPY scripts ./scripts
RUN bun install --frozen-lockfile
COPY source ./source
RUN if [ -n "$APP_VERSION" ]; then \
      bun scripts/build-bun.mjs source dist --version "$APP_VERSION" --no-sourcemap; \
    else \
      bun run build; \
    fi

FROM trailbase/trailbase:latest
# The outlines schema (migration) + record API with the owner ACL rules
# (docs/storage-interface.md §4.2).
COPY --from=build /app/scripts/trailbase/traildepot/config.textproto /app/traildepot/config.textproto
COPY --from=build /app/scripts/trailbase/traildepot/migrations /app/traildepot/migrations
# The built app, served by TrailBase on the same origin as the API.
COPY --from=build /app/dist /public
CMD ["/app/trail", "--depot", "/app/traildepot", "run", "--public-dir", "/public", "--spa", "--address", "0.0.0.0:4000"]
