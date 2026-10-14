import { describe, expect, it } from "vitest";
import type { CompraAgil, Cotizacion, Monto, OrdenCompra, Proceso, Proveedor } from "../src/modelo.js";
import { AJUSTES, calibrar, competidores, decidir, precioSugerido, priorizar, proximasCompras, rangoDePrecio, type Oportunidad, type Perfil } from "../src/radar/index.js";

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
    expect(o!.factores.map((f) => f.peso)).toEqual([0.25, 0.75, 0, 0, 0, 0]);
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
    expect(rangoDePrecio(COD, [], { minimo: 0 })).toMatchObject({ n: 0, insuficiente: true }); // no NaN
  });
});

// ── Lo nuevo: historial, decidir, calibrar, precio sugerido, competidores, próximas compras ──

const prov = (rut: string, nombre = rut): Proveedor => ({ rut, nombre, codigo: null });
const enOrganismo = (p: Proceso, org: string, dia = "2026-01-01"): Proceso => ({
  ...p,
  comprador: { ...p.comprador!, codigoOrganismo: org, nombreOrganismo: `Org ${org}` },
  fechas: { ...p.fechas, publicacion: `${dia}T10:00:00-03:00` },
});
/** OC adjudicada a `rut` en el organismo, con un ítem del producto. */
const oc = (codigo: string, rut: string, org = "7248", producto = 43211507, dia = "2026-01-01", procesoOrigen: string | null = null): OrdenCompra => ({
  ...(enOrganismo(proceso({ codigo, estado: "aceptada", productos: [producto], monto: enPesos(1000) }), org, dia) as Omit<OrdenCompra, "tipo" | "tipoOrden" | "proveedor" | "procesoOrigen">),
  tipo: "orden_compra",
  tipoOrden: null,
  proveedor: prov(rut),
  procesoOrigen,
});

describe("incumbente", () => {
  const abierta = enOrganismo(proceso({ productos: [43211508] }), "7248");
  const inc = (historial: Proceso[], rut?: string) =>
    priorizar([abierta], { pesos: { incumbente: 1 }, rut }, { ahora: AHORA, historial })[0]!.factores.find((f) => f.nombre === "incumbente")!;

  it("1 − cuota del proveedor ajeno que más gana en el organismo y la familia", () => {
    const h = [oc("a", "1-9"), oc("b", "1-9"), oc("c", "1-9"), oc("d", "2-7")];
    expect(inc(h)).toMatchObject({ valor: 0.25, razon: expect.stringContaining("1-9 se llevó 3 de 4") });
    // Si el que más gana eres tú, cuenta el siguiente.
    expect(inc(h, "1.9")).toMatchObject({ valor: 0.75, razon: expect.stringContaining("Tú, 3") });
    expect(inc([oc("a", "1-9"), oc("b", "1-9"), oc("c", "1-9")], "1-9").valor).toBe(1);
  });

  it("neutro sin historial, con pocas victorias o en otro organismo o familia", () => {
    expect(solo("incumbente", abierta).valor).toBe(AJUSTES.neutro);
    expect(inc([oc("a", "1-9"), oc("b", "1-9")]).razon).toMatch(/Solo 2 adjudicaciones/);
    expect(inc([oc("a", "1-9", "999"), oc("b", "1-9", "999"), oc("c", "1-9", "999")]).valor).toBe(AJUSTES.neutro);
    expect(inc([oc("a", "1-9", "7248", 10101501), oc("b", "1-9", "7248", 10101501), oc("c", "1-9", "7248", 10101501)]).valor).toBe(AJUSTES.neutro);
  });
});

describe("decidir", () => {
  const perfil: Perfil = { pesos: { rubro: 1, region: 1 }, rubros: ["4321"], regiones: [13] };

  it("postular, revisar o descartar según umbrales, con su porqué", () => {
    const ds = decidir([proceso({ codigo: "si" }), proceso({ codigo: "medio", region: 5 }), proceso({ codigo: "no", region: 5, productos: [10101501] })], perfil, { ahora: AHORA });
    expect(ds.map((d) => [d.proceso.codigo, d.accion])).toEqual([["si", "postular"], ["medio", "revisar"], ["no", "descartar"]]);
    expect(ds[0]!.porque).toHaveLength(2);
    expect(ds[1]!.porque[1]).toMatch(/^Ojo: .*región 5/);
    expect(ds[2]!.turno).toBeNull();
  });

  it("avisa cuando el organismo no publica el monto (VisibilidadMonto 0)", () => {
    const oculto = { ...proceso({ codigo: "oculto", monto: null }), raw: { VisibilidadMonto: 0 } };
    const conMonto = { ...perfil, pesos: { rubro: 3, region: 1, diasAlCierre: 1, monto: 1 }, montoMin: 1, montoMax: 10 };
    const [d] = decidir([oculto], conMonto, { ahora: AHORA });
    expect(factor(d, "monto").razon).toBe("El organismo no publica el monto estimado; factor neutro.");
    expect(d!.porque.at(-1)).toBe("Ojo: El organismo no publica el monto estimado; factor neutro.");
    expect(new Set(d!.porque).size).toBe(d!.porque.length);
    // Sin peso de monto, o con el monto solo desconocido, no se agrega nada.
    expect(decidir([oculto], perfil, { ahora: AHORA })[0]!.porque.join()).not.toMatch(/monto/);
    expect(factor(decidir([proceso({ monto: null })], conMonto, { ahora: AHORA })[0], "monto").razon).toBe("Monto desconocido; factor neutro.");
  });

  it("vetos y palabras excluidas descartan aunque el puntaje sea alto", () => {
    const p = { ...proceso({ codigo: "x", region: 5 }), nombre: "Instalación de equipos" };
    const [v] = decidir([p], { ...perfil, pesos: { rubro: 1 }, vetos: [{ factor: "region", minimo: 1 }] }, { ahora: AHORA });
    expect(v).toMatchObject({ accion: "descartar", porque: [expect.stringMatching(/^Veto de region/)] });
    const [e] = decidir([p], { ...perfil, excluir: ["INSTALACION"] }, { ahora: AHORA });
    expect(e).toMatchObject({ accion: "descartar", porque: ['Menciona "instalacion", que tu perfil excluye.'] });
    expect(() => decidir([], { ...perfil, vetos: [{ factor: "nada" as "rubro", minimo: 1 }] })).toThrow(RangeError);
    expect(() => decidir([], { ...perfil, umbralRevisar: 0.9 })).toThrow(RangeError);
    expect(() => decidir([], { ...perfil, capacidad: 1.5 })).toThrow(RangeError);
  });

  it("agenda: las N de mejor puntaje, ordenadas por cierre; las que no caben lo dicen", () => {
    const ps = [proceso({ codigo: "tarde", cierre: enDias(20) }), proceso({ codigo: "pronto", cierre: enDias(3) }), proceso({ codigo: "peor", region: 5, cierre: enDias(1) })];
    const ds = decidir(ps, { ...perfil, capacidad: 2 }, { ahora: AHORA });
    expect(ds.map((d) => [d.proceso.codigo, d.turno])).toEqual([["pronto", 1], ["tarde", 2], ["peor", null]]);
    expect(ds[2]!.porque.at(-1)).toMatch(/capacidad de 2/);
    // Sin capacidad, todas las no descartadas van a la agenda.
    expect(decidir(ps, perfil, { ahora: AHORA }).map((d) => d.turno)).toEqual([1, 2, 3]);
  });
});

describe("calibrar", () => {
  // El equipo postula lo de pocos oferentes y descarta lo de muchos; el perfil solo mira la región (que no discrimina).
  const ps = Array.from({ length: 12 }, (_, i) => proceso({ codigo: `p${i}`, oferentes: i < 6 ? 0 : 20, region: i % 2 ? 13 : 5 }));
  const decisiones = ps.map((p, i) => ({ codigo: p.codigo, decision: i < 6 ? ("postular" as const) : ("descartar" as const) }));
  const perfil: Perfil = { pesos: { region: 4, competencia: 0 }, regiones: [13] };

  it("propone subir el peso que separa lo que el equipo postula de lo que descarta", () => {
    const c = calibrar(ps, perfil, decisiones, { ahora: AHORA });
    if ("insuficiente" in c) throw new Error("insuficiente");
    expect(c.acuerdo).toBe(0.5);
    expect(c.acuerdoSugerido).toBe(1);
    expect(c.cambios.find((x) => x.factor === "competencia")).toMatchObject({ de: 0, razon: expect.stringMatching(/^Sube competencia/) });
    expect(c.pesosSugeridos.competencia).toBeGreaterThan(0);
    expect(Object.values(c.pesosSugeridos).reduce((s, x) => s + x, 0)).toBeCloseTo(4, 1);
  });

  it("sin cambios si ya calza, e insuficiente con pocas decisiones", () => {
    const c = calibrar(ps, { pesos: { competencia: 1 } }, decisiones, { ahora: AHORA });
    expect(c).toMatchObject({ acuerdo: 1, acuerdoSugerido: 1, cambios: [], desacuerdos: [] });
    expect(calibrar(ps, perfil, decisiones.slice(0, 8), { ahora: AHORA })).toMatchObject({ insuficiente: true, postuladas: 6, descartadas: 2 });
    expect(calibrar(ps, perfil, [...decisiones, { codigo: "fantasma", decision: "postular" }]).supuestos.join(" ")).toMatch(/1 decisiones sin su proceso/);
  });
});

describe("precioSugerido", () => {
  const COD = 44121701;
  const compra = (precio: number): CompraAgil => ({
    ...(proceso() as Omit<CompraAgil, "tipo" | "ordenCompra" | "cotizaciones">),
    tipo: "compra_agil",
    ordenCompra: null,
    items: [{ codigoProducto: COD, nombre: null, descripcion: null, cantidad: 1, unidad: "caja", precioUnitario: null, total: null, proveedor: null }],
    cotizaciones: [{ proveedor: null, monto: null, seleccionada: true, productos: [{ codigoProducto: COD, nombre: null, cantidad: 1, precioUnitario: enPesos(precio) }] }],
  });
  const ganadores = [100, 200, 300, 400, 500].map(compra);

  it("maximiza P(ganar) × (precio − costo) sobre los precios ganadores", () => {
    // costo 50: 100→1·50=50, 200→0,8·150=120, 300→0,6·250=150, 400→0,4·350=140, 500→0,2·450=90.
    const r = precioSugerido(COD, ganadores, { costo: 50, minimo: 5 });
    expect(r).toMatchObject({ n: 5, precio: 300, ganadas: 3, probabilidad: 0.6, ganancia: 150, margen: 250 / 300, unidad: "caja" });
    if (!("insuficiente" in r)) expect(r.curva.map((c) => c.ganadas)).toEqual([5, 4, 3, 2, 1]);
  });

  it("insuficiente con poca muestra o costo sobre todo lo que ganó; costo inválido lanza", () => {
    expect(precioSugerido(COD, ganadores, { costo: 50 })).toMatchObject({ insuficiente: true, motivo: "muestra insuficiente" });
    expect(precioSugerido(COD, ganadores, { costo: 600, minimo: 5 })).toMatchObject({ insuficiente: true, motivo: "costo sobre los precios ganadores" });
    expect(() => precioSugerido(COD, ganadores, { costo: -1 })).toThrow(RangeError);
  });
});

describe("competidores", () => {
  it("victorias, tasa, cuota y HHI; una OC no duplica la Compra Ágil de la que viene", () => {
    const ca: CompraAgil = {
      ...(enOrganismo(proceso({ codigo: "CA1", estado: "oc_emitida" }), "7248") as Omit<CompraAgil, "tipo" | "ordenCompra" | "cotizaciones">),
      tipo: "compra_agil",
      ordenCompra: null,
      cotizaciones: [
        { proveedor: prov("1-9", "Uno"), monto: null, seleccionada: false, productos: [] },
        { proveedor: prov("2-7", "Dos"), monto: null, seleccionada: false, productos: [] },
      ],
    };
    const h = [ca, oc("OC1", "1-9", "7248", 43211507, "2026-01-01", "CA1"), oc("OC2", "1-9"), oc("OC3", "2-7"), oc("OTRA", "3-5", "7248", 10101501)];
    const r = competidores(h, { rubros: ["4321"], rut: "2.7" });
    expect(r).toMatchObject({ procesos: 3, victorias: 3, lectura: expect.stringMatching(/^Concentrado/) });
    expect(r.hhi).toBeCloseTo((200 / 3) ** 2 + (100 / 3) ** 2);
    expect(r.competidores.map((c) => [c.proveedor.nombre, c.participaciones, c.victorias, c.eresTu])).toEqual([
      ["Uno", 2, 2, false],
      ["Dos", 2, 1, true],
    ]);
    expect(r.competidores[1]!.tasa).toBe(0.5);
    expect(competidores([])).toMatchObject({ hhi: null, lectura: "Sin adjudicaciones registradas." });
  });
});

describe("proximasCompras", () => {
  const cada30 = ["2026-06-01", "2026-07-01", "2026-07-31", "2026-08-30"].map((d, i) => oc(`r${i}`, "1-9", "7248", 43211507, d));

  it("patrón regular → ventana última + mín … última + máx", () => {
    const [r, ...resto] = proximasCompras(cada30, { ahora: new Date("2026-09-15T12:00:00-03:00") });
    expect(resto).toEqual([]);
    expect(r).toMatchObject({ familia: "4321", veces: 4, cadaDias: 30, ultima: "2026-08-30", desde: "2026-09-29", hasta: "2026-09-29", organismo: { codigo: "7248" } });
  });

  it("descarta lo irregular, lo vencido, lo escaso y lo de otro rubro", () => {
    const irregular = ["2026-01-01", "2026-01-05", "2026-06-01"].map((d, i) => oc(`i${i}`, "1-9", "1", 43211507, d));
    expect(proximasCompras(irregular, { ahora: AHORA })).toEqual([]);
    expect(proximasCompras(cada30, { ahora: AHORA })).toEqual([]); // la ventana fue el 29-09
    expect(proximasCompras(cada30.slice(0, 2), { ahora: new Date("2026-07-02") })).toEqual([]);
    expect(proximasCompras(cada30, { ahora: new Date("2026-09-15"), rubros: ["44"] })).toEqual([]);
    expect(proximasCompras(cada30.slice(0, 2), { ahora: new Date("2026-07-02"), comprasMinimas: 2 })).toHaveLength(1);
  });
});
