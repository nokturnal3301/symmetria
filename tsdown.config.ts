import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "tsdown";

const shared = {
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  clean: true,
  dts: true,
  publint: true,
  tsconfig: resolve(import.meta.dirname, "tsconfig.build.json"),
  deps: { neverBundle: true },
  inputOptions: { external: [/^bun:/] },
} satisfies UserConfig;

export default defineConfig([
  {
    ...shared,
    name: "symmetria",
    cwd: resolve(import.meta.dirname, "packages/runtime"),
    entry: {
      index: "src/index.ts",
      driver: "src/entries/driver.ts",
      bun: "src/entries/bun.ts",
      pg: "src/entries/pg.ts",
      vector: "src/entries/vector.ts",
      search: "src/entries/search.ts",
      voyage: "src/entries/voyage.ts",
      ollama: "src/entries/ollama.ts",
      openai: "src/entries/openai.ts",
      cohere: "src/entries/cohere.ts",
      google: "src/entries/google.ts",
      mistral: "src/entries/mistral.ts",
      jina: "src/entries/jina.ts",
      "better-auth": "src/entries/better-auth.ts",
      opentelemetry: "src/entries/opentelemetry.ts",
      internal: "src/entries/internal.ts",
    },
    copy: [{ from: "../../LICENSE", to: "." }],
  },
  {
    ...shared,
    name: "symmetria-kit",
    cwd: resolve(import.meta.dirname, "packages/kit"),
    entry: {
      index: "src/index.ts",
      cli: "src/cli/index.ts",
      testing: "src/testing.ts",
      "cli/query-inspect": "src/cli/screens/query-inspector.ts",
    },
    copy: [{ from: "../../LICENSE", to: "." }],
  },
]);
