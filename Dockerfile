# Build context: repository root.
#
# Stage 1: Build the WASM module from sandspiel/crate (a git submodule;
# Social Vibecoding clones with --recurse-submodules so this is populated
# at build time).
FROM rust:1.83-slim AS wasm-builder

RUN apt-get update \
 && apt-get install -y curl pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

WORKDIR /build
COPY sandspiel/ sandspiel/
RUN cd sandspiel && wasm-pack build crate --target nodejs

# Stage 2: Node.js runtime.
#
# pg's bindings are pure JS so node:22-alpine is fine. We do need a
# /app/data directory for the on-disk snapshot mirror.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN { [ -f package-lock.json ] && npm ci --omit=dev || npm install --omit=dev; }

# Built WASM package - the engine + browser loader both look here.
COPY --from=wasm-builder /build/sandspiel/crate/pkg/ sandspiel/crate/pkg/

# Server, engine, loaders, lib, public assets, tests.
COPY server.js engine.js seed-content.js wasm-loader.js wasm-browser.js ./
COPY lib/ lib/
COPY public/ public/
COPY tests/ tests/

RUN mkdir -p /app/data

ENV PORT=3000 SNAPSHOT_DIR=/app/data
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O - http://localhost:3000/health > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
