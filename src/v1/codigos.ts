// Tablas de códigos de la API v1 (docs/api-notes.md §2). Son abiertas: un código desconocido da null, nunca error.
// Las contradicciones de la documentación se resuelven aquí y solo aquí; cada una tiene su test en test/codigos.test.ts.
// Fuentes: [W] chilecompra.cl/api, [PL]/[PO] diccionarios PDF de licitaciones y OC, [OCDS] datos reales.
import type { Proceso } from "../modelo.js";
import { str } from "../util.js";

/** Glosa de un código en una tabla; null si el código no está o viene vacío. */
export function glosa(tabla: object, codigo: unknown): string | null {
  const k = str(codigo);
  if (k === null || !Object.hasOwn(tabla, k)) return null;
  const v: unknown = (tabla as Record<string, unknown>)[k];
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[1]) : null;
}

/** [slug, glosa]. */
type Estado = readonly [string, string];

// Corrección: [W] dice Revocada=18 y Suspendida=19; [OCDS] y la API real usan 15 y 16 (18 y 19 no se han visto). Se aceptan los cuatro.
// La glosa de 7 es la que manda la API real.
// 9, 11, 12 y 14 solo aparecen en [OCDS] (statusDetails "9-Adjudicada", "11-Cerrada"…).
export const ESTADO_LICITACION = {
  5: ["publicada", "Publicada"],
  6: ["cerrada", "Cerrada"],
  7: ["desierta", "Desierta (o art. 3 ó 9 Ley 19.886)"],
  8: ["adjudicada", "Adjudicada"],
  9: ["adjudicada", "Adjudicada"],
  11: ["cerrada", "Cerrada"],
  12: ["cerrada", "Cerrada"],
  14: ["cerrada", "Cerrada"],
  15: ["revocada", "Revocada"],
  16: ["suspendida", "Suspendida"],
  18: ["revocada", "Revocada"],
  19: ["suspendida", "Suspendida"],
} as const satisfies Record<number, Estado>;

// [W]; 4, 6, 9 y 12 confirmados en [OCDS].
export const ESTADO_OC = {
  4: ["enviada_proveedor", "Enviada a Proveedor"],
  5: ["en_proceso", "En proceso"],
  6: ["aceptada", "Aceptada"],
  9: ["cancelada", "Cancelada"],
  12: ["recepcion_conforme", "Recepción Conforme"],
  13: ["pendiente_recepcion", "Pendiente de Recepcionar"],
  14: ["recepcion_parcial", "Recepcionada Parcialmente"],
  15: ["recepcion_conforme_incompleta", "Recepción Conforme Incompleta"],
} as const satisfies Record<number, Estado>;

/** Valores del parámetro `estado` de licitaciones.json: se envían tal cual, en minúscula ([W]). */
export const ESTADOS_FILTRO_LICITACION = ["publicada", "cerrada", "desierta", "adjudicada", "revocada", "suspendida", "todos", "activas"] as const;
export type EstadoFiltroLicitacion = (typeof ESTADOS_FILTRO_LICITACION)[number];

// Corrección: [W] escribe dos valores con errata ("recepcionaceptadacialmente", "recepecionconformeincompleta").
// Se envían literal porque es lo único documentado; no se sabe si el server acepta la grafía correcta.
// "en_proceso" (código 5) no tiene valor de filtro.
export const ESTADO_FILTRO_OC = {
  enviada_proveedor: "enviadaproveedor",
  aceptada: "aceptada",
  cancelada: "cancelada",
  recepcion_conforme: "recepcionconforme",
  pendiente_recepcion: "pendienterecepcion",
  recepcion_parcial: "recepcionaceptadacialmente",
  recepcion_conforme_incompleta: "recepecionconformeincompleta",
  todos: "todos",
} as const;
export type EstadoFiltroOC = keyof typeof ESTADO_FILTRO_OC;

/** Estado normalizado; si el código no está en la tabla, slug de la glosa que trajo la API (o "desconocido") y glosa null. */
export function estado(tabla: Record<number, Estado>, codigo: unknown, texto?: unknown): { estado: string; glosa: string | null } {
  const k = str(codigo);
  const e = k !== null && Object.hasOwn(tabla, k) ? (tabla as Record<string, Estado>)[k] : undefined;
  if (e) return { estado: e[0], glosa: e[1] };
  return { estado: slug(texto) ?? "desconocido", glosa: null };
}

function slug(x: unknown): string | null {
  const t = str(x)?.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return t || null;
}

// Corrección: LQ, LR, H2 e I2 solo están en [PL]; por eso LP y B2 son "<2.000 UTM" ([PL]) y no "mayor a 1.000" ([W]).
// O1/O2 solo aparecen en [OCDS]. Los de dos letras al final son tipologías antiguas que solo lista [W].
export const TIPO_LICITACION = {
  L1: "Licitación Pública menor a 100 UTM",
  LE: "Licitación Pública igual o superior a 100 UTM e inferior a 1.000 UTM",
  LP: "Licitación Pública igual o superior a 1.000 UTM e inferior a 2.000 UTM",
  LQ: "Licitación Pública igual o superior a 2.000 UTM e inferior a 5.000 UTM",
  LR: "Licitación Pública igual o superior a 5.000 UTM",
  LS: "Licitación Pública de servicios personales especializados",
  E2: "Licitación Privada menor a 100 UTM",
  CO: "Licitación Privada igual o superior a 100 UTM e inferior a 1.000 UTM",
  B2: "Licitación Privada igual o superior a 1.000 UTM e inferior a 2.000 UTM",
  H2: "Licitación Privada igual o superior a 2.000 UTM e inferior a 5.000 UTM",
  I2: "Licitación Privada mayor a 5.000 UTM",
  O1: "Licitación Pública MOP",
  O2: "Licitación Privada MOP",
  R1: "Orden de compra menor a 3 UTM",
  A1: "Licitación Privada por licitación pública anterior sin oferentes",
  B1: "Licitación Privada por otras causales",
  J1: "Licitación Privada por servicios de naturaleza confidencial",
  F1: "Licitación Privada por convenios con personas jurídicas extranjeras",
  E1: "Licitación Privada por remanente de contrato",
  A2: "Trato Directo por licitación privada sin oferentes o desierta",
  D1: "Trato Directo por proveedor único",
  C2: "Trato Directo (cotización)",
  F2: "Trato Directo (cotización)",
  G2: "Directo (cotización)",
  C1: "Compra Directa (orden de compra)",
  F3: "Compra Directa (orden de compra)",
  G1: "Compra Directa (orden de compra)",
  CA: "Orden de compra sin resolución",
  SE: "Orden de compra sin emisión automática",
} as const;

/**
 * Tipo desde el código del proceso ("1509-5-L114" → "L1"), solo como respaldo para listados que no traen `Tipo`.
 * El sufijo no siempre es el tipo: "1469-227-R126" es L1 y los "-R226" son LE o LP, así que R1/R2 dan null.
 */
export function tipoDesdeCodigo(codigo: unknown): string | null {
  const t = sufijo(codigo);
  return t === null || /^R\d$/.test(t) ? null : t;
}

/** Sufijo del código sin los dos dígitos del año ("1509-5-L114" → "L1", "1057539-228-COT26" → "COT"); null si no es un código. */
function sufijo(codigo: unknown): string | null {
  return /^\d+-\d+-([A-Z]+\d?)\d{2}$/.exec(str(codigo) ?? "")?.[1] ?? null;
}

// SE está en TIPO_OC y en TIPO_LICITACION, pero las cuatro muestras reales con SE son orden_compra (test/codigos.test.ts).
const SUFIJO_OC_EN_LICITACION = new Set(["SE"]);

/**
 * Familia del proceso desde su código ("1509-5-L114" → "licitacion", "1057539-228-COT26" → "compra_agil"); null si no es un código.
 * ponytail: los sufijos ambiguos (CA, R1, D1…) caen en licitación; si el proceso no aparece ahí, el caller prueba orden_compra.
 */
export function familiaDesdeCodigo(codigo: string): Proceso["tipo"] | null {
  const s = sufijo(codigo);
  if (s === null) return null;
  if (s === "COT" || s === "FTD") return "compra_agil";
  const esOC = Object.values(TIPO_OC).some(([abrev]) => abrev === s);
  if (SUFIJO_OC_EN_LICITACION.has(s) || (esOC && !Object.hasOwn(TIPO_LICITACION, s))) return "orden_compra";
  return "licitacion";
}

/** URL pública de la ficha del proceso, para citar fuentes; null si no hay URL confirmada. */
export function urlPublica(tipo: Proceso["tipo"], codigo: string): string | null {
  if (tipo === "licitacion") return `https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(codigo)}`;
  if (tipo === "orden_compra") return `https://www.mercadopublico.cl/PurchaseOrder/Modules/PO/DetailsPurchaseOrder.aspx?codigoOC=${encodeURIComponent(codigo)}`;
  // La URL pública de Compra Ágil todavía no está confirmada.
  return null;
}

// Corrección: [PL] dice 2=Privada, pero la API real manda 3 para las privadas (CO, I2, B2, E2). Se aceptan ambos.
export const CODIGO_TIPO_LICITACION = { 1: "Pública", 2: "Privada", 3: "Privada" } as const;

// Corrección: en la tabla de OC de [W] las glosas de UTM y EUR están invertidas; vale [PL]/[PO].
export const MONEDA = { CLP: "Peso", CLF: "Unidad de Fomento", USD: "Dólar", UTM: "Unidad Tributaria Mensual", EUR: "Euro" } as const;

// [W] trae 1 y 2; el 3 solo está en [PL].
export const ESTIMACION = { 1: "Presupuesto Disponible", 2: "Precio Referencial", 3: "Monto no es posible de estimar" } as const;

// Corrección: [PL] y [W] no coinciden del 5 al 10. Vale [PL], el diccionario más reciente (marzo 2026).
export const MODALIDAD_PAGO = {
  1: "Pago a 30 días",
  2: "Pago a 30, 60 y 90 días",
  3: "Pago al día",
  4: "Pago Anual",
  5: "Pago Bimensual",
  6: "Contra Entrega Conforme",
  7: "Pagos Mensuales",
  8: "Por Estado de Avance",
  9: "Pago Trimestral",
  10: "Pago a 60 días",
} as const;

export const UNIDAD_TIEMPO = { 1: "Horas", 2: "Días", 3: "Semanas", 4: "Meses", 5: "Años" } as const;

// Corrección: [W] invierte 3 y 5 (3 Otros, 5 Acuerdo). Vale [PL].
export const TIPO_ACTO_ADJUDICACION = { 1: "Autorización", 2: "Resolución", 3: "Acuerdo", 4: "Decreto", 5: "Otros" } as const;

// Corrección: [PL] dice 0=No, 2=Sí; [W] dice 1=No, 2=Sí (con ejemplo <Obras>0</Obras>). Ambos coinciden en 2=Sí.
export const OBRAS = { 0: "No", 1: "No", 2: "Sí" } as const;

// Corrección: [PL] dice 1=requiere suscripción de contrato, 2=se formaliza con OC (solo LE); [W] lo da como binario
// con ejemplo "NO". Vale [PL] y se acepta 0/"NO" de [W].
export const CONTRATO = { 0: "No", NO: "No", SI: "Sí", 1: "Requiere suscripción de contrato", 2: "Se formaliza con la orden de compra" } as const;

/** [abreviación, glosa], según [W]. [PO] solo trae 8 y 9. */
export const TIPO_OC = {
  1: ["OC", "Automática"],
  2: ["D1", "Trato directo por proveedor único"],
  3: ["C1", "Trato directo por emergencia"],
  4: ["F3", "Trato directo por confidencialidad"],
  5: ["G1", "Trato directo por naturaleza de la negociación"],
  6: ["R1", "Orden de compra menor a 3 UTM"],
  7: ["CA", "Orden de compra sin resolución"],
  8: ["SE", "Sin emisión automática"],
  9: ["CM", "Convenio Marco"],
  10: ["FG", "Trato directo art. 8 letras f y g"],
  11: ["TL", "Convenio Marco Tienda de Libros"],
  12: ["MC", "Microcompra"],
  13: ["AG", "Compra Ágil"],
  14: ["CC", "Compra Coordinada"],
  // 16 y 17 solo en la API real: TD ("Orden de Compra generada por Trato Directo ID …-FTD26") y CT (sin glosa documentada).
  16: ["TD", "Trato directo"],
  17: ["CT", "CT (sin glosa documentada)"],
} as const satisfies Record<number, readonly [string, string]>;

/** `CodigoEstadoProveedor` de OC, según la API real (no está en [W] ni [PO]). */
export const ESTADO_PROVEEDOR_OC = { 1: "Nueva orden de compra", 2: "En proceso", 4: "Aceptada", 5: "Cancelada", 7: "Recepción Conforme" } as const;

export const TIPO_DESPACHO = {
  7: "Despachar a dirección de envío",
  9: "Despachar según programa adjunto",
  12: "Otra forma de despacho, ver instrucciones",
  14: "Retiramos de su bodega",
  20: "Despacho por courier vía aéreo",
  21: "Despacho por courier vía terrestre",
  22: "A convenir",
} as const;

// [PO] trae 1, 2, 39, 46 y 47; 48 y 49 solo están en [W].
export const FORMA_PAGO = { 1: "15 días contra la recepción de la factura", 2: "30 días contra la recepción de la factura", 39: "Otra forma de pago", 46: "50 días contra la recepción de la factura", 47: "60 días contra la recepción de la factura", 48: "A 45 días", 49: "A más de 30 días" } as const;

export const REGION = {
  1: "Tarapacá",
  2: "Antofagasta",
  3: "Atacama",
  4: "Coquimbo",
  5: "Valparaíso",
  6: "O'Higgins",
  7: "Maule",
  8: "Biobío",
  9: "Araucanía",
  10: "Los Lagos",
  11: "Aysén",
  12: "Magallanes",
  13: "Metropolitana",
  14: "Los Ríos",
  15: "Arica y Parinacota",
  16: "Ñuble",
} as const;

const CLAVES_REGION: [RegExp, number][] = [
  [/arica/, 15], [/tarapaca/, 1], [/antofagasta/, 2], [/atacama/, 3], [/coquimbo/, 4], [/valparaiso/, 5],
  [/higgins/, 6], [/maule/, 7], [/nuble/, 16], [/bio.?bio/, 8], [/araucania/, 9], [/los rios/, 14],
  [/los lagos/, 10], [/aysen|aisen/, 11], [/magallanes/, 12], [/metropolitana|santiago/, 13],
];

/** Código de región (1 a 16) desde el nombre que trae la v1 ("Región Metropolitana de Santiago") o desde el número. */
export function regionCodigo(x: unknown): number | null {
  const t = str(x);
  if (t === null) return null;
  if (/^\d+$/.test(t)) return Object.hasOwn(REGION, t) ? Number(t) : null;
  const n = t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return CLAVES_REGION.find(([re]) => re.test(n))?.[1] ?? null;
}
