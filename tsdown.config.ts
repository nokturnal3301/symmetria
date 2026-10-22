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
      driver: "src/driver.ts",
      dialect: "src/dialect.ts",
      internal: "src/internal.ts",
    },
    copy: [{ from: "../../LICENSE", to: "." }],
  },
  {
    ...shared,
    name: "symmetria-kit",
    cwd: resolve(import.meta.dirname, "packages/kit"),
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      testing: "src/testing.ts",
      "cli/query-inspect": "src/cli/query-inspect.ts",
    },
    copy: [{ from: "../../LICENSE", to: "." }],
  },
]);
