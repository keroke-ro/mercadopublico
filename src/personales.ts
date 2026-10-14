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

/** Copia del proceso sin datos personales: `personales` en null y esos campos tapados dentro de `raw`. */
export function ocultarPersonales<T extends Proceso>(p: T, campos: ReadonlySet<string>): T {
  return { ...p, personales: null, raw: limpiar(p.raw, campos) };
}
