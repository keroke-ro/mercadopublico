// OCDS → modelo, en streaming: los archivos de OCP llegan a 2,9 GB. Ver docs/api-notes.md §5.
import { MercadoPublicoError } from "./errores.js";
import { normalizarFecha } from "./fecha.js";
import type { Comprador, Item, Licitacion, OrdenCompra, Proceso, Proveedor } from "./modelo.js";
import { monto, num, str } from "./util.js";
import { ESTADO_LICITACION, ESTADO_OC, TIPO_LICITACION, estado, glosa, regionCodigo, tipoDesdeCodigo } from "./v1/codigos.js";

const PREFIJO = "ocds-70d2nz-";
/** Sufijos de código cuya release es una OC (el award es la OC), no una licitación. */
const TIPOS_OC: ReadonlySet<string> = new Set(["TD", "CM"]);
/** `tender.status` estándar → código de ESTADO_LICITACION, para releases sin `statusDetails` (licitaciones antiguas). */
const ESTADO_TENDER: Record<string, number> = { active: 5, complete: 8, unsuccessful: 7, cancelled: 15 };

/** Espejo de Open Contracting Partnership: gzip, una compiled release por línea. */
export function urlOcds(anio: number | "full"): string {
  return `https://data.open-contracting.org/en/publication/144/download?name=${anio}.jsonl.gz`;
}

/**
 * Claves con datos personales dentro de `raw`, para `ocultarPersonales` (se tapa `contactPoint` entero).
 * Los nombres de persona natural en `suppliers[].name` sí van a `personales`, pero no se pueden tapar en `raw`
 * por clave sin borrar también todos los `name` del documento.
 */
export const CAMPOS_PERSONALES_OCDS: readonly string[] = ["contactPoint"];

export interface OpcionesOcds {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Línea que no se pudo leer o traducir; se salta y se sigue. `numero` parte en 1. */
  alError?: (linea: string, error: unknown, numero: number) => void;
}

/**
 * Lee un .jsonl o .jsonl.gz (se detecta por los bytes mágicos, no por el nombre) línea a línea, sin cargarlo
 * en memoria. Acepta compiled releases, record packages (`records[].compiledRelease`) y release packages.
 */
export async function* leerOcds(
  fuente: ReadableStream<Uint8Array> | Response | string,
  opciones: OpcionesOcds = {},
): AsyncGenerator<Proceso> {
  let n = 0;
  for await (const linea of lineas(await cuerpo(fuente, opciones))) {
    n++;
    if (!linea.trim()) continue;
    let ps: Proceso[];
    try {
      ps = desdeOcds(JSON.parse(linea));
    } catch (e) {
      opciones.alError?.(linea, e, n);
      continue;
    }
    yield* ps;
  }
}

/** Un JSON OCDS ya parseado → procesos. Sirve para los `{codigo}.json` del 7z del publisher. Lanza si no es OCDS. */
export function desdeOcds(json: unknown): Proceso[] {
  const o = obj(json);
  if (Array.isArray(o.records)) return lista(o.records).map((r) => proceso(obj(r.compiledRelease)));
  if (Array.isArray(o.releases)) return lista(o.releases).map(proceso);
  return [proceso(o)];
}

async function cuerpo(fuente: ReadableStream<Uint8Array> | Response | string, o: OpcionesOcds): Promise<ReadableStream<Uint8Array>> {
  if (fuente instanceof ReadableStream) return fuente;
  const res = typeof fuente === "string" ? await (o.fetch ?? fetch)(fuente, { signal: o.signal }) : fuente;
  if (!res.ok) throw new MercadoPublicoError(res.status === 404 ? "no_encontrado" : "servidor", `HTTP ${res.status} al descargar OCDS`, { status: res.status });
  return res.body ?? new ReadableStream();
}

async function descomprimir(s: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const lector = s.getReader();
  // Junta al menos 2 bytes para mirar la cabecera gzip (1f 8b), aunque lleguen en trozos de 1 byte.
  const cabeza: Uint8Array[] = [];
  let n = 0;
  while (n < 2) {
    const r = await lector.read();
    if (r.done) break;
    cabeza.push(r.value);
    n += r.value.length;
  }
  const primero = new Uint8Array(n);
  cabeza.reduce((i, c) => (primero.set(c, i), i + c.length), 0);
  const plano = new ReadableStream<Uint8Array>({
    start(c) {
      if (n) c.enqueue(primero);
    },
    async pull(c) {
      const r = await lector.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel: (motivo) => lector.cancel(motivo),
  });
  return primero[0] === 0x1f && primero[1] === 0x8b ? plano.pipeThrough(new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>) : plano;
}

async function* lineas(s: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const lector = (await descomprimir(s)).pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>).getReader();
  let resto = "";
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      // Solo se parte el trozo nuevo; `resto` se concatena sin volver a recorrerlo (líneas de varios MB).
      const partes = value.split("\n");
      partes[0] = resto + partes[0];
      resto = partes.pop() ?? "";
      yield* partes;
    }
    if (resto) yield resto;
  } finally {
    await lector.cancel().catch(() => {});
  }
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const lista = (x: unknown): Obj[] => (Array.isArray(x) ? x.map(obj) : []);

/**
 * ponytail: las fechas OCDS de ChileCompra traen "Z", pero se leen como hora de pared de Santiago (se descarta la Z).
 * Su base guarda hora local sin huso, así que lo más probable es que la Z sea solo una etiqueta, y esta lectura
 * deja el día tal como lo publicó ChileCompra (leerlas como UTC correría de día lo publicado después de las 20-21 h).
 * Si se confirma que son UTC reales, cambiar a `normalizarFecha(str(x))`; esta es la única función que lo decide.
 */
function fecha(x: unknown): string | null {
  try {
    return normalizarFecha(str(x)?.replace(/Z$/, ""));
  } catch {
    return null;
  }
}

/** "612020000" (CL-RUT, sin puntos ni guion) → "61202000-0". */
function rut(p: Obj | undefined): string | null {
  const i = obj(p?.identifier);
  const id = i.scheme === "CL-RUT" ? str(i.id) : null;
  return id && !id.includes("-") ? `${id.slice(0, -1)}-${id.slice(-1).toUpperCase()}` : id;
}

const sinMp = (id: unknown) => str(id)?.replace(/^CL-MP-/, "") ?? null;

/** "8-Adjudicada" → estado de la tabla por código; la glosa es la que publicó ChileCompra. */
function estadoOcds(tabla: typeof ESTADO_LICITACION | typeof ESTADO_OC, detalle: unknown, respaldo?: number) {
  const m = /^(\d+)\s*-\s*(.*)$/.exec(str(detalle) ?? "");
  const e = estado(tabla, m?.[1] ?? respaldo, m?.[2]);
  return { estado: e.estado, estadoGlosa: str(m?.[2]) ?? e.glosa };
}

/** El comprador viene como `{id:"CL-MP-1996", name:"ORGANISMO | UNIDAD"}`; el resto, de su entrada en `parties`. */
function comprador(org: Obj, p: Obj | undefined): Comprador | null {
  const nombre = str(org.name) ?? str(p?.name);
  if (!nombre && !str(org.id)) return null;
  const [organismo, unidad] = (nombre ?? "").split(" | ");
  const dir = obj(p?.address);
  return {
    codigoOrganismo: null, // OCDS no lo trae: CL-MP-n y additionalIdentifiers apuntan a la unidad (.../Comprador/Unidad/n)
    nombreOrganismo: str(organismo),
    rutUnidad: rut(p),
    codigoUnidad: sinMp(org.id),
    nombreUnidad: str(unidad),
    region: regionCodigo(dir.region),
    comuna: str(dir.locality),
  };
}

function proveedor(s: Obj, p: Obj | undefined): Proveedor {
  return { rut: rut(p), nombre: str(str(s.name)?.split(" | ")[0]), codigo: sinMp(s.id) };
}

/** `adj` es el ítem del award, de donde salen precio y total; en una OC es el mismo ítem. */
function item(x: Obj, dia: string | null, prov: Proveedor | null = null, adj: Obj = x): Item {
  const c = obj(x.classification);
  const unitario = obj(obj(adj.unit).value);
  const neto = obj(lista(adj.valueBreakdown).find((b) => b.id === "net")?.value);
  return {
    codigoProducto: num(c.id) || null, // en CM viene "0"
    nombre: str(c.description) ?? str(x.description), // en tender.items, la glosa UNSPSC
    descripcion: str(adj.description) ?? str(x.description), // en el award, lo que pidió el comprador
    cantidad: num(x.quantity),
    unidad: str(obj(x.unit).name),
    precioUnitario: monto(unitario.amount, unitario.currency, dia),
    total: monto(neto.amount, neto.currency, dia),
    proveedor: prov,
  };
}

function proceso(r: Obj): Proceso {
  const t = obj(r.tender);
  const codigo = str(t.id) ?? str(r.ocid)?.replace(PREFIJO, "");
  if (!codigo) throw new TypeError("No es una release OCDS: falta tender.id y ocid");
  const tipo = tipoDesdeCodigo(codigo);
  const partes = lista(r.parties);
  const parte = (id: unknown) => (id == null ? undefined : partes.find((p) => p.id === id));
  const awards = lista(r.awards);
  const a0 = awards[0] ?? {};
  // Hay sufijos de OC fuera de TD/CM (p. ej. CT); el award de una OC dice "N-Orden de Compra …".
  const esOC = (tipo !== null && TIPOS_OC.has(tipo)) || /orden de compra/i.test(str(a0.statusDetails) ?? "");
  const periodo = obj(t.tenderPeriod);
  const fechas = {
    creacion: esOC ? fecha(a0.date) : null,
    publicacion: fecha(periodo.startDate),
    cierre: fecha(periodo.endDate),
    adjudicacion: esOC ? null : fecha(a0.date),
    ultimoCambio: fecha(r.date),
  };
  const dia = (fechas.publicacion ?? fechas.creacion)?.slice(0, 10) ?? null;
  const org = obj(r.buyer ?? t.procuringEntity);

  const personales: Record<string, string> = {};
  partes.forEach((p, i) => {
    for (const [k, v] of Object.entries(obj(p.contactPoint))) {
      const s = str(v);
      if (s) personales[`parties.${i}.contactPoint.${k}`] = s;
    }
  });
  // "EMPRESA | SUCURSAL": si el proveedor es persona natural, la segunda parte suele ser su nombre.
  awards.forEach((a, i) =>
    lista(a.suppliers).forEach((s, j) => {
      const nombre = str(s.name);
      const [empresa, sucursal] = (nombre ?? "").split(" | ");
      if (nombre && sucursal && sucursal !== empresa) personales[`awards.${i}.suppliers.${j}.name`] = nombre;
    }),
  );

  const base = {
    codigo,
    nombre: str(t.title) ?? str(a0.title) ?? codigo,
    descripcion: str(t.description) ?? (esOC ? str(a0.description) : null),
    comprador: comprador(org, parte(org.id)),
    fechas,
    personales: Object.keys(personales).length ? personales : null,
    origen: "ocds" as const,
    raw: r,
  };

  if (esOC) {
    const v = obj(a0.value);
    const s = lista(a0.suppliers)[0];
    const prov = s ? proveedor(s, parte(s.id)) : null;
    return {
      ...base,
      tipo: "orden_compra",
      ...estadoOcds(ESTADO_OC, a0.statusDetails),
      monto: monto(v.amountGross ?? v.amount, v.currency, dia), // total con impuestos, como `Total` de la v1
      items: awards.flatMap((a) => lista(a.items).map((it) => item(it, dia, prov))),
      oferentes: null,
      tipoOrden: tipo,
      proveedor: prov,
      procesoOrigen: str(lista(r.relatedProcesses)[0]?.identifier)?.replace(PREFIJO, "") ?? null,
    } satisfies OrdenCompra;
  }

  // Precio y proveedor de cada ítem salen del award que lo adjudicó (mismo `id` de ítem).
  const adjudicados = new Map<unknown, { it: Obj; prov: Proveedor | null }>();
  for (const a of awards) {
    const s = lista(a.suppliers)[0];
    const prov = s ? proveedor(s, parte(s.id)) : null;
    for (const it of lista(a.items)) adjudicados.set(it.id, { it, prov });
  }
  const v = obj(t.value);
  const tipoLicitacion = /\(([A-Z0-9]{2})\)\s*$/.exec(str(t.procurementMethodDetails) ?? "")?.[1] ?? tipo;
  return {
    ...base,
    tipo: "licitacion",
    ...estadoOcds(
      ESTADO_LICITACION,
      t.statusDetails ?? a0.statusDetails,
      ESTADO_TENDER[String(t.status)] ?? (a0.status === "active" ? 8 : undefined),
    ),
    monto: monto(v.amount, v.currency, dia),
    items: lista(t.items).map((it) => {
      const ad = adjudicados.get(it.id);
      return item(it, dia, ad?.prov ?? null, ad?.it);
    }),
    oferentes: num(t.numberOfTenderers) ?? (Array.isArray(t.tenderers) ? t.tenderers.length : null),
    tipoLicitacion,
    tipoLicitacionGlosa: str(t.procurementMethodDetails) ?? glosa(TIPO_LICITACION, tipoLicitacion),
  } satisfies Licitacion;
}
