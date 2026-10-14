import { describe, expect, it } from "vitest";
import type { CompraAgil, Cotizacion, Monto, Proceso } from "../src/modelo.js";
import { AJUSTES, priorizar, rangoDePrecio, type Oportunidad, type Perfil } from "../src/radar/index.js";

const AHORA = new Date("2026-10-13T12:00:00-03:00");
const enDias = (d: number) => new Date(AHORA.getTime() + d * 86_400_000).toISOString();
const enPesos = (m: number): Monto => ({ valor: m, moneda: "CLP", clp: m, fechaValor: "2026-10-13", fuente: "identidad" });

function proceso(x: { codigo?: string; estado?: string; region?: number | null; monto?: Monto | null; cierre?: string | null; oferentes?: number | null; productos?: number[] } = {}): Proceso {
  return {
    tipo: "licitacion",
    tipoLicitacion: "L1",
    tipoLicitacionGlosa: null,
    codigo: x.codigo ?? "1-1-L126",
    nombre: "x",
    descripcion: null,
    estado: x.estado ?? "publicada",
    estadoGlosa: null,
    comprador: { codigoOrganismo: null, nombreOrganismo: null, rutUnidad: null, codigoUnidad: null, nombreUnidad: null, region: x.region === undefined ? 13 : x.region, comuna: null },
    fechas: { creacion: null, publicacion: null, cierre: x.cierre === undefined ? enDias(10) : x.cierre, adjudicacion: null, ultimoCambio: null },
    monto: x.monto === undefined ? enPesos(5_000_000) : x.monto,
    items: (x.productos ?? [43211507]).map((c) => ({ codigoProducto: c, nombre: null, descripcion: null, cantidad: 1, unidad: null, precioUnitario: null, total: null, proveedor: null })),
    oferentes: x.oferentes === undefined ? 0 : x.oferentes,
    personales: null,
    origen: "v1",
    raw: null,
  };
}

const factor = (o: Oportunidad | undefined, nombre: string) => o!.factores.find((f) => f.nombre === nombre)!;
/** Evalúa un factor solo, con peso 1. */
const solo = (nombre: keyof Perfil["pesos"], p: Proceso, perfil: Omit<Perfil, "pesos"> = {}) =>
  factor(priorizar([p], { ...perfil, pesos: { [nombre]: 1 } }, { ahora: AHORA, incluirCerrados: true })[0], nombre);

describe("priorizar", () => {
  const perfil: Perfil = { pesos: { rubro: 3, region: 1, monto: 2, diasAlCierre: 1, competencia: 1 }, rubros: ["4321"], regiones: [13], montoMin: 1_000_000, montoMax: 10_000_000 };

  it("ordena por puntaje y el puntaje es la suma de los aportes", () => {
    const ops = priorizar(
      [proceso({ codigo: "malo", region: 5, productos: [10101501], oferentes: 9 }), proceso({ codigo: "bueno" }), proceso({ codigo: "medio", region: 5 })],
      perfil,
      { ahora: AHORA },
    );
    expect(ops.map((o) => o.proceso.codigo)).toEqual(["bueno", "medio", "malo"]);
    for (const o of ops) {
      expect(o.puntaje).toBe(o.factores.reduce((s, f) => s + f.aporte, 0));
      for (const f of o.factores) expect(f.aporte).toBeCloseTo(f.peso * f.valor);
    }
    expect(ops[0]!.puntaje).toBeCloseTo(1);
  });

  it("normaliza los pesos; el que falta vale 0; todo en 0 o negativo lanza", () => {
    const [o] = priorizar([proceso()], { pesos: { rubro: 2, region: 6 } }, { ahora: AHORA });
    expect(o!.factores.map((f) => f.peso)).toEqual([0.25, 0.75, 0, 0, 0]);
    expect(() => priorizar([], { pesos: {} })).toThrow(RangeError);
    expect(() => priorizar([], { pesos: { rubro: 0 } })).toThrow(RangeError);
    expect(() => priorizar([], { pesos: { rubro: 1, monto: -1 } })).toThrow(RangeError);
  });

  it("excluye los no abiertos salvo incluirCerrados", () => {
    const ps = [proceso({ codigo: "a" }), proceso({ codigo: "c", estado: "adjudicada" })];
    expect(priorizar(ps, perfil, { ahora: AHORA }).map((o) => o.proceso.codigo)).toEqual(["a"]);
    const todas = priorizar(ps, perfil, { ahora: AHORA, incluirCerrados: true });
    expect(factor(todas.find((o) => o.proceso.codigo === "c"), "diasAlCierre")).toMatchObject({ valor: 0, razon: expect.stringContaining("adjudicada") });
  });

  it("rubro: crédito UNSPSC por nivel compartido", () => {
    const r = (rubro: string, codigo: number) => solo("rubro", proceso({ productos: [codigo] }), { rubros: [rubro] }).valor;
    expect(r("43211507", 43211507)).toBe(1);
    expect(r("43", 43211507)).toBe(1);
    expect(r("432115", 43211507)).toBe(1);
    expect(r("43211507", 43211508)).toBe(0.75); // misma clase
    expect(r("43211507", 43212001)).toBe(0.5); // misma familia
    expect(r("43211507", 43190000)).toBe(0.25); // mismo segmento
    expect(r("4321", 10101501)).toBe(0);
    // Se queda con el mejor par ítem × rubro.
    expect(solo("rubro", proceso({ productos: [10101501, 43211508] }), { rubros: ["44", "43211507"] }).valor).toBe(0.75);
    // Escala configurable.
    expect(solo("rubro", proceso({ productos: [43211508] }), { rubros: ["43211507"], creditoRubro: [0, 0.1, 0.2, 0.3] }).valor).toBe(0.3);
    expect(solo("rubro", proceso({ productos: [] }), { rubros: ["43"] })).toMatchObject({ valor: 0.5, razon: expect.stringContaining("neutro") });
    expect(solo("rubro", proceso()).valor).toBe(AJUSTES.neutro);
    expect(() => priorizar([], { pesos: { rubro: 1 }, rubros: ["432"] })).toThrow(RangeError);
  });

  it("región: dentro 1, fuera 0, desconocida 0,5", () => {
    expect(solo("region", proceso({ region: 13 }), { regiones: [13, 5] }).valor).toBe(1);
    expect(solo("region", proceso({ region: 8 }), { regiones: [13] }).valor).toBe(0);
    expect(solo("region", proceso({ region: null }), { regiones: [13] })).toMatchObject({ valor: 0.5, razon: expect.stringContaining("No se sabe") });
  });

  it("monto: 1 en rango, decae en log10, 0,5 si no hay CLP", () => {
    const rango = { montoMin: 1_000_000, montoMax: 10_000_000 };
    const m = (monto: Monto | null) => solo("monto", proceso({ monto }), rango);
    expect(m(enPesos(1_000_000)).valor).toBe(1);
    expect(m(enPesos(10_000_000)).valor).toBe(1);
    expect(m(enPesos(10_000_000 * Math.sqrt(10))).valor).toBeCloseTo(0.5);
    expect(m(enPesos(100_000)).valor).toBe(0);
    expect(m(enPesos(1)).valor).toBe(0);
    expect(m({ valor: 100, moneda: "CLF", clp: null, fechaValor: null, fuente: null })).toMatchObject({ valor: 0.5, razon: expect.stringContaining("sin convertir") });
    expect(m(null)).toMatchObject({ valor: 0.5, razon: expect.stringContaining("desconocido") });
    expect(solo("monto", proceso({ monto: enPesos(1_000_000) }), { ...rango, decadasMonto: 2 }).valor).toBe(1);
    expect(solo("monto", proceso({ monto: enPesos(100_000) }), { ...rango, decadasMonto: 2 }).valor).toBeCloseTo(0.5);
    expect(() => priorizar([], { pesos: { monto: 1 }, montoMin: 2, montoMax: 1 })).toThrow(RangeError);
  });

  it("días al cierre: 0 si ya pasó, rampa bajo diasMinimos, neutro sin fecha", () => {
    const d = (cierre: string | null, perfil = {}) => solo("diasAlCierre", proceso({ cierre }), perfil);
    expect(d(enDias(-1))).toMatchObject({ valor: 0, razon: expect.stringContaining("ya pasó") });
    expect(d(enDias(1)).valor).toBeCloseTo(0.5);
    expect(d(enDias(2)).valor).toBe(1);
    expect(d(enDias(30)).valor).toBe(1);
    expect(d(enDias(2), { diasMinimos: 4 }).valor).toBeCloseTo(0.5);
    expect(d(null).valor).toBe(0.5);
  });

  it("competencia: k / (k + n), desconocida 0,5", () => {
    const c = (oferentes: number | null) => solo("competencia", proceso({ oferentes })).valor;
    expect(c(0)).toBe(1);
    expect(c(3)).toBe(0.5);
    expect(c(9)).toBe(0.25);
    expect(c(null)).toBe(0.5);
    expect(solo("competencia", proceso({ oferentes: 1 }), { oferentesReferencia: 1 }).valor).toBe(0.5);
  });
});

describe("rangoDePrecio", () => {
  const COD = 44121701;
  const cot = (precios: (number | null)[], seleccionada = false, codigo = COD): Cotizacion => ({
    proveedor: null,
    monto: null,
    seleccionada,
    productos: precios.map((p) => ({ codigoProducto: codigo, nombre: null, cantidad: 1, precioUnitario: p === null ? null : { ...enPesos(p), clp: p } })),
  });
  const compra = (cotizaciones: Cotizacion[], unidad: string | null = "Unidad"): CompraAgil => ({
    ...(proceso() as Omit<CompraAgil, "tipo" | "ordenCompra" | "cotizaciones">),
    tipo: "compra_agil",
    ordenCompra: null,
    items: [{ codigoProducto: COD, nombre: null, descripcion: null, cantidad: 1, unidad, precioUnitario: null, total: null, proveedor: null }],
    cotizaciones,
  });
  // 100..1000 desordenado y repartido en dos compras.
  const diez = [compra([cot([700, 100, 1000]), cot([300, 900], true)]), compra([cot([500, 200], true), cot([800, 400, 600]), cot([null], true), cot([5], false, 99999999)])];

  it("p25/p50/p75 por interpolación lineal (tipo 7)", () => {
    const r = rangoDePrecio(COD, diez);
    // h = 9p → p25: x[2] + 0,25·(x[3] − x[2]) = 325; p50: x[4] + 0,5·100 = 550; p75: x[6] + 0,75·100 = 775.
    expect(r).toMatchObject({ n: 10, p25: 325, p50: 550, p75: 775, unidad: "unidad", moneda: "CLP", soloSeleccionadas: false });
    expect(r.supuestos.join(" ")).toMatch(/Hyndman–Fan tipo 7/);
    expect(r.supuestos.join(" ")).toMatch(/Se omitieron 1 precios/);
  });

  it("con n < mínimo dice muestra insuficiente", () => {
    const r = rangoDePrecio(COD, [compra([cot([1, 2, 3, 4, 5, 6, 7, 8, 9])])]);
    expect(r).toEqual({ n: 9, insuficiente: true, motivo: "muestra insuficiente", supuestos: expect.any(Array) });
    expect(rangoDePrecio(COD, [compra([cot([1, 2, 3])])], { minimo: 3 })).toMatchObject({ n: 3, p50: 2 });
  });

  it("soloSeleccionadas usa solo las cotizaciones seleccionadas", () => {
    const r = rangoDePrecio(COD, diez, { soloSeleccionadas: true, minimo: 4 });
    // [200, 300, 500, 900]: p25 = 200 + 0,75·100 = 275, p50 = 400, p75 = 500 + 0,25·400 = 600.
    expect(r).toMatchObject({ n: 4, p25: 275, p50: 400, p75: 600, soloSeleccionadas: true });
    expect(r.supuestos.join(" ")).toMatch(/cuánto suele ganar/);
  });

  it("unidades distintas: usa la más frecuente y lo dice, o la pedida", () => {
    const mezcla = [...diez, compra([cot([1, 2, 3])], " CAJA ")];
    const r = rangoDePrecio(COD, mezcla);
    expect(r).toMatchObject({ n: 10, p50: 550, unidad: "unidad" });
    expect(r.supuestos.join(" ")).toMatch(/varias unidades \(unidad: 10, caja: 3\); se usó la más frecuente, unidad/);
    expect(rangoDePrecio(COD, mezcla, { unidad: "Caja", minimo: 3 })).toMatchObject({ n: 3, p50: 2, unidad: "caja" });
    expect(rangoDePrecio(COD, mezcla, { unidad: "kilo" })).toMatchObject({ n: 0, insuficiente: true });
  });
});
