import { describe, expect, it } from "vitest";
import { MercadoPublico, storeMemoria, type Store } from "../src/index.js";
import { MercadoPublicoError } from "../src/errores.js";
import { parseLicitacion } from "../src/v1/parse.js";
import { parseCompraAgil } from "../src/v2/parse.js";

const HOY = "2026-06-20";

/** Cliente con fetch falso: `ruta` recibe la URL y devuelve el JSON (o una Response). */
function cliente(ruta: (u: URL) => unknown, limiteDiario = 10_000) {
  const pedidos: URL[] = [];
  const mp = new MercadoPublico({
    ticket: "T",
    conversor: false,
    reintentos: 0,
    limiteDiario,
    dormir: async () => {},
    ahora: () => new Date(`${HOY}T12:00:00-04:00`),
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

  it("un detalle que falla se anota, no corta el sync y no avanza el cursor", async () => {
    const { mp } = cliente(v1(dias, { A: 5, B: 8 })); // C no tiene detalle
    const store = storeMemoria();
    const plan = await mp.sync.planificar({ desde: "2026-06-01", hasta: "2026-06-02", fuentes: ["licitaciones"], store });
    const r = await mp.sync.ejecutar(plan);
    expect(r.errores).toEqual([{ codigo: "C", error: "falló C" }]);
    expect(r).toMatchObject({ nuevos: 2 }); // A y B
    expect(await store.cursor("licitaciones")).toBe("2026-06-01");
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
});
