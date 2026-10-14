// JSON v1 (PascalCase) → modelo. Tolerante: nunca lanza; lo que no se reconoce queda en `raw`.
import type { Aviso } from "../eventos.js";
import { normalizarFecha } from "../fecha.js";
import type { Comprador, Item, Licitacion, Monto, OrdenCompra, Proveedor } from "../modelo.js";
import { avisador, entero, exigir, monto, num, revisar, str, type Avisar, type Esquema } from "../util.js";
import {
  CODIGO_TIPO_LICITACION,
  CONTRATO,
  ESTADO_LICITACION,
  ESTADO_OC,
  ESTADO_PROVEEDOR_OC,
  ESTIMACION,
  MODALIDAD_PAGO,
  OBRAS,
  TIPO_LICITACION,
  TIPO_OC,
  estado,
  glosa,
  regionCodigo,
  tipoDesdeCodigo,
} from "./codigos.js";

// ── Campos conocidos (fixtures reales de test/fixtures/v1/*.real.json + docs/api-notes.md §1) ──────────────────────
// Un campo fuera de estas listas avisa `campo_nuevo`; uno con otro tipo JSON, `tipo_distinto`. "*" = se conoce y no se lee.

const COMPRADOR: Esquema = {
  CodigoOrganismo: "s",
  NombreOrganismo: "s",
  RutUnidad: "s",
  CodigoUnidad: "s",
  NombreUnidad: "s",
  DireccionUnidad: "*",
  ComunaUnidad: "s",
  RegionUnidad: "s",
};

/** Detalle de licitación (`Listado[]`). El listado trae solo CodigoExterno, Nombre, CodigoEstado y FechaCierre. */
export const ESQUEMA_LICITACION: Esquema = {
  CodigoExterno: "s",
  Nombre: "s",
  CodigoEstado: "n",
  Estado: "s",
  Descripcion: "s",
  FechaCierre: "s",
  Comprador: { ...COMPRADOR, RutUsuario: "*", CodigoUsuario: "*", NombreUsuario: "*", CargoUsuario: "*" },
  ...Object.fromEntries(
    ["DiasCierreLicitacion", "Informada", "CodigoTipo", "TipoConvocatoria", "Etapas", "EstadoEtapas", "TomaRazon", "EstadoPublicidadOfertas",
      "JustificacionPublicidad", "Contrato", "Obras", "CantidadReclamos", "UnidadTiempoEvaluacion", "DireccionVisita", "DireccionEntrega",
      "Estimacion", "FuenteFinanciamiento", "VisibilidadMonto", "Tiempo", "UnidadTiempo", "Modalidad", "TipoPago", "NombreResponsablePago",
      "EmailResponsablePago", "NombreResponsableContrato", "EmailResponsableContrato", "FonoResponsableContrato", "ProhibicionContratacion",
      "SubContratacion", "UnidadTiempoDuracionContrato", "TiempoDuracionContrato", "TipoDuracionContrato", "JustificacionMontoEstimado",
      "ObservacionContract", "ExtensionPlazo", "EsBaseTipo", "UnidadTiempoContratoLicitacion", "ValorTiempoRenovacion",
      "PeriodoTiempoRenovacion", "EsRenovable", "CodigoBIP"].map((k) => [k, "*"]),
  ),
  Tipo: "s",
  Moneda: "m",
  MontoEstimado: "n",
  Fechas: {
    FechaCreacion: "s",
    FechaCierre: "s",
    FechaPublicacion: "s",
    FechaAdjudicacion: "s",
    ...Object.fromEntries(
      ["FechaInicio", "FechaFinal", "FechaPubRespuestas", "FechaActoAperturaTecnica", "FechaActoAperturaEconomica", "FechaEstimadaAdjudicacion",
        "FechaSoporteFisico", "FechaTiempoEvaluacion", "FechaEstimadaFirma", "FechasUsuario", "FechaVisitaTerreno", "FechaEntregaAntecedentes"].map((k) => [k, "*"]),
    ),
  },
  Adjudicacion: { Tipo: "*", Fecha: "s", Numero: "*", NumeroOferentes: "n", UrlActa: "*" },
  Items: {
    Cantidad: "*",
    Listado: [
      {
        CodigoEstadoLicitacion: "*",
        Correlativo: "*",
        CodigoProducto: "n",
        CodigoCategoria: "*",
        Categoria: "*",
        NombreProducto: "s",
        Descripcion: "s",
        UnidadMedida: "s",
        Cantidad: "n",
        // La API real manda `Cantidad` (number); el diccionario dice `CantidadAdjudicada` (nvarchar). Se leen ambos.
        Adjudicacion: { RutProveedor: "s", NombreProveedor: "s", Cantidad: "n", CantidadAdjudicada: "sn", MontoUnitario: "n" },
      },
    ],
  },
};

const CONTACTO = { NombreContacto: "*", CargoContacto: "*", FonoContacto: "*", MailContacto: "*" } as const;

/** Detalle de OC (`Listado[]`). El listado trae solo Codigo, Nombre y CodigoEstado. */
export const ESQUEMA_OC: Esquema = {
  Codigo: "s",
  Nombre: "s",
  CodigoEstado: "n",
  Estado: "s",
  CodigoLicitacion: "s",
  Descripcion: "s",
  CodigoTipo: "sn", // "13" en la API real, int en el diccionario
  Tipo: "s",
  TipoMoneda: "m",
  Total: "n",
  ...Object.fromEntries(
    ["CodigoEstadoProveedor", "EstadoProveedor", "TieneItems", "PromedioCalificacion", "CantidadEvaluacion", "Descuentos", "Cargos", "TotalNeto",
      "PorcentajeIva", "Impuestos", "Financiamiento", "Pais", "TipoDespacho", "FormaPago"].map((k) => [k, "*"]),
  ),
  Fechas: { FechaCreacion: "s", FechaEnvio: "s", FechaAceptacion: "*", FechaCancelacion: "*", FechaUltimaModificacion: "s" },
  Comprador: { ...COMPRADOR, Actividad: "*", Pais: "*", ...CONTACTO },
  Proveedor: {
    Codigo: "s",
    Nombre: "s",
    RutSucursal: "s",
    ...Object.fromEntries(["Actividad", "CodigoSucursal", "NombreSucursal", "Direccion", "Comuna", "Region", "Pais"].map((k) => [k, "*"])),
    ...CONTACTO,
  },
  Items: {
    Cantidad: "*",
    Listado: [
      {
        Correlativo: "*",
        CodigoCategoria: "*",
        Categoria: "s",
        CodigoProducto: "n",
        Producto: "s",
        EspecificacionComprador: "s",
        EspecificacionProveedor: "*",
        Cantidad: "n",
        Unidad: "s",
        Moneda: "m",
        PrecioNeto: "n",
        TotalCargos: "*",
        TotalDescuentos: "*",
        TotalImpuestos: "*",
        Total: "n",
      },
    ],
  },
};

/** Campos de los que depende el modelo: siempre (listado) y además en el detalle. */
const EXIGIDOS_LICITACION = ["CodigoExterno", "Nombre", "CodigoEstado"];
const EXIGIDOS_LICITACION_DETALLE = ["Estado", "Comprador", "Fechas.FechaPublicacion", "Moneda", "Items"];
const EXIGIDOS_OC = ["Codigo", "Nombre", "CodigoEstado"];
const EXIGIDOS_OC_DETALLE = ["Comprador", "Proveedor", "Fechas.FechaCreacion", "TipoMoneda", "Total", "Items"];

const RUTA = "Listado[]";
/** El listado trae 3 o 4 campos; con cualquiera de estos ya es un detalle. */
const esDetalle = (r: Obj) => "Comprador" in r || "Fechas" in r || "Items" in r;

/** Avisa códigos que la tabla no conoce (el parseo sigue igual: slug de la glosa o null). */
function desconocido(av: Avisar, ruta: string, valor: unknown, conocido: (k: string) => boolean) {
  const k = str(valor);
  if (k !== null && !conocido(k)) av("valor_desconocido", `${RUTA}.${ruta}`, `${ruta} ${k.slice(0, 40)}`);
}

function vigilarLicitacion(raw: unknown, av: Avisar) {
  const r = obj(raw);
  revisar(raw, ESQUEMA_LICITACION, RUTA, av);
  exigir(raw, esDetalle(r) ? [...EXIGIDOS_LICITACION, ...EXIGIDOS_LICITACION_DETALLE] : EXIGIDOS_LICITACION, RUTA, av);
  desconocido(av, "CodigoEstado", r.CodigoEstado, (k) => Object.hasOwn(ESTADO_LICITACION, k));
  desconocido(av, "Tipo", r.Tipo, (k) => Object.hasOwn(TIPO_LICITACION, k));
  desconocido(av, "CodigoTipo", r.CodigoTipo, (k) => Object.hasOwn(CODIGO_TIPO_LICITACION, k));
  // Códigos que el parser no lee pero que tienen tabla: la API real ya mandó Modalidad 0 y 11.
  for (const [k, tabla] of [["Contrato", CONTRATO], ["Obras", OBRAS], ["Modalidad", MODALIDAD_PAGO], ["Estimacion", ESTIMACION]] as const)
    desconocido(av, k, r[k], (c) => Object.hasOwn(tabla, c));
  desconocido(av, "Comprador.RegionUnidad", obj(r.Comprador).RegionUnidad, (k) => regionCodigo(k) !== null);
}

const ABREVIACIONES_OC: ReadonlySet<string> = new Set(Object.values(TIPO_OC).map(([a]) => a));

function vigilarOrdenCompra(raw: unknown, av: Avisar) {
  const r = obj(raw);
  revisar(raw, ESQUEMA_OC, RUTA, av);
  exigir(raw, esDetalle(r) ? [...EXIGIDOS_OC, ...EXIGIDOS_OC_DETALLE] : EXIGIDOS_OC, RUTA, av);
  desconocido(av, "CodigoEstado", r.CodigoEstado, (k) => Object.hasOwn(ESTADO_OC, k));
  desconocido(av, "CodigoTipo", r.CodigoTipo, (k) => Object.hasOwn(TIPO_OC, k));
  desconocido(av, "Tipo", r.Tipo, (k) => ABREVIACIONES_OC.has(k));
  desconocido(av, "CodigoEstadoProveedor", r.CodigoEstadoProveedor, (k) => Object.hasOwn(ESTADO_PROVEEDOR_OC, k));
  desconocido(av, "Comprador.RegionUnidad", obj(r.Comprador).RegionUnidad, (k) => regionCodigo(k) !== null);
}

/** Revisa sin que nada de la revisión llegue al parseo. */
function vigilar(f: (raw: unknown, av: Avisar) => void, raw: unknown, codigo: unknown, o: unknown) {
  const av = avisador("v1", codigo, (o as { avisar?: (a: Aviso) => void } | null | undefined)?.avisar);
  if (!av) return;
  try {
    f(raw, av);
  } catch {
    // un aviso nunca detiene el parseo
  }
}

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

/** `o.avisar` recibe los cambios de forma que note (campos nuevos o faltantes, tipos, códigos); no cambia el resultado. */
export function parseLicitacion(raw: unknown, o?: { avisar?: (a: Aviso) => void }): Licitacion {
  const r = obj(raw);
  vigilar(vigilarLicitacion, raw, r.CodigoExterno, o);
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
      codigoProducto: entero(i.CodigoProducto) || null,
      nombre: str(i.NombreProducto),
      descripcion: str(i.Descripcion),
      cantidad: num(i.Cantidad),
      unidad: str(i.UnidadMedida),
      precioUnitario: monto(unitario, r.Moneda, d),
      // Total adjudicado del ítem; la API no lo entrega, se calcula.
      total: producto(unitario, num(a.Cantidad ?? a.CantidadAdjudicada), r.Moneda, d),
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
    oferentes: entero(adj.NumeroOferentes),
    personales: personales(raw),
    origen: "v1",
    raw,
    tipoLicitacion: tipo,
    tipoLicitacionGlosa: glosa(TIPO_LICITACION, tipo),
  };
}

export function parseOrdenCompra(raw: unknown, o?: { avisar?: (a: Aviso) => void }): OrdenCompra {
  const r = obj(raw);
  vigilar(vigilarOrdenCompra, raw, r.Codigo, o);
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
      codigoProducto: entero(i.CodigoProducto) || null,
      nombre: str(i.Producto) ?? str(i.Categoria),
      descripcion: str(i.EspecificacionComprador),
      cantidad: num(i.Cantidad),
      unidad: str(i.Unidad),
      precioUnitario: monto(i.PrecioNeto, mon, d),
      // La API real entrega Total 0 en el ítem aunque haya precio (visto en 2026-10): se calcula el neto.
      total: num(i.Total) ? monto(i.Total, mon, d) : producto(num(i.PrecioNeto), num(i.Cantidad), mon, d),
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
    // Las OC de Compra Ágil y de Trato Directo vienen sin CodigoLicitacion pero con el código en el nombre:
    // "…ID:1002772-2662-COT26…", "CAJAS MEGA BOX 1002584-93-COT26", "…Trato Directo ID 1016414-13-FTD26".
    procesoOrigen: str(r.CodigoLicitacion) ?? /(?<![\w-])(\d+-\d+-(?:COT|FTD)\d{2})(?![\w-])/.exec(str(r.Nombre) ?? "")?.[1] ?? null,
  };
}
