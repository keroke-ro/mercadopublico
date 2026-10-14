// Contrato nocturno (PRD §3.6): pocas consultas reales, serializadas, y comparación de la FORMA
// de las respuestas contra test/fixtures. Autocontenido (solo fetch) para correr sin build:
//   MP_TICKET=… node --experimental-strip-types scripts/contrato.ts
// Imprime un reporte markdown y sale con 1 si algo cambió o falló.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Ruta → tipos JSON vistos. Los arreglos se colapsan en `ruta[]` (unión de sus elementos). */
export type Forma = Map<string, Set<string>>;

export function forma(x: unknown, f: Forma = new Map(), ruta = "$"): Forma {
  const tipo = x === null ? "null" : Array.isArray(x) ? "array" : typeof x;
  if (!f.has(ruta)) f.set(ruta, new Set());
  f.get(ruta)!.add(tipo);
  if (Array.isArray(x)) for (const v of x) forma(v, f, `${ruta}[]`);
  else if (tipo === "object") for (const [k, v] of Object.entries(x as object)) if (k !== "_fixture") forma(v, f, `${ruta}.${k}`);
  return f;
}

export interface Diferencias {
  agregados: string[];
  eliminados: string[];
  cambiados: { ruta: string; antes: string[]; ahora: string[] }[];
}

/**
 * Compara la forma esperada (fixture) con la real. Para no dar falsas alarmas por muestreo:
 * `null` es compatible con cualquier tipo, un campo solo cuenta como eliminado si su objeto padre sí llegó,
 * y un arreglo vacío no elimina a sus elementos.
 */
export function comparar(esperada: Forma, real: Forma): Diferencias {
  const sinNull = (s: Set<string> | undefined) => [...(s ?? [])].filter((t) => t !== "null").sort();
  const d: Diferencias = { agregados: [], eliminados: [], cambiados: [] };
  for (const ruta of real.keys()) if (!esperada.has(ruta)) d.agregados.push(ruta);
  for (const [ruta, tipos] of esperada) {
    if (real.has(ruta)) {
      const antes = sinNull(tipos);
      const ahora = sinNull(real.get(ruta));
      if (antes.length && ahora.some((t) => !antes.includes(t))) d.cambiados.push({ ruta, antes: [...tipos].sort(), ahora: [...real.get(ruta)!].sort() });
    } else if (!ruta.endsWith("[]") && real.get(ruta.slice(0, ruta.lastIndexOf(".")))?.has("object")) d.eliminados.push(ruta);
  }
  // Un campo nuevo dentro de otro nuevo se reporta solo una vez (el de arriba).
  d.agregados = d.agregados.filter((r) => !d.agregados.some((p) => p !== r && (r.startsWith(`${p}.`) || r.startsWith(`${p}[]`))));
  return d;
}

export function reporte(resultados: { nombre: string; d?: Diferencias; error?: string }[]): string {
  const lineas = ["# Contrato de la API de Mercado Público", "", `Fecha: ${new Date().toISOString()}`, ""];
  for (const { nombre, d, error } of resultados) {
    if (error) lineas.push(`## ${nombre}`, "", `Error: ${error}`, "");
    else if (d && (d.agregados.length || d.eliminados.length || d.cambiados.length)) {
      lineas.push(`## ${nombre}`, "");
      for (const r of d.agregados) lineas.push(`- agregado: \`${r}\``);
      for (const r of d.eliminados) lineas.push(`- eliminado: \`${r}\``);
      for (const c of d.cambiados) lineas.push(`- tipo cambiado: \`${c.ruta}\` (${c.antes.join("|")} → ${c.ahora.join("|")})`);
      lineas.push("");
    }
  }
  if (lineas.length === 4) lineas.push("Sin diferencias.");
  return lineas.join("\n");
}

const V1 = "https://api.mercadopublico.cl/servicios/v1";
const V2 = "https://api2.mercadopublico.cl/v2";
const PAUSA_MS = 2000;
const DETALLES = 3;
let consultas = 0;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Una consulta (más hasta 2 reintentos). Total ≤ 13·3 = 39 < 50. Los errores nunca incluyen la URL: lleva el ticket. */
async function pedir(ruta: string, ticket: string, api: "v1" | "v2"): Promise<unknown> {
  const url = api === "v1" ? `${V1}/${ruta}${ruta.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}` : `${V2}/${ruta}`;
  let ultimo = "";
  for (let intento = 0; intento < 3; intento++) {
    if (consultas) await dormir(PAUSA_MS * (intento + 1));
    consultas++;
    try {
      const res = await fetch(url, { headers: api === "v2" ? { ticket, accept: "application/json" } : { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      const cuerpo = JSON.parse(await res.text()) as Record<string, unknown>;
      const fallo = api === "v1" ? "Codigo" in cuerpo && !("Listado" in cuerpo) && !("listaEmpresas" in cuerpo) : cuerpo.success !== "OK";
      if (res.ok && !fallo) return cuerpo;
      ultimo = `HTTP ${res.status}: ${JSON.stringify(cuerpo.Mensaje ?? cuerpo.errors ?? "").slice(0, 200)}`;
      if (res.status < 500 && res.status !== 429 && !String(cuerpo.Codigo).startsWith("105")) break;
    } catch (e) {
      ultimo = (e as Error).name;
    }
  }
  throw new Error(`${api} ${ruta.split("?")[0]}: ${ultimo}`);
}

// Con --grabar se guardan respuestas reales en `<fixture>.real.json` y desde ahí el contrato compara contra ellas.
// Los tests unitarios siguen usando los fixtures reconstruidos.
const GRABAR = process.argv.includes("--grabar");
const ruta = (fix: string, real: boolean) => new URL(`../test/fixtures/${fix}${real ? ".real" : ""}.json`, import.meta.url);
const fixture = (fix: string) => JSON.parse(readFileSync(existsSync(ruta(fix, true)) ? ruta(fix, true) : ruta(fix, false), "utf8")) as unknown;

// Mismos campos que CAMPOS_PERSONALES_V1 en src/v1/parse.ts: nunca se commitean datos de funcionarios.
const PERSONALES = new Set(["RutUsuario", "CodigoUsuario", "NombreUsuario", "CargoUsuario", "NombreResponsablePago", "EmailResponsablePago", "NombreResponsableContrato", "EmailResponsableContrato", "FonoResponsableContrato", "NombreContacto", "CargoContacto", "FonoContacto", "MailContacto", "contactPoint", "rut_proveedor", "razon_social"]);
// Igual que taparTextoLibre en src/personales.ts.
const CORREO = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const FONO = /(\+?56[\s-]?)?(?<![\d-])[29](?:[\s-]?\d){8}(?![\d-])/g;
function anonimizar(x: unknown): unknown {
  if (typeof x === "string") return x.replace(CORREO, "[oculto]").replace(FONO, "[oculto]");
  if (Array.isArray(x)) return x.slice(0, 3).map(anonimizar);
  if (x === null || typeof x !== "object") return x;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, PERSONALES.has(k) && v ? "[oculto]" : anonimizar(v)]));
}
function grabar(fix: string, respuesta: unknown) {
  const datos = { _fixture: `grabado de la API real el ${new Date().toISOString().slice(0, 10)}`, ...(anonimizar(respuesta) as object) };
  writeFileSync(ruta(fix, true), `${JSON.stringify(datos, null, 2)}\n`);
}

/** "AAAA-MM-DD" de ayer en Santiago → "ddmmaaaa". Ayer: a las 03:00 de Chile las OC de hoy pueden no existir aún. */
function ayer(): string {
  const d = new Date(Date.now() - 864e5).toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
  const [a, m, dd] = d.split("-");
  return `${dd}${m}${a}`;
}

async function contrato(ticket: string) {
  const resultados: { nombre: string; d?: Diferencias; error?: string }[] = [];
  const caso = async (nombre: string, fix: string, pedidos: () => Promise<unknown[]>) => {
    try {
      const real: Forma = new Map();
      const respuestas = await pedidos();
      if (GRABAR && respuestas[0]) grabar(fix, respuestas[0]);
      for (const r of respuestas) forma(r, real);
      resultados.push({ nombre, d: comparar(forma(fixture(fix)), real) });
    } catch (e) {
      resultados.push({ nombre, error: (e as Error).message });
    }
  };
  type Listado = { Listado?: Record<string, unknown>[]; payload?: { items?: Record<string, unknown>[] } };
  const codigos = (r: unknown, k: string) => {
    const l = ((r as Listado).Listado ?? (r as Listado).payload?.items ?? []).slice(0, DETALLES).map((x) => String(x[k]));
    if (!l.length) throw new Error("el listado vino vacío, no hay códigos para pedir detalles");
    return l;
  };

  let lics: unknown;
  await caso("v1 licitaciones activas", "v1/licitaciones-listado", async () => [(lics = await pedir("publico/licitaciones.json?estado=activas", ticket, "v1"))]);
  if (lics) await caso("v1 licitación detalle", "v1/licitacion-detalle", async () => {
    const r = [];
    for (const c of codigos(lics, "CodigoExterno")) r.push(await pedir(`publico/licitaciones.json?codigo=${encodeURIComponent(c)}`, ticket, "v1"));
    return r;
  });
  let ocs: unknown;
  await caso("v1 órdenes del día", "v1/ordenes-listado", async () => [(ocs = await pedir(`publico/ordenesdecompra.json?fecha=${ayer()}`, ticket, "v1"))]);
  if (ocs) await caso("v1 OC detalle", "v1/oc-detalle", async () => {
    const r = [];
    for (const c of codigos(ocs, "Codigo")) r.push(await pedir(`publico/ordenesdecompra.json?codigo=${encodeURIComponent(c)}`, ticket, "v1"));
    return r;
  });
  // No hay fixture de BuscarComprador: comparte forma con BuscarProveedor ({listaEmpresas: [{CodigoEmpresa, NombreEmpresa}]}).
  await caso("v1 BuscarComprador", "v1/empresas-proveedor", async () => [await pedir("Publico/Empresas/BuscarComprador", ticket, "v1")]);
  let cas: unknown;
  await caso("v2 Compra Ágil listado", "v2/listado-p1", async () => [(cas = await pedir("compra-agil?numero_pagina=1&tamano_pagina=10", ticket, "v2"))]);
  if (cas) await caso("v2 Compra Ágil detalle", "v2/detalle", async () => {
    const r = [];
    for (const c of codigos(cas, "codigo")) r.push(await pedir(`compra-agil/${encodeURIComponent(c)}`, ticket, "v2"));
    return r;
  });
  return resultados;
}

const directo = (() => {
  try {
    return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

/**
 * Suma las consultas al mismo archivo de cuota que usa la CLI (~/.mercadopublico/cuota.json), para que la cuenta del día
 * sea una. Igual que la CLI: suma a lo que hay ahora y escribe atómico (tmp + rename), sin lock (ver guardarCuota en src/cli.ts).
 */
function sumarCuota(n: number) {
  try {
    const ruta = join(process.env.MERCADOPUBLICO_HOME ?? join(homedir(), ".mercadopublico"), "cuota.json");
    const dia = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
    const previa = existsSync(ruta) ? (JSON.parse(readFileSync(ruta, "utf8")) as { dia?: string; usadas?: number }) : {};
    mkdirSync(join(ruta, ".."), { recursive: true });
    const tmp = `${ruta}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ dia, usadas: (previa.dia === dia ? (previa.usadas ?? 0) : 0) + n }));
    renameSync(tmp, ruta);
  } catch {
    // sin cuenta persistente no se rompe el contrato
  }
}

if (directo) {
  try {
    process.loadEnvFile(); // .env local; en CI viene del secreto
  } catch {}
  const ticket = process.env.MP_TICKET;
  if (!ticket) {
    console.error("Falta MP_TICKET");
    process.exit(2);
  }
  const resultados = await contrato(ticket);
  sumarCuota(consultas);
  console.log(reporte(resultados));
  console.log(`\n_${consultas} consultas._`);
  process.exitCode = resultados.some((r) => r.error || r.d!.agregados.length || r.d!.eliminados.length || r.d!.cambiados.length) ? 1 : 0;
}
