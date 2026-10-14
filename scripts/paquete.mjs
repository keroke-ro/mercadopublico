// Revisa el paquete tal como llega a npm: build, publint, attw, `npm pack` e import del tarball desde
// Node ESM, Node CJS, el subpath /radar, el bin, Bun y Deno (si están) y un entorno tipo edge sin globales
// de Node (node:vm, solo APIs web). Uso: npm run paquete. Sale con 1 al primer fallo.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const raiz = fileURLToPath(new URL("..", import.meta.url));
const fixture = (r) => JSON.parse(readFileSync(join(raiz, "test/fixtures", r), "utf8"));

if (process.argv[2] === "--borde") await borde(process.argv[3]);
else await principal();

function correr(cmd, args, o = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: process.platform === "win32", ...o });
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? "");
    throw new Error(`${cmd} ${args.join(" ")} salió con ${r.status ?? r.signal ?? r.error}`);
  }
  return r.stdout;
}

function hay(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

async function principal() {
  correr("npm", ["run", "build"], { cwd: raiz });
  console.log(correr("npx", ["publint", "--strict"], { cwd: raiz }));
  console.log(correr("npx", ["attw", "--pack", "."], { cwd: raiz }));

  const tmp = mkdtempSync(join(tmpdir(), "mp-paquete-"));
  const tgz = join(tmp, JSON.parse(correr("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: raiz }))[0].filename);
  const proy = join(tmp, "proyecto");
  mkdirSync(proy);
  writeFileSync(join(proy, "package.json"), JSON.stringify({ name: "prueba", private: true }));
  correr("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", tgz], { cwd: proy });

  writeFileSync(
    join(proy, "esm.mjs"),
    `import * as mp from "mercadopublico";
import * as radar from "mercadopublico/radar";
const c = new mp.MercadoPublico({ ticket: "x", conversor: false });
if (typeof c.cuota.restante !== "number" || typeof radar.priorizar !== "function") throw new Error("API incompleta");
if (radar.priorizar([], { pesos: { monto: 1 } }).length !== 0) throw new Error("priorizar");
console.log(JSON.stringify([Object.keys(mp).sort(), Object.keys(radar).sort()]));
`,
  );
  writeFileSync(
    join(proy, "cjs.cjs"),
    `const mp = require("mercadopublico");
const radar = require("mercadopublico/radar");
const c = new mp.MercadoPublico({ ticket: "x", conversor: false });
if (typeof c.cuota.restante !== "number" || !(new mp.MercadoPublicoError("red", "x") instanceof Error)) throw new Error("API incompleta");
console.log(JSON.stringify([Object.keys(mp).filter((k) => k !== "__esModule").sort(), Object.keys(radar).sort()]));
`,
  );

  const esm = correr("node", ["esm.mjs"], { cwd: proy }).trim();
  const cjs = correr("node", ["cjs.cjs"], { cwd: proy }).trim();
  if (esm !== cjs) throw new Error(`ESM y CJS exportan distinto:\n${esm}\n${cjs}`);
  console.log("node esm/cjs/radar: ok");

  const env = { ...process.env, MERCADOPUBLICO_HOME: tmp, MP_TICKET: "" };
  if (!correr("npx", ["--no-install", "mercadopublico", "--ayuda"], { cwd: proy, env }).includes("--ticket")) throw new Error("--ayuda sin texto");
  JSON.parse(correr("npx", ["--no-install", "mercadopublico", "cuota"], { cwd: proy, env }));
  console.log("bin: ok");

  if (hay("bun")) {
    for (const f of ["esm.mjs", "cjs.cjs"]) if (correr("bun", [f], { cwd: proy }).trim() !== esm) throw new Error(`bun ${f}: exportaciones distintas`);
    console.log("bun: ok");
  } else console.log("bun: no está, se salta");

  if (hay("deno")) {
    for (const f of ["esm.mjs", "cjs.cjs"]) if (correr("deno", ["run", "-A", f], { cwd: proy }).trim() !== esm) throw new Error(`deno ${f}: exportaciones distintas`);
    console.log("deno: ok");
  } else console.log("deno: no está, se salta");

  const dist = join(proy, "node_modules/mercadopublico/dist");
  correr(process.execPath, ["--experimental-vm-modules", "--no-warnings", fileURLToPath(import.meta.url), "--borde", dist], { stdio: "inherit" });
  console.log(`\nPaquete ok (${tgz}).`);
}

/**
 * Carga el bundle ESM en un contexto de node:vm sin process/Buffer/require, solo con APIs web, como un worker
 * edge. Los imports estáticos fuera de dist/ (node:*, dependencias) fallan al enlazar; los diferidos
 * (storeArchivo) solo fallarían si se llaman.
 */
async function borde(dist) {
  const lic = fixture("v1/licitacion-detalle.json");
  const llamadas = [];
  const fetchFalso = async (url) => {
    llamadas.push(String(url));
    if (new URL(url).pathname.endsWith("/licitaciones.json")) return Response.json(lic);
    return new Response("no", { status: 404 });
  };
  const g = { URL, URLSearchParams, TextEncoder, TextDecoder, TextDecoderStream, DecompressionStream, ReadableStream, WritableStream, TransformStream };
  Object.assign(g, { Response, Request, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, queueMicrotask, structuredClone, console, fetch: fetchFalso });
  const vm = await import("node:vm");
  const ctx = vm.createContext(g);
  if (vm.runInContext("[typeof process, typeof Buffer, typeof require].join()", ctx) !== "undefined,undefined,undefined") throw new Error("el contexto tiene globales de Node");

  const cache = new Map();
  const cargar = async (ruta) => {
    if (!cache.has(ruta)) cache.set(ruta, new vm.SourceTextModule(await readFile(ruta, "utf8"), { context: ctx, identifier: pathToFileURL(ruta).href }));
    return cache.get(ruta);
  };
  const enlazar = async (archivo) => {
    const m = await cargar(join(dist, archivo));
    await m.link(async (spec, ref) => {
      if (!spec.startsWith(".")) throw new Error(`import estático no apto para edge en ${ref.identifier}: ${spec}`);
      return cargar(fileURLToPath(new URL(spec, ref.identifier)));
    });
    await m.evaluate();
    return m.namespace;
  };
  const sdk = await enlazar("index.js");
  const radar = await enlazar("radar.js");

  const mp = new sdk.MercadoPublico({ ticket: "x", conversor: false, intervaloMs: 0 });
  const l = await mp.licitaciones.porCodigo(lic.Listado[0].CodigoExterno);
  if (l?.tipo !== "licitacion" || llamadas.length !== 1) throw new Error("porCodigo en edge");
  if (sdk.parseLicitacion(lic.Listado[0]).codigo !== l.codigo) throw new Error("parseLicitacion en edge");
  if (sdk.parseCompraAgil(fixture("v2/detalle.json").payload, { detalle: true }).tipo !== "compra_agil") throw new Error("parseCompraAgil en edge");
  if (sdk.ocultarPersonales(l).codigo !== l.codigo) throw new Error("ocultarPersonales en edge");

  const gz = gzipSync(JSON.stringify(fixture("ocds/release-cm.json")) + "\n");
  const stream = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(gz)), c.close()) });
  const ocds = [];
  for await (const p of sdk.leerOcds(stream)) ocds.push(p);
  if (ocds.length !== 1 || !ocds[0].codigo) throw new Error("leerOcds en edge");

  if (radar.priorizar([l], { pesos: { monto: 1 } }, { incluirCerrados: true }).length !== 1) throw new Error("priorizar en edge");
  console.log("edge (node:vm sin globales de Node): ok");
}
