// Datos personales de funcionarios (Ley 21.719). El SDK los entrega marcados en `personales`;
// la CLI y las exportaciones los ocultan salvo que se pida `--incluir-personales`.
import type { Proceso } from "./modelo.js";

export const OCULTO = "[oculto]";

/**
 * Persona natural: RUT bajo 50 millones (las personas jurídicas parten en 50 millones). Sin RUT no se puede saber y
 * devuelve false. Es el criterio del parser OCDS, del radar y del MCP.
 */
export function esPersonaNatural(rut: string | null | undefined): boolean {
  const n = parseInt((rut ?? "").replace(/[^0-9kK]/g, "").slice(0, -1), 10);
  return n > 0 && n < 50_000_000;
}

// Los organismos escriben contactos en texto libre ("CONTACTO BODEGA: Nombre, 226126832, nombre@x.gob.cl").
// ponytail: tapa correos y teléfonos chilenos de 9 dígitos (2… fijo, 9… móvil, con o sin +56); los nombres sueltos
// en texto libre no se detectan.
// Mismas reglas que scripts/muestras.ts, probadas con el corpus real.
const CORREO = /[\w.+-]+\s?@\s?[\w-]+(\.[\w-]+)+/g; // a veces con espacio: "CASILLA X @DOMINIO.COM"
// El lookbehind va antes del +56 ("+56-9-…" y "+569 9558 1570" calzan) y no corta tokens alfanuméricos.
const FONO = /(?<![\w/+=-])(\+?56[\s-]?)?[29](?:[\s-]?\d){8}(?![\w-])/g;
// Las URL no se tocan: los dígitos de un querystring o de un base64 (UrlActa) no son teléfonos.
const URL_ = /((?:https?:\/\/|www\.)\S+)/i;

export function taparTextoLibre(s: string): string {
  return s
    .split(URL_)
    .map((t, i) => (i % 2 ? t : t.replace(CORREO, OCULTO).replace(FONO, OCULTO)))
    .join("");
}

/** Forma de comparar valores personales: "12.345.678-5" y "123456785" son el mismo RUT. */
const normal = (s: string) => s.replace(/[\s.-]/g, "").toLowerCase();

/** `valores`: personales normalizados; un string igual a uno de ellos se tapa entero, esté donde esté. */
function limpiar(x: unknown, campos: ReadonlySet<string>, valores: ReadonlySet<string>): unknown {
  if (typeof x === "string") return valores.has(normal(x)) ? OCULTO : taparTextoLibre(x);
  if (Array.isArray(x)) return x.map((v) => limpiar(v, campos, valores));
  if (x === null || typeof x !== "object") return x;
  // fromEntries crea propiedades propias: una clave "__proto__" de la API sigue siendo una clave, no el prototipo.
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, campos.has(k) && v !== null && v !== "" ? OCULTO : limpiar(v, campos, valores)]));
}

/** Tapa en `x` (ya copiado) la ruta "a.0.b" de una clave de `personales`; si no existe, no hace nada. */
function taparRuta(x: unknown, [k, ...resto]: string[]): void {
  if (x === null || typeof x !== "object" || !Object.hasOwn(x, k!)) return;
  const o = x as Record<string, unknown>;
  if (resto.length) taparRuta(o[k!], resto);
  else if (o[k!] !== null && o[k!] !== "") o[k!] = OCULTO;
}

/**
 * Copia del proceso sin datos personales: `personales` en null; los `campos` tapados por nombre de clave a cualquier
 * profundidad; cada ruta que el parser anotó en `personales` tapada en `raw`; todo texto igual a un valor de
 * `personales` tapado también fuera de esa ruta (p. ej. el nombre y RUT de un proveedor persona natural que el parser
 * copió a `proveedor`); y correos y teléfonos tapados en todo texto (descripciones incluidas).
 */
export function ocultarPersonales<T extends Proceso>(p: T, campos: ReadonlySet<string>): T {
  // ponytail: valores de menos de 3 caracteres solo se tapan en su ruta; compararlos en todo el proceso taparía cada "0".
  const valores = new Set(Object.values(p.personales ?? {}).map(normal).filter((v) => v.length >= 3));
  const copia = limpiar({ ...p, personales: null }, campos, valores) as T; // copia nueva: se puede mutar
  for (const ruta of Object.keys(p.personales ?? {})) taparRuta(copia.raw, ruta.split("."));
  return copia;
}
