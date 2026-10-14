/**
 * `mercadopublico/radar`: una capa de decisión de ejemplo sobre datos públicos.
 *
 * Es una vitrina, no el producto de KeroKero: muestra cómo ordenar oportunidades y leer precios
 * con fórmulas explícitas y explicables, sin caja negra ni machine learning. El criterio de cada
 * cliente (sus pesos, rubros, márgenes) nunca va en este repo: se pasa en `Perfil` desde afuera.
 *
 * Todo es determinista: mismas entradas (y mismo `ahora`), mismo resultado. Cada constante es un
 * default exportado en `AJUSTES` que el perfil puede sobrescribir.
 */
import type { CompraAgil, Proceso } from "../modelo.js";

export type NombreFactor = "rubro" | "region" | "monto" | "diasAlCierre" | "competencia";
const FACTORES: readonly NombreFactor[] = ["rubro", "region", "monto", "diasAlCierre", "competencia"];

/** Defaults de `priorizar`. Cualquiera se sobrescribe con el campo del mismo nombre en `Perfil`. */
export const AJUSTES = {
  /** Valor de un factor cuando falta el dato (o el perfil no lo define): ni suma ni resta. */
  neutro: 0.5,
  /**
   * Crédito parcial UNSPSC por niveles compartidos k (pares de dígitos iguales desde la izquierda)
   * cuando no se llega al nivel completo del rubro: [nada, segmento, familia, clase].
   * Calce completo (el código del ítem empieza con el del rubro) vale 1.
   */
  creditoRubro: [0, 0.25, 0.5, 0.75] as readonly [number, number, number, number],
  /** Fuera de [montoMin, montoMax] el factor cae linealmente en escala log10 y llega a 0 a esta distancia en décadas. */
  decadasMonto: 1,
  /** Bajo esta cantidad de días al cierre no alcanza a preparar la oferta: f = días / diasMinimos. */
  diasMinimos: 2,
  /** Oferentes con los que la competencia vale 0,5: f = k / (k + n). */
  oferentesReferencia: 3,
  /** Estados en que un proceso todavía recibe ofertas. Una OC nunca es oportunidad. */
  estadosAbiertos: ["publicada"] as readonly string[],
};
export type Ajustes = typeof AJUSTES;

export interface Perfil extends Partial<Ajustes> {
  /** Pesos wᵢ ≥ 0, en cualquier escala; se normalizan para sumar 1. El que falta vale 0. */
  pesos: Partial<Record<NombreFactor, number>>;
  /** Códigos UNSPSC de 2, 4, 6 u 8 dígitos (segmento, familia, clase, producto). */
  rubros?: (number | string)[];
  /** Códigos de región, 1 a 16. */
  regiones?: number[];
  /** Rango de montos que la empresa puede atender, en CLP. */
  montoMin?: number;
  montoMax?: number;
}

export interface Factor {
  nombre: NombreFactor;
  /** fᵢ ∈ [0, 1]. */
  valor: number;
  /** wᵢ normalizado. */
  peso: number;
  /** wᵢ · fᵢ. */
  aporte: number;
  razon: string;
}

export interface Oportunidad {
  proceso: Proceso;
  /** Σ aporte, en [0, 1]. */
  puntaje: number;
  factores: Factor[];
}

type Evaluado = Pick<Factor, "valor" | "razon">;
const NIVELES = ["", "segmento", "familia", "clase", "producto"];
const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;
const dec = (n: number) => n.toLocaleString("es-CL", { maximumFractionDigits: 2 });

/** Niveles UNSPSC compartidos entre un código de 8 dígitos y un rubro de 2 a 8: pares iguales desde la izquierda. */
function nivelesComunes(codigo: string, rubro: string): number {
  let k = 0;
  while (k < rubro.length / 2 && codigo.slice(2 * k, 2 * k + 2) === rubro.slice(2 * k, 2 * k + 2)) k++;
  return k;
}

function rubro(p: Proceso, rubros: string[], a: Ajustes): Evaluado {
  if (!rubros.length) return { valor: a.neutro, razon: "El perfil no define rubros; factor neutro." };
  const codigos = p.items.map((i) => i.codigoProducto).filter((c): c is number => c !== null);
  if (!codigos.length) return { valor: a.neutro, razon: "Sin ítems con código UNSPSC (¿listado sin detalle?); factor neutro." };
  // f = max sobre ítems × rubros: 1 si el ítem cae dentro del rubro, si no creditoRubro[k].
  let mejor = { valor: 0, razon: "Ningún ítem comparte siquiera el segmento UNSPSC con los rubros del perfil." };
  for (const c of codigos)
    for (const r of rubros) {
      const k = nivelesComunes(String(c), r);
      const completo = k === r.length / 2;
      const valor = completo ? 1 : a.creditoRubro[k]!;
      if (valor > mejor.valor)
        mejor = {
          valor,
          razon: completo
            ? `El ítem ${c} está dentro del rubro ${r} (${NIVELES[k]}).`
            : `El ítem ${c} comparte ${NIVELES[k]} con el rubro ${r}, pero no ${NIVELES[r.length / 2]}.`,
        };
    }
  return mejor;
}

function region(p: Proceso, regiones: number[], a: Ajustes): Evaluado {
  if (!regiones.length) return { valor: a.neutro, razon: "El perfil no define regiones; factor neutro." };
  const r = p.comprador?.region ?? null;
  if (r === null) return { valor: a.neutro, razon: "No se sabe la región del comprador; factor neutro." };
  return regiones.includes(r)
    ? { valor: 1, razon: `El comprador está en la región ${r}, que atiendes.` }
    : { valor: 0, razon: `El comprador está en la región ${r}, fuera de las que atiendes.` };
}

function monto(p: Proceso, min: number, max: number, a: Ajustes): Evaluado {
  if (min === 0 && max === Infinity) return { valor: a.neutro, razon: "El perfil no define rango de montos; factor neutro." };
  const x = p.monto?.clp ?? null;
  if (x === null)
    return { valor: a.neutro, razon: p.monto ? `Monto en ${p.monto.moneda} sin convertir a CLP; factor neutro.` : "Monto desconocido; factor neutro." };
  if (x >= min && x <= max) return { valor: 1, razon: `Monto ${clp(x)} dentro de tu rango.` };
  // f = max(0, 1 − |log10(x / borde)| / decadasMonto)
  const borde = x < min ? min : max;
  const valor = Math.max(0, 1 - Math.abs(Math.log10(x / borde)) / a.decadasMonto);
  return { valor, razon: `Monto ${clp(x)} ${x < min ? "bajo tu mínimo" : "sobre tu máximo"} de ${clp(borde)} (${dec(x / borde)}×).` };
}

function diasAlCierre(p: Proceso, ahora: Date, a: Ajustes): Evaluado {
  if (!a.estadosAbiertos.includes(p.estado)) return { valor: 0, razon: `No está abierto (estado ${p.estado}).` };
  if (!p.fechas.cierre) return { valor: a.neutro, razon: "Sin fecha de cierre; factor neutro." };
  const d = (Date.parse(p.fechas.cierre) - ahora.getTime()) / 86_400_000;
  if (!(d > 0)) return { valor: 0, razon: "La fecha de cierre ya pasó." };
  // f = min(1, d / diasMinimos)
  return d >= a.diasMinimos
    ? { valor: 1, razon: `Cierra en ${dec(d)} días: hay tiempo para preparar la oferta.` }
    : { valor: d / a.diasMinimos, razon: `Cierra en ${dec(d)} días, menos de los ${a.diasMinimos} que necesitas.` };
}

function competencia(p: Proceso, a: Ajustes): Evaluado {
  const n = p.oferentes;
  if (n === null) return { valor: a.neutro, razon: "No se sabe cuántos oferentes hay; factor neutro." };
  // f = k / (k + n): 0 oferentes → 1, k → 0,5. En un proceso abierto n es cuántos van, no cuántos habrá.
  const k = a.oferentesReferencia;
  return { valor: k / (k + n), razon: `${n} oferente${n === 1 ? "" : "s"} hasta ahora (referencia: ${k} → 0,5).` };
}

/**
 * Cola de oportunidades ordenada por `puntaje = Σ wᵢ · fᵢ` (desc; los empates mantienen el orden de entrada).
 * Excluye los procesos que no están en `estadosAbiertos` salvo `incluirCerrados`.
 */
export function priorizar(procesos: Proceso[], perfil: Perfil, opciones: { ahora?: Date; incluirCerrados?: boolean } = {}): Oportunidad[] {
  const a: Ajustes = { ...AJUSTES, ...Object.fromEntries(Object.entries(perfil).filter(([, v]) => v !== undefined)) };
  const ahora = opciones.ahora ?? new Date();

  const crudos = FACTORES.map((f) => perfil.pesos[f] ?? 0);
  if (crudos.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError("Los pesos deben ser números finitos ≥ 0");
  const total = crudos.reduce((s, w) => s + w, 0);
  if (total === 0) throw new RangeError("Al menos un peso debe ser mayor que 0");
  const pesos = crudos.map((w) => w / total);

  const rubros = (perfil.rubros ?? []).map((r) => String(r).trim());
  const malo = rubros.find((r) => !/^\d{2}(\d{2}){0,3}$/.test(r));
  if (malo !== undefined) throw new RangeError(`Rubro UNSPSC inválido: "${malo}" (2, 4, 6 u 8 dígitos)`);
  const min = perfil.montoMin ?? 0;
  const max = perfil.montoMax ?? Infinity;
  if (min > max) throw new RangeError("montoMin es mayor que montoMax");

  return procesos
    .filter((p) => opciones.incluirCerrados || a.estadosAbiertos.includes(p.estado))
    .map((p) => {
      const evaluados: Record<NombreFactor, Evaluado> = {
        rubro: rubro(p, rubros, a),
        region: region(p, perfil.regiones ?? [], a),
        monto: monto(p, min, max, a),
        diasAlCierre: diasAlCierre(p, ahora, a),
        competencia: competencia(p, a),
      };
      const factores = FACTORES.map((nombre, i) => ({ nombre, ...evaluados[nombre], peso: pesos[i]!, aporte: pesos[i]! * evaluados[nombre].valor }));
      return { proceso: p, puntaje: factores.reduce((s, f) => s + f.aporte, 0), factores };
    })
    .sort((x, y) => y.puntaje - x.puntaje);
}

/** Mínimo de precios para entregar un rango. */
export const MUESTRA_MINIMA = 10;

export type RangoDePrecio =
  | { n: number; p25: number; p50: number; p75: number; unidad: string | null; moneda: "CLP"; soloSeleccionadas: boolean; supuestos: string[] }
  | { n: number; insuficiente: true; motivo: "muestra insuficiente"; supuestos: string[] };

/** Percentil por interpolación lineal (Hyndman–Fan tipo 7): h = (n − 1)·p, x⌊h⌋ + (h − ⌊h⌋)(x⌊h⌋₊₁ − x⌊h⌋). `xs` ordenado. */
function percentil(xs: number[], p: number): number {
  const h = (xs.length - 1) * p;
  const i = Math.floor(h);
  return xs[i]! + (h - i) * ((xs[i + 1] ?? xs[i]!) - xs[i]!);
}

const normUnidad = (u: string | null | undefined) => u?.trim().toLowerCase() || null;

/**
 * p25, p50 y p75 del precio unitario en CLP que cotizaron para `codigoProducto` en el detalle de Compra Ágil.
 * Con menos de `minimo` precios no inventa un rango: devuelve `insuficiente`.
 */
export function rangoDePrecio(
  codigoProducto: number,
  compras: CompraAgil[],
  opciones: { soloSeleccionadas?: boolean; unidad?: string; minimo?: number } = {},
): RangoDePrecio {
  const { soloSeleccionadas = false, minimo = MUESTRA_MINIMA } = opciones;
  const supuestos = [
    "Precios unitarios de productos_cotizados[].precio_unitario, tomados como netos (sin IVA ni despacho).",
    "La muestra solo incluye a quienes cotizaron; no es el precio de mercado.",
    "Montos en CLP al día del documento; se omiten los que no se pudieron convertir.",
    soloSeleccionadas
      ? "Solo cotizaciones seleccionadas: estima cuánto suele ganar. Cuando la API no informa la selección, solo se infiere si hubo una única cotización."
      : "Todas las cotizaciones, seleccionadas o no: estima cuánto se suele cotizar, no cuánto gana.",
    "La cotización no trae unidad: se usa la de productos_solicitados de la misma compra.",
    "Percentiles por interpolación lineal (Hyndman–Fan tipo 7, el de R y PERCENTIL.INC de Excel).",
  ];

  // Precios por unidad normalizada (null = la compra no informó unidad).
  const porUnidad = new Map<string | null, number[]>();
  let omitidos = 0;
  for (const ca of compras) {
    const u = normUnidad(ca.items.find((i) => i.codigoProducto === codigoProducto)?.unidad);
    for (const c of ca.cotizaciones) {
      if (soloSeleccionadas && !c.seleccionada) continue;
      for (const pr of c.productos) {
        if (pr.codigoProducto !== codigoProducto) continue;
        const v = pr.precioUnitario?.clp ?? null;
        if (v === null) omitidos++;
        else porUnidad.set(u, [...(porUnidad.get(u) ?? []), v]);
      }
    }
  }
  if (omitidos) supuestos.push(`Se omitieron ${omitidos} precios sin valor en CLP.`);

  let unidad: string | null;
  if (opciones.unidad !== undefined) unidad = normUnidad(opciones.unidad);
  else {
    // La más frecuente; empate → orden alfabético, para que sea determinista.
    const orden = [...porUnidad].sort(([a, x], [b, y]) => y.length - x.length || String(a).localeCompare(String(b)));
    unidad = orden[0]?.[0] ?? null;
    if (orden.length > 1)
      supuestos.push(
        `Hay precios en varias unidades (${orden.map(([u, xs]) => `${u ?? "sin unidad"}: ${xs.length}`).join(", ")}); se usó la más frecuente, ${unidad ?? "sin unidad"}. Pasa \`unidad\` para elegir otra.`,
      );
  }
  supuestos.push(`Mismo producto (${codigoProducto}) y misma unidad (${unidad ?? "sin unidad"}).`);

  const xs = [...(porUnidad.get(unidad) ?? [])].sort((a, b) => a - b);
  if (xs.length < minimo) return { n: xs.length, insuficiente: true, motivo: "muestra insuficiente", supuestos };
  return { n: xs.length, p25: percentil(xs, 0.25), p50: percentil(xs, 0.5), p75: percentil(xs, 0.75), unidad, moneda: "CLP", soloSeleccionadas, supuestos };
}
