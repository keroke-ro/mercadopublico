import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", radar: "src/radar/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "es2022",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
  },
]);
