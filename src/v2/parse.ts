// Compra Ágil v2 (snake_case) → modelo. Nunca lanza: lo que no se entiende queda en `raw`.
import type { CompraAgil, Cotizacion, Item, Monto } from "../modelo.js";
import { normalizarFecha } from "../fecha.js";
import { monto, num, str } from "../util.js";

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

export function parseCompraAgil(raw: unknown, { detalle }: { detalle: boolean }): CompraAgil {
  const r = obj(raw);
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
      codigoProducto: num(p.codigo_producto),
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
        return { codigoProducto: num(p.codigo_producto), nombre: str(p.nombre_producto), cantidad: num(p.cantidad), precioUnitario: precio(p.precio_unitario) };
      }),
    };
  });

  return {
    tipo: "compra_agil",
    codigo: str(r.codigo) ?? "",
    nombre: str(r.nombre) ?? "",
    descripcion: str(r.descripcion),
    estado,
    estadoGlosa: GLOSAS[estado as EstadoCompraAgil] ?? str(est.glosa),
    comprador: Object.keys(inst).length
      ? {
          codigoOrganismo: null,
          nombreOrganismo: str(inst.organismo_comprador),
          rutUnidad: str(inst.rut),
          codigoUnidad: null,
          nombreUnidad: str(inst.unidad_compra),
          region: num(inst.region),
          comuna: null,
        }
      : null,
    fechas: { creacion: null, publicacion, cierre: fecha(f.fecha_cierre), adjudicacion: null, ultimoCambio: fecha(f.fecha_ultimo_cambio) },
    monto: monto(pre.monto_disponible, mon, dia) ?? monto(pre.presupuesto_estimado, mon, dia),
    items,
    oferentes: num(obj(r.resumen).total_ofertas_recibidas) ?? (detalle ? cotizaciones.length : null),
    personales: null,
    origen: "v2",
    // `codigo_orden_compra` llega null aunque la OC exista; `id_orden_compra` es el indicador confiable.
    ordenCompra: str(oc.codigo_orden_compra) ?? str(oc.id_orden_compra) ?? str(oc.id_oc),
    cotizaciones,
    raw,
  };
}
