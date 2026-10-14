// Casos que dejó vivos Stryker en src/personales.ts (ver stryker.config.json).
import { describe, expect, it } from "vitest";
import type { Proceso } from "../../src/modelo.js";
import { OCULTO, ocultarPersonales, taparTextoLibre } from "../../src/personales.js";

const proceso = (raw: unknown, personales: Record<string, string> | null = null) =>
  ({ codigo: "X", nombre: "Compra de insumos", personales, raw }) as unknown as Proceso;
const sinCampos = new Set<string>();

describe("taparTextoLibre", () => {
  it("tapa correos con espacio a un lado de la @", () => {
    expect(taparTextoLibre("escribir a fulana @ x.cl hoy")).toBe(`escribir a ${OCULTO} hoy`);
  });

  it("no toca URL http ni https, aunque traigan algo con forma de teléfono", () => {
    for (const url of ["http://x.cl/a?b&912345678", "https://x.cl/a?b&912345678", "www.x.cl/a?b&912345678"]) {
      expect(taparTextoLibre(`ver ${url} o 912345678`)).toBe(`ver ${url} o ${OCULTO}`);
    }
  });
});

describe("ocultarPersonales", () => {
  it("conserva la forma de raw: listas, números, booleanos y null", () => {
    const raw = { lista: ["a", "b"], n: 5, b: true, nada: null, sub: { m: [1, { k: 2 }] } };
    expect(ocultarPersonales(proceso(raw), sinCampos).raw).toEqual(raw);
  });

  it("un campo personal vacío o null se deja como vino; con valor se tapa", () => {
    const raw = { Rut: "", Nombre: null, Fono: "algo", otro: "texto" };
    expect(ocultarPersonales(proceso(raw), new Set(["Rut", "Nombre", "Fono"])).raw).toEqual({ Rut: "", Nombre: null, Fono: OCULTO, otro: "texto" });
  });

  it("tapa la ruta anotada aunque el valor no sea texto o sea corto, y solo esa ruta", () => {
    const raw = { a: { b: [{ rut: 12345678, ini: "JP" }] }, otro: "JP", rut: 12345678 };
    const limpio = ocultarPersonales(proceso(raw, { "a.b.0.rut": "12345678", "a.b.0.ini": "JP" }), sinCampos);
    // "JP" tiene menos de 3 caracteres: fuera de su ruta no se compara (taparía cualquier "JP").
    expect(limpio.raw).toEqual({ a: { b: [{ rut: OCULTO, ini: OCULTO }] }, otro: "JP", rut: 12345678 });
    expect(limpio.personales).toBeNull();
    expect(raw.a.b[0]!.rut).toBe(12345678); // el original no se toca
  });

  it("un valor personal de 3 caracteres ya se tapa en todo el proceso", () => {
    const limpio = ocultarPersonales(proceso({ x: "ABC", y: "abc", z: "AB" }, { x: "ABC", w: "AB" }), sinCampos);
    expect(limpio.raw).toEqual({ x: OCULTO, y: OCULTO, z: "AB" });
  });

  it("una ruta que no existe, pasa por null o por un texto no crea ni rompe nada", () => {
    const raw = { a: null, s: "XY", v: "", n: null, o: { p: 1 } };
    const personales = { "a.b": "zz", "s.0": "X", "falta": "zz", "o.q": "zz", "o.p.r": "zz", v: "", n: "zz" };
    expect(ocultarPersonales(proceso(raw, personales), sinCampos).raw).toEqual(raw);
  });
});
