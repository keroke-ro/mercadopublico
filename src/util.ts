// Conversión defensiva: el diccionario declara nvarchar para campos numéricos y la API a veces manda "" o null.
import type { Aviso } from "./eventos.js";
import type { Moneda, Monto, Origen } from "./modelo.js";

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Número finito desde un number o un texto decimal; cualquier otra cosa (listas, booleanos, "0x10", " "), null. */
export function num(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  // "1.234,5" y "1.234.567" (formato chileno) y "1234.5" (formato JSON). "1.234" queda como decimal: es ambiguo.
  let t = x.trim();
  if (/,\d+$/.test(t) || /^[+-]?\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  if (!DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Entero ≥ 0 o null (códigos UNSPSC, conteos). */
export function entero(x: unknown): number | null {
  const n = num(x);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Texto sin blancos de borde; null si viene vacío o no es un primitivo (un objeto no es "[object Object]"). */
export function str(x: unknown): string | null {
  if (typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean" && typeof x !== "bigint") return null;
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

/** Sin moneda: null, undefined o texto en blanco. Un objeto o una lista no es "sin moneda", es una moneda que no se entiende. */
const sinMoneda = (x: unknown) => x === null || x === undefined || (typeof x === "string" && !x.trim());

/**
 * Monto sin convertir. Sin moneda se asume CLP; con una moneda que no se reconoce, null (no se inventa). Si es CLP, `clp` ya es el valor; si no, queda null hasta que
 * `convertirMontos` lo complete con el valor del día del documento.
 */
export function monto(valor: unknown, mon: unknown, dia: string | null): Monto | null {
  const v = num(valor);
  if (v === null) return null;
  const m = sinMoneda(mon) ? "CLP" : moneda(mon);
  if (!m) return null;
  return m === "CLP"
    ? { valor: v, moneda: m, clp: v, fechaValor: dia, fuente: "identidad" }
    : { valor: v, moneda: m, clp: null, fechaValor: null, fuente: null };
}

// ── Avisos de cambios en la API ────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que un parser espera de cada campo que conoce: "s" string, "n" number, "b" boolean, "sn" string o number,
 * "m" código de moneda (string que `moneda` reconoce), "*" cualquier cosa (campo conocido que no se lee);
 * un objeto anidado, o `[objeto]` para una lista de objetos. La clave "…" deja el objeto abierto: no avisa campos nuevos.
 * null siempre vale (la API manda null en casi todo).
 */
export type Esquema = { [k: string]: "s" | "n" | "b" | "sn" | "m" | "*" | Esquema | [Esquema] };

export type Avisar = (tipo: Aviso["tipo"], ruta: string, detalle?: string) => void;

const unir = (base: string, k: string) => (base ? `${base}.${k}` : k);
const tipoJson = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const NOMBRE = { s: "string", n: "number", b: "boolean", sn: "string o number", m: "moneda" } as const;

/**
 * Prepara el aviso de un parseo: uno por (tipo, ruta) y un hook que lanza no rompe nada. null si no hay hook,
 * para que el parser ni revise.
 */
export function avisador(origen: Origen, codigo: unknown, avisar: ((a: Aviso) => void) | undefined): Avisar | null {
  if (typeof avisar !== "function") return null;
  const cod = str(codigo);
  const vistos = new Set<string>();
  return (tipo, ruta, detalle) => {
    const k = `${tipo} ${ruta}`;
    if (vistos.has(k)) return;
    vistos.add(k);
    try {
      avisar({ tipo, origen, ruta, ...(cod ? { codigo: cod } : {}), ...(detalle ? { detalle } : {}) });
    } catch {
      // el hook es del usuario
    }
  };
}

/** Compara `x` con su esquema: campos nuevos, tipos distintos y monedas desconocidas. */
export function revisar(x: unknown, e: Esquema, ruta: string, av: Avisar): void {
  if (!x || typeof x !== "object" || Array.isArray(x)) return;
  for (const [k, v] of Object.entries(x)) {
    const r = unir(ruta, k);
    if (!Object.hasOwn(e, k)) {
      if (!Object.hasOwn(e, "…")) av("campo_nuevo", r);
      continue;
    }
    const t = e[k]!;
    if (v === null || t === "*") continue;
    if (Array.isArray(t)) {
      if (!Array.isArray(v)) av("tipo_distinto", r, `se esperaba array, llegó ${tipoJson(v)}`);
      else
        for (const i of v)
          if (tipoJson(i) === "object") revisar(i, t[0], `${r}[]`, av);
          else if (i !== null) av("tipo_distinto", `${r}[]`, `se esperaba object, llegó ${tipoJson(i)}`);
    } else if (typeof t === "object") {
      if (tipoJson(v) === "object") revisar(v, t, r, av);
      else av("tipo_distinto", r, `se esperaba object, llegó ${tipoJson(v)}`);
    } else if (t === "m") {
      if (typeof v !== "string") av("tipo_distinto", r, `se esperaba string, llegó ${tipoJson(v)}`);
      else if (!sinMoneda(v) && !moneda(v)) av("valor_desconocido", r, `moneda ${v.slice(0, 20)}`);
    } else if (!t.includes(tipoJson(v)[0]!)) av("tipo_distinto", r, `se esperaba ${NOMBRE[t]}, llegó ${tipoJson(v)}`);
  }
}

/** Campos de los que depende el modelo: avisa los que faltan o vienen null. Rutas con "." y sin listas. */
export function exigir(x: unknown, rutas: readonly string[], base: string, av: Avisar): void {
  for (const ruta of rutas) {
    const v = ruta.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined), x);
    if (v === null || v === undefined) av("campo_faltante", unir(base, ruta));
  }
}
