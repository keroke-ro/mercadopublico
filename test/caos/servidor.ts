// Servidor falso para pruebas de caos: v1, v2, mindicador, Banco Central, paridad y OCDS sobre sockets reales
// (127.0.0.1:0), con datos deterministas armados con los fixtures reales y un plan de fallas por ruta y número de pedido.
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { Evento } from "../../src/eventos.js";
import { MercadoPublico, type OpcionesMercadoPublico } from "../../src/index.js";

export type Ruta = "lic" | "oc" | "empresas" | "v2" | "v2det" | "mindicador" | "bcentral" | "paridad" | "ocds" | "otra";
type Api = "v1" | "v2" | "otra";
const API: Record<Ruta, Api> = { lic: "v1", oc: "v1", empresas: "v1", v2: "v2", v2det: "v2", mindicador: "otra", bcentral: "otra", paridad: "otra", ocds: "otra", otra: "otra" };

/** Cómo responder. Lo que no se indique sale de los datos normales de la ruta. */
export interface Respuesta {
  status?: number;
  /** string o Buffer tal cual; cualquier otra cosa va como JSON. */
  cuerpo?: unknown;
  headers?: Record<string, string>;
  /** Espera antes de mandar los headers. */
  demoraMs?: number;
  /** Headers de inmediato y el cuerpo en trozos de `trozo` bytes con `pausaMs` entre cada uno. */
  goteo?: { trozo: number; pausaMs: number };
  /** Manda solo estos bytes del cuerpo (con el content-length completo) y destruye el socket. */
  cortarEn?: number;
  /** Con `cortarEn`: termina limpio, sin content-length (el cliente no puede saber que faltó algo). */
  limpio?: boolean;
  /** Nunca responde; el socket queda abierto hasta que el cliente se vaya. */
  colgar?: boolean;
  /** Comprime: "header" manda content-encoding gzip; "crudo" manda los bytes gzip sin avisar. */
  gzip?: "header" | "crudo";
}

export interface Llegada {
  ruta: Ruta;
  /** Número de pedido a esa ruta, desde 1. */
  n: number;
  url: URL;
  /** performance.now() al llegar. */
  t: number;
  headers: IncomingHttpHeaders;
  /** El cliente cerró el socket antes de que terminara la respuesta. */
  cerrada: boolean;
}

export type Falla = Respuesta | ((l: Llegada) => Respuesta | undefined);

// ── Datos ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const fx = (r: string) => JSON.parse(readFileSync(new URL(`../fixtures/${r}`, import.meta.url), "utf8"));
const LIC_DET = fx("v1/licitacion-detalle.real.json").Listado[0];
const OC_DET = fx("v1/oc-detalle.real.json").Listado[0];
const LIC_ACTIVAS = fx("v1/licitaciones-listado.real.json");
const EMPRESAS = fx("v1/empresas-proveedor.real.json");
const CA_ITEM = fx("v2/listado-p1.json").payload.items[0];
const CA_DET = fx("v2/detalle.json").payload;
const OCDS_CM = JSON.parse(readFileSync(new URL("../fixtures/ocds/release-cm.json", import.meta.url), "utf8"));

/** Día ("ddmmaaaa") → código → CodigoEstado. */
export const LIC: Record<string, Record<string, number>> = {
  "01102026": { "1000-1-LE26": 5, "1000-2-LE26": 5, "1000-3-LE26": 6 },
  "02102026": { "1000-4-LE26": 5, "1000-5-LE26": 5 },
  "03102026": { "1000-6-LE26": 5 },
};
export const OC: Record<string, Record<string, number>> = {
  "01102026": { "2000-1-SE26": 4, "2000-2-SE26": 4 },
  "02102026": { "2000-3-SE26": 4 },
  "03102026": {},
};
/** Licitaciones en otra moneda: código → [Moneda, MontoEstimado]. Se publican el 2026-10-06 (fixture real). */
export const MONEDA: Record<string, [string, number]> = { "1000-7-LE26": ["UF", 100], "1000-8-LE26": ["USD", 10], "1000-9-LE26": ["EUR", 10] };
/** Compra Ágil: código → fecha_ultimo_cambio, ya en orden descendente como la API. */
export const CA: Record<string, string> = {
  "3000-3-COT26": "2026-10-03T10:00:00Z",
  "3000-2-COT26": "2026-10-02T10:00:00Z",
  "3000-1-COT26": "2026-10-01T10:00:00Z",
};
/** Valor fijo por indicador, igual todos los días. */
export const VALOR = { uf: 39_000, dolar: 950, euro: 1_100, utm: 69_000 };
/** Líneas OCDS: `OCDS_VALIDAS` releases y estas malas intercaladas. */
export const OCDS_VALIDAS = 60;
export const OCDS_MALAS = ["{roto", "esto no es json"];

const v1 = (Listado: unknown[]) => ({ Cantidad: Listado.length, FechaCreacion: "2026-10-13T12:00:00", Version: "v1", Listado });
const v2 = (payload: unknown) => ({ success: "OK", trace: null, errors: null, payload });

function detalleLic(codigo: string, estado: number) {
  const [m, v] = MONEDA[codigo] ?? [LIC_DET.Moneda, LIC_DET.MontoEstimado];
  return { ...LIC_DET, CodigoExterno: codigo, CodigoEstado: estado, Moneda: m, MontoEstimado: v };
}

const buscar = (t: Record<string, Record<string, number>>, c: string) => Object.values(t).find((d) => c in d)?.[c];

function v1Listado(u: URL, tabla: Record<string, Record<string, number>>, det: (c: string, e: number) => unknown, campo: string) {
  const codigo = u.searchParams.get("codigo");
  if (codigo) {
    const e = buscar(tabla, codigo) ?? (MONEDA[codigo] ? 5 : undefined);
    return e === undefined ? v1([]) : v1([det(codigo, e)]);
  }
  const fecha = u.searchParams.get("fecha");
  if (!fecha) return { ...LIC_ACTIVAS, _fixture: undefined };
  return v1(Object.entries(tabla[fecha] ?? {}).map(([c, e]) => ({ [campo]: c, Nombre: `Proceso ${c}`, CodigoEstado: e })));
}

const caItem = (codigo: string) => ({ ...CA_ITEM, codigo, fechas: { ...CA_ITEM.fechas, fecha_ultimo_cambio: CA[codigo] } });

function v2Listado(u: URL) {
  const tam = Number(u.searchParams.get("tamano_pagina") ?? 50);
  const n = Number(u.searchParams.get("numero_pagina") ?? 1);
  const desde = Date.parse(u.searchParams.get("cambio_desde") ?? "2000-01-01");
  const todos = Object.keys(CA).filter((c) => Date.parse(CA[c]!) >= desde);
  const paginacion = { numero_pagina: n, total_paginas: Math.ceil(todos.length / tam), tamano_pagina: tam, total_resultados: todos.length };
  return v2({ items: todos.slice(tam * (n - 1), tam * n).map(caItem), paginacion });
}

const MESES_BC = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const GCODE: Record<string, number> = { UF: VALOR.uf, PRE_TCO: VALOR.dolar, PRE_EUR: VALOR.euro, PRE_UTM: VALOR.utm };
const pesos = (v: number) => `${v.toLocaleString("de-DE")},00`;

/** Tabla "Ver serie" con la forma real de si3.bcentral.cl (ver test/monto.test.ts). La UTM: una fila por año. */
export function paginaBancoCentral(gcode: string, conTabla = true): string {
  const v = GCODE[gcode] ?? 0;
  const claves = gcode === "PRE_UTM" ? ["2026"] : Array.from({ length: 31 }, (_, i) => String(i + 1));
  const filas = claves.map(
    (c, i) => `<tr class="GridNormal"><td align="center">${c}</td>${MESES_BC.map((m) => `<td align="center"><span id="gr_ctl${String(i + 2).padStart(2, "0")}_${m}" class="obs">${pesos(v)}</span></td>`).join("")}</tr>`,
  );
  const tabla = conTabla ? `<table id="gr"><tr><th scope="col">Día</th></tr>${filas.join("\n")}</table>` : "<p>Sin datos</p>";
  return `<html><select name="DrDwnFechas"><option selected="selected" value="2026">2026</option></select>${tabla}</html>`;
}

/** Releases OCDS válidas (la OC CM real con otro código) y, cada 20, una línea mala. */
export function lineasOcds(): string[] {
  const l: string[] = [];
  for (let i = 1; i <= OCDS_VALIDAS; i++) {
    const codigo = `9000-${i}-CM26`;
    l.push(JSON.stringify({ ...OCDS_CM, id: `ocds-70d2nz-${codigo}-x`, ocid: `ocds-70d2nz-${codigo}`, tender: { ...OCDS_CM.tender, id: codigo } }));
    if (i % 20 === 0 && OCDS_MALAS[i / 20 - 1]) l.push(OCDS_MALAS[i / 20 - 1]!);
  }
  return l;
}
export const OCDS_GZ = gzipSync(lineasOcds().join("\n") + "\n");

const json = (cuerpo: unknown, status = 200): Respuesta => ({ status, cuerpo, headers: { "content-type": "application/json; charset=utf-8" } });
const html = (cuerpo: string, status = 200): Respuesta => ({ status, cuerpo, headers: { "content-type": "text/html; charset=utf-8" } });

function rutaDe(p: string): Ruta {
  if (p.endsWith("/licitaciones.json")) return "lic";
  if (p.endsWith("/ordenesdecompra.json")) return "oc";
  if (p.includes("/Publico/Empresas/")) return "empresas";
  if (p === "/v2/compra-agil") return "v2";
  if (p.startsWith("/v2/compra-agil/")) return "v2det";
  if (p.startsWith("/mindicador/")) return "mindicador";
  if (p.startsWith("/bcentral/")) return "bcentral";
  if (p === "/paridad.csv") return "paridad";
  if (p.startsWith("/ocds/")) return "ocds";
  return "otra";
}

function normal(ruta: Ruta, u: URL): Respuesta {
  switch (ruta) {
    case "lic":
      return json(v1Listado(u, LIC, detalleLic, "CodigoExterno"));
    case "oc":
      return json(v1Listado(u, OC, (c, e) => ({ ...OC_DET, Codigo: c, CodigoEstado: e }), "Codigo"));
    case "empresas":
      return json({ ...EMPRESAS, _fixture: undefined });
    case "v2":
      return json(v2Listado(u));
    case "v2det": {
      const c = decodeURIComponent(u.pathname.split("/").pop()!);
      if (!CA[c]) return json({ success: "NOK", trace: null, payload: null, errors: [{ codigo: "404", mensaje: "No existe", detalle: null }] }, 404);
      return json(v2({ ...CA_DET, codigo: c, fechas: { ...CA_DET.fechas, fecha_ultimo_cambio: CA[c] } }));
    }
    case "mindicador": {
      const [, , ind, anio] = u.pathname.split("/");
      const v = VALOR[ind as keyof typeof VALOR];
      if (!v || !anio) return json({ error: "no existe" }, 404);
      const serie = [];
      for (let t = Date.parse(`${anio}-01-01T03:00:00Z`); t < Date.parse(`${Number(anio) + 1}-01-01T03:00:00Z`); t += 86_400_000) {
        serie.push({ fecha: new Date(t).toISOString(), valor: v });
      }
      return json({ version: "1", codigo: ind, serie: serie.reverse() });
    }
    case "bcentral":
      if (u.pathname.endsWith("Indicadoresdiarios.aspx")) {
        return html(Object.keys(GCODE).map((g) => `<a href="Serie.aspx?gcode=${g}&amp;param=p${g}">${g}</a>`).join(""));
      }
      return html(paginaBancoCentral(u.searchParams.get("gcode") ?? ""));
    case "paridad": {
      const filas = Object.entries({ UF: VALOR.uf, USD: VALOR.dolar, EUR: VALOR.euro, UTM: VALOR.utm }).map(([m, v]) => `2026;10;${m};0;${String(v + 0.5).replace(".", ",")}`);
      return { status: 200, cuerpo: ["Anio;Mes;Moneda;Otra;VMCLP", ...filas].join("\r\n"), headers: { "content-type": "text/csv" } };
    }
    case "ocds":
      return { status: 200, cuerpo: OCDS_GZ, headers: { "content-type": "application/gzip" } };
    default:
      return html("<h1>404</h1>", 404);
  }
}

// ── Servidor ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Servidor {
  url: string;
  /** Bases para `MercadoPublico`/`Transporte`. */
  baseV1: string;
  baseV2: string;
  urlMindicador: string;
  urlBancoCentral: string;
  urlParidad: string;
  urlOcds: string;
  llegadas: Llegada[];
  /** Máximo de pedidos en curso a la vez, por API. */
  maxEnVuelo: Record<Api, number>;
  /** Las próximas llegadas a `ruta` reciben estas fallas, en orden (`undefined` = respuesta normal). */
  fallar(ruta: Ruta, ...fallas: (Falla | undefined)[]): void;
  /** Todas las llegadas a `ruta` reciben esto, después del plan (`undefined` lo quita). */
  siempre(ruta: Ruta, falla: Falla | undefined): void;
  /** Resuelve con la llegada n° `n` a `ruta` (ya ocurrida o futura). */
  llegada(ruta: Ruta, n?: number): Promise<Llegada>;
  de(ruta: Ruta): Llegada[];
  /** Resuelve cuando el cliente cerró el socket de esa llegada. */
  cerrada(l: Llegada): Promise<void>;
  reiniciar(): void;
  cerrar(): Promise<void>;
}

export async function levantar(): Promise<Servidor> {
  const plan = new Map<Ruta, (Falla | undefined)[]>();
  const fijas = new Map<Ruta, Falla>();
  const cuenta = new Map<Ruta, number>();
  const enVuelo: Record<Api, number> = { v1: 0, v2: 0, otra: 0 };
  const maxEnVuelo: Record<Api, number> = { v1: 0, v2: 0, otra: 0 };
  let llegadas: Llegada[] = [];
  let esperando: (() => void)[] = [];
  const avisar = () => {
    const e = esperando;
    esperando = [];
    for (const f of e) f();
  };
  const hasta = <T>(ver: () => T | undefined) =>
    new Promise<T>((ok) => {
      const probar = () => {
        const x = ver();
        if (x !== undefined) ok(x);
        else esperando.push(probar);
      };
      probar();
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ruta = rutaDe(url.pathname);
    const n = (cuenta.get(ruta) ?? 0) + 1;
    cuenta.set(ruta, n);
    const l: Llegada = { ruta, n, url, t: performance.now(), headers: req.headers, cerrada: false };
    llegadas.push(l);
    const api = API[ruta];
    maxEnVuelo[api] = Math.max(maxEnVuelo[api], ++enVuelo[api]);
    let listo = false;
    let cortada = false;
    const terminar = () => {
      if (!listo) (listo = true), enVuelo[api]--;
    };
    res.on("close", () => {
      if (!res.writableFinished && !cortada) l.cerrada = true;
      terminar();
      avisar();
    });
    avisar();
    const q = plan.get(ruta);
    const f = q?.length ? q.shift() : fijas.get(ruta);
    const r = { ...normal(ruta, url), ...(typeof f === "function" ? f(l) : f) };
    await responder(res, r, terminar, () => (cortada = true));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    baseV1: `${url}/servicios/v1/publico`,
    baseV2: `${url}/v2`,
    urlMindicador: `${url}/mindicador`,
    urlBancoCentral: `${url}/bcentral/`,
    urlParidad: `${url}/paridad.csv`,
    urlOcds: `${url}/ocds/2026.jsonl.gz`,
    get llegadas() {
      return llegadas;
    },
    maxEnVuelo,
    fallar: (ruta, ...fallas) => void plan.set(ruta, [...(plan.get(ruta) ?? []), ...fallas]),
    siempre: (ruta, falla) => void (falla ? fijas.set(ruta, falla) : fijas.delete(ruta)),
    llegada: (ruta, n = 1) => hasta(() => llegadas.find((l) => l.ruta === ruta && l.n === n)),
    de: (ruta) => llegadas.filter((l) => l.ruta === ruta),
    cerrada: (l) => hasta(() => (l.cerrada ? (true as const) : undefined)).then(() => {}),
    reiniciar() {
      plan.clear();
      fijas.clear();
      cuenta.clear();
      llegadas = [];
      for (const k of Object.keys(maxEnVuelo) as Api[]) maxEnVuelo[k] = enVuelo[k];
    },
    cerrar: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

/** Espera `ms` o hasta que se cierre la respuesta, sin dejar timers colgando. */
const dormir = (res: ServerResponse, ms: number) =>
  new Promise<void>((ok) => {
    const fin = () => (clearTimeout(t), res.off("close", fin), ok());
    const t = setTimeout(fin, ms);
    res.once("close", fin);
  });

async function responder(res: ServerResponse, r: Respuesta, terminar: () => void, cortar: () => void) {
  if (r.colgar) return;
  if (r.demoraMs) await dormir(res, r.demoraMs);
  if (res.destroyed) return;
  let cuerpo = Buffer.isBuffer(r.cuerpo) ? r.cuerpo : Buffer.from(typeof r.cuerpo === "string" ? r.cuerpo : r.cuerpo === undefined ? "" : JSON.stringify(r.cuerpo));
  const headers: Record<string, string> = { ...r.headers };
  if (r.gzip) {
    cuerpo = gzipSync(cuerpo);
    if (r.gzip === "header") headers["content-encoding"] = "gzip";
  }
  if (!(r.cortarEn !== undefined && r.limpio)) headers["content-length"] = String(cuerpo.length);
  res.writeHead(r.status ?? 200, headers);
  if (r.cortarEn !== undefined) {
    cortar();
    const parte = cuerpo.subarray(0, r.cortarEn);
    if (r.limpio) return terminar(), void res.end(parte);
    res.write(parte, () => setTimeout(() => res.socket?.destroy(), 5));
    return;
  }
  if (r.goteo) {
    res.flushHeaders();
    for (let i = 0; i < cuerpo.length; i += r.goteo.trozo) {
      if (res.destroyed) return;
      res.write(cuerpo.subarray(i, i + r.goteo.trozo));
      await dormir(res, r.goteo.pausaMs);
    }
    if (res.destroyed) return;
  }
  terminar();
  res.end(r.goteo ? undefined : cuerpo);
}

// ── Ayudas para los tests ─────────────────────────────────────────────────────────────────────────────────────────
export const TICKET = "TICKET-CAOS-0000-SECRETO";

/** Cliente apuntado al servidor: sin pausa, backoff de 1 ms, timeout corto y sin conversión de montos. */
export function cliente(srv: Servidor, extra: Partial<OpcionesMercadoPublico> = {}) {
  const eventos: Evento[] = [];
  const mp = new MercadoPublico({
    ticket: TICKET,
    baseV1: srv.baseV1,
    baseV2: srv.baseV2,
    intervaloMs: 0,
    esperaBaseMs: 1,
    timeoutMs: 300,
    conversor: false,
    alEvento: (e) => void eventos.push(e),
    ...extra,
  });
  const de = <T extends Evento["tipo"]>(tipo: T) => eventos.filter((e): e is Extract<Evento, { tipo: T }> => e.tipo === tipo);
  return { mp, eventos, de };
}

/** Todo lo que el SDK deja ver (eventos, errores con su cadena de causas, textos) sin el ticket. */
export function sinTicket(...cosas: unknown[]): boolean {
  const vistos = new Set<unknown>();
  const texto = (x: unknown): string => {
    if (x === null || typeof x !== "object" || vistos.has(x)) return String(x);
    vistos.add(x);
    if (x instanceof Error) return `${x.message} ${x.stack} ${JSON.stringify(x)} ${texto(x.cause)}`;
    return JSON.stringify(x);
  };
  return cosas.every((c) => !texto(c).includes(TICKET));
}

/** Rechazos sin manejar durante el archivo; afterAll debe verlo vacío. */
export function vigilarRechazos(): unknown[] {
  const sueltos: unknown[] = [];
  process.on("unhandledRejection", (e) => void sueltos.push(e));
  return sueltos;
}

/** Rechaza (o resuelve) y mide cuánto tardó. */
export async function medir<T>(p: Promise<T>): Promise<{ ms: number; valor?: T; error?: unknown }> {
  const t0 = performance.now();
  try {
    const valor = await p;
    return { ms: performance.now() - t0, valor };
  } catch (error) {
    return { ms: performance.now() - t0, error };
  }
}
