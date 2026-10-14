// Conversión defensiva: el diccionario declara nvarchar para campos numéricos y la API a veces manda "" o null.
import type { Moneda, Monto } from "./modelo.js";

export function num(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  // "1.234,5" (formato chileno) y "1234.5" (formato JSON).
  const t = String(x).trim();
  const n = Number(/,\d+$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? n : null;
}

export function str(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  const t = String(x).trim();
  return t === "" ? null : t;
}

const MONEDAS: ReadonlySet<string> = new Set(["CLP", "CLF", "UTM", "USD", "EUR"]);

/** "UF" y "$" llegan a veces en lugar del código ISO. */
export function moneda(x: unknown): Moneda | null {
  const t = str(x)?.toUpperCase();
  if (!t) return null;
  if (t === "UF") return "CLF";
  if (t === "$" || t === "PESO" || t === "PESOS") return "CLP";
  return MONEDAS.has(t) ? (t as Moneda) : null;
}

/**
 * Monto sin convertir. Sin moneda se asume CLP; con una moneda que no se reconoce, null (no se inventa). Si es CLP, `clp` ya es el valor; si no, queda null hasta que
 * `convertirMontos` lo complete con el valor del día del documento.
 */
export function monto(valor: unknown, mon: unknown, dia: string | null): Monto | null {
  const v = num(valor);
  if (v === null) return null;
  const m = str(mon) === null ? "CLP" : moneda(mon);
  if (!m) return null;
  return m === "CLP"
    ? { valor: v, moneda: m, clp: v, fechaValor: dia, fuente: "identidad" }
    : { valor: v, moneda: m, clp: null, fechaValor: null, fuente: null };
}
