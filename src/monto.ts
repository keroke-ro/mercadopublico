// Montos a pesos con el valor del día del documento, nunca el de hoy. Ver docs/api-notes.md §6.
import { diaSantiago, sumarDias } from "./fecha.js";
import type { Moneda, Monto, Proceso } from "./modelo.js";
import { moneda as aMoneda } from "./util.js";

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

async function descargar(o: OpcionesConversor, url: string): Promise<string | null> {
  try {
    const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

const INDICADOR = { CLF: "uf", UTM: "utm", USD: "dolar", EUR: "euro" } as const;

/**
 * Valores diarios de mindicador.cl, un request por moneda y año (`/api/{indicador}/{AAAA}`).
 * Si el día no tiene valor (dólar y euro en fin de semana) usa el último de los 7 días anteriores.
 * La UTM es mensual: vale el valor del mes.
 * ponytail: un año que falló queda en caché como fallido mientras viva el conversor, para no esperar
 * el timeout en cada monto si el servicio está caído; crear otro conversor para reintentar.
 */
export function conversorMindicador(opciones: OpcionesConversor = {}): Conversor {
  const base = opciones.url ?? "https://mindicador.cl/api";
  const cache = new Map<string, Promise<Map<string, number> | null>>();
  const cargar = async (ruta: string) => {
    const t = await descargar(opciones, `${base}/${ruta}`);
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
  const serie = (ind: string, anio: string) => {
    const k = `${ind}/${anio}`;
    let p = cache.get(k);
    if (!p) cache.set(k, (p = cargar(k)));
    return p;
  };
  const paridad = (valor: number, fechaValor: string): Paridad => ({ valor, fechaValor, fuente: "mindicador.cl" });

  return async (moneda, dia) => {
    const ind = INDICADOR[moneda];
    if (moneda === "UTM") {
      const mes = dia.slice(0, 7);
      for (const [d, v] of (await serie(ind, dia.slice(0, 4))) ?? []) if (d.startsWith(mes)) return paridad(v, d);
      return null;
    }
    for (let i = 0; i <= 7; i++) {
      const d = sumarDias(dia, -i);
      const v = (await serie(ind, d.slice(0, 4)))?.get(d);
      if (v !== undefined) return paridad(v, d);
    }
    return null;
  };
}

export const URL_PARIDAD = "https://transparenciachc.blob.core.windows.net/oc-da/ParidadMoneda.csv";

/**
 * ParidadMoneda.csv oficial de ChileCompra: un promedio por moneda y mes, así que `fechaValor` es el
 * primer día del mes. Se descarga una vez por conversor. El mes en curso no está hasta que termina.
 */
export function conversorParidadChileCompra(opciones: OpcionesConversor = {}): Conversor {
  let tabla: Promise<Map<string, number> | null> | undefined;
  const cargar = async () => {
    const t = await descargar(opciones, opciones.url ?? URL_PARIDAD);
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
  };
  return async (moneda, dia) => {
    const mes = dia.slice(0, 7);
    const v = (await (tabla ??= cargar()))?.get(`${moneda}/${mes}`);
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

/** mindicador.cl (diario) y, si no responde, el promedio mensual oficial de ChileCompra. */
export const conversorPorDefecto: Conversor = conversorEncadenado(conversorMindicador(), conversorParidadChileCompra());

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
