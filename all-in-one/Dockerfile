# Actual Budget + Actual Budget Tweaks + Actual Insights in ONE container, for hosts that run a single image behind one HTTPS port
# (for example PikaPods). Build from the repository root:
#
#   docker build -f all-in-one/Dockerfile -t actual-insights-aio .
#
# ACTUAL_VERSION must be a published ghcr.io/actualbudget/actual tag, and it must equal the
# @actual-app/api version in api/package.json: a mismatch fails the build on purpose.
ARG ACTUAL_VERSION=26.10.0
# Actual Budget Tweaks sidecar, pinned by digest. Re-read server.js and browser-shim.js before changing it.
ARG ABT_IMAGE=ghcr.io/aelxxs/abt-sidecar:0.1.100@sha256:f641fb2d1e6487462d8cfbe7e6f522e81278d3fb9deb85d6e7c9eaa9f8fbfdb0

# --- 0. ABT files, copied unmodified ---
FROM ${ABT_IMAGE} AS abt-src

# --- 1. Insights API with its native dependency, built against the SAME Node as the final image ---
FROM ghcr.io/actualbudget/actual:${ACTUAL_VERSION} AS api-build
ARG ACTUAL_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/insights/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev
COPY api/src ./src
ENV AV=${ACTUAL_VERSION}
RUN node -e "const v=JSON.parse(require('fs').readFileSync('node_modules/@actual-app/api/package.json','utf8')).version; if (v!==process.env.AV) { console.error('@actual-app/api '+v+' does not match the Actual server '+process.env.AV+'. Update api/package.json or pass a matching --build-arg ACTUAL_VERSION.'); process.exit(1); }"

# --- 2. Insights proxy (pure JavaScript) ---
FROM node:22-bookworm-slim AS proxy-build
WORKDIR /opt/insights/proxy
COPY proxy/package.json proxy/package-lock.json ./
RUN npm ci --omit=dev
COPY proxy/src ./src

# --- 3. Browser bundle ---
FROM node:22-bookworm-slim AS bundle-build
WORKDIR /build/bundle
COPY bundle/package.json bundle/package-lock.json ./
RUN npm ci
COPY bundle/ ./
RUN npx vite build

# --- final image: the official Actual image plus the three Insights parts ---
FROM ghcr.io/actualbudget/actual:${ACTUAL_VERSION}
COPY --from=api-build /opt/insights/api /opt/insights/api
COPY --from=proxy-build /opt/insights/proxy /opt/insights/proxy
COPY --from=bundle-build /build/bundle/dist /opt/insights/static
COPY --from=abt-src /app/server.js /app/browser-shim.js /app/package.json /opt/abt/
COPY --from=abt-src /assets /opt/abt/assets
COPY all-in-one/licenses/ABT-LICENSE /opt/abt/LICENSE
COPY all-in-one/THIRD-PARTY.md /opt/THIRD-PARTY.md
COPY all-in-one/supervisor.js all-in-one/supervisor-lib.js all-in-one/healthcheck.js /opt/insights/

# Same single port as the official image. Everything else listens on loopback only.
EXPOSE 5006
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 CMD ["node", "/opt/insights/healthcheck.js"]

# The official image's entrypoint (tini) stays; only the command changes.
CMD ["node", "/opt/insights/supervisor.js"]
