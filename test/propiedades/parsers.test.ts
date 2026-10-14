// Los parsers nunca lanzan y siempre devuelven un Proceso bien formado, venga lo que venga.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { desdeOcds } from "../../src/ocds.js";
import { parseLicitacion, parseOrdenCompra } from "../../src/v1/parse.js";
import { parseCompraAgil } from "../../src/v2/parse.js";
import { bienFormado, mutado, ocdsCm, ocdsLicitacion, v1, v2Detalle, v2Listado } from "./generadores.js";

const N = { numRuns: 400 };
const cualquiera = fc.jsonValue({ maxDepth: 4 });

/** desdeOcds lanza TypeError solo si no hay código (no es OCDS); si traduce, todo sale bien formado. */
function ocdsOk(x: unknown) {
  let ps;
  try {
    ps = desdeOcds(x);
  } catch (e) {
    expect(e).toBeInstanceOf(TypeError);
    expect(String(e)).toMatch(/No es una release OCDS/);
    return;
  }
  for (const p of ps) bienFormado(p, p.raw);
  if (ps.length === 1 && x && typeof x === "object" && !Array.isArray(x) && !("records" in x) && !("releases" in x)) expect(ps[0]!.raw).toBe(x);
}

describe("parsers con JSON arbitrario", () => {
  it("v1 licitación y OC", () => {
    fc.assert(
      fc.property(cualquiera, (x) => {
        bienFormado(parseLicitacion(x), x);
        bienFormado(parseOrdenCompra(x), x);
      }),
      N,
    );
  });
  it("v2 listado y detalle", () => {
    fc.assert(
      fc.property(cualquiera, fc.boolean(), (x, detalle) => bienFormado(parseCompraAgil(x, { detalle }), x)),
      N,
    );
  });
  it("OCDS", () => {
    fc.assert(fc.property(cualquiera, ocdsOk), N);
  });
});

describe("parsers con fixtures mutados", () => {
  for (const [nombre, base, parse] of [
    ["licitación real", () => v1("licitacion-detalle.real"), parseLicitacion],
    ["licitación reconstruida", () => v1("licitacion-detalle"), parseLicitacion],
    ["OC real", () => v1("oc-detalle.real"), parseOrdenCompra],
    ["OC reconstruida", () => v1("oc-detalle"), parseOrdenCompra],
    ["v2 detalle", v2Detalle, (x: unknown) => parseCompraAgil(x, { detalle: true })],
    ["v2 listado", v2Listado, (x: unknown) => parseCompraAgil(x, { detalle: false })],
  ] as const)
    it(nombre, () => {
      fc.assert(
        fc.property(mutado(base), (x) => bienFormado(parse(x), x)),
        N,
      );
    });

  it("OCDS CM y licitación", () => {
    fc.assert(fc.property(fc.oneof(mutado(ocdsCm), mutado(ocdsLicitacion)), ocdsOk), N);
  });

  it("los avisos no cambian el resultado ni lanzan, aunque el hook lance", () => {
    const sinRaw = (p: object) => JSON.stringify({ ...p, raw: null });
    const avisar = () => {
      throw new Error("hook roto");
    };
    fc.assert(
      fc.property(mutado(() => v1("licitacion-detalle.real")), mutado(() => v1("oc-detalle.real")), mutado(v2Detalle), (l, o, c) => {
        expect(sinRaw(parseLicitacion(l, { avisar }))).toBe(sinRaw(parseLicitacion(l)));
        expect(sinRaw(parseOrdenCompra(o, { avisar }))).toBe(sinRaw(parseOrdenCompra(o)));
        expect(sinRaw(parseCompraAgil(c, { detalle: true, avisar }))).toBe(sinRaw(parseCompraAgil(c, { detalle: true })));
      }),
      { numRuns: 200 },
    );
  });
});
