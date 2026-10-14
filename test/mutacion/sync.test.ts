// Casos que dejó vivos Stryker en src/sync.ts (ver stryker.config.json). Cliente falso: sin HTTP ni parsers.
import { describe, expect, it } from "vitest";
import { MercadoPublicoError, type TipoError } from "../../src/errores.js";
import { Cuota } from "../../src/http.js";
import type { MercadoPublico } from "../../src/index.js";
import type { Proceso } from "../../src/modelo.js";
import { storeMemoria, type Store } from "../../src/store.js";
import { Sync, type FuenteSync, type OpcionesSync } from "../../src/sync.js";

const HOY = "2026-06-20";
const AYER = "2026-06-19";
const AHORA = new Date(`${HOY}T12:00:00-04:00`);

const proc = (codigo: string, estado = "publicada", tipo: Proceso["tipo"] = "licitacion", fechas: Partial<Proceso["fechas"]> = {}) =>
  ({ codigo, tipo, estado, fechas }) as unknown as Proceso;
const ca = (codigo: string, ultimoCambio: string, estado = "publicada") => proc(codigo, estado, "compra_agil", { ultimoCambio });

interface Escenario {
  /** Listados v1 por `${fuente}:${dia}`. */
  dias?: Record<string, Proceso[]>;
  /** Páginas de la v2. */
  paginas?: Proceso[][];
  /** Detalle de un código; por defecto uno publicado. Puede lanzar. */
  detalle?: (codigo: string, signal?: AbortSignal) => Proceso | undefined;
  /** Consultas que gasta el detalle de un código (un reintento gasta 2). */
  costo?: Record<string, number>;
  /** Puede lanzar al pedir la página n. */
  pagina?: (n: number) => void;
  limite?: number;
}

function falso(e: Escenario = {}) {
  const cuota = new Cuota(e.limite ?? 10_000, undefined, () => AHORA);
  const llamadas: string[] = [];
  const senales: (AbortSignal | undefined)[] = [];
  const gastar = (q: string, n = 1) => {
    llamadas.push(q);
    cuota.registrar(n);
  };
  const detalle = (tipo: Proceso["tipo"]) => async (codigo: string, o: { signal?: AbortSignal } = {}) => {
    senales.push(o.signal);
    gastar(codigo, e.costo?.[codigo]);
    return e.detalle ? e.detalle(codigo, o.signal) : proc(codigo, "publicada", tipo);
  };
  const v1 = (f: FuenteSync, tipo: Proceso["tipo"]) => ({
    delDia: async (d: string) => (gastar(`${f} ${d}`), e.dias?.[`${f}:${d}`] ?? []),
    porCodigo: detalle(tipo),
  });
  const paginas = e.paginas ?? [];
  const mp = {
    cuota,
    licitaciones: v1("licitaciones", "licitacion"),
    ordenes: v1("ordenes", "orden_compra"),
    compraAgil: {
      pagina: async (_: unknown, n: number, o: { signal?: AbortSignal } = {}) => {
        senales.push(o.signal);
        gastar(`pagina ${n}`);
        e.pagina?.(n);
        return { items: paginas[n - 1] ?? [], totalPaginas: paginas.length, totalResultados: paginas.flat().length };
      },
      detalle: detalle("compra_agil"),
    },
  };
  return { sync: new Sync(mp as unknown as MercadoPublico), cuota, llamadas, senales };
}

const op = (store: Store, extra: Partial<OpcionesSync> = {}): OpcionesSync => ({ desde: AYER, hasta: AYER, fuentes: ["licitaciones"], tasaRechazo: 0, store, ...extra });
const err = (tipo: TipoError) => new MercadoPublicoError(tipo, `falla ${tipo}`);

describe("planificar", () => {
  it.each(["adjudicada", "desierta", "revocada", "cancelada", "recepcion_conforme", "oc_emitida"])("no vuelve a pedir lo guardado en estado final (%s)", async (estado) => {
    const store = storeMemoria();
    await store.guardar([proc("A", estado)]);
    const { sync } = falso({ dias: { [`licitaciones:${AYER}`]: [proc("A")] } });
    const plan = await sync.planificar(op(store));
    expect(plan.desglose[0]!.consultas).toBe(1); // solo el día
  });

  it("por defecto recorre las tres fuentes hasta hoy", async () => {
    const { sync } = falso();
    const plan = await sync.planificar({ desde: HOY, store: storeMemoria() });
    expect(plan.desglose.map((d) => d.fuente)).toEqual(["licitaciones", "ordenes", "compra_agil"]);
    expect(plan.hasta).toBe(HOY);
  });

  it.each([-0.1, 1])("rechaza tasaRechazo fuera de [0, 1): %s", async (tasaRechazo) => {
    const { sync, llamadas } = falso();
    await expect(sync.planificar(op(storeMemoria(), { tasaRechazo }))).rejects.toMatchObject({
      tipo: "parametros",
      message: `tasaRechazo debe estar en [0, 1): ${tasaRechazo}`,
    });
    expect(llamadas).toEqual([]);
  });

  it("parte desde `desde` si el cursor quedó atrás y desde el día siguiente al cursor si no", async () => {
    const store = storeMemoria();
    await store.fijarCursor("licitaciones", "2026-05-01");
    const a = falso();
    await a.sync.planificar(op(store, { desde: "2026-06-01", hasta: "2026-06-02" }));
    expect(a.llamadas).toEqual(["licitaciones 2026-06-01", "licitaciones 2026-06-02"]);
    await store.fijarCursor("licitaciones", "2026-06-01");
    const b = falso();
    await b.sync.planificar(op(store, { desde: "2026-06-01", hasta: "2026-06-02" }));
    expect(b.llamadas).toEqual(["licitaciones 2026-06-02"]);
  });

  it("los listados (días v1 + página 1 de la v2) se exigen a la cuota antes de pedir nada", async () => {
    const fuentes: FuenteSync[] = ["licitaciones", "compra_agil"];
    const { sync } = falso();
    expect((await sync.planificar(op(storeMemoria(), { desde: "2026-06-01", hasta: "2026-06-02", fuentes }))).listadas).toBe(3);
    const corto = falso({ limite: 2 });
    await expect(corto.sync.planificar(op(storeMemoria(), { desde: "2026-06-01", hasta: "2026-06-02", fuentes }))).rejects.toMatchObject({
      tipo: "cuota_insuficiente",
      message: expect.stringMatching(/^planificar el sync necesita unas 3 consultas/),
    });
    expect(corto.llamadas).toEqual([]);
  });

  it("explica cada fuente en el desglose", async () => {
    const store = storeMemoria();
    await store.guardar([proc("B", "adjudicada")]);
    await store.fijarCursor("ordenes", AYER);
    const dias = { "licitaciones:2026-06-17": [proc("A"), proc("B")] };
    const { sync } = falso({ dias, paginas: [[ca("P", "2026-06-10T12:00:00Z"), ca("Q", "2026-06-10T12:00:00Z")]] });
    const plan = await sync.planificar(op(store, { desde: "2026-06-17", fuentes: ["licitaciones", "ordenes", "compra_agil"] }));
    expect(plan.desglose.map((d) => d.nota)).toEqual([
      "exacto: 3 días (2026-06-17 a 2026-06-19) + 1 detalles + 0 abiertas cerradas en los últimos 90 días a refrescar; 1 ya guardados se omiten",
      "exacto: 0 días (sin días nuevos) + 0 detalles + 0 abiertas creadas en los últimos 90 días a refrescar; 0 ya guardados se omiten",
      "cota superior: 1 páginas + hasta 2 detalles (se saltan los sin cambios y los cerrados), cambios desde 2026-06-17",
    ]);
    const sin = await falso({ dias, paginas: [[ca("P", "x")]] }).sync.planificar(
      op(store, { desde: "2026-06-17", fuentes: ["licitaciones", "compra_agil"], detalle: false }),
    );
    expect(sin.desglose.map((d) => d.nota)).toEqual([
      "exacto: 3 días (2026-06-17 a 2026-06-19) + 0 detalles + 0 abiertas cerradas en los últimos 90 días a refrescar; 1 ya guardados se omiten",
      "cota superior: 1 páginas, cambios desde 2026-06-17",
    ]);
  });

  it("refrescar elige por fuente lo abierto con cierre (licitación) o creación (OC) en los últimos 90 días, sin hoy", async () => {
    const store = storeMemoria();
    const cierre = (codigo: string, dia: string | null, estado = "publicada") => proc(codigo, estado, "licitacion", { cierre: dia && `${dia}T15:00:00-04:00` });
    await store.guardar([
      cierre("L1", AYER),
      cierre("L2", HOY),
      cierre("L3", "2026-03-22"), // justo 90 días
      cierre("L4", "2026-03-21"),
      cierre("L5", null),
      cierre("L6", AYER, "adjudicada"),
      cierre("L7", AYER), // vino en el listado
      proc("O1", "enviada_proveedor", "orden_compra", { creacion: `${AYER}T10:00:00-04:00` }),
      proc("O2", "enviada_proveedor", "orden_compra", { creacion: null, publicacion: `${AYER}T10:00:00-04:00` }),
    ]);
    const { sync } = falso({ dias: { [`licitaciones:${AYER}`]: [proc("L7")] } });
    const plan = await sync.planificar(op(store, { fuentes: ["licitaciones", "ordenes"], refrescar: true }));
    const refresco = plan.listados.filter((l) => l.refresco).map((l) => ({ ...l, items: l.items.map((p) => p.codigo).sort() }));
    expect(refresco).toEqual([
      { fuente: "licitaciones", desde: HOY, items: ["L1", "L3"], paginas: 0, refresco: true },
      { fuente: "ordenes", desde: HOY, items: ["O1", "O2"], paginas: 0, refresco: true },
    ]);
    // Sin nada abierto, no hay listado de refresco.
    const vacio = await falso().sync.planificar(op(storeMemoria(), { fuentes: ["licitaciones", "ordenes"], refrescar: true }));
    expect(vacio.listados.filter((l) => l.refresco)).toEqual([]);
  });

  it("pasa el signal a la página 1 de la v2", async () => {
    const c = new AbortController();
    const { sync, senales } = falso();
    await sync.planificar({ ...op(storeMemoria(), { fuentes: ["compra_agil"] }), signal: c.signal });
    expect(senales).toEqual([c.signal]);
  });
});

describe("ejecutar", () => {
  const unDia = (...items: Proceso[]) => ({ [`licitaciones:${AYER}`]: items });

  it.each(["cuota_agotada", "cuota_insuficiente", "ticket_invalido", "circuito_abierto", "cancelada"] as const)(
    "un detalle con %s aborta el sync",
    async (tipo) => {
      const store = storeMemoria();
      const { sync } = falso({ dias: unDia(proc("A")), detalle: () => { throw err(tipo); } });
      await expect(sync.ejecutar(await sync.planificar(op(store)))).rejects.toMatchObject({ tipo });
    },
  );

  it("Compra Ágil sin cambios desde lo guardado se omite aunque se pida detalle", async () => {
    const store = storeMemoria();
    await store.guardar([ca("P", "2026-06-10T12:00:00Z"), ca("R", "2026-06-01T12:00:00Z")]);
    const { sync, llamadas } = falso({ paginas: [[ca("P", "2026-06-10T12:00:00Z"), ca("R", "2026-06-11T12:00:00Z")]] });
    const r = await sync.ejecutar(await sync.planificar(op(store, { fuentes: ["compra_agil"] })));
    expect(r).toMatchObject({ nuevos: 0, actualizados: 1, omitidos: 1 });
    expect(llamadas).toEqual(["pagina 1", "R"]);
  });

  it("sin detalle guarda el ítem del listado solo si cambió de estado", async () => {
    const store = storeMemoria();
    await store.guardar([proc("A"), proc("B")]);
    const { sync, llamadas } = falso({ dias: unDia(proc("A"), proc("B", "cerrada"), proc("C")) });
    const r = await sync.ejecutar(await sync.planificar(op(store, { detalle: false })));
    expect(r).toMatchObject({ nuevos: 1, actualizados: 1, omitidos: 1 });
    expect((await store.obtener("B"))?.estado).toBe("cerrada");
    expect(llamadas).toEqual([`licitaciones ${AYER}`]);
  });

  it("exige a la cuota justo lo que falta (sin los listados ya gastados)", async () => {
    const dias = unDia(proc("A"), proc("B"));
    const justo = falso({ dias, limite: 3 });
    await expect(justo.sync.ejecutar(await justo.sync.planificar(op(storeMemoria())))).resolves.toMatchObject({ nuevos: 2 });
    const corto = falso({ dias, limite: 2 });
    await expect(corto.sync.ejecutar(await corto.sync.planificar(op(storeMemoria())))).rejects.toMatchObject({
      tipo: "cuota_insuficiente",
      message: expect.stringMatching(/^el sync necesita unas 2 consultas y quedan 1/),
    });
  });

  it("si los reintentos agotan la cuota a mitad, para, guarda lo hecho y no mueve el cursor", async () => {
    const store = storeMemoria();
    const { sync, llamadas } = falso({ dias: unDia(proc("A"), proc("B"), proc("C")), costo: { A: 2 }, limite: 4 });
    const r = await sync.ejecutar(await sync.planificar(op(store)));
    expect(r).toMatchObject({ nuevos: 2, detenido: "se acabó la cuota del día (se reinicia 2026-06-21T00:00:00-04:00); lo hecho quedó guardado" });
    expect(llamadas).not.toContain("C");
    expect(await store.obtener("B")).toBeDefined();
    expect(await store.cursor("licitaciones")).toBeUndefined();
  });

  it("informa el avance por fuente, sin contar el refresco como día", async () => {
    const store = storeMemoria();
    await store.guardar([proc("L1", "publicada", "licitacion", { cierre: `${AYER}T15:00:00-04:00` })]);
    const dias = { "licitaciones:2026-06-18": [proc("A")], [`licitaciones:${AYER}`]: [proc("B")], [`ordenes:${AYER}`]: [proc("O")] };
    const { sync } = falso({ dias });
    const plan = await sync.planificar(op(store, { desde: "2026-06-18", fuentes: ["licitaciones", "ordenes"], refrescar: true }));
    const avance: string[] = [];
    await sync.ejecutar(plan, { alAvanzar: (p) => void avance.push(`${p.fuente} ${p.hechas}/${p.total}`) });
    expect(avance).toEqual(["licitaciones 3/5", "licitaciones 3/5", "licitaciones 4/5", "licitaciones 4/5", "licitaciones 5/5", "ordenes 2/3", "ordenes 3/3", "ordenes 3/3"]);
  });

  it("sin detalle avanza una vez por día", async () => {
    const { sync } = falso({ dias: { "licitaciones:2026-06-18": [proc("A")], [`licitaciones:${AYER}`]: [proc("B")] } });
    const plan = await sync.planificar(op(storeMemoria(), { desde: "2026-06-18", detalle: false }));
    const avance: number[] = [];
    await sync.ejecutar(plan, { alAvanzar: (p) => void avance.push(p.hechas) });
    expect(avance).toEqual([2, 2]);
  });

  it("Compra Ágil: pide la página siguiente, avanza por página y deja el cursor en el último cambio más nuevo", async () => {
    const store = storeMemoria();
    const { sync, llamadas } = falso({ paginas: [[ca("R1", "2026-06-10T12:00:00Z"), ca("R2", "2026-06-11T12:00:00Z")], [ca("R3", "2026-06-09T12:00:00Z")]] });
    const plan = await sync.planificar(op(store, { fuentes: ["compra_agil"] }));
    const avance: string[] = [];
    await sync.ejecutar(plan, { alAvanzar: (p) => void avance.push(`${p.hechas}/${p.total}`) });
    expect(llamadas).toEqual(["pagina 1", "R1", "R2", "pagina 2", "R3"]);
    expect(avance).toEqual(["2/5", "3/5", "4/5", "5/5", "5/5"]);
    expect(await store.cursor("compra_agil")).toBe("2026-06-11T12:00:00Z");
  });

  it("Compra Ágil: un error pasajero en un detalle queda pendiente y el cursor avanza", async () => {
    const store = storeMemoria();
    const { sync } = falso({ paginas: [[ca("R1", "2026-06-10T12:00:00Z")]], detalle: () => { throw err("red"); } });
    const r = await sync.ejecutar(await sync.planificar(op(store, { fuentes: ["compra_agil"] })));
    expect(r.errores).toEqual([{ codigo: "R1", error: "falla red" }]);
    expect(await store.cursor("compra_agil")).toBe("2026-06-10T12:00:00Z");
    expect(JSON.parse((await store.cursor("compra_agil:pendientes"))!)).toEqual({ R1: 1 });
  });

  it("Compra Ágil: cancelar a mitad de una página o entre páginas devuelve detenido sin pedir más", async () => {
    for (const [cancelarEn, pedidas] of [["R1", ["pagina 1", "R1"]], ["R2", ["pagina 1", "R1", "R2"]]] as const) {
      const c = new AbortController();
      const store = storeMemoria();
      const { sync, llamadas } = falso({
        paginas: [[ca("R1", "2026-06-10T12:00:00Z"), ca("R2", "2026-06-10T12:00:00Z")], [ca("R3", "2026-06-10T12:00:00Z")]],
        detalle: (codigo) => (codigo === cancelarEn && c.abort(), ca(codigo, "2026-06-10T12:00:00Z")),
      });
      const plan = await sync.planificar(op(store, { fuentes: ["compra_agil"] }));
      await expect(sync.ejecutar(plan, { signal: c.signal })).resolves.toMatchObject({ detenido: "cancelado" });
      expect(llamadas).toEqual(pedidas);
      expect(await store.cursor("compra_agil")).toBeUndefined();
    }
  });

  it("Compra Ágil: si falla la página siguiente, cancelado devuelve detenido y otro error se propaga tal cual", async () => {
    const paginas = [[ca("R1", "2026-06-10T12:00:00Z")], [ca("R2", "2026-06-10T12:00:00Z")]];
    const c = new AbortController();
    const a = falso({ paginas, pagina: (n) => { if (n === 2) throw (c.abort(), err("cancelada")); } });
    const plan = await a.sync.planificar(op(storeMemoria(), { fuentes: ["compra_agil"] }));
    await expect(a.sync.ejecutar(plan, { signal: c.signal })).resolves.toMatchObject({ detenido: "cancelado", nuevos: 1 });
    const b = falso({ paginas, pagina: (n) => { if (n === 2) throw err("servidor"); } });
    const plan2 = await b.sync.planificar(op(storeMemoria(), { fuentes: ["compra_agil"] }));
    await expect(b.sync.ejecutar(plan2)).rejects.toMatchObject({ tipo: "servidor" });
  });

  it("una respuesta inválida en un detalle queda pendiente; un detalle vacío es un error permanente", async () => {
    const invalida = storeMemoria();
    const a = falso({ dias: unDia(proc("A")), detalle: () => { throw err("respuesta_invalida"); } });
    await a.sync.ejecutar(await a.sync.planificar(op(invalida)));
    expect(await invalida.cursor("licitaciones")).toBe(AYER);
    expect(JSON.parse((await invalida.cursor("licitaciones:pendientes"))!)).toEqual({ A: 1 });

    const vacio = storeMemoria();
    const b = falso({ dias: unDia(proc("A")), detalle: () => undefined });
    const r = await b.sync.ejecutar(await b.sync.planificar(op(vacio)));
    expect(r.errores).toEqual([{ codigo: "A", error: "A no tiene detalle" }]);
    expect(await vacio.cursor("licitaciones")).toBe(AYER);
    expect(await vacio.cursor("licitaciones:pendientes")).toBeUndefined();
  });

  it("un pendiente se reintenta en la vuelta siguiente sin re-listar y sale de la lista al resolverse", async () => {
    const store = storeMemoria();
    let caido = true;
    const detalle = (codigo: string) => {
      if (caido) throw err("red");
      return proc(codigo);
    };
    const a = falso({ dias: unDia(proc("A"), proc("B")), detalle });
    await a.sync.ejecutar(await a.sync.planificar(op(store)));
    expect(JSON.parse((await store.cursor("licitaciones:pendientes"))!)).toEqual({ A: 1, B: 1 });
    await store.guardar([proc("B", "adjudicada")]); // B cerró por otro lado: ya no se pide

    caido = false;
    const b = falso({ detalle });
    const plan = await b.sync.planificar(op(store, { desde: HOY, hasta: HOY }));
    expect(plan.listados[0]).toEqual({ fuente: "licitaciones", desde: HOY, items: [], paginas: 0, pendientes: ["A", "B"] });
    expect(plan.desglose[0]).toMatchObject({ consultas: 3, nota: expect.stringContaining("+ 2 pendientes de vueltas anteriores") });
    const r = await b.sync.ejecutar(plan);
    expect(r).toMatchObject({ actualizados: 0, nuevos: 1, omitidos: 1, errores: [] });
    expect(b.llamadas).toEqual([`licitaciones ${HOY}`, "A"]);
    expect(JSON.parse((await store.cursor("licitaciones:pendientes"))!)).toEqual({});
  });

  it("con el signal ya cancelado no guarda ni mueve el cursor, aunque no haya detalles que pedir", async () => {
    const store = storeMemoria();
    const { sync } = falso({ dias: unDia(proc("A")) });
    const plan = await sync.planificar(op(store, { detalle: false }));
    await expect(sync.ejecutar(plan, { signal: AbortSignal.abort() })).resolves.toMatchObject({ detenido: "cancelado", nuevos: 0 });
    expect(await store.obtener("A")).toBeUndefined();
    expect(await store.cursor("licitaciones")).toBeUndefined();
  });

  it("pasa el signal a cada detalle (v1 y v2) y a las páginas siguientes, y pide cada detalle a su API", async () => {
    const c = new AbortController();
    const store = storeMemoria();
    const { sync, senales } = falso({ dias: unDia(proc("A")), paginas: [[ca("R", "2026-06-10T12:00:00Z")], [ca("R2", "2026-06-10T12:00:00Z")]] });
    const plan = await sync.planificar(op(store, { fuentes: ["licitaciones", "compra_agil"] }));
    senales.length = 0;
    await sync.ejecutar(plan, { signal: c.signal });
    expect(senales).toEqual([c.signal, c.signal, c.signal, c.signal]); // A, R, página 2, R2
    expect((await store.obtener("A"))?.tipo).toBe("licitacion");
    expect((await store.obtener("R"))?.tipo).toBe("compra_agil");
  });

  it("no escribe lotes vacíos", async () => {
    const store = storeMemoria();
    await store.guardar([proc("A", "adjudicada")]);
    const guardados: number[] = [];
    const guardar = store.guardar.bind(store);
    store.guardar = async (ps) => (guardados.push(ps.length), guardar(ps));
    const { sync } = falso({ dias: unDia(proc("A")) });
    await sync.ejecutar(await sync.planificar(op(store)));
    expect(guardados).toEqual([]);
    expect(await store.cursor("licitaciones")).toBe(AYER);
  });
});
