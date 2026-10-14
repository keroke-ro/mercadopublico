import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Transporte } from "../src/http.js";
import { MercadoPublicoError } from "../src/errores.js";
import { CompraAgilApi, type FiltrosCompraAgil } from "../src/v2/compra-agil.js";
import { parseCompraAgil } from "../src/v2/parse.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/v2/${n}.json`, import.meta.url), "utf8");
const res = (n: string, status = 200) => new Response(fixture(n), { status });

function api(...respuestas: Response[]) {
  const pedidos: { url: URL; headers: Record<string, string> }[] = [];
  const t = new Transporte({
    ticket: "T-123",
    dormir: async () => {},
    fetch: async (url, init) => {
      pedidos.push({ url: new URL(String(url)), headers: init?.headers as Record<string, string> });
      return respuestas.shift() ?? new Response("{}", { status: 500 });
    },
  });
  return { ca: new CompraAgilApi(t), t, pedidos };
}

const todos = async <T>(it: AsyncIterable<T>) => {
  const r: T[] = [];
  for await (const x of it) r.push(x);
  return r;
};

describe("CompraAgilApi.listar", () => {
  it("manda el ticket en header, los filtros exactos y pagina hasta total_paginas", async () => {
    const { ca, t, pedidos } = api(res("listado-p1"), res("listado-p2"));
    const cas = await todos(
      ca.listar({
        estado: ["publicada", "cerrada"],
        region: [13, 5],
        cambioDesde: new Date("2026-01-19T00:00:00Z"),
        cambioHasta: "2026-01-20T00:00:00Z",
        publicadoDesde: "2026-01-01", // sin offset = medianoche de Santiago (verano, -03:00)
        q: "papel",
        ordenarPor: "FechaPublicacion",
      }),
    );
    expect(cas.map((c) => c.codigo)).toEqual(["1057539-228-COT26", "2001-15-COT26", "1057539-240-COT26"]);
    expect(pedidos).toHaveLength(2);
    expect(t.cuota.usadas).toBe(2);

    const { url, headers } = pedidos[0]!;
    expect(url.origin + url.pathname).toBe("https://api2.mercadopublico.cl/v2/compra-agil");
    expect(headers.ticket).toBe("T-123");
    expect(url.searchParams.has("ticket")).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      estado: "publicada,cerrada",
      region: "13,5",
      cambio_desde: "2026-01-19T00:00:00.000Z",
      cambio_hasta: "2026-01-20T00:00:00.000Z",
      publicado_desde: "2026-01-01T03:00:00.000Z",
      q: "papel",
      ordenar_por: "FechaPublicacion",
      tamano_pagina: "50",
      numero_pagina: "1",
    });
    expect(pedidos[1]!.url.searchParams.get("numero_pagina")).toBe("2");
  });

  it("con 0 resultados gasta una sola consulta", async () => {
    const vacio = { success: "OK", trace: null, errors: null, payload: { items: [], paginacion: { total_paginas: 0, numero_pagina: 1, tamano_pagina: 50, total_resultados: 0 } } };
    const { ca, t } = api(new Response(JSON.stringify(vacio)));
    expect(await todos(ca.listar({ ttlCambioMs: 300000 }))).toEqual([]);
    expect(t.cuota.usadas).toBe(1);
  });

  it("pagina() expone el costo del listado completo", async () => {
    const { ca } = api(res("listado-p1"));
    const p = await ca.pagina({ tamanoPagina: 15 }, 1);
    expect(p).toMatchObject({ pagina: 1, totalPaginas: 2, totalResultados: 3 });
    expect(p.items).toHaveLength(2);
  });

  it("rutOrganismo filtra en local sin importar puntos, y no ahorra consultas", async () => {
    const { ca, t } = api(res("listado-p1"), res("listado-p2"));
    const cas = await todos(ca.listar({ region: [13], rutOrganismo: "61608000-5" }));
    expect(cas.map((c) => c.codigo)).toEqual(["1057539-228-COT26", "1057539-240-COT26"]);
    expect(t.cuota.usadas).toBe(2);
  });

  it.each<[string, FiltrosCompraAgil]>([
    ["id y q", { id: "1-1-COT26", q: "papel" }],
    ["ttl y cambio_*", { ttlCambioMs: 1000, cambioDesde: "2026-01-01" }],
    ["tamaño > 50", { tamanoPagina: 51 }],
    ["región 17", { region: [17] }],
    ["fecha inválida", { publicadoDesde: "ayer" }],
  ])("rechaza %s antes de consultar", async (_, filtros) => {
    const { ca, t, pedidos } = api(res("listado-p1"));
    const err = await todos(ca.listar(filtros)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MercadoPublicoError);
    expect(err).toMatchObject({ tipo: "parametros" });
    expect(pedidos).toHaveLength(0);
    expect(t.cuota.usadas).toBe(0);
  });

  it("el NOK de la API sale como error tipado", async () => {
    const { ca } = api(res("error-nok", 429));
    await expect(ca.pagina({}, 1)).rejects.toMatchObject({ tipo: "cuota_agotada", codigo: "429" });
  });
});

describe("CompraAgilApi.detalle", () => {
  it("parsea productos, cotizaciones, OC y fechas", async () => {
    const { ca, pedidos } = api(res("detalle"));
    const d = await ca.detalle("1195-39-COT26");
    expect(pedidos[0]!.url.pathname).toBe("/v2/compra-agil/1195-39-COT26");

    expect(d).toMatchObject({
      tipo: "compra_agil",
      origen: "v2",
      codigo: "1195-39-COT26",
      estado: "proveedor_seleccionado",
      estadoGlosa: "Proveedor seleccionado",
      ordenCompra: "123456789", // codigo_orden_compra vino null
      oferentes: 2,
      personales: null,
      comprador: { nombreOrganismo: "Servicio de Salud de Ejemplo", rutUnidad: "61.608.000-5", region: 13 },
      monto: { valor: 500000, moneda: "CLP", clp: 500000, fechaValor: "2026-04-01" },
    });
    // Z → hora de Santiago; el 5 de abril de 2026 termina el horario de verano.
    expect(d.fechas).toEqual({
      creacion: null,
      publicacion: "2026-04-01T09:00:00-03:00",
      cierre: "2026-04-03T09:00:00-03:00",
      adjudicacion: null,
      ultimoCambio: "2026-04-06T11:30:00-04:00",
    });
    expect(d.items.map((i) => [i.codigoProducto, i.cantidad, i.unidad])).toEqual([
      [47131800, 10, "EA"],
      [53131608, 20, "EA"],
    ]);

    const [a, b] = d.cotizaciones;
    expect(a).toMatchObject({
      seleccionada: true,
      proveedor: { rut: "76.000.000-0", nombre: "Limpieza SpA", codigo: "1234" },
      monto: { valor: 476000, moneda: "CLP" },
    });
    expect(a!.productos[1]).toEqual({
      codigoProducto: 53131608,
      nombre: "Jabón líquido",
      cantidad: 20,
      precioUnitario: { valor: 10000, moneda: "CLP", clp: 10000, fechaValor: "2026-04-02", fuente: "identidad" },
    });
    expect(b!.seleccionada).toBe(false);
    expect(b!.productos[0]!.precioUnitario).toBeNull();
  });

  it("rechaza un código vacío sin consultar", async () => {
    const { ca, pedidos } = api();
    await expect(ca.detalle(" ")).rejects.toMatchObject({ tipo: "parametros" });
    expect(pedidos).toHaveLength(0);
  });
});

describe("parseCompraAgil", () => {
  const detalle = () => JSON.parse(fixture("detalle")).payload;

  it("tolera campos desconocidos, tipos raros y basura sin lanzar", () => {
    const p2 = JSON.parse(fixture("listado-p2")).payload.items[0];
    const ca = parseCompraAgil(p2, { detalle: false });
    expect(ca.monto?.valor).toBe(250000);
    expect((ca.raw as { campo_nuevo_no_documentado: unknown }).campo_nuevo_no_documentado).toEqual({ x: 1 });

    for (const x of [null, 42, "x", [], { estado: "rara", fechas: { fecha_publicacion: "no es fecha" }, proveedores_cotizando: "nada" }]) {
      expect(() => parseCompraAgil(x, { detalle: true })).not.toThrow();
    }
    expect(parseCompraAgil({ estado: { id_estado: 9 } }, { detalle: false }).estado).toBe("desconocido");
    expect(parseCompraAgil({ estado: { codigo: "nueva", glosa: "Nueva" } }, { detalle: false })).toMatchObject({ estado: "nueva", estadoGlosa: "Nueva", ordenCompra: null });
  });

  it("monto en UF queda sin convertir", () => {
    const p1 = JSON.parse(fixture("listado-p1")).payload.items[1];
    expect(parseCompraAgil(p1, { detalle: false }).monto).toEqual({ valor: 30, moneda: "CLF", clp: null, fechaValor: null, fuente: null });
  });

  it("ordenCompra prefiere codigo_orden_compra si algún día viene", () => {
    const d = detalle();
    d.orden_compra.codigo_orden_compra = "1195-100-AG26";
    expect(parseCompraAgil(d, { detalle: true }).ordenCompra).toBe("1195-100-AG26");
  });

  it("sin `seleccion` solo infiere la seleccionada si hay una única cotización", () => {
    const d = detalle();
    for (const c of d.proveedores_cotizando) delete c.seleccion;
    expect(parseCompraAgil(d, { detalle: true }).cotizaciones.map((c) => c.seleccionada)).toEqual([false, false]);
    d.proveedores_cotizando.pop();
    expect(parseCompraAgil(d, { detalle: true }).cotizaciones.map((c) => c.seleccionada)).toEqual([true]);
  });

  it("oferentes cae al largo de proveedores_cotizando si falta el resumen", () => {
    const d = detalle();
    delete d.resumen;
    expect(parseCompraAgil(d, { detalle: true }).oferentes).toBe(2);
    expect(parseCompraAgil({ codigo: "x" }, { detalle: false }).oferentes).toBeNull();
  });
});
