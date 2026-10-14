export type TipoError =
  | "ticket_invalido" // nunca se reintenta
  | "cuota_agotada" // 429 de la API, nunca se reintenta
  | "cuota_insuficiente" // el SDK se negó antes de gastar consultas
  | "simultaneas" // código 10500, se reintenta
  | "no_encontrado"
  | "parametros" // la API rechazó los filtros
  | "servidor" // 5xx, se reintenta
  | "red" // corte de red o timeout, se reintenta
  | "respuesta_invalida"; // JSON que no se entiende

const REINTENTABLES: ReadonlySet<TipoError> = new Set(["simultaneas", "servidor", "red"]);

export class MercadoPublicoError extends Error {
  override readonly name = "MercadoPublicoError";
  readonly tipo: TipoError;
  readonly status?: number;
  /** Código que entregó la API (p. ej. 10500), si lo hubo. */
  readonly codigo?: number | string;

  constructor(tipo: TipoError, mensaje: string, extra: { status?: number; codigo?: number | string; cause?: unknown } = {}) {
    super(mensaje, { cause: extra.cause });
    this.tipo = tipo;
    this.status = extra.status;
    this.codigo = extra.codigo;
  }

  get reintentable(): boolean {
    return REINTENTABLES.has(this.tipo);
  }
}
