FROM oven/bun:1.3.2@sha256:30b6593d5646d1d695ed0c68c76ed370de538f5f49c34ed565386fd455bf6194
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl=3.0.22-1~deb12u1 libssl3=3.0.22-1~deb12u1 ca-certificates=20250419~deb12u2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /suite/benchmarks
COPY benchmarks/package.json benchmarks/bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json /suite/tsconfig.json
COPY packages/runtime/src /suite/packages/runtime/src
COPY packages/kit/src /suite/packages/kit/src
COPY benchmarks ./
RUN ln -s benchmarks/node_modules /suite/node_modules \
    && bun node_modules/prisma/build/index.js generate --config fixtures/prisma.config.ts \
    && bun run check
ENV BENCH_RESULTS=/artifacts
CMD ["bun", "src/run.ts"]
