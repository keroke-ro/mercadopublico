// radar: puntajes acotados y explicables, orden estable; percentiles ordenados dentro de la muestra.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CompraAgil, Monto, Proceso } from "../../src/modelo.js";
import { priorizar, rangoDePrecio, type Perfil } from "../../src/radar/index.js";

const AHORA = new Date("2026-10-13T12:00:00-03:00");
const clp = (v: number): Monto => ({ valor: v, moneda: "CLP", clp: v, fechaValor: null, fuente: "identidad" });
const finito = fc.double({ noNaN: true, noDefaultInfinity: true });
const codigo = fc.oneof(fc.integer({ min: 10_000_000, max: 99_999_999 }), fc.constantFrom(43211507, 43211508, 43210000, 44121701));

const proceso: fc.Arbitrary<Proceso> = fc
  .record({
    estado: fc.constantFrom("publicada", "cerrada", "adjudicada"),
    region: fc.option(fc.integer({ min: 1, max: 16 })),
    monto: fc.option(fc.oneof(finito.map(clp), fc.constant<Monto>({ valor: 10, moneda: "CLF", clp: null, fechaValor: null, fuente: null }))),
    cierre: fc.option(fc.oneof(fc.date({ noInvalidDate: true, min: new Date("2000-01-01"), max: new Date("2100-01-01") }).map((d) => d.toISOString()), fc.constant("no es fecha"))),
    oferentes: fc.option(fc.integer({ min: -5, max: 1000 })),
    productos: fc.array(fc.option(codigo), { maxLength: 4 }),
  })
  .map((x) => ({
    tipo: "licitacion",
    tipoLicitacion: null,
    tipoLicitacionGlosa: null,
    codigo: "1-1-L126",
    nombre: "x",
    descripcion: null,
    estado: x.estado,
    estadoGlosa: null,
    comprador: { codigoOrganismo: null, nombreOrganismo: null, rutUnidad: null, codigoUnidad: null, nombreUnidad: null, region: x.region, comuna: null },
    fechas: { creacion: null, publicacion: null, cierre: x.cierre, adjudicacion: null, ultimoCambio: null },
    monto: x.monto,
    items: x.productos.map((c) => ({ codigoProducto: c, nombre: null, descripcion: null, cantidad: 1, unidad: null, precioUnitario: null, total: null, proveedor: null })),
    oferentes: x.oferentes,
    personales: null,
    origen: "v1",
    raw: null,
  }));

const peso = fc.oneof(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.constantFrom(0, 1, 1e300, Number.MAX_VALUE));
const perfil: fc.Arbitrary<Perfil> = fc
  .record(
    {
      pesos: fc.record({ rubro: peso, region: peso, monto: peso, diasAlCierre: peso, competencia: peso }, { requiredKeys: [] }),
      rubros: fc.array(fc.oneof(fc.stringMatching(/^\d{2}(\d{2}){0,3}$/), fc.constantFrom(43, 4321, "432115", 43211507))),
      regiones: fc.array(fc.integer({ min: 1, max: 16 })),
      montoMin: fc.double({ min: 0, max: 1e12, noNaN: true }),
      montoMax: fc.double({ min: 0, max: 1e15, noNaN: true }),
      neutro: fc.double({ min: 0, max: 1, noNaN: true }),
      decadasMonto: fc.double({ min: 0.01, max: 10, noNaN: true }),
      diasMinimos: fc.double({ min: 0.01, max: 30, noNaN: true }),
      oferentesReferencia: fc.double({ min: 0.01, max: 50, noNaN: true }),
    },
    { requiredKeys: ["pesos"] },
  )
  .filter((p) => Object.values(p.pesos).some((w) => w! > 0) && (p.montoMin ?? 0) <= (p.montoMax ?? Infinity));

describe("priorizar", () => {
  it("puntaje en [0, 1], igual a Σ aporte, sin NaN, ordenado desc", () => {
    fc.assert(
      fc.property(fc.array(proceso, { maxLength: 8 }), perfil, fc.boolean(), (ps, pf, incluirCerrados) => {
        const ops = priorizar(ps, pf, { ahora: AHORA, incluirCerrados });
        let previo = Infinity;
        for (const o of ops) {
          expect(o.puntaje).toBeGreaterThanOrEqual(0);
          expect(o.puntaje).toBeLessThanOrEqual(1);
          expect(Math.abs(o.puntaje - o.factores.reduce((s, f) => s + f.aporte, 0))).toBeLessThanOrEqual(1e-9);
          expect(Math.abs(o.factores.reduce((s, f) => s + f.peso, 0) - 1)).toBeLessThanOrEqual(1e-9);
          for (const f of o.factores) {
            expect(f.valor).toBeGreaterThanOrEqual(0);
            expect(f.valor).toBeLessThanOrEqual(1);
          }
          expect(o.puntaje).toBeLessThanOrEqual(previo);
          previo = o.puntaje;
        }
      }),
      { numRuns: 500 },
    );
  });

  it("regresiones: monto negativo, oferentes negativos y pesos enormes no dan NaN ni salen de [0, 1]", () => {
    const base = { pesos: { monto: 1, competencia: 1 }, montoMin: 0, montoMax: 10 };
    const p = { ...fc.sample(proceso, { seed: 1, numRuns: 1 })[0]!, estado: "publicada", monto: clp(-5), oferentes: -3 } as Proceso;
    const [o] = priorizar([p], base, { ahora: AHORA });
    // Antes: NaN (log10 de un negativo) y competencia 3/(3−3) = Infinity. Ahora monto 0 y competencia neutra.
    expect(o!.factores.find((f) => f.nombre === "monto")!.valor).toBe(0);
    expect(o!.factores.find((f) => f.nombre === "competencia")!.valor).toBe(0.5);
    expect(o!.puntaje).toBe(0.25);
    const [g] = priorizar([p], { pesos: { rubro: Number.MAX_VALUE, region: Number.MAX_VALUE } }, { ahora: AHORA });
    expect(g!.factores.map((f) => f.peso)).toEqual([0.5, 0.5, 0, 0, 0]);
    // Pesos 7, 4, 2, 2, 3 normalizados suman 1,0000000000000002; con todo en 1 el puntaje no pasa de 1.
    const lleno = { ...p, monto: clp(5), oferentes: 0, fechas: { ...p.fechas, cierre: "2027-01-01T00:00:00-03:00" } } as Proceso;
    const [u] = priorizar([lleno], { pesos: { rubro: 7, region: 4, monto: 2, diasAlCierre: 2, competencia: 3 }, montoMin: 0, montoMax: 10, neutro: 1 }, { ahora: AHORA });
    expect(u!.factores.every((f) => f.valor === 1)).toBe(true);
    expect(u!.puntaje).toBe(1);
  });
});

describe("rangoDePrecio", () => {
  const COD = 43211507;
  const compra = (precios: (number | null)[], unidad: string | null, seleccionada: boolean): CompraAgil =>
    ({
      tipo: "compra_agil",
      items: [{ codigoProducto: COD, unidad }],
      cotizaciones: precios.map((v) => ({
        proveedor: null,
        monto: null,
        seleccionada,
        productos: [{ codigoProducto: COD, nombre: null, cantidad: 1, precioUnitario: v === null ? null : clp(v) }],
      })),
    }) as unknown as CompraAgil;

  it("p25 ≤ p50 ≤ p75 dentro de [min, max]; insuficiente si n < minimo", () => {
    const precio = fc.oneof(fc.double({ min: -1e15, max: 1e15, noNaN: true }), fc.integer({ min: 1, max: 1e7 }), fc.constant(null));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.array(precio, { maxLength: 6 }), fc.constantFrom("Unidad", "unidad ", "KG", null), fc.boolean()), { maxLength: 8 }),
        fc.integer({ min: 0, max: 15 }),
        fc.boolean(),
        (cs, minimo, soloSeleccionadas) => {
          const r = rangoDePrecio(
            COD,
            cs.map(([ps, u, s]) => compra(ps, u, s)),
            { minimo, soloSeleccionadas },
          );
          if ("insuficiente" in r) {
            expect(r.n === 0 || r.n < minimo).toBe(true);
            return;
          }
          expect(r.n).toBeGreaterThanOrEqual(Math.max(1, minimo));
          const xs = cs.flatMap(([ps, u, s]) => (soloSeleccionadas && !s ? [] : (u?.trim().toLowerCase() || null) === r.unidad ? ps : [])).filter((v): v is number => v !== null);
          expect(xs.length).toBe(r.n);
          const [min, max] = [Math.min(...xs), Math.max(...xs)];
          expect(min).toBeLessThanOrEqual(r.p25);
          expect(r.p25).toBeLessThanOrEqual(r.p50);
          expect(r.p50).toBeLessThanOrEqual(r.p75);
          expect(r.p75).toBeLessThanOrEqual(max);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
