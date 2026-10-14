// Fechas en America/Santiago sin dependencias: Intl hace el trabajo de husos y horario de verano.

const ZONA = "America/Santiago";

const partes = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

function piezas(d: Date) {
  const p: Record<string, string> = {};
  for (const { type, value } of partes.formatToParts(d)) p[type] = value;
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName!.slice(3);
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}:${p.second}`, off };
}

const minutos = (off: string) => (off[0] === "-" ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));

/** ISO 8601 con el offset de Santiago vigente en ese instante: "2026-10-01T15:00:00-03:00". */
export function isoSantiago(d: Date): string {
  const { dia, hora, off } = piezas(d);
  return `${dia}T${hora}${off}`;
}

/** Día calendario en Santiago, "AAAA-MM-DD". */
export function diaSantiago(d: Date = new Date()): string {
  return piezas(d).dia;
}

/**
 * Hora "de pared" de Santiago (sin offset, como la entrega la API) → instante real.
 * Si el texto ya trae offset o Z, se respeta.
 */
export function desdeHoraSantiago(texto: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(texto)) return new Date(texto);
  const comoUtc = new Date(`${texto.length === 10 ? `${texto}T00:00:00` : texto}Z`);
  if (Number.isNaN(comoUtc.getTime())) throw new RangeError(`Fecha inválida: ${texto}`);
  // Dos pasadas: la segunda corrige cuando el offset cambia justo en el borde del horario de verano.
  let t = comoUtc.getTime() - minutos(piezas(comoUtc).off) * 60_000;
  t = comoUtc.getTime() - minutos(piezas(new Date(t)).off) * 60_000;
  return new Date(t);
}

/** Normaliza cualquier fecha de la API a ISO con offset de Santiago; null si viene vacía. */
export function normalizarFecha(texto: string | null | undefined): string | null {
  if (!texto) return null;
  return isoSantiago(desdeHoraSantiago(texto));
}

/** "AAAA-MM-DD" → "ddmmaaaa", el formato que pide la API v1. */
export function ddmmaaaa(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `${d}${m}${a}`;
}

/** Suma días a un "AAAA-MM-DD" (aritmética de calendario, sin husos). */
export function sumarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Instante de la próxima medianoche en Santiago, en ISO con offset. */
export function proximaMedianoche(ahora: Date = new Date()): string {
  return isoSantiago(desdeHoraSantiago(sumarDias(diaSantiago(ahora), 1)));
}
