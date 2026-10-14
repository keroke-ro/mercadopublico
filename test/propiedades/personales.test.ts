// Datos personales: el texto libre pierde correos y teléfonos, y nada más; ocultarPersonales no deja rastros.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Proceso } from "../../src/modelo.js";
import { CAMPOS_PERSONALES_OCDS, desdeOcds } from "../../src/ocds.js";
import { OCULTO, ocultarPersonales, taparTextoLibre } from "../../src/personales.js";
import { CAMPOS_PERSONALES_V1, parseLicitacion, parseOrdenCompra } from "../../src/v1/parse.js";
import { CAMPOS_PERSONALES_V2 } from "../../src/v2/parse.js";
import { mutado, ocdsLicitacion, v1 } from "./generadores.js";

const digito = fc.integer({ min: 0, max: 9 }).map(String);
const sep = fc.constantFrom("", " ", "-");
/** Teléfono chileno de 9 dígitos (2… fijo, 9… móvil), con o sin +56, con espacios o guiones en cualquier parte. */
const fono = fc
  .tuple(fc.constantFrom("", "+56 ", "+56-", "+56", "56 ", "56-"), fc.constantFrom("2", "9"), fc.array(fc.tuple(sep, digito), { minLength: 8, maxLength: 8 }))
  .map(([pre, a, resto]) => pre + a + resto.map(([s, d]) => s + d).join(""));
const etiqueta = fc.stringMatching(/^[a-z0-9]([a-z0-9._-]{0,10}[a-z0-9])?$/);
const correo = fc
  .tuple(etiqueta, fc.array(fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/), { minLength: 1, maxLength: 3 }), fc.constantFrom("cl", "com", "gob.cl"))
  .map(([u, ds, tld]) => `${u}@${ds.join(".")}.${tld}`);
/** Relleno sin dígitos ni @: no puede formar un teléfono ni un correo por sí solo. */
const relleno = fc.string({ unit: fc.constantFrom(..."abcdeñáÉ ,.;:()/*\t\n|_".split("")), maxLength: 20 });

const miles = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const seguro = fc.oneof(
  fc.tuple(fc.integer({ min: 1000, max: 9_999_999 }), fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 10, max: 99 })).map(([a, b, y]) => `${a}-${b}-COT${y}`),
  fc.tuple(fc.integer({ min: 1, max: 99_999_999 }), fc.constantFrom(..."0123456789K")).map(([n, dv]) => `${miles(n)}-${dv}`),
  fc.date({ min: new Date("1990-01-01"), max: new Date("2099-12-31"), noInvalidDate: true }).chain((d) => {
    const [a, m, dd] = d.toISOString().slice(0, 10).split("-");
    return fc.constantFrom(`${a}-${m}-${dd}`, `${dd}-${m}-${a}`, `${dd}/${m}/${a}`, d.toISOString().slice(0, 19), `${a}-${m}-${dd} ${d.toISOString().slice(11, 16)}`);
  }),
  fc.stringMatching(/^[1-9]\d{9}$/),
  fc.integer({ min: 0, max: 1e12 }).map((n) => `$ ${miles(n)}`),
  fc.integer({ min: 0, max: 1e12 }).map(miles),
  fc.integer({ min: 0, max: 99_999_999 }).map(String),
  // URL con dígitos en el querystring, como UrlActa
  fc.tuple(fc.stringMatching(/^[A-Za-z0-9+/=]{0,30}$/), fc.stringMatching(/^[29]\d{8}$/)).map(([b, f]) => `https://www.mercadopublico.cl/Acta.aspx?qs=${b}${f}`),
);

describe("taparTextoLibre", () => {
  it("tapa todo teléfono y correo insertado, en cualquier posición", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(relleno, fc.oneof(fono, correo)), { minLength: 1, maxLength: 5 }), relleno, (partes, fin) => {
        const t = partes.map(([r, x]) => `${r} ${x} `).join("") + fin;
        const s = taparTextoLibre(t);
        expect(s).not.toMatch(/\d/); // el relleno no tiene dígitos: si queda uno, quedó un pedazo de teléfono
        expect(s).not.toContain("@");
      }),
      { numRuns: 1000 },
    );
  });

  it("no toca códigos, RUT, fechas, números de 10 dígitos ni montos", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(relleno, seguro), { maxLength: 6 }), relleno, (partes, fin) => {
        const t = partes.map(([r, x]) => `${r} ${x} `).join("") + fin;
        expect(taparTextoLibre(t)).toBe(t);
      }),
      { numRuns: 1000 },
    );
  });

  it("regresiones del corpus real: +569 pegado, correo con espacio antes de @, URL con dígitos", () => {
    expect(taparTextoLibre("fono +569 9558 1570")).toBe(`fono ${OCULTO}`);
    expect(taparTextoLibre("A LA CASILLA X @DOMINIO.COM y")).toBe(`A LA CASILLA ${OCULTO} y`);
    const url = "https://www.mercadopublico.cl/Procurement/Modules/RFB/StepsProcessAward/PreviewAwardAct.aspx?qs=Ab2+2123456789/912345678=";
    expect(taparTextoLibre(`acta ${url} fono 912345678`)).toBe(`acta ${url} fono ${OCULTO}`);
  });

  it("regresión: +56 seguido de guion", () => {
    expect(taparTextoLibre("fono +56-9-1234-5678.")).toBe(`fono ${OCULTO}.`);
    expect(taparTextoLibre("fono 56-2-2612-6832")).toBe(`fono ${OCULTO}`);
  });
});

describe("ocultarPersonales", () => {
  const CAMPOS = new Set([...CAMPOS_PERSONALES_V1, ...CAMPOS_PERSONALES_V2, ...CAMPOS_PERSONALES_OCDS]);
  const norm = (s: string) => s.replace(/[\s.-]/g, "").toLowerCase();
  /** Hojas string del valor, sin importar dónde estén. */
  const hojas = (x: unknown, out: string[] = []): string[] => {
    if (typeof x === "string") out.push(x);
    else if (x && typeof x === "object") for (const v of Object.values(x)) hojas(v, out);
    return out;
  };

  const procesos: fc.Arbitrary<Proceso[]> = fc.oneof(
    mutado(() => v1("licitacion-detalle")).map((x) => [parseLicitacion(x)]),
    mutado(() => v1("oc-detalle")).map((x) => [parseOrdenCompra(x)]),
    mutado(ocdsLicitacion).map((x) => {
      try {
        return desdeOcds(x);
      } catch {
        return [];
      }
    }),
    fc.jsonValue({ maxDepth: 4 }).map((x) => [parseLicitacion(x), parseOrdenCompra(x)]),
  );

  it("no muta la entrada y ningún valor de `personales` sobrevive en la salida", () => {
    fc.assert(
      fc.property(procesos, (ps) => {
        for (const p of ps) {
          const antes = JSON.stringify(p);
          const q = ocultarPersonales(p, CAMPOS);
          expect(JSON.stringify(p)).toBe(antes);
          expect(q.personales).toBeNull();
          const valores = Object.values(p.personales ?? {}).filter((v) => v !== OCULTO && norm(v).length >= 3);
          const quedan = new Set(hojas(q).map(norm));
          for (const v of valores) expect(quedan.has(norm(v)), `quedó "${v}"`).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("regresión: el nombre y el RUT de un proveedor persona natural no quedan en el modelo (OCDS)", () => {
    const [p] = desdeOcds(ocdsLicitacion());
    const q = JSON.stringify({ ...ocultarPersonales(p!, CAMPOS), raw: null });
    expect(q).not.toContain("Juan Soto");
    expect(q).not.toContain("12345678-5");
  });

  it("regresión: una clave \"__proto__\" en raw no cambia la forma de la copia", () => {
    const raw = JSON.parse('{"CodigoExterno":"1-1-LE26","__proto__":{"NombreUsuario":"Fulana"}}');
    const q = ocultarPersonales(parseLicitacion(raw), CAMPOS);
    expect(Object.hasOwn(q.raw as object, "__proto__")).toBe(true);
    expect(JSON.stringify(q.raw)).not.toContain("Fulana");
  });
});
