// Compra Ágil v2 (snake_case) → modelo. Nunca lanza: lo que no se entiende queda en `raw`.
import type { Aviso } from "../eventos.js";
import type { CompraAgil, Cotizacion, Item, Monto } from "../modelo.js";
import { normalizarFecha } from "../fecha.js";
import { avisador, entero, exigir, monto, num, revisar, str, type Avisar, type Esquema } from "../util.js";
import { regionCodigo } from "../v1/codigos.js";

export type EstadoCompraAgil = "publicada" | "cerrada" | "desierta" | "cancelada" | "proveedor_seleccionado" | "oc_emitida";

const GLOSAS: Record<EstadoCompraAgil, string> = {
  publicada: "Publicada",
  cerrada: "Cerrada",
  desierta: "Desierta",
  cancelada: "Cancelada",
  proveedor_seleccionado: "Proveedor seleccionado",
  oc_emitida: "OC emitida",
};

/**
 * La v2 no publica contactos de funcionarios, así que `personales` queda en null.
 * Estos campos de `proveedores_cotizando[]` son datos personales cuando el proveedor es persona natural;
 * siguen en `raw` y en `cotizaciones[].proveedor`.
 */
export const CAMPOS_PERSONALES_V2: readonly string[] = ["rut_proveedor", "razon_social"];

// ── Campos conocidos (docs/api-notes.md §3 y test/fixtures/v2; la v2 aún no tiene fixtures grabados de la API real) ──
// Un mismo esquema para listado (`payload.items[]`) y detalle (`payload`): los del detalle no aparecen en el listado.

export const ESQUEMA_COMPRA_AGIL: Esquema = {
  codigo: "s",
  nombre: "s",
  descripcion: "s",
  estado: { id_estado: "*", codigo: "s", glosa: "s" },
  convocatoria: "*",
  documentos: "*",
  fechas: { fecha_publicacion: "s", fecha_cierre: "s", fecha_ultimo_cambio: "s", fecha_cancelacion: "*" },
  montos: { moneda: "m", monto_disponible: "n", monto_disponible_clp: "*" },
  presupuesto: {
    tipo_presupuesto: "*",
    moneda: "m",
    presupuesto_estimado: "n",
    monto_disponible: "n",
    monto_disponible_clp: "*",
    valor_cambio_moneda: "*",
    fecha_cambio_moneda: "*",
  },
  institucion: { organismo_comprador: "s", rut: "s", unidad_compra: "s", region: "n", nombre_region: "*" },
  resumen: { total_ofertas_recibidas: "n", multa_sancion: "*", total_demandas: "*" },
  motivos: "*",
  links: "*",
  entrega: "*",
  flags: "*",
  orden_compra: { id_orden_compra: "sn", id_oc: "sn", codigo_orden_compra: "s", estado_orden_compra: "*" },
  productos_solicitados: [{ codigo_producto: "sn", nombre: "s", descripcion: "s", cantidad: "sn", unidad_medida: "s" }],
  proveedores_cotizando: [
    {
      rut_proveedor: "s",
      razon_social: "s",
      codigo_empresa: "sn",
      moneda: "m",
      fecha_creacion: "s",
      monto_total: "n",
      productos_cotizados: [{ codigo_producto: "sn", nombre_producto: "s", descripcion: "*", cantidad: "sn", precio_unitario: "n", monto_total_producto: "*" }],
      seleccion: { proveedor_seleccionado: "b", motivo_seleccion: "*", criterio_seleccion: "*" },
      ...Object.fromEntries(
        ["es_emt", "id_cotizacion", "codigo_sucursal_empresa", "estado_por_comprador", "activo", "fecha_vigencia", "valor_neto", "total_impuesto",
          "monto_despacho", "nombre_impuesto", "porcentaje_impuesto", "descripcion_cotizacion", "descripcion", "justificacion_inadmisibilidad",
          "estado_cotizacion"].map((k) => [k, "*"]),
      ),
    },
  ],
};

const EXIGIDOS = ["codigo", "nombre", "estado.codigo", "fechas.fecha_publicacion"];
const EXIGIDOS_LISTADO = ["montos"];
const EXIGIDOS_DETALLE = ["presupuesto", "productos_solicitados", "proveedores_cotizando"];

function vigilar(raw: unknown, detalle: boolean, av: Avisar) {
  const ruta = detalle ? "payload" : "payload.items[]";
  revisar(raw, ESQUEMA_COMPRA_AGIL, ruta, av);
  exigir(raw, [...EXIGIDOS, ...(detalle ? EXIGIDOS_DETALLE : EXIGIDOS_LISTADO)], ruta, av);
  const e = str(obj(obj(raw).estado).codigo);
  if (e !== null && !Object.hasOwn(GLOSAS, e)) av("valor_desconocido", `${ruta}.estado.codigo`, `estado ${e.slice(0, 40)}`);
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

function fecha(x: unknown): string | null {
  try {
    return normalizarFecha(str(x));
  } catch {
    return null;
  }
}

/** `avisar` recibe los cambios de forma que note (campos nuevos o faltantes, tipos, códigos); no cambia el resultado. */
export function parseCompraAgil(raw: unknown, { detalle, avisar }: { detalle: boolean; avisar?: (a: Aviso) => void }): CompraAgil {
  const r = obj(raw);
  const av = avisador("v2", r.codigo, avisar);
  if (av)
    try {
      vigilar(raw, detalle, av);
    } catch {
      // un aviso nunca detiene el parseo
    }
  const est = obj(r.estado);
  const f = obj(r.fechas);
  const inst = obj(r.institucion);
  const oc = obj(r.orden_compra);
  // Listado: `montos`; detalle: `presupuesto` (que puede traer solo `presupuesto_estimado`).
  const pre = { ...obj(r.montos), ...obj(r.presupuesto) };

  const estado = str(est.codigo) ?? (typeof r.estado === "string" ? str(r.estado) : null) ?? "desconocido";
  const publicacion = fecha(f.fecha_publicacion);
  const dia = publicacion?.slice(0, 10) ?? null;
  const mon = pre.moneda;

  const items: Item[] = arr(r.productos_solicitados).map((x) => {
    const p = obj(x);
    return {
      codigoProducto: entero(p.codigo_producto) || null,
      nombre: str(p.nombre),
      descripcion: str(p.descripcion),
      cantidad: num(p.cantidad),
      unidad: str(p.unidad_medida),
      precioUnitario: null,
      total: null,
      proveedor: null,
    };
  });

  const crudas = arr(r.proveedores_cotizando).map(obj);
  const conSeleccion = estado === "proveedor_seleccionado" || estado === "oc_emitida";
  const cotizaciones: Cotizacion[] = crudas.map((c) => {
    // La guía no dice la moneda de la cotización; se asume la del presupuesto.
    const m = c.moneda ?? mon;
    const d = fecha(c.fecha_creacion)?.slice(0, 10) ?? dia;
    const precio = (v: unknown): Monto | null => monto(v, m, d);
    const sel = obj(c.seleccion).proveedor_seleccionado;
    return {
      proveedor: { rut: str(c.rut_proveedor), nombre: str(c.razon_social), codigo: str(c.codigo_empresa) },
      monto: precio(c.monto_total), // con impuesto y despacho; el neto queda en raw.valor_neto
      // `seleccion.proveedor_seleccionado` está documentado pero "no confirmado en la respuesta real".
      // Si no viene, solo se infiere cuando no hay ambigüedad: una única cotización en una compra con proveedor elegido.
      seleccionada: typeof sel === "boolean" ? sel : conSeleccion && crudas.length === 1,
      productos: arr(c.productos_cotizados).map((x) => {
        const p = obj(x);
        return { codigoProducto: entero(p.codigo_producto) || null, nombre: str(p.nombre_producto), cantidad: num(p.cantidad), precioUnitario: precio(p.precio_unitario) };
      }),
    };
  });

  return {
    tipo: "compra_agil",
    codigo: str(r.codigo) ?? "",
    nombre: str(r.nombre) ?? "",
    descripcion: str(r.descripcion),
    estado,
    estadoGlosa: (Object.hasOwn(GLOSAS, estado) ? GLOSAS[estado as EstadoCompraAgil] : null) ?? str(est.glosa),
    comprador: Object.keys(inst).length
      ? {
          codigoOrganismo: null,
          nombreOrganismo: str(inst.organismo_comprador),
          rutUnidad: str(inst.rut),
          codigoUnidad: null,
          nombreUnidad: str(inst.unidad_compra),
          region: regionCodigo(inst.region),
          comuna: null,
        }
      : null,
    fechas: { creacion: null, publicacion, cierre: fecha(f.fecha_cierre), adjudicacion: null, ultimoCambio: fecha(f.fecha_ultimo_cambio) },
    monto: monto(pre.monto_disponible, mon, dia) ?? monto(pre.presupuesto_estimado, mon, dia),
    items,
    oferentes: entero(obj(r.resumen).total_ofertas_recibidas) ?? (detalle ? cotizaciones.length : null),
    personales: null,
    origen: "v2",
    // `codigo_orden_compra` llega null aunque la OC exista; `id_orden_compra` es el indicador confiable.
    ordenCompra: str(oc.codigo_orden_compra) ?? str(oc.id_orden_compra) ?? str(oc.id_oc),
    cotizaciones,
    raw,
  };
}
