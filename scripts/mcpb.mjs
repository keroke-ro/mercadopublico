// Arma mercadopublico.mcpb para Claude Desktop: manifest + dist/cli.js (y los chunks que importa) en una carpeta
// temporal, comprueba que arranque solo con `mcp` y corre `mcpb pack`. Uso: npm run mcpb (hace el build antes).
// Sale con 1 si server.json no tiene la versión de package.json o si mcpName no coincide con su name.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("..", import.meta.url));
const leer = (f) => JSON.parse(readFileSync(join(raiz, f), "utf8"));
const pkg = leer("package.json");
const srv = leer("server.json");

const versiones = [srv.version, ...srv.packages.map((p) => p.version)];
if (versiones.some((v) => v !== pkg.version) || pkg.mcpName !== srv.name)
  throw new Error(`server.json (${srv.name}, ${versiones}) no coincide con package.json (${pkg.mcpName}, ${pkg.version}): actualízalo`);

const tmp = mkdtempSync(join(tmpdir(), "mp-mcpb-"));
try {
  const stage = join(tmp, "bundle");
  mkdirSync(join(stage, "server"), { recursive: true });

  // cli.js y los chunks relativos que importa, en cadena
  const pendientes = ["cli.js"];
  const copiados = new Set();
  while (pendientes.length) {
    const f = pendientes.pop();
    if (copiados.has(f)) continue;
    copiados.add(f);
    const fuente = join(raiz, "dist", f);
    copyFileSync(fuente, join(stage, "server", f));
    for (const m of readFileSync(fuente, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) pendientes.push(m[1].slice(2));
  }

  const manifest = {
    ...leer("mcpb/manifest.json"),
    version: pkg.version,
    license: pkg.license,
    homepage: pkg.homepage,
    repository: { type: "git", url: pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "") },
  };
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Arranque aislado: nada del repo al alcance (ni node_modules ni .env)
  const r = spawnSync("node", ["server/cli.js", "mcp"], {
    cwd: stage,
    input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MP_TICKET: "x" },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0 || !/"result"/.test(r.stdout)) throw new Error(`el bundle no responde solo: ${r.stderr || r.stdout}`);
  console.log(`bundle: arranca solo (${copiados.size} archivo(s): ${[...copiados].join(", ")})`);

  const salida = join(raiz, `${pkg.name}.mcpb`);
  const pack = spawnSync("npx", ["--no-install", "mcpb", "pack", stage, salida], { cwd: raiz, stdio: "inherit" });
  if (pack.status !== 0) throw new Error(`mcpb pack salió con ${pack.status}`);
  console.log(`${salida} (${(statSync(salida).size / 1024).toFixed(1)} KiB)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
