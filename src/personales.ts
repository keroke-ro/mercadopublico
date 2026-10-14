// Datos personales de funcionarios (Ley 21.719). El SDK los entrega marcados en `personales`;
// la CLI y las exportaciones los ocultan salvo que se pida `--incluir-personales`.
import type { Proceso } from "./modelo.js";

export const OCULTO = "[oculto]";

function limpiar(x: unknown, campos: ReadonlySet<string>): unknown {
  if (Array.isArray(x)) return x.map((v) => limpiar(v, campos));
  if (x === null || typeof x !== "object") return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[k] = campos.has(k) && v !== null && v !== "" ? OCULTO : limpiar(v, campos);
  return out;
}

/** Tapa en `x` (ya copiado) la ruta "a.0.b" de una clave de `personales`; si no existe, no hace nada. */
function taparRuta(x: unknown, [k, ...resto]: string[]): void {
  if (x === null || typeof x !== "object" || !(k! in x)) return;
  const o = x as Record<string, unknown>;
  if (resto.length) taparRuta(o[k!], resto);
  else if (o[k!] !== null && o[k!] !== "") o[k!] = OCULTO;
}

/**
 * Copia del proceso sin datos personales: `personales` en null y, dentro de `raw`, tapados los `campos` (por nombre
 * de clave, a cualquier profundidad) y cada ruta que el parser anotó en `personales` (relativa a `raw`).
 */
export function ocultarPersonales<T extends Proceso>(p: T, campos: ReadonlySet<string>): T {
  const raw = limpiar(p.raw, campos); // copia nueva: se puede mutar
  for (const ruta of Object.keys(p.personales ?? {})) taparRuta(raw, ruta.split("."));
  return { ...p, personales: null, raw };
}
