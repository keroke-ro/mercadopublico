/**
 * `mercadopublico/radar`: la capa de decisión de KeroKero sobre los datos públicos de Mercado Público.
 *
 * Responde lo que se pregunta cada mañana un equipo que le vende al Estado: qué postular primero (`decidir`), a qué
 * precio (`precioSugerido`, `rangoDePrecio`), contra quién (`competidores`), qué viene (`proximasCompras`) y si el
 * criterio escrito sigue calzando con lo que el equipo de verdad decide (`calibrar`). Fórmulas explícitas, sin caja
 * negra ni machine learning: cada número trae su porqué en texto.
 *
 * El criterio de cada empresa (pesos, rubros, costos, vetos) no va en este repo: se pasa en `Perfil` desde afuera.
 * Todo es determinista: mismas entradas (y mismo `ahora`), mismo resultado. Cada constante es un default exportado
 * en `AJUSTES` que el perfil puede sobrescribir.
 */
import { diaSantiago, sumarDias } from "../fecha.js";
import type { CompraAgil, Proceso, Proveedor } from "../modelo.js";
import { esPersonaNatural } from "../personales.js";

export type NombreFactor = "rubro" | "region" | "monto" | "diasAlCierre" | "competencia" | "incumbente";
const FACTORES: readonly NombreFactor[] = ["rubro", "region", "monto", "diasAlCierre", "competencia", "incumbente"];

/** Defaults del radar. Cualquiera se sobrescribe con el campo del mismo nombre en `Perfil` (o en las opciones). */
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
  /** Adjudicaciones previas (mismo organismo y familia UNSPSC) bajo las cuales `incumbente` no opina: queda neutro. */
  victoriasMinimas: 3,
  /** Estados en que un proceso todavía recibe ofertas. Una OC nunca es oportunidad. */
  estadosAbiertos: ["publicada"] as readonly string[],
  /** `decidir`: desde este puntaje, postular. */
  umbralPostular: 0.7,
  /** `decidir`: desde este puntaje (y bajo `umbralPostular`), revisar. Bajo esto, descartar. */
  umbralRevisar: 0.4,
  /** `calibrar`: decisiones mínimas de cada tipo (postular y descartar) para sugerir pesos. */
  decisionesMinimas: 5,
  /** `calibrar`: mejora mínima de acuerdo por paso para proponer un cambio. Evita perseguir ruido. */
  mejoraMinima: 0.02,
  /** `proximasCompras`: compras mínimas (en días distintos) de una familia en un organismo para hablar de patrón. */
  comprasMinimas: 3,
  /** `proximasCompras`: el patrón es regular si (intervalo máximo − mínimo) ≤ esto × la mediana. */
  irregularidadMaxima: 1,
};
export type Ajustes = typeof AJUSTES;

/** Regla dura de `decidir`: descarta si el factor vale menos que `minimo`, aunque su peso sea 0. */
export interface Veto {
  factor: NombreFactor;
  minimo: number;
}

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
  /** Tu RUT, para no contarte como tu propia competencia. */
  rut?: string;
  /** Reglas duras de `decidir`. */
  vetos?: Veto[];
  /** Palabras que descartan en `decidir` si aparecen en el nombre, la descripción o los ítems (sin tildes ni mayúsculas). */
  excluir?: string[];
  /** Cuántas ofertas alcanza a preparar el equipo: `decidir` agenda solo las N de mejor puntaje. */
  capacidad?: number;
  /** Costo unitario neto en CLP por código de producto UNSPSC, para `precioSugerido`. */
  costos?: Record<string, number>;
}

export interface OpcionesRadar {
  /** Fija el reloj. */
  ahora?: Date;
  /** Incluye los procesos que no están en `estadosAbiertos`. */
  incluirCerrados?: boolean;
  /** Procesos pasados (OC, licitaciones adjudicadas, Compra Ágil con selección) para el factor `incumbente`. */
  historial?: Proceso[];
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
const definidos = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const ajustes = (o: object): Ajustes => ({ ...AJUSTES, ...definidos(o) });

function rubrosValidos(rs: (number | string)[] | undefined): string[] {
  const rubros = (rs ?? []).map((r) => String(r).trim());
  const malo = rubros.find((r) => !/^\d{2}(\d{2}){0,3}$/.test(r));
  if (malo !== undefined) throw new RangeError(`Rubro UNSPSC inválido: "${malo}" (2, 4, 6 u 8 dígitos)`);
  return rubros;
}

/** Familias UNSPSC (4 dígitos) de los ítems del proceso. */
const familias = (p: Proceso) => [...new Set(p.items.flatMap((i) => (i.codigoProducto ? [String(i.codigoProducto).slice(0, 4)] : [])))];

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

/** Licitación con `VisibilidadMonto: 0`: el organismo decidió no publicar el monto estimado. */
const montoOculto = (p: Proceso) => p.monto === null && (p.raw as { VisibilidadMonto?: unknown } | null)?.VisibilidadMonto === 0;
const OCULTO = "El organismo no publica el monto estimado; factor neutro.";

function monto(p: Proceso, min: number, max: number, a: Ajustes): Evaluado {
  if (min === 0 && max === Infinity) return { valor: a.neutro, razon: "El perfil no define rango de montos; factor neutro." };
  const x = p.monto?.clp ?? null;
  if (x === null)
    return { valor: a.neutro, razon: p.monto ? `Monto en ${p.monto.moneda} sin convertir a CLP; factor neutro.` : montoOculto(p) ? OCULTO : "Monto desconocido; factor neutro." };
  if (x >= min && x <= max) return { valor: 1, razon: `Monto ${clp(x)} dentro de tu rango.` };
  // f = max(0, 1 − |log10(x / borde)| / decadasMonto)
  const borde = x < min ? min : max;
  // Un monto ≤ 0 (o un borde 0) no tiene escala log: vale 0, no NaN.
  const valor = x > 0 && borde > 0 ? Math.max(0, 1 - Math.abs(Math.log10(x / borde)) / a.decadasMonto) : 0;
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
  if (n === null || !(n >= 0)) return { valor: a.neutro, razon: "No se sabe cuántos oferentes hay; factor neutro." };
  // f = k / (k + n): 0 oferentes → 1, k → 0,5. En un proceso abierto n es cuántos van, no cuántos habrá.
  const k = a.oferentesReferencia;
  return { valor: k / (k + n), razon: `${n} oferente${n === 1 ? "" : "s"} hasta ahora (referencia: ${k} → 0,5).` };
}

// ── Historial: quién participó y quién ganó ──────────────────────────────────────────────────────────────────────

interface Participacion {
  proceso: Proceso;
  clave: string;
  proveedor: Proveedor;
  gano: boolean;
  montoClp: number | null;
}

/** RUT solo con dígitos y K ("76.123.456-7" = "761234567"); si no hay, el código de empresa o el nombre. */
function claveProveedor(p: Proveedor | null): string | null {
  return p?.rut?.replace(/[^0-9kK]/g, "").toUpperCase() || p?.codigo || p?.nombre?.trim().toLowerCase() || null;
}

/**
 * Una fila por proceso × proveedor. Compra Ágil: cada cotización, gana la seleccionada. Licitación: los proveedores
 * de sus ítems (solo se ven los que ganaron). OC: su proveedor gana, y si viene de un proceso del historial se anota
 * en ese proceso para no contar la misma compra dos veces. Los procesos abiertos no tienen resultado y no cuentan.
 */
function participaciones(historial: Proceso[], a: Ajustes): Participacion[] {
  const m = new Map<string, Participacion>();
  const agregar = (proceso: Proceso, proveedor: Proveedor | null, gano: boolean, montoClp: number | null) => {
    const clave = claveProveedor(proveedor);
    if (!clave || !proveedor) return;
    const x = m.get(`${proceso.codigo}|${clave}`);
    if (!x) m.set(`${proceso.codigo}|${clave}`, { proceso, clave, proveedor, gano, montoClp });
    else if (gano && !x.gano) Object.assign(x, { gano, montoClp: x.montoClp ?? montoClp });
  };
  const cerrados = historial.filter((p) => !a.estadosAbiertos.includes(p.estado));
  const porCodigo = new Map(cerrados.filter((p) => p.tipo !== "orden_compra").map((p) => [p.codigo, p]));
  for (const p of porCodigo.values()) {
    if (p.tipo === "compra_agil") for (const c of p.cotizaciones) agregar(p, c.proveedor, c.seleccionada, c.seleccionada ? (c.monto?.clp ?? null) : null);
    else {
      const total = new Map<string, { proveedor: Proveedor; monto: number | null }>();
      for (const i of p.items) {
        const k = claveProveedor(i.proveedor);
        if (!k) continue;
        const t = total.get(k) ?? { proveedor: i.proveedor!, monto: null };
        if (i.total?.clp != null) t.monto = (t.monto ?? 0) + i.total.clp;
        total.set(k, t);
      }
      for (const t of total.values()) agregar(p, t.proveedor, true, t.monto);
    }
  }
  for (const p of cerrados)
    if (p.tipo === "orden_compra") agregar((p.procesoOrigen && porCodigo.get(p.procesoOrigen)) || p, p.proveedor, true, p.monto?.clp ?? null);
  return [...m.values()];
}

type IndiceVictorias = Map<string, Participacion[]>;

/** Victorias por organismo|familia, para `incumbente`. */
function indiceVictorias(historial: Proceso[], a: Ajustes): IndiceVictorias {
  const ix: IndiceVictorias = new Map();
  for (const x of participaciones(historial, a)) {
    const org = x.proceso.comprador?.codigoOrganismo;
    if (!x.gano || !org) continue;
    for (const f of familias(x.proceso)) ix.set(`${org}|${f}`, [...(ix.get(`${org}|${f}`) ?? []), x]);
  }
  return ix;
}

/** Nombre para mostrar en textos: una persona natural no se nombra, y sin nombre no se cae al RUT. `un`: "Un" o "un" según el lugar de la frase. */
function nombreVisible(p: Proveedor, un: "Un" | "un"): string {
  return esPersonaNatural(p.rut) ? `${un} proveedor persona natural` : (p.nombre ?? `${un} proveedor`);
}

function incumbente(p: Proceso, ix: IndiceVictorias | null, yo: string | null, a: Ajustes): Evaluado {
  if (!ix) return { valor: a.neutro, razon: "Sin historial de adjudicaciones; factor neutro." };
  const org = p.comprador?.codigoOrganismo;
  const fams = familias(p);
  if (!org || !fams.length) return { valor: a.neutro, razon: "Sin organismo o sin ítems con código UNSPSC; factor neutro." };
  // Mismo proceso y proveedor una sola vez, aunque calce en varias familias.
  const victorias = new Map(fams.flatMap((f) => ix.get(`${org}|${f}`) ?? []).map((x) => [`${x.proceso.codigo}|${x.clave}`, x]));
  const total = victorias.size;
  if (total < a.victoriasMinimas)
    return { valor: a.neutro, razon: `Solo ${total} adjudicaci${total === 1 ? "ón" : "ones"} previa${total === 1 ? "" : "s"} de estas familias en este organismo; factor neutro.` };
  const cuenta = new Map<string, { nombre: string; n: number }>();
  for (const x of victorias.values()) {
    const c = cuenta.get(x.clave) ?? { nombre: nombreVisible(x.proveedor, "Un"), n: 0 };
    c.n++;
    cuenta.set(x.clave, c);
  }
  const mias = (yo && cuenta.get(yo)?.n) || 0;
  const [clave, top] = [...cuenta].filter(([k]) => k !== yo).sort(([k1, x], [k2, y]) => y.n - x.n || k1.localeCompare(k2))[0] ?? [];
  if (!clave || !top) return { valor: 1, razon: `Ganaste las ${total} adjudicaciones previas de estas familias en este organismo.` };
  // f = 1 − cuota del proveedor ajeno que más gana aquí.
  return {
    valor: 1 - top.n / total,
    razon: `${top.nombre} se llevó ${top.n} de ${total} adjudicaciones previas de estas familias en este organismo.${mias ? ` Tú, ${mias}.` : ""}`,
  };
}

// ── Priorizar y decidir ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cola de oportunidades ordenada por `puntaje = Σ wᵢ · fᵢ` (desc; los empates mantienen el orden de entrada).
 * Excluye los procesos que no están en `estadosAbiertos` salvo `incluirCerrados`.
 */
export function priorizar(procesos: Proceso[], perfil: Perfil, opciones: OpcionesRadar = {}): Oportunidad[] {
  const a = ajustes(perfil);
  const ahora = opciones.ahora ?? new Date();

  const crudos = FACTORES.map((f) => perfil.pesos[f] ?? 0);
  if (crudos.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError("Los pesos deben ser números finitos ≥ 0");
  // Se escalan por el mayor antes de sumar: dos pesos de 1e308 suman Infinity y todos quedarían en 0.
  const mayor = Math.max(...crudos);
  if (mayor === 0) throw new RangeError("Al menos un peso debe ser mayor que 0");
  const total = crudos.reduce((s, w) => s + w / mayor, 0);
  const pesos = crudos.map((w) => w / mayor / total);

  const rubros = rubrosValidos(perfil.rubros);
  const min = perfil.montoMin ?? 0;
  const max = perfil.montoMax ?? Infinity;
  if (min > max) throw new RangeError("montoMin es mayor que montoMax");
  const ix = opciones.historial ? indiceVictorias(opciones.historial, a) : null;
  const yo = perfil.rut ? claveProveedor({ rut: perfil.rut, nombre: null, codigo: null }) : null;

  return procesos
    .filter((p) => opciones.incluirCerrados || a.estadosAbiertos.includes(p.estado))
    .map((p) => {
      const evaluados: Record<NombreFactor, Evaluado> = {
        rubro: rubro(p, rubros, a),
        region: region(p, perfil.regiones ?? [], a),
        monto: monto(p, min, max, a),
        diasAlCierre: diasAlCierre(p, ahora, a),
        competencia: competencia(p, a),
        incumbente: incumbente(p, ix, yo, a),
      };
      const factores = FACTORES.map((nombre, i) => ({ nombre, ...evaluados[nombre], peso: pesos[i]!, aporte: pesos[i]! * evaluados[nombre].valor }));
      // Con todos los fᵢ en 1 el redondeo puede dar 1,0000000000000002: se acota a 1.
      return { proceso: p, puntaje: Math.min(1, factores.reduce((s, f) => s + f.aporte, 0)), factores };
    })
    .sort((x, y) => y.puntaje - x.puntaje);
}

export type Accion = "postular" | "revisar" | "descartar";

export interface Decision extends Oportunidad {
  accion: Accion;
  /** Lugar en la agenda (1 = primero), por fecha de cierre. null si se descarta o no entra en `capacidad`. */
  turno: number | null;
  /** Lo esencial del porqué, de lo más a lo menos importante. */
  porque: string[];
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * La lista corta: qué postular, qué revisar y qué descartar, cada uno con su porqué, y en qué orden.
 *
 * Primero las reglas duras (`excluir`, `vetos`) y después el puntaje contra `umbralPostular` y `umbralRevisar`.
 * Las que no se descartan entran a la agenda por puntaje hasta llenar `capacidad`, y la agenda se ordena por fecha
 * de cierre: lo que cierra antes, primero. Devuelve la agenda, luego lo que no cupo y al final lo descartado.
 */
export function decidir(procesos: Proceso[], perfil: Perfil, opciones: Omit<OpcionesRadar, "incluirCerrados"> = {}): Decision[] {
  const a = ajustes(perfil);
  if (!(0 <= a.umbralRevisar && a.umbralRevisar <= a.umbralPostular && a.umbralPostular <= 1))
    throw new RangeError("Se necesita 0 ≤ umbralRevisar ≤ umbralPostular ≤ 1");
  const cap = perfil.capacidad;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0)) throw new RangeError("capacidad debe ser un entero ≥ 0");
  const vetoMalo = perfil.vetos?.find((v) => !FACTORES.includes(v.factor) || !Number.isFinite(v.minimo));
  if (vetoMalo) throw new RangeError(`Veto inválido: ${JSON.stringify(vetoMalo)}`);
  const excluir = (perfil.excluir ?? []).map((w) => sinTildes(w).trim()).filter(Boolean);

  const ds = priorizar(procesos, perfil, opciones).map((o): Decision => {
    const p = o.proceso;
    const texto = sinTildes([p.nombre, p.descripcion, ...p.items.flatMap((i) => [i.nombre, i.descripcion])].filter(Boolean).join(" "));
    const palabra = excluir.find((w) => texto.includes(w));
    if (palabra) return { ...o, accion: "descartar", turno: null, porque: [`Menciona "${palabra}", que tu perfil excluye.`] };
    for (const v of perfil.vetos ?? []) {
      const f = o.factores.find((x) => x.nombre === v.factor)!;
      if (f.valor < v.minimo) return { ...o, accion: "descartar", turno: null, porque: [`Veto de ${v.factor} (mínimo ${dec(v.minimo)}): ${f.razon}`] };
    }
    const activos = o.factores.filter((f) => f.peso > 0);
    const aFavor = [...activos].sort((x, y) => y.aporte - x.aporte);
    const enContra = [...activos].sort((x, y) => y.peso * (1 - y.valor) - x.peso * (1 - x.valor));
    const accion: Accion = o.puntaje >= a.umbralPostular ? "postular" : o.puntaje >= a.umbralRevisar ? "revisar" : "descartar";
    const porque =
      accion === "postular"
        ? aFavor.slice(0, 2).map((f) => f.razon)
        : accion === "descartar"
          ? enContra.slice(0, 2).map((f) => f.razon)
          : [aFavor[0]!.razon, ...(enContra[0] !== aFavor[0] ? [`Ojo: ${enContra[0]!.razon}`] : [])];
    // Postular o revisar sin saber el monto es una decisión distinta: se dice aunque no esté entre los factores elegidos.
    if (accion !== "descartar" && o.factores.some((f) => f.nombre === "monto" && f.peso > 0 && f.razon === OCULTO) && !porque.some((x) => x.endsWith(OCULTO)))
      porque.push(`Ojo: ${OCULTO}`);
    return { ...o, accion, turno: null, porque };
  });

  const candidatas = ds.filter((d) => d.accion !== "descartar");
  const n = cap ?? candidatas.length;
  const cierre = (d: Decision) => Date.parse(d.proceso.fechas.cierre ?? "") || Infinity;
  const agenda = candidatas.slice(0, n).sort((x, y) => cierre(x) - cierre(y) || y.puntaje - x.puntaje);
  agenda.forEach((d, i) => (d.turno = i + 1));
  const sinCupo = candidatas.slice(n);
  for (const d of sinCupo) d.porque.push(`No entra en tu capacidad de ${n}: hay ${n} con mejor puntaje.`);
  return [...agenda, ...sinCupo, ...ds.filter((d) => d.accion === "descartar")];
}

// ── Calibrar con las decisiones del equipo ───────────────────────────────────────────────────────────────────────

export interface DecisionEquipo {
  codigo: string;
  decision: "postular" | "descartar";
}

export interface CambioDePeso {
  factor: NombreFactor;
  /** Peso normalizado (suman 1) antes y después. */
  de: number;
  a: number;
  razon: string;
}

export type Calibracion =
  | { postuladas: number; descartadas: number; insuficiente: true; motivo: "pocas decisiones"; supuestos: string[] }
  | {
      postuladas: number;
      descartadas: number;
      /** Fracción de pares (postulada, descartada) en que el radar puso más arriba la postulada. 1 = calza siempre. */
      acuerdo: number;
      acuerdoSugerido: number;
      /** En la escala de los pesos del perfil, listos para pegar. Iguales a los actuales si nada mejora lo suficiente. */
      pesosSugeridos: Record<NombreFactor, number>;
      cambios: CambioDePeso[];
      /** Decisiones del equipo que contradicen la acción que habría sugerido el radar. */
      desacuerdos: string[];
      supuestos: string[];
    };

/**
 * Compara lo que el equipo postuló y descartó con el puntaje del radar y propone pesos que calcen mejor. No cambia
 * el perfil: propone, con su porqué, y el equipo decide si lo acepta.
 *
 * Acuerdo = AUC: fracción de pares (postulada, descartada) en que la postulada saca más puntaje (empate = 0,5).
 * Búsqueda por coordenadas, determinista: en cada paso prueba apagar, dividir por dos o duplicar cada peso (o
 * encender uno apagado) y aplica el mejor cambio mientras mejore al menos `mejoraMinima`.
 */
export function calibrar(procesos: Proceso[], perfil: Perfil, decisiones: DecisionEquipo[], opciones: Omit<OpcionesRadar, "incluirCerrados"> = {}): Calibracion {
  const a = ajustes(perfil);
  const decision = new Map(decisiones.map((d) => [d.codigo, d.decision]));
  const ops = priorizar(
    procesos.filter((p) => decision.has(p.codigo)),
    perfil,
    { ...opciones, incluirCerrados: true },
  );
  const supuestos = [
    "Acuerdo = fracción de pares (postulada, descartada) en que la postulada saca más puntaje; un empate cuenta 0,5 (AUC).",
    "Los factores se calculan con los datos de hoy, no con los del día en que se decidió: p. ej. los oferentes finales en vez de los que iban.",
    `Búsqueda por coordenadas: apagar, dividir por dos o duplicar un peso; se aplica el mejor cambio mientras mejore al menos ${dec(a.mejoraMinima)}.`,
  ];
  const sinProceso = decision.size - new Set(ops.map((o) => o.proceso.codigo)).size;
  if (sinProceso) supuestos.push(`${sinProceso} decisiones sin su proceso en los datos; se ignoraron.`);
  const P = ops.filter((o) => decision.get(o.proceso.codigo) === "postular");
  const D = ops.filter((o) => decision.get(o.proceso.codigo) === "descartar");
  if (P.length < a.decisionesMinimas || D.length < a.decisionesMinimas)
    return { postuladas: P.length, descartadas: D.length, insuficiente: true, motivo: "pocas decisiones", supuestos };

  const fp = P.map((o) => o.factores.map((f) => f.valor));
  const fd = D.map((o) => o.factores.map((f) => f.valor));
  const acuerdo = (w: number[]) => {
    const s = (f: number[]) => f.reduce((t, v, i) => t + v * w[i]!, 0);
    const sd = fd.map(s);
    let t = 0;
    for (const x of fp.map(s)) for (const y of sd) t += x > y ? 1 : x === y ? 0.5 : 0;
    return t / (fp.length * fd.length);
  };

  const w0 = P[0]!.factores.map((f) => f.peso);
  let w = w0;
  const inicial = acuerdo(w0);
  let actual = inicial;
  // ponytail: O(pasos × factores × P × D); sobra para cientos de decisiones. Con decenas de miles, ordenar y contar.
  for (let paso = 0; paso < 20; paso++) {
    let mejor: { w: number[]; v: number } | null = null;
    for (let i = 0; i < w.length; i++)
      for (const c of w[i] ? [0, w[i]! / 2, w[i]! * 2] : [1 / w.length]) {
        const n = w.map((x, j) => (j === i ? c : x));
        const total = n.reduce((s, x) => s + x, 0);
        if (!total) continue;
        const nn = n.map((x) => x / total);
        const v = acuerdo(nn);
        if (v > (mejor?.v ?? actual)) mejor = { w: nn, v };
      }
    if (!mejor || mejor.v - actual < a.mejoraMinima) break;
    ({ w, v: actual } = mejor);
  }

  const crudos = FACTORES.map((f) => perfil.pesos[f] ?? 0);
  const escala = crudos.reduce((s, x) => s + x, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const media = (fs: number[][], i: number) => fs.reduce((s, f) => s + f[i]!, 0) / fs.length;
  return {
    postuladas: P.length,
    descartadas: D.length,
    acuerdo: inicial,
    acuerdoSugerido: actual,
    pesosSugeridos: Object.fromEntries(FACTORES.map((f, i) => [f, r2(w[i]! * (Number.isFinite(escala) ? escala : 1))])) as Record<NombreFactor, number>,
    cambios: FACTORES.flatMap((factor, i) =>
      Math.abs(w[i]! - w0[i]!) < 1e-12
        ? []
        : [
            {
              factor,
              de: w0[i]!,
              a: w[i]!,
              razon: `${w[i]! > w0[i]! ? "Sube" : "Baja"} ${factor}: en las que postulaste vale en promedio ${dec(media(fp, i))}; en las que descartaste, ${dec(media(fd, i))}.`,
            },
          ],
    ),
    desacuerdos: [
      ...D.filter((o) => o.puntaje >= a.umbralPostular).map((o) => `${o.proceso.codigo}: la descartaste, pero el radar decía postular (puntaje ${dec(o.puntaje)}).`),
      ...P.filter((o) => o.puntaje < a.umbralRevisar).map((o) => `${o.proceso.codigo}: la postulaste, pero el radar decía descartar (puntaje ${dec(o.puntaje)}).`),
    ],
    supuestos,
  };
}

// ── Precios ──────────────────────────────────────────────────────────────────────────────────────────────────────

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

/** Precios unitarios en CLP de `codigoProducto` en una sola unidad, ordenados, y las notas de cómo se eligieron. */
function muestra(codigoProducto: number, compras: CompraAgil[], soloSeleccionadas: boolean, unidadPedida: string | undefined) {
  const notas: string[] = [];
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
  if (omitidos) notas.push(`Se omitieron ${omitidos} precios sin valor en CLP.`);

  let unidad: string | null;
  if (unidadPedida !== undefined) unidad = normUnidad(unidadPedida);
  else {
    // La más frecuente; empate → orden alfabético, para que sea determinista.
    const orden = [...porUnidad].sort(([a, x], [b, y]) => y.length - x.length || String(a).localeCompare(String(b)));
    unidad = orden[0]?.[0] ?? null;
    if (orden.length > 1)
      notas.push(
        `Hay precios en varias unidades (${orden.map(([u, xs]) => `${u ?? "sin unidad"}: ${xs.length}`).join(", ")}); se usó la más frecuente, ${unidad ?? "sin unidad"}. Pasa \`unidad\` para elegir otra.`,
      );
  }
  notas.push(`Mismo producto (${codigoProducto}) y misma unidad (${unidad ?? "sin unidad"}).`);
  return { xs: [...(porUnidad.get(unidad) ?? [])].sort((a, b) => a - b), unidad, notas };
}

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
  const { xs, unidad, notas } = muestra(codigoProducto, compras, soloSeleccionadas, opciones.unidad);
  const supuestos = [
    "Precios unitarios de productos_cotizados[].precio_unitario, tomados como netos (sin IVA ni despacho).",
    "La muestra solo incluye a quienes cotizaron; no es el precio de mercado.",
    "Montos en CLP al día del documento; se omiten los que no se pudieron convertir.",
    soloSeleccionadas
      ? "Solo cotizaciones seleccionadas: estima cuánto suele ganar. Cuando la API no informa la selección, solo se infiere si hubo una única cotización."
      : "Todas las cotizaciones, seleccionadas o no: estima cuánto se suele cotizar, no cuánto gana.",
    "La cotización no trae unidad: se usa la de productos_solicitados de la misma compra.",
    "Percentiles por interpolación lineal (Hyndman–Fan tipo 7, el de R y PERCENTIL.INC de Excel).",
    ...notas,
  ];
  if (!xs.length || xs.length < minimo) return { n: xs.length, insuficiente: true, motivo: "muestra insuficiente", supuestos };
  return { n: xs.length, p25: percentil(xs, 0.25), p50: percentil(xs, 0.5), p75: percentil(xs, 0.75), unidad, moneda: "CLP", soloSeleccionadas, supuestos };
}

export interface PuntoDePrecio {
  precio: number;
  /** Precios ganadores ≥ `precio`: las compras parecidas que habrías ganado cotizando eso. */
  ganadas: number;
  /** ganadas / n. */
  probabilidad: number;
  /** probabilidad × (precio − costo): ganancia esperada por unidad. */
  ganancia: number;
}

export type PrecioSugerido =
  | ({ n: number; costo: number; margen: number; unidad: string | null; moneda: "CLP"; curva: PuntoDePrecio[]; supuestos: string[] } & PuntoDePrecio)
  | { n: number; insuficiente: true; motivo: "muestra insuficiente" | "costo sobre los precios ganadores"; supuestos: string[] };

/**
 * Precio unitario que maximiza la ganancia esperada contra los precios que ganaron antes en Compra Ágil:
 * P(ganar | x) = precios ganadores ≥ x / n, y se elige el x (entre los precios ganadores observados, donde la curva
 * cambia) que maximiza P · (x − costo). Empate: el más barato, que gana más seguido.
 */
export function precioSugerido(codigoProducto: number, compras: CompraAgil[], opciones: { costo: number; unidad?: string; minimo?: number }): PrecioSugerido {
  const { costo, minimo = MUESTRA_MINIMA } = opciones;
  if (!Number.isFinite(costo) || costo < 0) throw new RangeError("costo debe ser un número finito ≥ 0");
  const { xs, unidad, notas } = muestra(codigoProducto, compras, true, opciones.unidad);
  const supuestos = [
    "Precios ganadores: precio_unitario de las cotizaciones seleccionadas, netos (sin IVA ni despacho), en CLP al día del documento.",
    "Se gana si tu precio es ≤ al que ganó. Supone que el comprador elige por precio; en Compra Ágil también pesan plazo y calidad.",
    "Probabilidad = precios ganadores ≥ tu precio / total: frecuencia observada, no una predicción.",
    `Sugerido: el que maximiza probabilidad × (precio − costo), con costo ${clp(costo)} por unidad.`,
    ...notas,
  ];
  const n = xs.length;
  if (!n || n < minimo) return { n, insuficiente: true, motivo: "muestra insuficiente", supuestos };
  // xs ordenado: desde el primer índice i de cada precio distinto, ganan n − i.
  const curva = xs.flatMap((precio, i) => (i && xs[i - 1] === precio ? [] : [{ precio, ganadas: n - i, probabilidad: (n - i) / n, ganancia: ((n - i) / n) * (precio - costo) }]));
  const mejor = curva.reduce((m, c) => (c.ganancia > m.ganancia ? c : m));
  if (!(mejor.ganancia > 0)) return { n, insuficiente: true, motivo: "costo sobre los precios ganadores", supuestos };
  return { n, ...mejor, costo, margen: (mejor.precio - costo) / mejor.precio, unidad, moneda: "CLP", curva, supuestos };
}

// ── Competidores ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface Competidor {
  proveedor: Proveedor;
  /** Procesos en que aparece. En OC y licitaciones solo se ve a quien ganó, así que ahí participar = ganar. */
  participaciones: number;
  victorias: number;
  /** victorias / participaciones. */
  tasa: number;
  /** Suma en CLP de lo ganado, cuando se conoce. */
  montoGanado: number;
  /** victorias / victorias de todos. */
  cuota: number;
  eresTu: boolean;
}

export interface Competencia {
  procesos: number;
  victorias: number;
  /** Herfindahl–Hirschman sobre las cuotas de victorias: 0 a 10.000. null sin victorias. */
  hhi: number | null;
  lectura: string;
  competidores: Competidor[];
  supuestos: string[];
}

/** Quién gana, cuánto y con qué concentración, en los procesos del historial que pasan el filtro. */
export function competidores(
  historial: Proceso[],
  filtro: { rubros?: (number | string)[]; organismos?: string[]; regiones?: number[]; rut?: string } = {},
): Competencia {
  const rubros = rubrosValidos(filtro.rubros);
  const pasa = (p: Proceso) =>
    (!rubros.length || p.items.some((i) => i.codigoProducto !== null && rubros.some((r) => String(i.codigoProducto).startsWith(r)))) &&
    (!filtro.organismos?.length || filtro.organismos.includes(p.comprador?.codigoOrganismo ?? "")) &&
    (!filtro.regiones?.length || filtro.regiones.includes(p.comprador?.region ?? -1));
  // Filtra después de juntar, para que una OC se anote en su proceso de origen aunque la OC no traiga ítems.
  const filas = participaciones(historial, AJUSTES).filter((x) => pasa(x.proceso));
  const yo = filtro.rut ? claveProveedor({ rut: filtro.rut, nombre: null, codigo: null }) : null;
  const m = new Map<string, Competidor>();
  for (const x of filas) {
    const c = m.get(x.clave) ?? { proveedor: x.proveedor, participaciones: 0, victorias: 0, tasa: 0, montoGanado: 0, cuota: 0, eresTu: x.clave === yo };
    c.participaciones++;
    if (x.gano) {
      c.victorias++;
      c.montoGanado += x.montoClp ?? 0;
    }
    m.set(x.clave, c);
  }
  const victorias = filas.filter((x) => x.gano).length;
  const lista = [...m.entries()]
    .map(([clave, c]) => ({ clave, c: { ...c, tasa: c.victorias / c.participaciones, cuota: victorias ? c.victorias / victorias : 0 } }))
    .sort((x, y) => y.c.victorias - x.c.victorias || y.c.montoGanado - x.c.montoGanado || x.clave.localeCompare(y.clave))
    .map((x) => x.c);
  const hhi = victorias ? lista.reduce((s, c) => s + (c.cuota * 100) ** 2, 0) : null;
  return {
    procesos: new Set(filas.map((x) => x.proceso.codigo)).size,
    victorias,
    hhi,
    lectura:
      hhi === null
        ? "Sin adjudicaciones registradas."
        : hhi < 1500
          ? "Competido: nadie domina."
          : hhi <= 2500
            ? "Moderadamente concentrado."
            : `Concentrado: ${lista[0]!.eresTu ? (lista[0]!.proveedor.nombre ?? "tu empresa") : nombreVisible(lista[0]!.proveedor, "un")} y pocos más se llevan casi todo.`,
    competidores: lista,
    supuestos: [
      "Compra Ágil: participa quien cotizó y gana la cotización seleccionada. Licitaciones y OC: solo se ve a quien ganó.",
      "Una OC que viene de un proceso de los datos se cuenta en ese proceso, no dos veces.",
      "Los procesos todavía abiertos no cuentan.",
      "HHI = Σ (cuota de victorias × 100)²: bajo 1.500 competido, sobre 2.500 concentrado.",
    ],
  };
}

// ── Lo que viene ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface CompraEsperada {
  organismo: { codigo: string; nombre: string | null };
  region: number | null;
  /** Familia UNSPSC (4 dígitos). */
  familia: string;
  /** Compras en días distintos. */
  veces: number;
  /** Mediana de días entre compras. */
  cadaDias: number;
  ultima: string;
  /** Ventana en que debería salir la próxima: última + intervalo mínimo … última + intervalo máximo. */
  desde: string;
  hasta: string;
  razon: string;
}

/**
 * Compras que se repiten: por organismo y familia UNSPSC, los días en que se publicó algo; si hay al menos
 * `comprasMinimas` y los intervalos son regulares, la próxima debería salir entre última + mínimo y última + máximo.
 * Solo devuelve las ventanas que no han terminado, ordenadas por inicio.
 */
export function proximasCompras(
  historial: Proceso[],
  opciones: { ahora?: Date; rubros?: (number | string)[] } & Partial<Pick<Ajustes, "comprasMinimas" | "irregularidadMaxima">> = {},
): CompraEsperada[] {
  const a = ajustes(opciones);
  const hoy = diaSantiago(opciones.ahora ?? new Date());
  const rubros = rubrosValidos(opciones.rubros);
  // Una OC que viene de un proceso de los datos es la misma compra: se cuenta el proceso.
  const codigos = new Set(historial.map((p) => p.codigo));
  const grupos = new Map<string, { organismo: CompraEsperada["organismo"]; region: number | null; dias: Set<string> }>();
  for (const p of historial) {
    const org = p.comprador?.codigoOrganismo;
    const dia = (p.fechas.publicacion ?? p.fechas.creacion)?.slice(0, 10);
    if (!org || !dia || (p.tipo === "orden_compra" && p.procesoOrigen && codigos.has(p.procesoOrigen))) continue;
    for (const i of p.items) {
      const c = i.codigoProducto === null ? "" : String(i.codigoProducto);
      if (!c || (rubros.length && !rubros.some((r) => c.startsWith(r)))) continue;
      const k = `${org}|${c.slice(0, 4)}`;
      if (!grupos.has(k)) grupos.set(k, { organismo: { codigo: org, nombre: p.comprador!.nombreOrganismo }, region: p.comprador!.region, dias: new Set() });
      grupos.get(k)!.dias.add(dia);
    }
  }
  const r: CompraEsperada[] = [];
  for (const [k, g] of grupos) {
    const dias = [...g.dias].sort();
    if (dias.length < a.comprasMinimas) continue;
    const gaps = dias.slice(1).map((d, i) => Math.round((Date.parse(d) - Date.parse(dias[i]!)) / 86_400_000)).sort((x, y) => x - y);
    const mediana = percentil(gaps, 0.5);
    const [min, max] = [gaps[0]!, gaps.at(-1)!];
    if (max - min > a.irregularidadMaxima * mediana) continue;
    const ultima = dias.at(-1)!;
    const hasta = sumarDias(ultima, max);
    if (hasta < hoy) continue;
    const familia = k.slice(k.lastIndexOf("|") + 1);
    const cada = Math.round(mediana);
    r.push({
      organismo: g.organismo,
      region: g.region,
      familia,
      veces: dias.length,
      cadaDias: cada,
      ultima,
      desde: sumarDias(ultima, min),
      hasta,
      razon: `${g.organismo.nombre ?? g.organismo.codigo} compró de la familia ${familia} ${dias.length} veces, cada ~${cada} días (entre ${min} y ${max}); la última, el ${ultima}.`,
    });
  }
  return r.sort((x, y) => x.desde.localeCompare(y.desde) || x.organismo.codigo.localeCompare(y.organismo.codigo) || x.familia.localeCompare(y.familia));
}

/** Dinero en pesos chilenos para los textos del radar: `$1.234.567`. */
export const pesos = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

/**
 * Resumen del radar sobre todo lo que hay en un store: lo abierto se decide, lo cerrado es historial.
 * Sin `raw` ni `personales`: nada de datos de funcionarios en la salida.
 */
export function resumenRadar(todos: Proceso[], perfil: Perfil, opciones: { decisiones?: DecisionEquipo[]; ahora?: Date } = {}) {
  const ahora = opciones.ahora ?? new Date();
  const compras = todos.filter((p) => p.tipo === "compra_agil");
  // Precio del primer ítem con datos: sugerido si el perfil trae su costo, si no el rango de lo que ganó.
  const precio = (d: Decision) => {
    if (d.accion === "descartar") return null;
    for (const c of new Set(d.proceso.items.map((i) => i.codigoProducto).filter((c): c is number => c !== null))) {
      const costo = perfil.costos?.[String(c)];
      if (costo !== undefined) {
        const s = precioSugerido(c, compras, { costo });
        if (!("insuficiente" in s))
          return { codigoProducto: c, texto: `${pesos(s.precio)} por ${s.unidad ?? "unidad"}: con ese precio habrías ganado ${s.ganadas} de ${s.n} compras parecidas, margen ${Math.round(s.margen * 100)} %`, detalle: s };
      }
      const r = rangoDePrecio(c, compras, { soloSeleccionadas: true });
      if (!("insuficiente" in r))
        return { codigoProducto: c, texto: `lo que ganó va de ${pesos(r.p25)} a ${pesos(r.p75)} por ${r.unidad ?? "unidad"} (mediana ${pesos(r.p50)}, n = ${r.n}); pon el costo en el perfil para un precio sugerido`, detalle: r };
    }
    return null;
  };
  return {
    ahora: ahora.toISOString(),
    procesos: todos.length,
    decisiones: decidir(todos, perfil, { ahora, historial: todos }).map((d) => ({
      turno: d.turno,
      accion: d.accion,
      puntaje: Math.round(d.puntaje * 100) / 100,
      codigo: d.proceso.codigo,
      nombre: d.proceso.nombre,
      organismo: d.proceso.comprador?.nombreOrganismo ?? null,
      region: d.proceso.comprador?.region ?? null,
      montoClp: d.proceso.monto?.clp ?? null,
      cierre: d.proceso.fechas.cierre,
      porque: d.porque,
      precio: precio(d),
    })),
    proximas: proximasCompras(todos, { ahora, rubros: perfil.rubros }).filter((x) => !perfil.regiones?.length || perfil.regiones.includes(x.region ?? -1)),
    calibracion: opciones.decisiones && calibrar(todos, perfil, opciones.decisiones, { ahora, historial: todos }),
  };
}
export type ResumenRadar = ReturnType<typeof resumenRadar>;
