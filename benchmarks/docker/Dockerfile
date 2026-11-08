FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
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
