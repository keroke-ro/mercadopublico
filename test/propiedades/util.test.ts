// num, moneda y monto: lo que entra en cualquier forma sale finito, y una moneda desconocida nunca se vuelve CLP.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { moneda, monto, num, str } from "../../src/util.js";

const miles = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

describe("num", () => {
  it("\"1.234,5\" (chileno) y \"1234.5\" (JSON) dan lo mismo", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.stringMatching(/^\d{1,6}$/), fc.boolean(), (ent, dec, neg) => {
        const s = neg ? "-" : "";
        const json = `${s}${ent}.${dec}`;
        expect(num(`${s}${miles(ent)},${dec}`)).toBe(Number(json));
        expect(num(json)).toBe(Number(json));
        expect(num(` ${json} `)).toBe(Number(json));
      }),
      { numRuns: 1000 },
    );
  });

  it("miles con más de un punto (\"1.234.567\") no son decimales", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 10n ** 6n, max: 10n ** 15n }), (n) => {
        expect(num(miles(n))).toBe(Number(n));
      }),
      { numRuns: 500 },
    );
  });

  it("número JSON finito: igual; cualquier otra cosa: número finito o null", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        expect(num(x)).toBe(x);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.string(), fc.double().map(String)), (x) => {
        const n = num(x);
        expect(n === null || Number.isFinite(n)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("regresiones: blancos, listas y booleanos no son 0 ni números", () => {
    for (const x of [" ", "\t", [], [5], ["1"], true, false, {}, "0x10", "1e400", "Infinity", "--1"]) expect(num(x)).toBeNull();
  });
});

describe("str", () => {
  it("objetos y listas no se vuelven \"[object Object]\"", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        const s = str(x);
        expect(s === null || (typeof s === "string" && s === s.trim() && s !== "")).toBe(true);
        if (s !== null) expect(s).not.toMatch(/^\[object /);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("monto", () => {
  const dia = fc.option(fc.constant("2026-10-01"));
  it("nunca inventa CLP: con moneda desconocida devuelve null", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.jsonValue({ maxDepth: 2 }), dia, (v, mon, d) => {
        const m = monto(v, mon, d);
        const ausente = mon === null || (typeof mon === "string" && !mon.trim());
        if (!ausente && moneda(mon) === null) expect(m).toBeNull();
        if (m) {
          expect(Number.isFinite(m.valor)).toBe(true);
          expect(m.moneda).toBe(ausente ? "CLP" : moneda(mon));
          expect(m.clp).toBe(m.moneda === "CLP" ? m.valor : null);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("moneda: alias conocidos sin importar mayúsculas ni espacios", () => {
    fc.assert(
      fc.property(fc.constantFrom("CLP", "CLF", "UTM", "USD", "EUR", "UF", "$", "PESO", "pesos"), fc.boolean(), (m, min) => {
        const t = ` ${min ? m.toLowerCase() : m} `;
        expect(moneda(t)).toBe(m === "UF" ? "CLF" : ["$", "PESO", "pesos"].includes(m) ? "CLP" : m);
      }),
    );
  });
});
