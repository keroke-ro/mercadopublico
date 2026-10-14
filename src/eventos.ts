// CONTRATO compartido: qué observa el SDK de sí mismo. Se pueden agregar variantes, no quitar ni renombrar campos.
import type { Origen } from "./modelo.js";

/** Lo que un parser nota al traducir una respuesta: la API cambió o vino algo raro. Nunca detiene el parseo. */
export interface Aviso {
  tipo: "campo_nuevo" | "campo_faltante" | "tipo_distinto" | "valor_desconocido";
  origen: Origen;
  /** Ruta del campo en la respuesta original, p. ej. "Listado[].Comprador.RutUnidad". */
  ruta: string;
  /** Código del proceso, si se sabe. */
  codigo?: string;
  detalle?: string;
}

/** Fuentes externas que el SDK vigila por separado (circuit breaker y salud). */
export type Fuente = "v1" | "v2" | "mindicador" | "bcentral" | "paridad";

export type EstadoCircuito = "cerrado" | "abierto" | "semiabierto";

export type Evento =
  /** Una consulta HTTP terminó (bien o mal). La URL nunca incluye el ticket. */
  | { tipo: "consulta"; fuente: Fuente; url: string; status: number | null; ms: number; intento: number }
  /** Se va a reintentar después de `esperaMs`. */
  | { tipo: "reintento"; fuente: Fuente; motivo: string; intento: number; esperaMs: number }
  /** Cambió la pausa entre consultas (ritmo adaptativo ante 10500). */
  | { tipo: "ritmo"; fuente: Fuente; intervaloMs: number }
  /** El circuit breaker de una fuente cambió de estado. */
  | { tipo: "circuito"; fuente: Fuente; estado: EstadoCircuito; fallas: number }
  /** La cuota local cruzó un umbral (p. ej. 80% o 95%) o se agotó. */
  | { tipo: "cuota"; usadas: number; limite: number; restante: number }
  /** Un monto no se pudo convertir con una fuente y se pasó a la siguiente (o a ninguna). */
  | { tipo: "conversion"; fuente: Fuente; ok: boolean; moneda: string; dia: string }
  /** Un parser notó algo raro. Plano como `Aviso`, pero su `tipo` va en `aviso` (`{ tipo: "aviso" } & Aviso` sería never). */
  | ({ tipo: "aviso"; aviso: Aviso["tipo"] } & Omit<Aviso, "tipo">);

export type AlEvento = (e: Evento) => void;

/** Llama al hook sin dejar que un error del usuario rompa el SDK. */
export function emitir(alEvento: AlEvento | undefined, e: Evento): void {
  if (!alEvento) return;
  try {
    alEvento(e);
  } catch {
    // el hook es del usuario: sus errores no son nuestros
  }
}
