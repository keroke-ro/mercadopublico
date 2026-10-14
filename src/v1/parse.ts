// JSON v1 (PascalCase) → modelo. Tolerante: nunca lanza; lo que no se reconoce queda en `raw`.
import { normalizarFecha } from "../fecha.js";
import type { Comprador, Item, Licitacion, Monto, OrdenCompra, Proveedor } from "../modelo.js";
import { monto, num, str } from "../util.js";
import { ESTADO_LICITACION, ESTADO_OC, TIPO_LICITACION, TIPO_OC, estado, glosa, regionCodigo, tipoDesdeCodigo } from "./codigos.js";

/**
 * Campos con datos personales de funcionarios y contactos (docs/api-notes.md §1, marcados 🔒).
 * No incluye RutProveedor/NombreProveedor/RutSucursal: son personales solo si el proveedor es persona natural,
 * y la API no lo indica.
 */
export const CAMPOS_PERSONALES_V1: readonly string[] = [
  "RutUsuario",
  "CodigoUsuario",
  "NombreUsuario",
  "CargoUsuario",
  "NombreResponsablePago",
  "EmailResponsablePago",
  "NombreResponsableContrato",
  "EmailResponsableContrato",
  "FonoResponsableContrato",
  "NombreContacto",
  "CargoContacto",
  "FonoContacto",
  "MailContacto",
];
const PERSONALES = new Set(CAMPOS_PERSONALES_V1);

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const lista = (x: unknown): Obj[] => (Array.isArray(x) ? x.map(obj) : []);

function fecha(x: unknown): string | null {
  try {
    return normalizarFecha(str(x));
  } catch {
    return null;
  }
}

/** Recorre el objeto y junta los campos personales; la clave es la ruta original unida con ".". */
function personales(raw: unknown): Record<string, string> | null {
  const out: Record<string, string> = {};
  const visitar = (x: unknown, ruta: string) => {
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      const r = ruta ? `${ruta}.${k}` : k;
      if (PERSONALES.has(k)) {
        const s = str(v);
        if (s !== null) out[r] = s;
      } else visitar(v, r);
    }
  };
  visitar(raw, "");
  return Object.keys(out).length ? out : null;
}

function comprador(x: unknown): Comprador | null {
  const c = obj(x);
  if (!Object.keys(c).length) return null;
  return {
    codigoOrganismo: str(c.CodigoOrganismo),
    nombreOrganismo: str(c.NombreOrganismo),
    rutUnidad: str(c.RutUnidad),
    codigoUnidad: str(c.CodigoUnidad),
    nombreUnidad: str(c.NombreUnidad),
    region: regionCodigo(c.RegionUnidad),
    comuna: str(c.ComunaUnidad),
  };
}

const dia = (iso: string | null) => iso?.slice(0, 10) ?? null;

function producto(n: number | null, cantidad: number | null, mon: unknown, d: string | null): Monto | null {
  return n !== null && cantidad !== null ? monto(n * cantidad, mon, d) : null;
}

export function parseLicitacion(raw: unknown): Licitacion {
  const r = obj(raw);
  const f = obj(r.Fechas);
  const adj = obj(r.Adjudicacion);
  const publicacion = fecha(f.FechaPublicacion);
  const creacion = fecha(f.FechaCreacion);
  const d = dia(publicacion ?? creacion);
  const e = estado(ESTADO_LICITACION, r.CodigoEstado, r.Estado);
  const tipo = str(r.Tipo) ?? tipoDesdeCodigo(r.CodigoExterno);

  const items: Item[] = lista(obj(r.Items).Listado).map((i) => {
    const a = obj(i.Adjudicacion);
    const unitario = num(a.MontoUnitario);
    const proveedor: Proveedor | null = Object.keys(a).length ? { rut: str(a.RutProveedor), nombre: str(a.NombreProveedor), codigo: null } : null;
    return {
      codigoProducto: num(i.CodigoProducto),
      nombre: str(i.NombreProducto),
      descripcion: str(i.Descripcion),
      cantidad: num(i.Cantidad),
      unidad: str(i.UnidadMedida),
      precioUnitario: monto(unitario, r.Moneda, d),
      // Total adjudicado del ítem; la API no lo entrega, se calcula.
      total: producto(unitario, num(a.CantidadAdjudicada), r.Moneda, d),
      proveedor,
    };
  });

  return {
    tipo: "licitacion",
    codigo: str(r.CodigoExterno) ?? "",
    nombre: str(r.Nombre) ?? "",
    descripcion: str(r.Descripcion),
    estado: e.estado,
    estadoGlosa: e.glosa ?? str(r.Estado),
    comprador: comprador(r.Comprador),
    fechas: {
      creacion,
      publicacion,
      cierre: fecha(f.FechaCierre ?? r.FechaCierre),
      adjudicacion: fecha(f.FechaAdjudicacion ?? adj.Fecha),
      ultimoCambio: null,
    },
    monto: monto(r.MontoEstimado, r.Moneda, d),
    items,
    oferentes: num(adj.NumeroOferentes),
    personales: personales(raw),
    origen: "v1",
    raw,
    tipoLicitacion: tipo,
    tipoLicitacionGlosa: glosa(TIPO_LICITACION, tipo),
  };
}

export function parseOrdenCompra(raw: unknown): OrdenCompra {
  const r = obj(raw);
  const f = obj(r.Fechas);
  const p = obj(r.Proveedor);
  // La OC no se "publica": se usa la fecha de envío al proveedor.
  const envio = fecha(f.FechaEnvio);
  const creacion = fecha(f.FechaCreacion);
  const d = dia(envio ?? creacion);
  const e = estado(ESTADO_OC, r.CodigoEstado, r.Estado);
  const codigoTipo = str(r.CodigoTipo);
  const tipoOC = codigoTipo !== null && Object.hasOwn(TIPO_OC, codigoTipo) ? TIPO_OC[Number(codigoTipo) as keyof typeof TIPO_OC][0] : null;

  const items: Item[] = lista(obj(r.Items).Listado).map((i) => {
    const mon = i.Moneda ?? r.TipoMoneda;
    return {
      codigoProducto: num(i.CodigoProducto),
      nombre: str(i.Producto) ?? str(i.Categoria),
      descripcion: str(i.EspecificacionComprador),
      cantidad: num(i.Cantidad),
      unidad: str(i.Unidad),
      precioUnitario: monto(i.PrecioNeto, mon, d),
      total: monto(i.Total, mon, d),
      proveedor: null,
    };
  });

  return {
    tipo: "orden_compra",
    codigo: str(r.Codigo) ?? "",
    nombre: str(r.Nombre) ?? "",
    descripcion: str(r.Descripcion),
    estado: e.estado,
    estadoGlosa: e.glosa ?? str(r.Estado),
    comprador: comprador(r.Comprador),
    fechas: { creacion, publicacion: envio, cierre: null, adjudicacion: null, ultimoCambio: fecha(f.FechaUltimaModificacion) },
    monto: monto(r.Total, r.TipoMoneda, d),
    items,
    oferentes: null,
    personales: personales(raw),
    origen: "v1",
    raw,
    tipoOrden: str(r.Tipo) ?? tipoOC,
    proveedor: Object.keys(p).length ? { rut: str(p.RutSucursal), nombre: str(p.Nombre), codigo: str(p.Codigo) } : null,
    procesoOrigen: str(r.CodigoLicitacion),
  };
}
