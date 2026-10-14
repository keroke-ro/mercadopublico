// Datos personales de funcionarios (Ley 21.719). El SDK los entrega marcados en `personales`;
// la CLI y las exportaciones los ocultan salvo que se pida `--incluir-personales`.
import type { Proceso } from "./modelo.js";

export const OCULTO = "[oculto]";

// Los organismos escriben contactos en texto libre ("CONTACTO BODEGA: Nombre, 226126832, nombre@x.gob.cl").
// ponytail: tapa correos y teléfonos chilenos de 9 dígitos (2… fijo, 9… móvil, con o sin +56); los nombres sueltos
// en texto libre no se detectan.
const CORREO = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const FONO = /(\+?56[\s-]?)?(?<![\d-])[29](?:[\s-]?\d){8}(?![\d-])/g;

export function taparTextoLibre(s: string): string {
  return s.replace(CORREO, OCULTO).replace(FONO, OCULTO);
}

function limpiar(x: unknown, campos: ReadonlySet<string>): unknown {
  if (typeof x === "string") return taparTextoLibre(x);
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
 * Copia del proceso sin datos personales: `personales` en null; los `campos` tapados por nombre de clave a cualquier
 * profundidad; cada ruta que el parser anotó en `personales` tapada en `raw`; y correos y teléfonos tapados en todo
 * texto (descripciones incluidas).
 */
export function ocultarPersonales<T extends Proceso>(p: T, campos: ReadonlySet<string>): T {
  const copia = limpiar({ ...p, personales: null }, campos) as T; // copia nueva: se puede mutar
  for (const ruta of Object.keys(p.personales ?? {})) taparRuta(copia.raw, ruta.split("."));
  return copia;
}
