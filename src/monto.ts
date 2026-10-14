// Montos a pesos con el valor del día del documento, nunca el de hoy. Ver docs/api-notes.md §6.
import { diaSantiago, sumarDias } from "./fecha.js";
import type { Moneda, Monto, Proceso } from "./modelo.js";
import { moneda as aMoneda, num } from "./util.js";

export interface Paridad {
  /** Pesos por 1 unidad de la moneda. */
  valor: number;
  /** Día ("AAAA-MM-DD") cuyo valor se usó; puede ser anterior al pedido. */
  fechaValor: string;
  fuente: string;
}

/** Pesos por 1 unidad de `moneda` el día `dia` ("AAAA-MM-DD"); null si no se sabe. No debe lanzar. */
export type Conversor = (moneda: Exclude<Moneda, "CLP">, dia: string) => Promise<Paridad | null>;

export interface OpcionesConversor {
  fetch?: typeof fetch;
  /** Por defecto 10000. */
  timeoutMs?: number;
  url?: string;
}

async function descargar(o: OpcionesConversor, url: string, init: RequestInit = {}): Promise<{ texto: string; cookie: string } | null> {
  try {
    const res = await (o.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    if (!res.ok) return null;
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    return { texto: await res.text(), cookie };
  } catch {
    return null;
  }
}

/** Tras una descarga fallida se espera esto antes de reintentar, para no pagar un timeout por monto con el servicio caído. */
const REINTENTO_MS = 5 * 60_000;
/** Lo que aún puede cambiar (el año en curso, el CSV) se vuelve a bajar pasado esto. */
const VIGENCIA_MS = 12 * 3_600_000;

/** Memoriza `cargar`: un null (falla) vale REINTENTO_MS y un resultado vale `vigencia` ms. */
function cacheado<T>(cargar: () => Promise<T | null>, vigencia: number): () => Promise<T | null> {
  let p: Promise<T | null> | undefined;
  let vence = 0;
  return () => {
    if (p && Date.now() < vence) return p;
    vence = Infinity; // mientras carga, todos esperan la misma promesa
    return (p = cargar()
      .catch(() => null)
      .then((v) => ((vence = Date.now() + (v === null ? REINTENTO_MS : vigencia)), v)));
  };
}

type Serie = (anio: string) => Promise<Map<string, number> | null>;

/**
 * Busca en una serie diaria ("AAAA-MM-DD" → pesos). La UTM es mensual: vale cualquier valor de ese mes.
 * Si el día no tiene valor (dólar y euro en fin de semana) usa el último de los 7 días anteriores.
 */
async function enSerie(serie: Serie, moneda: Exclude<Moneda, "CLP">, dia: string, fuente: string): Promise<Paridad | null> {
  if (moneda === "UTM") {
    const mes = dia.slice(0, 7);
    for (const [d, valor] of (await serie(dia.slice(0, 4))) ?? []) if (d.startsWith(mes)) return { valor, fechaValor: d, fuente };
    return null;
  }
  for (let i = 0; i <= 7; i++) {
    const d = sumarDias(dia, -i);
    const valor = (await serie(d.slice(0, 4)))?.get(d);
    if (valor !== undefined) return { valor, fechaValor: d, fuente };
  }
  return null;
}

/** Los años pasados no cambian: se bajan una vez. El en curso se renueva cada VIGENCIA_MS. */
const vigenciaDe = (anio: string) => (anio < diaSantiago(new Date()).slice(0, 4) ? Infinity : VIGENCIA_MS);

const INDICADOR = { CLF: "uf", UTM: "utm", USD: "dolar", EUR: "euro" } as const;

/**
 * Valores diarios de mindicador.cl, un request por moneda y año (`/api/{indicador}/{AAAA}`).
 * Si el día no tiene valor (dólar y euro en fin de semana) usa el último de los 7 días anteriores.
 * La UTM es mensual: vale el valor del mes. Los años pasados se bajan una vez; el en curso, cada VIGENCIA_MS.
 */
export function conversorMindicador(opciones: OpcionesConversor = {}): Conversor {
  const base = opciones.url ?? "https://mindicador.cl/api";
  const cache = new Map<string, () => Promise<Map<string, number> | null>>();
  const cargar = async (ruta: string) => {
    const t = (await descargar(opciones, `${base}/${ruta}`))?.texto;
    if (!t) return null;
    try {
      const dias = new Map<string, number>();
      // `fecha` es la medianoche de Santiago expresada en UTC ("2026-01-02T03:00:00.000Z").
      for (const { fecha, valor } of JSON.parse(t).serie as { fecha: string; valor: number }[]) {
        if (Number.isFinite(valor)) dias.set(diaSantiago(new Date(fecha)), valor);
      }
      return dias;
    } catch {
      return null;
    }
  };
  const serie = (ind: string): Serie => (anio) => {
    const k = `${ind}/${anio}`;
    let c = cache.get(k);
    if (!c) cache.set(k, (c = cacheado(() => cargar(k), vigenciaDe(anio))));
    return c();
  };
  return (moneda, dia) => enSerie(serie(INDICADOR[moneda]), moneda, dia, "mindicador.cl");
}

export const URL_BANCO_CENTRAL = "https://si3.bcentral.cl/Indicadoressiete/secure/";
const SERIE_BC = { CLF: "UF", USD: "PRE_TCO", EUR: "PRE_EUR", UTM: "PRE_UTM" } as const;
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

/**
 * Tabla "Ver serie" del Banco Central → "AAAA-MM-DD" → pesos. Diaria: una fila por día y una celda por mes.
 * UTM: una fila por año (todos los años en la misma página), se guarda como el día 1 de cada mes.
 */
export function leerSerieBancoCentral(html: string, anio: string): Map<string, number> {
  const dias = new Map<string, number>();
  for (const fila of html.split(/<tr[\s>]/).slice(1)) {
    const clave = /^[^<]*<td[^>]*>\s*(\d{1,4})\s*<\/td>/.exec(fila)?.[1];
    if (!clave) continue;
    for (const [, mes, texto] of fila.matchAll(/id="gr_ctl\d+_(\w+)"[^>]*>([^<]*)</g)) {
      const m = MESES.indexOf(mes!) + 1;
      const v = num(texto);
      if (!m || v === null) continue;
      const mm = String(m).padStart(2, "0");
      dias.set(clave.length === 4 ? `${clave}-${mm}-01` : `${anio}-${mm}-${clave.padStart(2, "0")}`, v);
    }
  }
  return dias;
}

/**
 * Valores diarios oficiales del Banco Central de Chile, leídos de las páginas "Ver serie" de Indicadores diarios
 * (si3.bcentral.cl): un request por moneda y año, más uno para obtener los enlaces. Los años pasados se piden con
 * el selector de año (postback de ASP.NET); la UTM trae todos los años de una vez.
 * ponytail: es HTML, no una API. Si cambian la página o el antibots la bloquea, devuelve null y la cadena sigue.
 * La API SIETE del Banco Central es la alternativa estable, pero pide usuario y clave.
 */
export function conversorBancoCentral(opciones: OpcionesConversor = {}): Conversor {
  const base = opciones.url ?? URL_BANCO_CENTRAL;
  const enlaces = cacheado(async () => {
    const r = await descargar(opciones, `${base}Indicadoresdiarios.aspx`);
    const m = new Map<string, string>();
    for (const [, g, p] of r?.texto.matchAll(/Serie\.aspx\?gcode=(\w+)&amp;param=([^"&]+)/g) ?? []) m.set(g!, p!);
    return m.size ? m : null;
  }, VIGENCIA_MS);
  const anioElegido = (html: string) => /<option selected="selected" value="(\d{4})"/.exec(html)?.[1];
  const cargar = async (gcode: string, anio: string) => {
    const param = (await enlaces())?.get(gcode);
    if (!param) return null;
    const url = `${base}Serie.aspx?gcode=${gcode}&param=${param}`;
    let r = await descargar(opciones, url);
    if (r && gcode !== SERIE_BC.UTM && anioElegido(r.texto) !== anio) {
      const t = r.texto;
      const campo = (n: string) => new RegExp(`name="${n}"[^>]*value="([^"]*)"`).exec(t)?.[1] ?? "";
      const body = new URLSearchParams({
        __EVENTTARGET: "DrDwnFechas",
        __EVENTARGUMENT: "",
        __LASTFOCUS: "",
        __VIEWSTATE: campo("__VIEWSTATE"),
        __VIEWSTATEGENERATOR: campo("__VIEWSTATEGENERATOR"),
        __EVENTVALIDATION: campo("__EVENTVALIDATION"),
        DrDwnFechas: anio,
        hdnFrecuencia: campo("hdnFrecuencia"),
      });
      r = await descargar(opciones, url, { method: "POST", body, headers: r.cookie ? { cookie: r.cookie } : {} });
      // Si la página no cambió de año, sus valores serían de otro año: mejor nada.
      if (r && anioElegido(r.texto) !== anio) return null;
    }
    const dias = r ? leerSerieBancoCentral(r.texto, anio) : null;
    return dias?.size ? dias : null;
  };
  const cache = new Map<string, () => Promise<Map<string, number> | null>>();
  const serie = (gcode: string): Serie => (anio) => {
    const k = gcode === SERIE_BC.UTM ? gcode : `${gcode}/${anio}`;
    let c = cache.get(k);
    if (!c) cache.set(k, (c = cacheado(() => cargar(gcode, anio), gcode === SERIE_BC.UTM ? VIGENCIA_MS : vigenciaDe(anio))));
    return c();
  };
  return (moneda, dia) => enSerie(serie(SERIE_BC[moneda]), moneda, dia, "bcentral.cl");
}

export const URL_PARIDAD = "https://transparenciachc.blob.core.windows.net/oc-da/ParidadMoneda.csv";

/**
 * ParidadMoneda.csv oficial de ChileCompra: un promedio por moneda y mes, así que `fechaValor` es el
 * primer día del mes. Se vuelve a bajar cada VIGENCIA_MS. El mes en curso no está hasta que termina.
 */
export function conversorParidadChileCompra(opciones: OpcionesConversor = {}): Conversor {
  const tabla = cacheado(async () => {
    const t = (await descargar(opciones, opciones.url ?? URL_PARIDAD))?.texto;
    if (!t) return null;
    const filas = t.split(/\r?\n/).map((l) => l.split(";").map((c) => c.trim().replace(/^"|"$/g, "")));
    const iClp = filas[0]?.indexOf("VMCLP") ?? -1;
    if (iClp < 0) return null;
    // Las filas vienen repetidas; la clave las deduplica. Decimal con coma, a veces con exponente ("1,39e-05").
    const meses = new Map<string, number>();
    for (const [anio, mes, mon, ...resto] of filas.slice(1)) {
      const m = aMoneda(mon);
      const v = Number(resto[iClp - 3]?.replace(",", "."));
      if (m && anio && mes && resto[iClp - 3] && Number.isFinite(v)) meses.set(`${m}/${anio}-${mes.padStart(2, "0")}`, v);
    }
    return meses;
  }, VIGENCIA_MS);
  return async (moneda, dia) => {
    const mes = dia.slice(0, 7);
    const v = (await tabla())?.get(`${moneda}/${mes}`);
    return v === undefined ? null : { valor: v, fechaValor: `${mes}-01`, fuente: "chilecompra:ParidadMoneda (mensual)" };
  };
}

/** El primero que responda gana; los errores cuentan como null. */
export function conversorEncadenado(...conversores: Conversor[]): Conversor {
  return async (moneda, dia) => {
    for (const c of conversores) {
      try {
        const r = await c(moneda, dia);
        if (r) return r;
      } catch {
        // siguiente
      }
    }
    return null;
  };
}

/** mindicador.cl (diario); si no responde, el Banco Central (diario); y si tampoco, el promedio mensual de ChileCompra. */
export const conversorPorDefecto: Conversor = conversorEncadenado(conversorMindicador(), conversorBancoCentral(), conversorParidadChileCompra());

/**
 * Copia del proceso con `clp`, `fechaValor` y `fuente` completos en cada monto no CLP, usando el día del
 * documento en Santiago (publicación o, si no hay, creación). Lo que no se pueda convertir queda con `clp` null.
 */
export async function convertirMontos<T extends Proceso>(p: T, conversor: Conversor): Promise<T> {
  const t = Date.parse(p.fechas.publicacion ?? p.fechas.creacion ?? "");
  const dia = Number.isNaN(t) ? null : diaSantiago(new Date(t));
  const conv = async (m: Monto | null): Promise<Monto | null> => {
    if (!m || m.moneda === "CLP" || m.clp !== null || !dia) return m;
    let r: Paridad | null = null;
    try {
      r = await conversor(m.moneda, dia);
    } catch {
      // queda sin convertir
    }
    return r ? { ...m, clp: Math.round(m.valor * r.valor), fechaValor: r.fechaValor, fuente: r.fuente } : m;
  };
  const items = await Promise.all(
    p.items.map(async (it) => ({ ...it, precioUnitario: await conv(it.precioUnitario), total: await conv(it.total) })),
  );
  const extra =
    p.tipo === "compra_agil"
      ? {
          cotizaciones: await Promise.all(
            p.cotizaciones.map(async (c) => ({
              ...c,
              monto: await conv(c.monto),
              productos: await Promise.all(c.productos.map(async (x) => ({ ...x, precioUnitario: await conv(x.precioUnitario) }))),
            })),
          ),
        }
      : {};
  return { ...p, monto: await conv(p.monto), items, ...extra };
}
