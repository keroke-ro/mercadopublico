#!/usr/bin/env node
// CLI: `npx mercadopublico <comando>`. Salida json, csv o tabla; datos personales ocultos salvo --incluir-personales.
import { createReadStream, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { diaSantiago } from "./fecha.js";
import {
  Cuota,
  MercadoPublico,
  MercadoPublicoError,
  conversorEncadenado,
  conversorBancoCentral,
  conversorMindicador,
  conversorParidadChileCompra,
  leerOcds,
  ocultarPersonales,
  storeArchivo,
  urlOcds,
  type EstadoCuota,
  type Proceso,
} from "./index.js";
import type { FuenteSync } from "./sync.js";
import { ESTADOS_FILTRO_LICITACION, ESTADO_FILTRO_OC, type EstadoFiltroLicitacion, type EstadoFiltroOC } from "./v1/codigos.js";
import type { EstadoCompraAgil } from "./v2/parse.js";

export interface Salida {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface IO {
  stdout: Salida;
  stderr: Salida;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

const AYUDA = `Uso: mercadopublico <comando> [opciones]

Comandos:
  licitacion <codigo>                 Detalle de una licitación
  licitaciones                        Activas, o filtradas con --dia --estado --organismo --proveedor
  oc <codigo>                         Detalle de una orden de compra
  ordenes                             Del día, o filtradas con --dia --estado --organismo --proveedor
  compra-agil [<codigo>]              Detalle, o listado con --region 13,5 --estado publicada --q texto --desde ISO --max N (100)
  proveedor <rut>                     Código de empresa de un proveedor
  compradores                         Todos los organismos compradores
  ocds <archivo|url|año> [--max N]    Lee OCDS (.jsonl o .jsonl.gz); no pide ticket
  sync --desde AAAA-MM-DD             Actualiza un store local [--hasta] [--fuentes licitaciones,ordenes,compra_agil] [--store ./mp.json] [--plan]
  cuota                               Consultas usadas hoy desde esta máquina

Opciones:
  --formato json|csv|tabla            Por defecto tabla en terminal y json si no
  --ticket T                          Por defecto la variable MP_TICKET
  --incluir-personales                No ocultar datos personales de funcionarios
  --sin-conversion                    No convertir montos a pesos
  -h, --ayuda
`;

class ErrorUso extends Error {}

const OPCIONES = {
  formato: { type: "string" },
  ticket: { type: "string" },
  "incluir-personales": { type: "boolean" },
  "sin-conversion": { type: "boolean" },
  ayuda: { type: "boolean", short: "h" },
  dia: { type: "string" },
  estado: { type: "string" },
  organismo: { type: "string" },
  proveedor: { type: "string" },
  region: { type: "string" },
  q: { type: "string" },
  desde: { type: "string" },
  hasta: { type: "string" },
  max: { type: "string" },
  fuentes: { type: "string" },
  store: { type: "string" },
  plan: { type: "boolean" },
} as const;

const COLUMNAS = [
  "tipo",
  "codigo",
  "nombre",
  "estado",
  "comprador.nombreOrganismo",
  "comprador.region",
  "fechas.publicacion",
  "fechas.cierre",
  "monto.valor",
  "monto.moneda",
  "monto.clp",
];

type Fila = Record<string, unknown>;

const esProceso = (x: unknown): x is Proceso =>
  !!x && typeof x === "object" && ["licitacion", "orden_compra", "compra_agil"].includes((x as Fila).tipo as string);

const lista = (s: string | undefined) => s?.split(",").map((x) => x.trim()).filter(Boolean);

function dia(s: string | undefined, flag: string): string | undefined {
  if (s !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErrorUso(`--${flag} debe ser AAAA-MM-DD`);
  return s;
}

function entero(s: string | undefined, defecto: number, flag: string): number {
  if (s === undefined) return defecto;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new ErrorUso(`--${flag} debe ser un entero positivo`);
  return n;
}

function uno<T extends string>(valor: string | undefined, validos: readonly string[], flag: string): T | undefined {
  if (valor !== undefined && !validos.includes(valor)) throw new ErrorUso(`--${flag} debe ser uno de: ${validos.join(", ")}`);
  return valor as T | undefined;
}

async function tomar<T>(it: AsyncIterable<T>, max: number): Promise<T[]> {
  const r: T[] = [];
  if (max <= 0) return r;
  for await (const x of it) if (r.push(x) >= max) break;
  return r;
}

function valor(f: Fila, ruta: string): unknown {
  return ruta.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Fila)[k] : undefined), f);
}

function celdas(filas: Fila[]): { cols: string[]; rows: string[][] } {
  const cols = filas.every(esProceso) && filas.length ? COLUMNAS : [...new Set(filas.flatMap((f) => Object.keys(f)))];
  const texto = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return { cols, rows: filas.map((f) => cols.map((c) => texto(valor(f, c)))) };
}

export function csv(filas: Fila[]): string {
  const { cols, rows } = celdas(filas);
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [cols, ...rows].map((r) => r.map(q).join(",") + "\r\n").join("");
}

export function tabla(filas: Fila[], ancho: number): string {
  const { cols, rows } = celdas(filas);
  const todas = [cols.map((c) => c.split(".").pop()!), ...rows].map((r) => r.map((s) => s.replace(/\s+/g, " ")));
  const w = cols.map((_, i) => Math.max(...todas.map((r) => r[i]!.length)));
  // Achica la columna más ancha hasta que quepa (2 espacios entre columnas).
  while (w.reduce((a, b) => a + b, 0) + 2 * (w.length - 1) > ancho) {
    const i = w.indexOf(Math.max(...w));
    if (w[i]! <= 4) break;
    w[i]!--;
  }
  const corta = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  return todas.map((r) => r.map((s, i) => corta(s, w[i]!)).join("  ").trimEnd() + "\n").join("");
}

function escribir(io: IO, datos: unknown, formato: string) {
  if (formato === "json") return io.stdout.write(`${JSON.stringify(datos, null, 2)}\n`);
  const filas = (Array.isArray(datos) ? datos : [datos]) as Fila[];
  io.stdout.write(formato === "csv" ? csv(filas) : tabla(filas, io.stdout.columns ?? 120));
}

const archivoCuota = (env: IO["env"]) => join(env.MERCADOPUBLICO_HOME ?? join(homedir(), ".mercadopublico"), "cuota.json");

async function leerCuota(env: IO["env"]): Promise<EstadoCuota | undefined> {
  try {
    const c = JSON.parse(await readFile(archivoCuota(env), "utf8")) as EstadoCuota;
    return typeof c.dia === "string" && Number.isInteger(c.usadas) ? { dia: c.dia, usadas: c.usadas } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Suma lo gastado por este proceso a lo que haya en el archivo ahora (no lo que había al empezar), así dos CLI o la
 * CLI y scripts/contrato.ts no se pisan la cuenta. Escritura atómica (tmp + rename) para no dejar un JSON a medias.
 * Se llama después de cada consulta (con 1 s entre consultas, el costo no se nota) y al terminar: devuelve la nueva
 * base, así lo ya guardado no se suma dos veces y un `kill -9` pierde a lo más la consulta en vuelo.
 * ponytail: sin lock; dos procesos que terminan en el mismo milisegundo pueden perder lo de uno. Lock con `wx` si importa.
 */
async function guardarCuota(env: IO["env"], c: Cuota, inicial: EstadoCuota | undefined): Promise<EstadoCuota | undefined> {
  const ruta = archivoCuota(env);
  const { dia, usadas } = c.toJSON();
  const delta = usadas - (inicial?.dia === dia ? inicial.usadas : 0);
  if (delta <= 0) return inicial;
  try {
    await mkdir(dirname(ruta), { recursive: true });
    const ahora = await leerCuota(env);
    const base = Math.max(ahora?.dia === dia ? ahora.usadas : 0, inicial?.dia === dia ? inicial.usadas : 0);
    const tmp = `${ruta}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ dia, usadas: base + delta }));
    await rename(tmp, ruta);
    return { dia, usadas };
  } catch {
    return inicial; // Sin cuenta persistente no se rompe el comando; se reintenta en el próximo guardado.
  }
}


export async function main(argv: string[], io: IO): Promise<number> {
  let mp: MercadoPublico | undefined;
  let guardada: EstadoCuota | undefined;
  let persistir: () => Promise<unknown> = async () => {};
  try {
    const { values: o, positionals } = parseArgs({ args: argv, options: OPCIONES, allowPositionals: true });
    const [comando, arg, ...sobra] = positionals;
    if (o.ayuda) return io.stdout.write(AYUDA), 0;
    if (!comando) throw new ErrorUso("Falta el comando");
    if (sobra.length) throw new ErrorUso(`Sobran argumentos: ${sobra.join(" ")}`);
    const formato = o.formato ?? (io.stdout.isTTY ? "tabla" : "json");
    uno(formato, ["json", "csv", "tabla"], "formato");
    const falta = (que: string) => {
      if (!arg) throw new ErrorUso(`Falta ${que}`);
      return arg;
    };
    const salir = (datos: unknown) => {
      const tapar = (x: unknown) => (esProceso(x) && !o["incluir-personales"] ? ocultarPersonales(x) : x);
      escribir(io, Array.isArray(datos) ? datos.map(tapar) : tapar(datos), formato);
      return 0;
    };
    const noExiste = (que: string): never => {
      throw new MercadoPublicoError("no_encontrado", `No existe ${que} ${arg}`);
    };

    if (comando === "ocds") {
      const fuente = falta("el archivo, la URL o el año");
      const entrada = /^(\d{4}|full)$/.test(fuente)
        ? urlOcds(fuente === "full" ? "full" : Number(fuente))
        : /^https?:\/\//.test(fuente)
          ? fuente
          : (Readable.toWeb(createReadStream(fuente)) as ReadableStream<Uint8Array>);
      let malas = 0;
      const max = entero(o.max, 100, "max");
      const ps: Proceso[] = [];
      let corte: unknown;
      // Si la descarga se corta a mitad de camino se entrega lo leído y se avisa, en vez de perderlo todo.
      try {
        if (max > 0) for await (const p of leerOcds(entrada, { fetch: io.fetch, alError: () => malas++ })) if (ps.push(p) >= max) break;
      } catch (e) {
        corte = e;
      }
      if (malas) io.stderr.write(`${malas} líneas no se pudieron leer\n`);
      salir(ps);
      if (corte) throw new Error(`La lectura OCDS se cortó después de ${ps.length} procesos (${(corte as Error).message ?? corte}); lo leído quedó en la salida`);
      return 0;
    }

    guardada = await leerCuota(io.env);
    if (comando === "cuota") return salir(new Cuota(undefined, guardada).toJSON());

    const ticket = o.ticket ?? io.env.MP_TICKET;
    if (!ticket) throw new ErrorUso("Falta el ticket: usa --ticket o la variable de entorno MP_TICKET");
    const f = io.fetch;
    let base = guardada;
    let guardando: Promise<unknown> = Promise.resolve();
    persistir = () => (guardando = guardando.then(async () => mp && (base = await guardarCuota(io.env, mp.cuota, base))));
    mp = new MercadoPublico({
      ticket,
      fetch: f,
      alEvento: (e) => {
        if (e.tipo === "consulta") void persistir();
      },
      cuota: guardada && { ...guardada }, // copia: Cuota la modifica y aquí hace falta la de partida
      conversor: o["sin-conversion"] ? false : f && conversorEncadenado(conversorMindicador({ fetch: f }), conversorBancoCentral({ fetch: f }), conversorParidadChileCompra({ fetch: f })),
    });

    const d = dia(o.dia, "dia");
    const filtrosV1 = <E extends string>(api: {
      porOrganismo(c: string, x: { dia: string }): Promise<Proceso[]>;
      porProveedor(c: string, x: { dia: string }): Promise<Proceso[]>;
      porEstado(e: E, x: { dia?: string }): Promise<Proceso[]>;
      delDia(dia: string): Promise<Proceso[]>;
    }, estado: E | undefined, sinFiltros: () => Promise<Proceso[]>) => {
      if (estado && (o.organismo || o.proveedor)) throw new ErrorUso("--estado no se combina con --organismo ni --proveedor");
      if (o.organismo) return api.porOrganismo(o.organismo, { dia: d ?? diaSantiago() });
      if (o.proveedor) return api.porProveedor(o.proveedor, { dia: d ?? diaSantiago() });
      if (estado) return api.porEstado(estado, { dia: d });
      return d ? api.delDia(d) : sinFiltros();
    };

    switch (comando) {
      case "licitacion":
        return salir((await mp.licitaciones.porCodigo(falta("el código"))) ?? noExiste("la licitación"));
      case "licitaciones": {
        const e = uno<EstadoFiltroLicitacion>(o.estado, ESTADOS_FILTRO_LICITACION, "estado");
        return salir(await filtrosV1(mp.licitaciones, e, () => mp!.licitaciones.activas()));
      }
      case "oc":
        return salir((await mp.ordenes.porCodigo(falta("el código"))) ?? noExiste("la orden de compra"));
      case "ordenes": {
        const e = uno<EstadoFiltroOC>(o.estado, Object.keys(ESTADO_FILTRO_OC), "estado");
        return salir(await filtrosV1(mp.ordenes, e, () => mp!.ordenes.porEstado("todos")));
      }
      case "compra-agil": {
        if (arg) return salir((await mp.compraAgil.detalle(arg)) ?? noExiste("la Compra Ágil"));
        const max = entero(o.max, 100, "max");
        const region = lista(o.region)?.map(Number);
        const filtros = { region, estado: lista(o.estado) as EstadoCompraAgil[] | undefined, q: o.q, publicadoDesde: o.desde, tamanoPagina: Math.min(50, Math.max(10, max)) };
        return salir(await tomar(mp.compraAgil.listar(filtros), max));
      }
      case "proveedor":
        return salir((await mp.empresas.buscarProveedor(falta("el RUT"))) ?? noExiste("el proveedor con RUT"));
      case "compradores":
        return salir(await mp.empresas.buscarComprador());
      case "sync": {
        if (!o.desde) throw new ErrorUso("sync necesita --desde AAAA-MM-DD");
        const ruta = o.store ?? "./mp.json";
        const fuentes = lista(o.fuentes)?.map((x) => uno<FuenteSync>(x, ["licitaciones", "ordenes", "compra_agil"], "fuentes")!);
        const store = await storeArchivo(ruta);
        // Ctrl-C cancela ordenado: se guarda lo hecho y la cuota; un segundo Ctrl-C mata como siempre.
        const ac = new AbortController();
        const cancelar = () => (io.stderr.write("\nCancelando: se guarda lo hecho…\n"), ac.abort());
        process.once("SIGINT", cancelar);
        try {
          const opciones = { desde: dia(o.desde, "desde")!, hasta: dia(o.hasta, "hasta"), fuentes, store };
          const plan = await mp.sync.planificar({ ...opciones, signal: ac.signal });
          // Sin `listados`: son procesos crudos (con datos personales) que solo usa ejecutar.
          const { listados: _, ...resumen } = plan;
          const visible = { ...resumen, opciones: { ...opciones, store: ruta } };
          if (o.plan) return salir(formato === "json" ? visible : plan.desglose);
          io.stderr.write(
            `Plan: ~${plan.consultas} consultas (${plan.gastadas} ya gastadas) + ~${plan.margenReintentos ?? 0} de margen por reintentos, quedan ${plan.restante} hoy\n` +
              plan.desglose.map((x) => `  ${x.fuente}: ${x.consultas} (${x.nota})\n`).join(""),
          );
          const resultado = await mp.sync.ejecutar(plan, {
            signal: ac.signal,
            alAvanzar: ({ fuente, hechas, total }) => {
              if (io.stderr.isTTY) io.stderr.write(`\r${fuente} ${hechas}/${total}   `);
              else if (hechas === total) io.stderr.write(`${fuente} ${hechas}/${total}\n`);
            },
          });
          if (io.stderr.isTTY) io.stderr.write("\n");
          salir(resultado);
          return resultado.detenido === "cancelado" ? 130 : 0;
        } finally {
          process.off("SIGINT", cancelar);
          await store.cerrar?.();
        }
      }
      default:
        throw new ErrorUso(`Comando desconocido: ${comando}`);
    }
  } catch (e) {
    const uso = e instanceof ErrorUso || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    io.stderr.write(`mercadopublico: ${String((e as Error).message ?? e).replace(/\s*\n\s*/g, " ")}${uso ? " (ver --ayuda)" : ""}\n`);
    if (io.env.DEBUG) io.stderr.write(`${(e as Error).stack}\n`);
    // Ctrl-C en sync mientras planifica llega como "cancelada": también es 130, igual que durante ejecutar.
    return uso ? 2 : e instanceof MercadoPublicoError && e.tipo === "cancelada" ? 130 : 1;
  } finally {
    if (mp) await persistir();
  }
}

const directo = (() => {
  try {
    return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (directo) {
  // Lee MP_TICKET de un .env en la carpeta actual, si existe; lo que ya está en el entorno manda.
  try {
    process.loadEnvFile();
  } catch {}
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env });
}
