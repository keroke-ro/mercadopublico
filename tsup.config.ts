import { defineConfig } from "tsup";

// removeNodeProtocol: false deja `node:fs/promises` tal cual en el import diferido de storeArchivo: Deno y los
// runtimes edge con compatibilidad Node solo resuelven los builtins con el prefijo.
export default defineConfig([
  {
    entry: { index: "src/index.ts", radar: "src/radar/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "es2022",
    removeNodeProtocol: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    removeNodeProtocol: false,
  },
]);
