// El modelo único. v1, v2 y OCDS se traducen a `Proceso`; el código del usuario no ve el transporte.

export type Moneda = "CLP" | "CLF" | "UTM" | "USD" | "EUR";

export interface Monto {
  valor: number;
  moneda: Moneda;
  /** Valor en pesos al día `fechaValor`. null si no se pudo convertir (o aún no se convierte). */
  clp: number | null;
  /** Día ("AAAA-MM-DD") cuyo valor de UF/UTM/dólar/euro se usó. Para CLP es el mismo día del documento. */
  fechaValor: string | null;
  /** De dónde salió el tipo de cambio, p. ej. "mindicador.cl". "identidad" para CLP. */
  fuente: string | null;
}

export interface Comprador {
  codigoOrganismo: string | null;
  nombreOrganismo: string | null;
  rutUnidad: string | null;
  codigoUnidad: string | null;
  nombreUnidad: string | null;
  /** Código de región (1 a 16). */
  region: number | null;
  comuna: string | null;
}

export interface Proveedor {
  rut: string | null;
  nombre: string | null;
  codigo: string | null;
}

export interface Item {
  /** Código ONU/UNSPSC del producto. */
  codigoProducto: number | null;
  nombre: string | null;
  descripcion: string | null;
  cantidad: number | null;
  unidad: string | null;
  precioUnitario: Monto | null;
  total: Monto | null;
  /** Proveedor adjudicado o seleccionado para el ítem, si lo hay. */
  proveedor: Proveedor | null;
}

export interface Fechas {
  creacion: string | null;
  publicacion: string | null;
  cierre: string | null;
  adjudicacion: string | null;
  ultimoCambio: string | null;
}

export type Origen = "v1" | "v2" | "ocds";

interface Base {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  /** Estado normalizado en snake_case, p. ej. "publicada", "adjudicada", "enviada_proveedor". */
  estado: string;
  /** Glosa oficial del estado. */
  estadoGlosa: string | null;
  comprador: Comprador | null;
  /** Todas en ISO 8601 con offset de America/Santiago. */
  fechas: Fechas;
  /** Monto estimado (licitación), total (OC) o presupuesto (Compra Ágil). */
  monto: Monto | null;
  items: Item[];
  /** Número de oferentes o cotizaciones recibidas, si se sabe. */
  oferentes: number | null;
  /**
   * Datos personales de funcionarios (nombre, RUT, correo, teléfono) tal como vinieron.
   * Ver `ocultarPersonales`: la CLI y las exportaciones los ocultan por defecto.
   */
  personales: Record<string, string> | null;
  origen: Origen;
  /** Respuesta original sin tocar, incluidos los campos que el parser no conoce. */
  raw: unknown;
}

export interface Licitacion extends Base {
  tipo: "licitacion";
  /** Código de tipo: L1, LE, LP, LQ, LR, E2, CO, B2, H2, I2, LS, O1… */
  tipoLicitacion: string | null;
  tipoLicitacionGlosa: string | null;
}

export interface OrdenCompra extends Base {
  tipo: "orden_compra";
  tipoOrden: string | null;
  proveedor: Proveedor | null;
  /** Código de la licitación o Compra Ágil que originó la OC, si aplica. */
  procesoOrigen: string | null;
}

export interface Cotizacion {
  proveedor: Proveedor | null;
  monto: Monto | null;
  seleccionada: boolean;
  productos: { codigoProducto: number | null; nombre: string | null; cantidad: number | null; precioUnitario: Monto | null }[];
}

export interface CompraAgil extends Base {
  tipo: "compra_agil";
  /** Ojo: la v2 lo entrega en null aunque la OC exista (error conocido de la API). */
  ordenCompra: string | null;
  cotizaciones: Cotizacion[];
}

export type Proceso = Licitacion | OrdenCompra | CompraAgil;

/** Paso que se aplica a cada detalle antes de devolverlo (p. ej. convertir montos a CLP). */
export type Enriquecer = <T extends Proceso>(p: T) => Promise<T>;
