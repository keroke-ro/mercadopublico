export type TipoError =
  | "ticket_invalido" // nunca se reintenta
  | "cuota_agotada" // 429 de la API, nunca se reintenta
  | "cuota_insuficiente" // el SDK se negó antes de gastar consultas
  | "simultaneas" // código 10500, se reintenta
  | "no_encontrado"
  | "parametros" // la API rechazó los filtros
  | "servidor" // 5xx, se reintenta
  | "red" // corte de red o timeout, se reintenta
  | "respuesta_invalida" // JSON que no se entiende
  | "circuito_abierto" // la fuente viene fallando: el SDK no consulta hasta que pase el enfriamiento
  | "cancelada"; // el AbortSignal del usuario se disparó

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

const fallo = (m: string) => new MercadoPublicoError("parametros", m);

/** "AAAA-MM-DD" que exista en el calendario. */
export function exigirDia(dia: string, campo = "dia"): string {
  const ok = typeof dia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dia) && new Date(`${dia}T00:00:00Z`).toISOString().startsWith(dia);
  if (!ok) throw fallo(`${campo}: se espera una fecha "AAAA-MM-DD" válida (${String(dia)})`);
  return dia;
}

/** Código no vacío y sin espacios internos; devuelve el código recortado. */
export function exigirCodigo(codigo: string, campo = "código"): string {
  const c = typeof codigo === "string" ? codigo.trim() : "";
  if (!c) throw fallo(`Falta el ${campo}`);
  if (/\s/.test(c)) throw fallo(`${campo} con espacios: "${c}"`);
  return c;
}

/** Forma plausible de RUT ("70.017.820-k", "70017820K"); no valida el dígito verificador. */
export function exigirRut(rut: string): string {
  if (typeof rut !== "string" || !/^\d{1,3}(\.?\d{3}){0,2}-?[\dkK]$/.test(rut.trim())) throw fallo(`RUT inválido: "${String(rut)}"`);
  return rut.trim();
}

/** `valor` debe ser uno de `validos`. */
export function exigirUno<T extends string>(valor: T, validos: readonly string[], campo: string): T {
  if (!validos.includes(valor)) throw fallo(`${campo} desconocido: "${String(valor)}" (válidos: ${validos.join(", ")})`);
  return valor;
}
