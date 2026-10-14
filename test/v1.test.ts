import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Transporte } from "../src/http.js";
import { MercadoPublicoError } from "../src/errores.js";
import { Empresas, formatearRut } from "../src/v1/empresas.js";
import { Licitaciones } from "../src/v1/licitaciones.js";
import { OrdenesCompra } from "../src/v1/ordenes.js";
import { CAMPOS_PERSONALES_V1, parseLicitacion, parseOrdenCompra } from "../src/v1/parse.js";
import { monto } from "../src/util.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/v1/${n}.json`, import.meta.url), "utf8");
const primero = (n: string) => (JSON.parse(fixture(n)) as { Listado: unknown[] }).Listado[0];

function api(cuerpo: string, status = 200) {
  const urls: URL[] = [];
  const t = new Transporte({
    ticket: "TICKET",
    dormir: async () => {},
    reintentos: 0,
    fetch: async (url) => {
      urls.push(new URL(String(url)));
      return new Response(cuerpo, { status });
    },
  });
  return { t, urls, q: (i = 0) => Object.fromEntries(urls[i]!.searchParams) };
}

describe("Licitaciones: URL y parámetros", () => {
  it.each([
    ["porCodigo", (l: Licitaciones) => l.porCodigo("1509-5-LE26"), { codigo: "1509-5-LE26" }],
    ["delDia", (l: Licitaciones) => l.delDia("2026-06-02"), { fecha: "02062026" }],
    ["delDia + estado", (l: Licitaciones) => l.delDia("2026-06-02", { estado: "adjudicada" }), { fecha: "02062026", estado: "adjudicada" }],
    ["activas", (l: Licitaciones) => l.activas(), { estado: "activas" }],
    ["porEstado", (l: Licitaciones) => l.porEstado("revocada"), { estado: "revocada" }],
    ["porEstado + dia", (l: Licitaciones) => l.porEstado("cerrada", { dia: "2026-12-31" }), { estado: "cerrada", fecha: "31122026" }],
    ["porOrganismo", (l: Licitaciones) => l.porOrganismo("6945", { dia: "2026-06-02" }), { fecha: "02062026", CodigoOrganismo: "6945" }],
    ["porProveedor", (l: Licitaciones) => l.porProveedor("17793", { dia: "2026-06-02" }), { fecha: "02062026", CodigoProveedor: "17793" }],
  ])("%s", async (_, llamar, params) => {
    const { t, urls, q } = api(fixture("licitaciones-listado"));
    await llamar(new Licitaciones(t));
    expect(urls[0]!.origin + urls[0]!.pathname).toBe("https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json");
    expect(q()).toEqual({ ...params, ticket: "TICKET" });
  });
});

describe("OrdenesCompra: URL y parámetros", () => {
  it.each([
    ["porCodigo", (o: OrdenesCompra) => o.porCodigo("2097-241-SE26"), { codigo: "2097-241-SE26" }],
    ["delDia", (o: OrdenesCompra) => o.delDia("2026-06-11"), { fecha: "11062026" }],
    ["porEstado todos (hoy)", (o: OrdenesCompra) => o.porEstado("todos"), { estado: "todos" }],
    ["porEstado enviada_proveedor", (o: OrdenesCompra) => o.porEstado("enviada_proveedor", { dia: "2026-06-11" }), { estado: "enviadaproveedor", fecha: "11062026" }],
    // Grafías con errata copiadas literal de la web oficial.
    ["porEstado recepcion_parcial", (o: OrdenesCompra) => o.porEstado("recepcion_parcial"), { estado: "recepcionaceptadacialmente" }],
    ["delDia + recepcion_conforme_incompleta", (o: OrdenesCompra) => o.delDia("2026-06-11", { estado: "recepcion_conforme_incompleta" }), { fecha: "11062026", estado: "recepecionconformeincompleta" }],
    ["porOrganismo", (o: OrdenesCompra) => o.porOrganismo("6945", { dia: "2026-06-11" }), { fecha: "11062026", CodigoOrganismo: "6945" }],
    ["porProveedor", (o: OrdenesCompra) => o.porProveedor("17793", { dia: "2026-06-11" }), { fecha: "11062026", CodigoProveedor: "17793" }],
  ])("%s", async (_, llamar, params) => {
    const { t, urls, q } = api(fixture("ordenes-listado"));
    await llamar(new OrdenesCompra(t));
    expect(urls[0]!.pathname).toBe("/servicios/v1/publico/ordenesdecompra.json");
    expect(q()).toEqual({ ...params, ticket: "TICKET" });
  });
});

describe("Empresas", () => {
  it("buscarProveedor formatea el RUT y usa la ruta con Publico en mayúscula", async () => {
    const { t, urls, q } = api(fixture("empresas-proveedor"));
    await expect(new Empresas(t).buscarProveedor("70017820K")).resolves.toEqual({ codigo: "17793", nombre: "Cámara de Comercio de Santiago A.G. (CCS)" });
    expect(urls[0]!.pathname).toBe("/servicios/v1/Publico/Empresas/BuscarProveedor");
    expect(q()).toEqual({ rutempresaproveedor: "70.017.820-k", ticket: "TICKET" });
  });

  it("buscarProveedor da null si no hay resultados; buscarComprador lista organismos", async () => {
    await expect(new Empresas(api('{"Cantidad":0,"listaEmpresas":[]}').t).buscarProveedor("1-9")).resolves.toBeNull();
    const { t, urls } = api(fixture("empresas-proveedor"));
    await expect(new Empresas(t).buscarComprador()).resolves.toEqual([{ codigo: "17793", nombre: "Cámara de Comercio de Santiago A.G. (CCS)" }]);
    expect(urls[0]!.pathname).toBe("/servicios/v1/Publico/Empresas/BuscarComprador");
  });

  it("formatearRut", () => {
    expect(formatearRut("70.017.820-K")).toBe("70.017.820-k");
    expect(formatearRut("123456785")).toBe("12.345.678-5");
    expect(formatearRut("1-9")).toBe("1-9");
  });
});

describe("parseLicitacion", () => {
  const lic = parseLicitacion(primero("licitacion-detalle"));

  it("estado, tipo, comprador y oferentes", () => {
    expect(lic).toMatchObject({
      tipo: "licitacion",
      origen: "v1",
      codigo: "1509-5-LE26",
      estado: "adjudicada",
      estadoGlosa: "Adjudicada",
      tipoLicitacion: "LE",
      tipoLicitacionGlosa: "Licitación Pública igual o superior a 100 UTM e inferior a 1.000 UTM",
      oferentes: 3,
      comprador: { codigoOrganismo: "6945", codigoUnidad: "1509", region: 13, comuna: "Santiago" },
    });
  });

  it("fechas ISO con offset de Santiago (invierno -04:00)", () => {
    expect(lic.fechas).toEqual({
      creacion: "2026-06-01T09:00:00-04:00",
      publicacion: "2026-06-02T09:00:00-04:00",
      cierre: "2026-06-10T15:00:00-04:00",
      adjudicacion: "2026-06-11T12:00:00-04:00",
      ultimoCambio: null,
    });
    // Verano: -03:00.
    expect(parseLicitacion({ Fechas: { FechaCierre: "2026-11-20T15:00:00" } }).fechas.cierre).toBe("2026-11-20T15:00:00-03:00");
  });

  it("monto en CLF queda sin convertir (clp null)", () => {
    expect(lic.monto).toEqual({ valor: 120.5, moneda: "CLF", clp: null, fechaValor: null, fuente: null });
  });

  it("ítems con código UNSPSC y proveedor adjudicado", () => {
    expect(lic.items).toEqual([
      {
        codigoProducto: 44121701,
        nombre: "Bolígrafos",
        descripcion: "Bolígrafo azul punta fina",
        cantidad: 100,
        unidad: "Unidad",
        precioUnitario: { valor: 0.01, moneda: "CLF", clp: null, fechaValor: null, fuente: null },
        total: { valor: 1, moneda: "CLF", clp: null, fechaValor: null, fuente: null },
        proveedor: { rut: "76.000.000-0", nombre: "Proveedor Ficticio SpA", codigo: null },
      },
    ]);
  });

  it("separa los datos personales con su ruta original", () => {
    expect(lic.personales).toEqual({
      "Comprador.RutUsuario": "11.111.111-1",
      "Comprador.CodigoUsuario": "999999",
      "Comprador.NombreUsuario": "Funcionaria De Prueba",
      "Comprador.CargoUsuario": "Analista Ficticia",
      NombreResponsablePago: "Pagador De Prueba",
      EmailResponsablePago: "pagos@ejemplo.invalid",
      NombreResponsableContrato: "Contratista De Prueba",
      EmailResponsableContrato: "contrato@ejemplo.invalid",
      FonoResponsableContrato: "56-2-00000000",
    });
  });

  it("ítem de listado: lo disponible, null en lo demás, tipo desde el código", () => {
    const l = parseLicitacion(primero("licitaciones-listado"));
    expect(l).toMatchObject({
      codigo: "1509-5-L114",
      estado: "publicada",
      estadoGlosa: "Publicada",
      tipoLicitacion: "L1",
      descripcion: null,
      comprador: null,
      monto: null,
      items: [],
      oferentes: null,
      personales: null,
      fechas: { cierre: "2026-06-20T15:00:00-04:00", publicacion: null },
    });
  });

  it("tolera campos desconocidos, tipos raros y basura", () => {
    const raw = { CodigoExterno: 123, CodigoEstado: "99", CampoNuevo: { x: 1 }, Fechas: { FechaCierre: "no-es-fecha" }, Items: "?", MontoEstimado: "1.234,5", Moneda: "UF" };
    const l = parseLicitacion(raw);
    expect(l).toMatchObject({ codigo: "123", nombre: "", estado: "desconocido", estadoGlosa: null, items: [], fechas: { cierre: null } });
    expect(l.monto).toMatchObject({ valor: 1234.5, moneda: "CLF" });
    expect(l.raw).toBe(raw);
    for (const x of [null, undefined, 42, "x", []]) expect(() => parseLicitacion(x)).not.toThrow();
  });

  it("CodigoEstado desconocido: glosa null; si la API trae `Estado` en texto se usa ese", () => {
    expect(parseLicitacion({ CodigoEstado: 42 })).toMatchObject({ estado: "desconocido", estadoGlosa: null });
    expect(parseLicitacion({ CodigoEstado: 42, Estado: "En Evaluación" })).toMatchObject({ estado: "en_evaluacion", estadoGlosa: "En Evaluación" });
  });
});

describe("parseOrdenCompra", () => {
  const oc = parseOrdenCompra(primero("oc-detalle"));

  it("estado, tipo, proveedor, origen y fechas", () => {
    expect(oc).toMatchObject({
      tipo: "orden_compra",
      codigo: "2097-241-SE26",
      estado: "aceptada",
      estadoGlosa: "Aceptada",
      tipoOrden: "SE",
      procesoOrigen: "1509-5-LE26",
      proveedor: { rut: "76.000.000-0", nombre: "Proveedor Ficticio SpA", codigo: "17793" },
      comprador: { region: 13 },
      fechas: { creacion: "2026-06-11T12:00:00-04:00", publicacion: "2026-06-11T12:05:00-04:00", ultimoCambio: "2026-06-12T09:00:00-04:00" },
    });
  });

  it("monto CLP con fecha del envío", () => {
    expect(oc.monto).toEqual({ valor: 29750, moneda: "CLP", clp: 29750, fechaValor: "2026-06-11", fuente: "identidad" });
    expect(oc.items[0]).toMatchObject({ codigoProducto: 44121701, cantidad: 100, precioUnitario: { valor: 250 }, total: { valor: 25000 } });
  });

  it("personales de comprador y proveedor", () => {
    expect(Object.keys(oc.personales ?? {}).sort()).toEqual(
      ["CargoContacto", "FonoContacto", "MailContacto", "NombreContacto"].flatMap((k) => [`Comprador.${k}`, `Proveedor.${k}`]).sort(),
    );
    expect(oc.personales?.["Proveedor.MailContacto"]).toBe("ventas@ejemplo.invalid");
    for (const k of Object.keys(oc.personales ?? {})) expect(CAMPOS_PERSONALES_V1).toContain(k.split(".").pop());
  });

  it("listado y estado desconocido", () => {
    expect(parseOrdenCompra(primero("ordenes-listado"))).toMatchObject({ estado: "aceptada", proveedor: null, items: [] });
    expect(parseOrdenCompra({ Codigo: "x", CodigoEstado: 77 })).toMatchObject({ estado: "desconocido", estadoGlosa: null });
    expect(parseOrdenCompra({ CodigoTipo: "9" }).tipoOrden).toBe("CM");
  });
});

describe("respuestas de la API", () => {
  it("porCodigo devuelve null si el Listado viene vacío", async () => {
    await expect(new Licitaciones(api('{"Cantidad":0,"Listado":[]}').t).porCodigo("x")).resolves.toBeNull();
  });

  it("el listado se parsea completo", async () => {
    const r = await new OrdenesCompra(api(fixture("ordenes-listado")).t).delDia("2026-06-12");
    expect(r.map((o) => [o.codigo, o.estado])).toEqual([["2097-241-SE26", "aceptada"], ["1000-3-CM26", "recepcion_conforme"]]);
  });

  it.each([
    ["error-10300", "parametros"],
    ["error-10500", "simultaneas"],
  ])("%s se traduce a MercadoPublicoError", async (n, tipo) => {
    const err = await new Licitaciones(api(fixture(n), n === "error-10300" ? 400 : 500).t).activas().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MercadoPublicoError);
    expect(err).toMatchObject({ tipo });
  });
});

describe("bordes", () => {
  it("porCodigo vacío no gasta consultas ni devuelve un proceso cualquiera", async () => {
    let llamadas = 0;
    const t = new Transporte({ ticket: "T", fetch: async () => (llamadas++, new Response("{}")) });
    await expect(new Licitaciones(t).porCodigo(" ")).rejects.toMatchObject({ tipo: "parametros" });
    expect(llamadas).toBe(0);
  });
  it("una moneda desconocida no se hace pasar por CLP", () => {
    expect(monto(100, "US$", "2026-10-01")).toBeNull();
    expect(monto(100, null, "2026-10-01")).toMatchObject({ moneda: "CLP", clp: 100 });
  });
});
