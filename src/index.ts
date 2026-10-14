import type { Fuente } from "./eventos.js";
import { Transporte, type OpcionesTransporte, type Salud } from "./http.js";
import type { Enriquecer, Proceso } from "./modelo.js";
import { cadenaPorDefecto, convertirMontos, type Conversor } from "./monto.js";
import { CAMPOS_PERSONALES_OCDS } from "./ocds.js";
import { ocultarPersonales as ocultar } from "./personales.js";
import { Sync } from "./sync.js";
import { Empresas } from "./v1/empresas.js";
import { Licitaciones } from "./v1/licitaciones.js";
import { OrdenesCompra } from "./v1/ordenes.js";
import { CAMPOS_PERSONALES_V1 } from "./v1/parse.js";
import { CompraAgilApi } from "./v2/compra-agil.js";

export interface OpcionesMercadoPublico extends OpcionesTransporte {
  /**
   * Cómo pasar UF, UTM, USD y EUR a pesos con el valor del día del documento.
   * Por defecto mindicador.cl; si no responde, el Banco Central; y si tampoco, la paridad mensual de ChileCompra. `false` no convierte.
   */
  conversor?: Conversor | false;
}

export class MercadoPublico {
  readonly http: Transporte;
  readonly licitaciones: Licitaciones;
  readonly ordenes: OrdenesCompra;
  readonly empresas: Empresas;
  readonly compraAgil: CompraAgilApi;
  readonly sync: Sync;

  constructor(opciones: OpcionesMercadoPublico) {
    const { conversor: elegido, ...transporte } = opciones;
    this.http = new Transporte(transporte);
    const conversor = elegido ?? cadenaPorDefecto({ alEvento: opciones.alEvento, circuitos: this.http.circuitos });
    const enriquecer: Enriquecer = conversor ? (p) => convertirMontos(p, conversor) : async (p) => p;
    this.licitaciones = new Licitaciones(this.http, enriquecer);
    this.ordenes = new OrdenesCompra(this.http, enriquecer);
    this.empresas = new Empresas(this.http);
    this.compraAgil = new CompraAgilApi(this.http, enriquecer);
    this.sync = new Sync(this);
  }

  /** Consultas usadas hoy, límite, restante y cuándo se reinicia (medianoche de Santiago). */
  get cuota() {
    return this.http.cuota;
  }

  /** Circuito, caídas seguidas, última caída y pausa actual de cada fuente (v1, v2 y los conversores de montos). */
  salud(): Record<Fuente, Salud> {
    return this.http.salud();
  }
}

/**
 * Campos de datos personales de funcionarios que se tapan en `raw`.
 * No incluye RUT ni razón social de proveedores: son datos de empresas y taparlos rompería el uso normal.
 */
export const CAMPOS_PERSONALES: ReadonlySet<string> = new Set([...CAMPOS_PERSONALES_V1, ...CAMPOS_PERSONALES_OCDS]);

/** Copia del proceso sin datos personales de funcionarios. Úsalo antes de exportar o publicar. */
export function ocultarPersonales<T extends Proceso>(p: T): T {
  return ocultar(p, CAMPOS_PERSONALES);
}

export { MercadoPublicoError, type TipoError } from "./errores.js";
export type { AlEvento, Aviso, EstadoCircuito, Evento, Fuente } from "./eventos.js";
export { CIRCUITO, Circuito, Cuota, PRESUPUESTO_REINTENTOS, RITMO, Transporte, UMBRALES_CUOTA, type Cancelable, type EstadoCuota, type OpcionesTransporte, type Salud } from "./http.js";
export type * from "./modelo.js";
export { cadenaPorDefecto, convertirMontos, conversorBancoCentral, conversorEncadenado, conversorMindicador, conversorParidadChileCompra, conversorPorDefecto, type Conversor, type OpcionesConversor, type Paridad } from "./monto.js";
export { desdeOcds, leerOcds, urlOcds, type OpcionesOcds } from "./ocds.js";
export { storeArchivo, storeMemoria, type Store } from "./store.js";
export type { FuenteSync, ListadoSync, OpcionesSync, PlanSync, ResultadoSync } from "./sync.js";
export * as codigos from "./v1/codigos.js";
export type { EstadoFiltroLicitacion, EstadoFiltroOC } from "./v1/codigos.js";
export { formatearRut, type Empresa } from "./v1/empresas.js";
export { parseLicitacion, parseOrdenCompra } from "./v1/parse.js";
export type { FiltrosCompraAgil, PaginaCompraAgil } from "./v2/compra-agil.js";
export { parseCompraAgil, type EstadoCompraAgil } from "./v2/parse.js";
export { isoSantiago, diaSantiago, normalizarFecha } from "./fecha.js";
