import { describe, expect, it } from "vitest";
import { MercadoPublico, storeMemoria, type Store } from "../src/index.js";
import { MercadoPublicoError } from "../src/errores.js";
import { parseLicitacion } from "../src/v1/parse.js";
import { parseCompraAgil } from "../src/v2/parse.js";

const HOY = "2026-06-20";

/** Cliente con fetch falso: `ruta` recibe la URL y devuelve el JSON (o una Response). */
function cliente(ruta: (u: URL) => unknown, limiteDiario = 10_000, extra: { reintentos?: number; ahora?: () => Date } = {}) {
  const pedidos: URL[] = [];
  const mp = new MercadoPublico({
    ticket: "T",
    conversor: false,
    reintentos: 0,
    limiteDiario,
    dormir: async () => {},
    ahora: () => new Date(`${HOY}T12:00:00-04:00`),
    ...extra,
    fetch: async (url) => {
      const u = new URL(String(url));
      pedidos.push(u);
      const c = ruta(u);
      return c instanceof Response ? c : Response.json(c);
    },
  });
  return { mp, pedidos, detalles: () => pedidos.filter((u) => u.searchParams.has("codigo") || /compra-agil\/./.test(u.pathname)).length };
}

/** v1: `dias` = listados por "ddmmaaaa"; `estados` = CodigoEstado del detalle (sin entrada → error de la API). */
function v1(dias: Record<string, Record<string, number>>, estados: Record<string, number>) {
  return (u: URL) => {
    const campo = u.pathname.endsWith("licitaciones.json") ? "CodigoExterno" : "Codigo";
    const cod = u.searchParams.get("codigo");
    if (cod) {
      if (estados[cod] === undefined) return Response.json({ Codigo: 400, Mensaje: `falló ${cod}` }, { status: 400 });
      return { Listado: [{ [campo]: cod, Nombre: `detalle ${cod}`, CodigoEstado: estados[cod] }] };
    }
    const lista = dias[`${campo}:${u.searchParams.get("fecha")}`] ?? {};
    return { Listado: Object.entries(lista).map(([c, e]) => ({ [campo]: c, Nombre: c, CodigoEstado: e })) };
  };
}

/** Store en memoria que anota cada escritura: `fijarCursor clave=valor` o `códigos@cursor`. */
function espiar(llamadas: string[]): Store {
  const base = storeMemoria();
  return {
    obtener: (c) => base.obtener(c),
    cursor: (c) => base.cursor(c),
    todos: () => base.todos(),
    guardar: async (ps) => (llamadas.push("guardar"), base.guardar(ps)),
    fijarCursor: async (c, v) => (llamadas.push(`fijarCursor ${c}=${v}`), base.fijarCursor(c, v)),
    guardarConCursor: async (ps, c, v) => (llamadas.push(`${ps.map((p) => p.codigo).join("")}@${v}`), await base.guardar(ps), base.fijarCursor(c, v)),
  };
}

const lic = (codigo: string, CodigoEstado: number) => parseLicitacion({ CodigoExterno: codigo, Nombre: codigo, CodigoEstado });

describe("sync v1", () => {
  const dias = {
    "CodigoExterno:01062026": { A: 5, B: 8 },
    "CodigoExterno:02062026": { C: 5 },
    "Codigo:01062026": { O1: 4 },
  };
  const estados = { A: 5, C: 6, O1: 6 };

  it("planifica exacto, omite los cerrados y ejecutar reutiliza los listados", async () => {
    const { mp, pedidos, detalles } = cliente(v1(dias, estados));
    const store = storeMemoria();
    await store.guardar([lic("B", 8)]); // adjudicada: no se vuelve a pedir
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones", "ordenes"], store });
    expect(plan.desglose.map((d) => d.consultas)).toEqual([2 + 2, 2 + 1]); // días + detalles
    expect(plan).toMatchObject({ consultas: 7, gastadas: 4, cabeHoy: true });
    expect(detalles()).toBe(0);

    const r = await mp.sync.ejecutar(plan);
    expect(r).toMatchObject({ consultas: 7, nuevos: 3, actualizados: 0, omitidos: 1, errores: [] });
    expect(pedidos).toHaveLength(7); // los 4 listados no se repiten
    expect((await store.obtener("C"))?.estado).toBe("cerrada");
    expect(await store.cursor("licitaciones")).toBe("2026-06-02");
    expect(await store.cursor("ordenes")).toBe("2026-06-02");

    // Segunda vuelta: el cursor deja todo al día sin gastar nada.
    const plan2 = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones", "ordenes"], store });
    expect(plan2).toMatchObject({ consultas: 0, gastadas: 0 });
    expect((await mp.sync.ejecutar(plan2)).consultas).toBe(0);
  });

  it("si la cuota no alcanza, el plan lo dice y ejecutar se niega sin pedir detalles", async () => {
    const { mp, pedidos, detalles } = cliente(v1(dias, estados), 3);
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store: storeMemoria() });
    expect(plan).toMatchObject({ consultas: 5, gastadas: 2, cabeHoy: false, restante: 1 });
    await expect(mp.sync.ejecutar(plan)).rejects.toMatchObject({ tipo: "cuota_insuficiente" });
    expect(detalles()).toBe(0);
    expect(pedidos).toHaveLength(2);
  });

  it("si ni los listados caben, planificar falla sin gastar", async () => {
    const { mp, pedidos } = cliente(v1(dias, estados), 1);
    await expect(mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store: storeMemoria() })).rejects.toBeInstanceOf(MercadoPublicoError);
    expect(pedidos).toHaveLength(0);
  });

  it("hoy no se marca: la segunda vuelta re-lista, omite los que cerraron y re-pide los abiertos", async () => {
    const { mp, pedidos } = cliente(v1({ "CodigoExterno:20062026": { D: 5, E: 5 } }, { D: 8, E: 5 }));
    const store = storeMemoria();
    const o = { desde: HOY, fuentes: ["licitaciones" as const], store };
    await mp.sync.ejecutar(await mp.sync.planificar(o));
    expect(await store.cursor("licitaciones")).toBeUndefined();
    const n = pedidos.length;
    const r = await mp.sync.ejecutar(await mp.sync.planificar(o));
    expect(r).toMatchObject({ consultas: 2, actualizados: 1, omitidos: 1 }); // listado + E
    expect(pedidos.slice(n).map((u) => u.searchParams.get("codigo"))).toEqual([null, "E"]);
  });

  it("un detalle que falla por la red queda pendiente (escrito antes que el cursor), no corta el sync y el cursor avanza", async () => {
    const ruta = v1(dias, { A: 5, B: 8 });
    const { mp } = cliente((u) => (u.searchParams.get("codigo") === "C" ? new Response("", { status: 503 }) : ruta(u)));
    const llamadas: string[] = [];
    const store = espiar(llamadas);
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store });
    const r = await mp.sync.ejecutar(plan);
    expect(r.errores.map((e) => e.codigo)).toEqual(["C"]);
    expect(r).toMatchObject({ nuevos: 2 }); // A y B
    expect(r.abandonados).toBeUndefined();
    expect(llamadas).toEqual(["AB@2026-06-01", 'fijarCursor licitaciones:pendientes={"C":1}', "@2026-06-02"]);
  });

  it("liveness: un detalle que falla siempre no frena el cursor, cuesta 1 consulta por vuelta y se abandona tras 5", async () => {
    // Un día nuevo por vuelta; X (día 1) responde 503 siempre.
    const dias6 = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [`CodigoExterno:0${d}062026`, d === 1 ? { X: 5, D1: 5 } : { [`D${d}`]: 5 }]));
    const estados6 = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [`D${d}`, 5]));
    const ruta = v1(dias6, estados6);
    const { mp } = cliente((u) => (u.searchParams.get("codigo") === "X" ? new Response("", { status: 503 }) : ruta(u)));
    const store = storeMemoria();
    const costos: number[] = [];
    for (let d = 1; d <= 6; d++) {
      const hasta = `2026-06-0${d}`;
      const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta, fuentes: ["licitaciones"], store });
      if (d === 2) expect(plan.desglose[0]!.nota).toMatch(/1 pendientes de vueltas anteriores/);
      const r = await mp.sync.ejecutar(plan);
      expect(r.consultas).toBe(plan.consultas); // el plan cuenta los pendientes
      costos.push(r.consultas);
      expect(await store.cursor("licitaciones"), hasta).toBe(hasta);
      expect(r.errores.map((e) => e.codigo)).toEqual(d <= 5 ? ["X"] : []);
      if (d === 5) {
        expect(r.abandonados).toEqual(["X"]);
        expect(r.errores[0]!.error).toMatch(/abandona tras 5/);
      } else expect(r.abandonados).toBeUndefined();
      expect(JSON.parse((await store.cursor("licitaciones:pendientes"))!)).toEqual(d < 5 ? { X: d } : {});
    }
    expect(costos).toEqual([3, 3, 3, 3, 3, 2]); // día 1: listado + X + D1; después: X + listado + Dd
  });

  it("un pendiente que vuelve a fallar con un error permanente se descarta sin abandonarlo", async () => {
    let tipo = 503;
    const ruta = v1(dias, { A: 5, B: 8 });
    const { mp } = cliente((u) => (u.searchParams.get("codigo") !== "C" ? ruta(u) : tipo === 503 ? new Response("", { status: 503 }) : Response.json({ Codigo: 400, Mensaje: "falló C" }, { status: 400 })));
    const store = storeMemoria();
    const o = { desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones" as const], store };
    await mp.sync.ejecutar(await mp.sync.planificar(o));
    expect(await store.cursor("licitaciones:pendientes")).toBe('{"C":1}');
    tipo = 400;
    const r = await mp.sync.ejecutar(await mp.sync.planificar(o));
    expect(r).toMatchObject({ consultas: 1, errores: [{ codigo: "C", error: "falló C" }] });
    expect(r.abandonados).toBeUndefined();
    expect(await store.cursor("licitaciones:pendientes")).toBe("{}");
  });

  it("un error permanente (400) se anota pero el cursor avanza: no se re-lista para siempre", async () => {
    const { mp } = cliente(v1(dias, { A: 5, B: 8 })); // C no tiene detalle
    const store = storeMemoria();
    const r = await mp.sync.ejecutar(await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store }));
    expect(r.errores).toEqual([{ codigo: "C", error: "falló C" }]);
    expect(await store.cursor("licitaciones")).toBe("2026-06-02");
  });

  it("planificar a las 23:59 y ejecutar a las 00:01 no marca el día planificado", async () => {
    let t = new Date("2026-06-20T23:59:00-04:00");
    const { mp } = cliente(v1({ "CodigoExterno:20062026": { D: 5 } }, { D: 5 }), 10_000, { ahora: () => t });
    const store = storeMemoria();
    const plan = await mp.sync.planificar({ desde: HOY, fuentes: ["licitaciones"], store });
    t = new Date("2026-06-21T00:01:00-04:00");
    await mp.sync.ejecutar(plan);
    expect(plan).toMatchObject({ dia: HOY, hasta: HOY });
    expect(await store.cursor("licitaciones")).toBeUndefined();
  });

  it("lo que queda por gastar no cuenta los reintentos del plan", async () => {
    let fallo = false;
    const ruta = v1(dias, estados);
    const { mp } = cliente((u) => (!fallo && !u.searchParams.has("codigo") ? ((fallo = true), new Response("", { status: 503 })) : ruta(u)), 5, { reintentos: 1 });
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store: storeMemoria() });
    expect(plan).toMatchObject({ consultas: 5, gastadas: 3, listadas: 2, restante: 2, cabeHoy: false }); // faltan 3 detalles
  });

  it("con refrescar, vuelve a pedir licitaciones guardadas abiertas con cierre pasado (apagado por defecto)", async () => {
    const { mp, pedidos } = cliente(v1({}, { V: 8 }));
    const store = storeMemoria();
    const vieja = (codigo: string, FechaCierre: string, CodigoEstado = 5) => parseLicitacion({ CodigoExterno: codigo, Nombre: codigo, CodigoEstado, FechaCierre });
    await store.guardar([vieja("V", "2026-06-10T15:00:00"), vieja("F", "2026-06-25T15:00:00"), vieja("X", "2026-01-01T15:00:00"), vieja("Z", "2026-06-10T15:00:00", 8)]);
    await store.fijarCursor("licitaciones", "2026-06-19");
    const o = { desde: "2026-06-01", fuentes: ["licitaciones" as const], store, refrescar: true };
    expect((await mp.sync.planificar({ ...o, refrescar: undefined })).consultas).toBe(1);
    const plan = await mp.sync.planificar(o);
    expect(plan.consultas).toBe(1 + 1); // listado de hoy + V (F aún no cierra, X es muy vieja, Z es final)
    expect(plan.desglose[0]!.nota).toMatch(/1 abiertas cerradas en los últimos 90 días/);
    const r = await mp.sync.ejecutar(plan);
    expect(r).toMatchObject({ actualizados: 1, errores: [] });
    expect((await store.obtener("V"))?.estado).toBe("adjudicada");
    expect(pedidos.at(-1)!.searchParams.get("codigo")).toBe("V");
    expect(await store.cursor("licitaciones")).toBe("2026-06-19");
  });

  it("margen de reintentos: (consultas − listadas)·t/(1−t) cuenta en cabeHoy y en ejecutar", async () => {
    const o = { desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones" as const] };
    const { mp, detalles } = cliente(v1(dias, estados), 5);
    const plan = await mp.sync.planificar({ ...o, store: storeMemoria() });
    expect(plan).toMatchObject({ consultas: 5, listadas: 2, restante: 3, margenReintentos: 1, cabeHoy: false }); // 3 detalles + 1
    await expect(mp.sync.ejecutar(plan)).rejects.toMatchObject({ tipo: "cuota_insuficiente" });
    expect(detalles()).toBe(0);

    const sin = cliente(v1(dias, estados), 5);
    expect(await sin.mp.sync.planificar({ ...o, store: storeMemoria(), tasaRechazo: 0 })).toMatchObject({ margenReintentos: 0, cabeHoy: true });
    expect((await cliente(v1(dias, estados)).mp.sync.planificar({ ...o, store: storeMemoria(), tasaRechazo: 0.5 })).margenReintentos).toBe(3);
    await expect(sin.mp.sync.planificar({ ...o, store: storeMemoria(), tasaRechazo: 1 })).rejects.toMatchObject({ tipo: "parametros" });
  });

  it("cancelar a mitad: guarda lo pedido, no mueve el cursor y devuelve detenido: cancelado", async () => {
    const ac = new AbortController();
    const ruta = v1(dias, estados);
    const { mp } = cliente((u) => {
      if (u.searchParams.get("codigo") === "B") ac.abort(); // se cancela con B en vuelo
      return ruta(u);
    });
    const store = storeMemoria();
    const o = { desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones" as const], store };
    const r = await mp.sync.ejecutar(await mp.sync.planificar(o), { signal: ac.signal });
    expect(r.detenido).toBe("cancelado");
    expect(r.errores).toEqual([]);
    expect(await store.obtener("A")).toBeDefined();
    expect(await store.cursor("licitaciones")).toBeUndefined();

    const r2 = await mp.sync.ejecutar(await mp.sync.planificar(o));
    expect(r2).toMatchObject({ actualizados: 1, nuevos: 1 }); // A sigue abierta: se vuelve a pedir; B no tiene detalle
    expect(r2.detenido).toBeUndefined();
    expect(await store.cursor("licitaciones")).toBe("2026-06-02");
  });

  it("con el signal ya cancelado, planificar rechaza sin gastar y ejecutar no pide nada", async () => {
    const { mp, pedidos } = cliente(v1(dias, estados));
    const o = { desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones" as const], store: storeMemoria() };
    await expect(mp.sync.planificar({ ...o, signal: AbortSignal.abort() })).rejects.toMatchObject({ tipo: "cancelada" });
    expect(pedidos).toHaveLength(0);
    const plan = await mp.sync.planificar(o);
    expect(await mp.sync.ejecutar(plan, { signal: AbortSignal.abort() })).toMatchObject({ detenido: "cancelado", consultas: 2 });
    expect(pedidos).toHaveLength(2);
  });

  it("con guardarConCursor, cada día es una sola escritura y el cursor va con sus datos", async () => {
    const { mp } = cliente(v1(dias, estados));
    const llamadas: string[] = [];
    const store = espiar(llamadas);
    await mp.sync.ejecutar(await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store }));
    expect(llamadas).toEqual(["A@2026-06-01", "C@2026-06-02"]);
  });

  it("ticket inválido aborta después de guardar lo hecho", async () => {
    const ruta = v1(dias, { A: 5 });
    const { mp } = cliente((u) => (u.searchParams.get("codigo") === "B" ? new Response("{}", { status: 401 }) : ruta(u)));
    const store = storeMemoria();
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-01", fuentes: ["licitaciones"], store });
    await expect(mp.sync.ejecutar(plan)).rejects.toMatchObject({ tipo: "ticket_invalido" });
    expect(await store.obtener("A")).toBeDefined();
    expect(await store.cursor("licitaciones")).toBeUndefined();
  });
});

describe("sync v2 (Compra Ágil)", () => {
  const item = (codigo: string, estado: string, cambio: string) => ({ codigo, nombre: codigo, estado: { codigo: estado }, fechas: { fecha_ultimo_cambio: cambio } });
  const P = item("P", "publicada", "2026-06-10T12:00:00Z");
  const Q = item("Q", "cerrada", "2026-06-09T12:00:00Z");
  const R = item("R", "publicada", "2026-06-11T12:00:00Z");
  const pagina = (items: unknown[], n: number) => ({ success: "OK", payload: { items, paginacion: { total_paginas: 2, numero_pagina: n, total_resultados: 3 } } });
  const ruta = (u: URL) => {
    const cod = /compra-agil\/(.+)$/.exec(u.pathname)?.[1];
    if (cod) return { success: "OK", payload: item(cod, "publicada", "2026-06-11T12:00:00Z") };
    return u.searchParams.get("numero_pagina") === "1" ? pagina([R, P], 1) : pagina([Q], 2);
  };

  async function storeConPyQ(): Promise<Store> {
    const store = storeMemoria();
    await store.guardar([
      parseCompraAgil(P, { detalle: false }), // mismo fecha_ultimo_cambio: sin cambios
      parseCompraAgil(item("Q", "desierta", "2026-06-01T12:00:00Z"), { detalle: false }), // final
    ]);
    return store;
  }

  it("cota superior en el plan, salta lo sin cambios y lo cerrado, y el cursor abarata la segunda vuelta", async () => {
    const { mp, pedidos, detalles } = cliente(ruta);
    const store = await storeConPyQ();
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: HOY, fuentes: ["compra_agil"], store });
    expect(plan).toMatchObject({ consultas: 2 + 3, gastadas: 1, cabeHoy: true });
    expect(plan.desglose[0]!.nota).toMatch(/cota superior/);
    expect(new Date(pedidos[0]!.searchParams.get("cambio_desde")!).toISOString()).toBe("2026-06-01T04:00:00.000Z");

    const r = await mp.sync.ejecutar(plan);
    expect(r).toMatchObject({ consultas: 3, nuevos: 1, omitidos: 2, errores: [] }); // página 1 + página 2 + detalle de R
    expect(detalles()).toBe(1);
    const cursor = await store.cursor("compra_agil");
    expect(Date.parse(cursor!)).toBe(Date.parse("2026-06-11T12:00:00Z"));

    await mp.sync.planificar({ desde: "2026-06-01", hasta: HOY, fuentes: ["compra_agil"], store });
    expect(pedidos.at(-1)!.searchParams.get("cambio_desde")).toBe("2026-06-11T12:00:00.000Z");
  });

  it("las páginas 2+ usan el mismo cambio_hasta que la 1 aunque se ejecute pasada la medianoche", async () => {
    let t = new Date("2026-06-20T23:59:00-04:00");
    const { mp, pedidos } = cliente(ruta, 10_000, { ahora: () => t });
    const plan = await mp.sync.planificar({ desde: "2026-06-01", fuentes: ["compra_agil"], store: await storeConPyQ() });
    t = new Date("2026-06-21T00:01:00-04:00");
    await mp.sync.ejecutar(plan);
    const hastas = pedidos.filter((u) => u.searchParams.has("numero_pagina")).map((u) => u.searchParams.get("cambio_hasta"));
    expect(hastas).toHaveLength(2);
    expect(hastas[1]).toBe(hastas[0]);
  });

  it("un detalle con error permanente no frena el cursor de la v2", async () => {
    const { mp } = cliente((u) => (/compra-agil\/R$/.test(u.pathname) ? Response.json({ success: "NOK", errors: [{ codigo: "404", mensaje: "no existe" }] }, { status: 404 }) : ruta(u)));
    const store = await storeConPyQ();
    const r = await mp.sync.ejecutar(await mp.sync.planificar({ desde: "2026-06-01", hasta: HOY, fuentes: ["compra_agil"], store }));
    expect(r.errores.map((e) => e.codigo)).toEqual(["R"]);
    expect(Date.parse((await store.cursor("compra_agil"))!)).toBe(Date.parse("2026-06-11T12:00:00Z"));
  });

  it("un detalle con error pasajero queda pendiente, el cursor avanza igual y la vuelta siguiente lo trae", async () => {
    let caido = true;
    const { mp, detalles } = cliente((u) => (caido && /compra-agil\/R$/.test(u.pathname) ? new Response("", { status: 503 }) : ruta(u)));
    const store = await storeConPyQ();
    const o = { desde: "2026-06-01", hasta: HOY, fuentes: ["compra_agil" as const], store };
    const r = await mp.sync.ejecutar(await mp.sync.planificar(o));
    expect(r.errores.map((e) => e.codigo)).toEqual(["R"]);
    expect(Date.parse((await store.cursor("compra_agil"))!)).toBe(Date.parse("2026-06-11T12:00:00Z"));
    expect(await store.cursor("compra_agil:pendientes")).toBe('{"R":1}');

    caido = false;
    const n = detalles();
    const plan = await mp.sync.planificar(o);
    expect(plan.desglose[0]!.nota).toMatch(/1 pendientes/);
    const r2 = await mp.sync.ejecutar(plan);
    expect(r2).toMatchObject({ nuevos: 1, errores: [] });
    expect(detalles() - n).toBe(1); // R como pendiente; en el listado ya sale igual a lo guardado
    expect((await store.obtener("R"))?.estado).toBe("publicada");
    expect(await store.cursor("compra_agil:pendientes")).toBe("{}");
  });
});
