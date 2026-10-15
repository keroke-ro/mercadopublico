import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

// removeNodeProtocol: false deja `node:fs/promises` tal cual en el import diferido de storeArchivo: Deno y los
// runtimes edge con compatibilidad Node solo resuelven los builtins con el prefijo.
export default defineConfig([
  {
    entry: { index: "src/index.ts", radar: "src/radar/index.ts", mcp: "src/mcp-http.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    // El CJS también comparte chunks: sin esto mercadopublico/mcp lleva su propia copia de MercadoPublicoError y
    // `instanceof` falla con los errores del MercadoPublico que viene de `mercadopublico`.
    splitting: true,
    target: "es2022",
    removeNodeProtocol: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    define: { __VERSION__: JSON.stringify(version) },
    target: "node20",
    removeNodeProtocol: false,
  },
]);
