// CONTRATO (lo implementa el agente de sync): firmas estables, cuerpo por hacer.
import type { MercadoPublico } from "./index.js";
import type { Store } from "./store.js";

export type FuenteSync = "licitaciones" | "ordenes" | "compra_agil";

export interface OpcionesSync {
  /** Primer día a recorrer, "AAAA-MM-DD". Si el store ya tiene cursor para una fuente, se parte desde el cursor. */
  desde: string;
  /** Último día (incluido). Por defecto hoy en Santiago. */
  hasta?: string;
  /** Por defecto las tres. */
  fuentes?: FuenteSync[];
  /** Pedir el detalle de cada proceso nuevo o cambiado (1 consulta c/u). Por defecto true. */
  detalle?: boolean;
  store: Store;
}

export interface PlanSync {
  opciones: OpcionesSync;
  /** Consultas estimadas en total (incluye las que ya gastó planificar). */
  consultas: number;
  /** Consultas que ya gastó la planificación (listados que se reutilizan al ejecutar). */
  gastadas: number;
  desglose: { fuente: FuenteSync; consultas: number; nota: string }[];
  cabeHoy: boolean;
  restante: number;
}

export interface ResultadoSync {
  consultas: number;
  nuevos: number;
  actualizados: number;
  /** Procesos en estado final que no se volvieron a consultar. */
  omitidos: number;
  errores: { codigo: string; error: string }[];
}

export class Sync {
  constructor(private readonly mp: MercadoPublico) {}

  planificar(_opciones: OpcionesSync): Promise<PlanSync> {
    void this.mp;
    throw new Error("por implementar");
  }

  ejecutar(_plan: PlanSync, _o: { store?: Store; alAvanzar?: (p: { fuente: FuenteSync; hechas: number; total: number }) => void } = {}): Promise<ResultadoSync> {
    throw new Error("por implementar");
  }
}
