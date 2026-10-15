import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { servirStdio } from "../src/cli.js";
import { MercadoPublico, storeArchivo, storeMemoria, type CompraAgil, type Proceso, type Store } from "../src/index.js";
import { diaSantiago, sumarDias } from "../src/fecha.js";
import { crearServidorMcp } from "../src/mcp.js";
import { urlOcds } from "../src/ocds.js";
import { competidores, precioSugerido, proximasCompras, rangoDePrecio } from "../src/radar/index.js";

const fixture = (r: string) => readFileSync(new URL(`./fixtures/${r}.json`, import.meta.url), "utf8");
const VACIO = '{"Cantidad":0,"Listado":[]}';

/** Fetch falso con los fixtures; `sinLicitacion` son códigos que la API v1 no encuentra como licitación. */
function api({ sinLicitacion = [] as string[], gate }: { sinLicitacion?: string[]; gate?: Promise<unknown> } = {}) {
  const urls: string[] = [];
  let detalles = 0;
  const f = (async (u: string | URL | Request) => {
    const url = new URL(String(u));
    urls.push(url.pathname + url.search);
    const codigo = url.searchParams.get("codigo");
    if (gate && (codigo || /compra-agil\/./.test(url.pathname)) && ++detalles > 1) await gate; // desde el segundo detalle esperan: el trabajo queda a medias
    if (url.hostname === "api2.mercadopublico.cl") return new Response(fixture(url.pathname.endsWith("compra-agil") ? "v2/listado-p1" : "v2/detalle"));
    if (url.pathname.endsWith("/licitaciones.json")) return new Response(codigo ? (sinLicitacion.includes(codigo) ? VACIO : fixture("v1/licitacion-detalle")) : fixture("v1/licitaciones-listado"));
    if (url.pathname.endsWith("/ordenesdecompra.json")) return new Response(fixture(codigo ? "v1/oc-detalle" : "v1/ordenes-listado"));
    if (url.pathname.endsWith("BuscarProveedor") || url.pathname.endsWith("BuscarComprador")) return new Response(fixture("v1/empresas-proveedor"));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, urls };
}

function servidor(op: { tope?: number; rutaStore?: string; store?: Store; abrirStore?: () => Promise<Store>; sinLicitacion?: string[]; gate?: Promise<unknown>; ocds?: typeof fetch } = {}) {
  const { f, urls } = api(op);
  const mp = new MercadoPublico({ ticket: "T", fetch: f, conversor: false, intervaloMs: 0 });
  const s = crearServidorMcp({ mp, fetch: op.ocds, rutaStore: op.rutaStore, tope: op.tope, version: "9.9.9", abrirStore: op.abrirStore ?? (op.store && (async () => op.store!)) });
  let n = 0;
  const rpc = (method: string, params?: object) => s.manejar({ jsonrpc: "2.0", id: ++n, method, params }) as Promise<any>;
  const llamar = async (name: string, args: object = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  return { rpc, llamar, urls, s, mp };
}

const datos = (r: any) => r.structuredContent;

describe("protocolo", () => {
  it("initialize legacy: devuelve la versión pedida si la soporta y la 2025-11-25 si no", async () => {
    const { rpc } = servidor();
    const r = (await rpc("initialize", { protocolVersion: "2025-06-18" })).result;
    expect(r).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "mercadopublico", version: "9.9.9" }, resultType: "complete" });
    expect(r.instructions).toContain("search");
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
  });

  it("server/discover con la forma de la spec 2026-07-28", async () => {
    const { rpc } = servidor();
    const r = (await rpc("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } })).result;
    expect(r).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
      capabilities: { tools: {}, prompts: {} },
      ttlMs: expect.any(Number),
      cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "mercadopublico", version: "9.9.9" } },
    });
    expect(typeof r.instructions).toBe("string");
  });

  it("versión moderna desconocida: -32022 con supported y requested", async () => {
    const { rpc } = servidor();
    const r = await rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    expect(r.error).toMatchObject({ code: -32022, data: { supported: expect.arrayContaining(["2026-07-28", "2025-11-25"]), requested: "1900-01-01" } });
  });

  it("tools/list: sin radar ni trabajos si no hay store, con ellos si lo hay; ttlMs, cacheScope, title y annotations", async () => {
    const sin = (await servidor().rpc("tools/list")).result;
    expect(sin.tools.map((t: any) => t.name)).toEqual(["search", "fetch", "listar", "organismos", "proveedor", "cuota"]);
    expect(sin).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "private" });
    const con = (await servidor({ store: storeMemoria() }).rpc("tools/list")).result;
    expect(con.tools.map((t: any) => t.name)).toEqual(["search", "fetch", "listar", "organismos", "proveedor", "cuota", "radar", "competidores", "proximas_compras", "precios", "sync", "ocds_importar", "trabajo_estado", "trabajo_cancelar"]);
    const escriben = ["sync", "ocds_importar", "trabajo_cancelar"];
    for (const t of con.tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations).toMatchObject({ readOnlyHint: !escriben.includes(t.name), idempotentHint: true, openWorldHint: expect.any(Boolean) });
    }
    const por = (n: string) => con.tools.find((t: any) => t.name === n);
    expect(por("sync").annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(por("trabajo_cancelar").annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(por("ocds_importar").annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    for (const n of ["competidores", "proximas_compras", "precios"]) expect(por(n).annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    expect(por("ocds_importar").inputSchema.required).toEqual(["anio"]);
    expect(por("precios").inputSchema.required).toEqual(["codigoProducto"]);
    expect(por("trabajo_estado").annotations.openWorldHint).toBe(false);
    expect(por("sync").inputSchema.required).toEqual(["desde", "maxConsultas"]);
    expect(con.tools.find((t: any) => t.name === "cuota").annotations.openWorldHint).toBe(false);
    expect(con.tools.find((t: any) => t.name === "search").outputSchema.properties.results.items.required).toEqual(["id", "title", "url"]);
  });

  it("ping, notificaciones, método desconocido, herramienta desconocida y mensajes inválidos", async () => {
    const { rpc, s } = servidor();
    expect((await rpc("ping")).result).toMatchObject({ resultType: "complete" });
    expect(await s.manejar({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect((await rpc("nada")).error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nada" })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "cuota", arguments: [] })).error.code).toBe(-32602);
    expect(((await s.manejar("hola")) as any).error.code).toBe(-32600);
  });

  it("los resultados de herramientas llevan resultType, _meta y el mismo JSON como texto", async () => {
    const { rpc } = servidor();
    const r = (await rpc("tools/call", { name: "cuota", arguments: {} })).result;
    expect(r).toMatchObject({ resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: "mercadopublico" } } });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    expect(r.structuredContent).toMatchObject({ limite: 10000, usadas: 0, costo: { consultas: 0, restanteHoy: 10000, topeAgente: { limite: 1000, usadas: 0 } } });
  });

  it("el núcleo no importa node: ni la CLI", () => {
    const fuente = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    expect(fuente).not.toMatch(/from "node:/);
    expect(fuente).not.toMatch(/import\(\s*"node:/);
    expect(fuente).not.toMatch(/from "\.\/cli/);
  });
});

describe("prompts", () => {
  it("prompts/list sin radar-diario si no hay store; prompts/get llena los argumentos y falla con -32602", async () => {
    const sin = (await servidor().rpc("prompts/list")).result;
    expect(sin.prompts.map((p: any) => p.name)).toEqual(["analizar-licitacion", "estudiar-competencia"]);
    expect(sin).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "private" });
    const { rpc } = servidor({ store: storeMemoria() });
    expect((await rpc("prompts/list")).result.prompts.map((p: any) => p.name)).toContain("radar-diario");
    const r = (await rpc("prompts/get", { name: "analizar-licitacion", arguments: { codigo: "1509-5-L114" } })).result;
    expect(r.messages[0].content.text).toContain("1509-5-L114");
    expect((await rpc("prompts/get", { name: "analizar-licitacion", arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("prompts/get", { name: "nada" })).error.code).toBe(-32602);
  });
});

describe("search", () => {
  it("cruza licitaciones activas y Compra Ágil sin importar tildes, ordenado por cierre", async () => {
    // Reloj antes de todos los cierres del fixture: todo está abierto y va por cierre más próximo.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T00:00:00Z") });
    const { llamar } = servidor();
    const r = await llamar("search", { query: "ADQUISICION" }).finally(() => vi.useRealTimers());
    const d = datos(r);
    // El fake de Compra Ágil devuelve sus 2 filas sin filtrar; la licitación sí se filtra por nombre ("Adquisición de insumos").
    expect(d.results.map((x: any) => x.id)).toEqual(["2001-15-COT26", "1057539-228-COT26", "1509-5-L114"]);
    expect(d.results[2]).toMatchObject({ tipo: "licitacion", fuente: "api_v1", cierre: expect.stringContaining("2026-06-20"), url: expect.stringContaining("idlicitacion=1509-5-L114") });
    expect(d.results[0]).toMatchObject({ tipo: "compra_agil", url: null, organismo: "Municipalidad de Ejemplo", region: 5 });
    expect(d.total).toBe(3);
    expect(d.costo.consultas).toBe(2);
    expect(d.notas.join(" ")).toContain("primera página"); // 3 resultados en la API, 2 en la página
  });

  it("lo cerrado va después de lo abierto, del más reciente al más viejo", async () => {
    // Entre los cierres de Compra Ágil (2 y 3 de abril) y el de la licitación (20 de junio).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-01T00:00:00Z") });
    const { llamar } = servidor();
    const d = datos(await llamar("search", { query: "ADQUISICION" }).finally(() => vi.useRealTimers()));
    expect(d.results.map((x: any) => x.id)).toEqual(["1509-5-L114", "1057539-228-COT26", "2001-15-COT26"]);
  });

  it("todas las palabras deben calzar; max corta; sin cierre al final", async () => {
    const { llamar } = servidor();
    expect(datos(await llamar("search", { query: "servicio aseo", tipo: "licitacion" })).results.map((x: any) => x.id)).toEqual(["6945-12-LE26"]);
    expect(datos(await llamar("search", { query: "servicio insumos", tipo: "licitacion" })).results).toEqual([]);
    const r = datos(await llamar("search", { query: "de", tipo: "licitacion", max: 1 }));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].id).toBe("1509-5-L114"); // la otra no tiene cierre
    expect(r.total).toBe(2);
  });

  it("con region excluye las licitaciones v1 y lo avisa en notas; pasa region y q a Compra Ágil", async () => {
    const { llamar, urls } = servidor();
    const d = datos(await llamar("search", { query: "materiales", region: [13] }));
    expect(d.results.every((x: any) => x.tipo === "compra_agil")).toBe(true);
    expect(d.notas.join(" ")).toMatch(/licitaciones v1 no se pueden filtrar por región/);
    expect(d.costo.consultas).toBe(1);
    expect(urls[0]).toContain("region=13");
    expect(urls[0]).toContain("q=materiales");
    expect(urls[0]).toContain("estado=publicada");
  });

  it("busca en el store (única forma de ver OC), dedupe prefiriendo la API y avisa si el store no abre", async () => {
    const store = storeMemoria();
    const base = { descripcion: null, estadoGlosa: null, comprador: null, fechas: { creacion: null, publicacion: null, cierre: null, adjudicacion: null, ultimoCambio: null }, monto: null, items: [], oferentes: null, personales: null, origen: "v1" as const, raw: null };
    await store.guardar([
      { ...base, tipo: "orden_compra", codigo: "2097-241-SE26", nombre: "OC insumos de oficina", estado: "aceptada", tipoOrden: "SE", proveedor: null, procesoOrigen: null },
      { ...base, tipo: "licitacion", codigo: "1509-5-L114", nombre: "Adquisición de insumos (copia del store)", estado: "publicada", tipoLicitacion: null, tipoLicitacionGlosa: null },
    ] as Proceso[]);
    const s = servidor({ store });
    const d = datos(await s.llamar("search", { query: "insumos" }));
    const ids = d.results.map((x: any) => x.id);
    expect(ids).toContain("2097-241-SE26");
    expect(d.results.find((x: any) => x.id === "1509-5-L114").fuente).toBe("api_v1");
    expect(ids.filter((i: string) => i === "1509-5-L114")).toHaveLength(1);
    expect(datos(await s.llamar("search", { query: "insumos", tipo: "orden_compra" })).results.map((x: any) => x.id)).toEqual(["2097-241-SE26"]);

    const roto = crearServidorMcp({ mp: new MercadoPublico({ ticket: "T", fetch: api().f, conversor: false, intervaloMs: 0 }), abrirStore: async () => Promise.reject(new Error("bloqueado por sync")) });
    const r = ((await roto.manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "aseo", tipo: "licitacion" } } })) as any).result;
    expect(datos(r).results.map((x: any) => x.id)).toEqual(["6945-12-LE26"]);
    expect(datos(r).notas.join(" ")).toContain("No se pudo abrir el store local");
    expect(datos(r).notas.join(" ")).not.toContain("bloqueado por sync"); // el mensaje original puede traer rutas, pid y host
  });

  it("sin store, tipo orden_compra explica cómo ver OC; query inválida es isError", async () => {
    const { llamar, urls } = servidor();
    const d = datos(await llamar("search", { query: "insumos", tipo: "orden_compra" }));
    expect(d.results).toEqual([]);
    expect(d.notas.join(" ")).toContain("listar");
    expect(urls).toHaveLength(0);
    const r = await llamar("search", { query: "a" });
    expect(r.isError).toBe(true);
  });
});

describe("fetch", () => {
  it("detecta la familia, resume en español y no trae raw ni datos personales", async () => {
    const { llamar, urls } = servidor();
    const r = await llamar("fetch", { id: "1509-5-LE26" });
    const d = datos(r);
    expect(d).toMatchObject({ id: "1509-5-LE26", title: "Adquisición de insumos de oficina", url: expect.stringContaining("idlicitacion=1509-5-LE26") });
    expect(d.text).toContain("Licitación 1509-5-LE26");
    expect(d.text).toContain("Estado:");
    expect(d.text).toContain("Dirección de Compras y Contratación Pública");
    expect(d.text).toContain("Cierre: 2026-06-10 15:00");
    expect(d.metadata).toMatchObject({ tipo: "licitacion", personales: null });
    expect(r.content[0].text).not.toContain("pagos@ejemplo.invalid");
    expect(r.content[0].text).not.toContain("ejemplo.invalid");
    expect(r.content[0].text).not.toContain('"raw"');
    expect(d.metadata).not.toHaveProperty("raw");
    expect(urls).toHaveLength(1);
    expect(d.costo).toMatchObject({ consultas: 1, restanteHoy: 9999, topeAgente: { limite: 1000, usadas: 1 } });
  });

  it("orden de compra y Compra Ágil", async () => {
    const { llamar, urls } = servidor();
    const oc = datos(await llamar("fetch", { id: "2097-241-SE26" }));
    expect(oc.text).toContain("Orden de compra 2097-241-SE26");
    expect(oc.url).toContain("codigoOC=2097-241-SE26");
    expect(urls[0]).toContain("ordenesdecompra.json");
    const ca = datos(await llamar("fetch", { id: "1195-39-COT26" }));
    expect(ca.text).toContain("Compra Ágil 1195-39-COT26");
    expect(ca.url).toBeNull();
  });

  it("si no existe en su familia prueba la otra; si no existe en ninguna es isError", async () => {
    const { llamar, urls } = servidor({ sinLicitacion: ["2097-241-CM26"] });
    const d = datos(await llamar("fetch", { id: "2097-241-CM26" })); // CM es OC: va primero a ordenes
    expect(d.metadata.tipo).toBe("orden_compra");
    expect(d.costo.consultas).toBe(1);
    // Licitación que la API no tiene como licitación: cae a ordenes (el fixture de OC responde).
    const otra = servidor({ sinLicitacion: ["1509-5-L114"] });
    const r = datos(await otra.llamar("fetch", { id: "1509-5-L114" }));
    expect(r.metadata.tipo).toBe("orden_compra");
    expect(r.costo.consultas).toBe(2);
    expect(otra.urls.map((u) => u.split("?")[0])).toEqual(["/servicios/v1/publico/licitaciones.json", "/servicios/v1/publico/ordenesdecompra.json"]);
    expect(urls).toHaveLength(1);
  });

  it("código raro es isError sin gastar consultas", async () => {
    const { llamar, urls } = servidor();
    const r = await llamar("fetch", { id: "hola" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no parece un código de Mercado Público");
    expect(urls).toHaveLength(0);
  });

  it("no encontrado en ninguna familia: isError", async () => {
    const mp = new MercadoPublico({ ticket: "T", fetch: (async () => new Response(VACIO)) as typeof fetch, conversor: false, intervaloMs: 0 });
    const r = ((await crearServidorMcp({ mp }).manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: { id: "1509-5-LE26" } } })) as any).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("No existe");
  });

  it("la caché de detalles evita la segunda consulta", async () => {
    const { llamar, urls } = servidor();
    await llamar("fetch", { id: "1509-5-LE26" });
    const d = datos(await llamar("fetch", { id: "1509-5-LE26" }));
    expect(urls).toHaveLength(1);
    expect(d.costo.consultas).toBe(0);
  });
});

describe("listar, organismos, proveedor", () => {
  it("listar: activas de hoy cacheadas, recorte a max y mismas reglas que la CLI", async () => {
    const { llamar, urls } = servidor();
    const d = datos(await llamar("listar", { tipo: "licitaciones", max: 1 }));
    expect(d).toMatchObject({ total: 2, mostrados: 1, truncado: true, resultados: [{ codigo: "1509-5-L114", nombre: "Adquisición de insumos", url: expect.stringContaining("idlicitacion=") }] });
    expect(urls[0]).toContain("estado=activas");
    expect(datos(await llamar("listar", { tipo: "licitaciones" })).costo.consultas).toBe(0); // misma caché que search
    const oc = datos(await llamar("listar", { tipo: "ordenes", dia: "2026-06-12" }));
    expect(oc.resultados.map((x: any) => x.codigo)).toEqual(["2097-241-SE26", "1000-3-CM26"]);
    expect(urls.at(-1)).toContain("fecha=12062026");
    expect((await llamar("listar", { tipo: "ordenes", estado: "aceptada", organismo: "1" })).isError).toBe(true);
    expect((await llamar("listar", { tipo: "ordenes", dia: "ayer" })).isError).toBe(true);
    expect((await llamar("listar", { tipo: "otra" })).isError).toBe(true);
  });

  it("organismos: filtra por palabras sin tildes y cachea 24 h", async () => {
    const { llamar, urls } = servidor();
    const d = datos(await llamar("organismos", { query: "camara comercio" }));
    expect(d.organismos).toEqual([{ codigo: "17793", nombre: "Cámara de Comercio de Santiago A.G. (CCS)" }]);
    expect(datos(await llamar("organismos", { query: "inexistente" })).organismos).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("proveedor: encontrado y no encontrado", async () => {
    const { llamar } = servidor();
    expect(datos(await llamar("proveedor", { rut: "70.017.820-k" }))).toMatchObject({ codigo: "17793" });
    const mp = new MercadoPublico({ ticket: "T", fetch: (async () => new Response('{"Cantidad":0,"listaEmpresas":[]}')) as typeof fetch, conversor: false, intervaloMs: 0 });
    const r = ((await crearServidorMcp({ mp }).manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "proveedor", arguments: { rut: "70017820K" } } })) as any).result;
    expect(r.isError).toBe(true);
    expect((await llamar("proveedor", { rut: "x" })).isError).toBe(true);
  });
});

describe("tope del agente", () => {
  it("corta las herramientas que consultan la API al llegar al tope, pero cuota sigue respondiendo", async () => {
    const { llamar, urls } = servidor({ tope: 2 });
    expect(datos(await llamar("fetch", { id: "1509-5-LE26" })).costo.topeAgente).toEqual({ limite: 2, usadas: 1 });
    expect((await llamar("fetch", { id: "2097-241-SE26" })).isError).toBeUndefined();
    const r = await llamar("fetch", { id: "1195-39-COT26" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/tope diario.*npx mercadopublico.*MP_MCP_TOPE/);
    expect(urls).toHaveLength(2);
    expect(datos(await llamar("cuota")).topeAgente).toEqual({ limite: 2, usadas: 2 });
  });
});

describe("radar", () => {
  const abierta = (codigo: string, region: number): Proceso =>
    ({
      tipo: "licitacion", tipoLicitacion: "L1", tipoLicitacionGlosa: null, codigo, nombre: `Compra ${codigo}`, descripcion: null, estado: "publicada", estadoGlosa: null,
      comprador: { codigoOrganismo: null, nombreOrganismo: "Municipio", rutUnidad: null, codigoUnidad: null, nombreUnidad: null, region, comuna: null },
      fechas: { creacion: null, publicacion: null, cierre: new Date(Date.now() + 10 * 86_400_000).toISOString(), adjudicacion: null, ultimoCambio: null },
      monto: { valor: 5_000_000, moneda: "CLP", clp: 5_000_000, fechaValor: null, fuente: null },
      items: [], oferentes: 0, personales: null, origen: "v1", raw: { secreto: "x" },
    }) as Proceso;

  it("lee el store, devuelve la agenda recortada a max con sus conteos y sin raw", async () => {
    const store = storeMemoria();
    await store.guardar([abierta("1-1-L126", 13), abierta("2-2-L126", 13), abierta("3-3-L126", 5)]);
    const { llamar } = servidor({ store });
    const r = await llamar("radar", { perfil: { pesos: { region: 1 }, regiones: [13] }, max: 1 });
    const d = datos(r);
    expect(d.procesos).toBe(3);
    expect(d.decisiones).toHaveLength(1);
    expect(d.decisiones[0]).toMatchObject({ turno: 1, accion: "postular" });
    expect(d.conteo).toMatchObject({ abiertas: 3, agenda: 2 });
    expect(d.costo.consultas).toBe(0);
    expect(r.content[0].text).not.toContain("secreto");
  });

  it("store vacío o perfil inválido son isError", async () => {
    const { llamar } = servidor({ store: storeMemoria() });
    const vacio = await llamar("radar", { perfil: { pesos: { region: 1 } } });
    expect(vacio.isError).toBe(true);
    expect(vacio.content[0].text).toContain("sync --desde");
    expect((await llamar("radar", { perfil: "perfil.json" })).isError).toBe(true);
  });
});

describe("sync como trabajo en segundo plano", () => {
  const DIA = { desde: "2026-06-12", hasta: "2026-06-12" }; // 1 día por fuente: el listado cuesta 3
  const esperar = async (f: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("se acabó la espera");
  };
  const estado = async (llamar: (n: string) => Promise<any>) => datos(await llamar("trabajo_estado")).trabajo;
  const compuerta = () => {
    let abrir!: () => void;
    return { gate: new Promise<void>((r) => (abrir = r)), abrir };
  };
  const detalles = (urls: string[]) => urls.filter((u) => /codigo=|compra-agil\/./.test(u)).length;

  it("responde al tiro con planificando y el job termina con resultado y procesos en el store", async () => {
    const store = storeMemoria();
    const { llamar, urls } = servidor({ store });
    expect(datos(await llamar("trabajo_estado"))).toMatchObject({ trabajo: null, costo: { consultas: 0 } });
    const t0 = Date.now();
    const r = await llamar("sync", { ...DIA, maxConsultas: 100 });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(datos(r).trabajo).toMatchObject({ tipo: "sync", estado: "planificando", parametros: { ...DIA, fuentes: ["licitaciones", "ordenes", "compra_agil"], maxConsultas: 100 }, inicio: expect.any(String) });
    expect(datos(r).costo.consultas).toBe(0); // lo que gaste el job no es de esta llamada
    expect(urls).toHaveLength(0);
    expect((await llamar("sync", { ...DIA, maxConsultas: 100 })).isError).toBe(true); // mientras corre o no, el primero sigue en el espacio

    await esperar(async () => !["planificando", "ejecutando"].includes((await estado(llamar)).estado));
    const t = await estado(llamar);
    expect(t).toMatchObject({ estado: "terminado", fin: expect.any(String), plan: { cabeHoy: true, desglose: expect.any(Array) }, resultado: { nuevos: expect.any(Number), totalErrores: 0 } });
    expect(t.resultado.nuevos).toBeGreaterThan(0);
    expect(t.resultado).not.toHaveProperty("errores", undefined);
    expect(t.plan.consultas).toBeGreaterThanOrEqual(3);
    expect(t.avance).toMatchObject({ fuente: expect.any(String), hechas: expect.any(Number), total: expect.any(Number) });
    let n = 0;
    for await (const _ of store.todos()) n++;
    expect(n).toBeGreaterThan(0);
    expect(await store.cursor("licitaciones")).toBe("2026-06-12");
    // El terminado sigue visible hasta el siguiente trabajo y la cuota refleja al job.
    expect(await estado(llamar)).toMatchObject({ estado: "terminado" });
    expect(datos(await llamar("cuota")).topeAgente.usadas).toBe(urls.length);
  });

  it("el precheck niega un rango demasiado caro sin consultar nada", async () => {
    const store = storeMemoria();
    const { llamar, urls } = servidor({ store });
    const r = await llamar("sync", { desde: "2026-01-01", hasta: "2026-03-01", maxConsultas: 50 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/cuesta 121 consultas.*60 días de licitaciones.*Prueba un rango más corto.*npx mercadopublico sync/);
    expect(urls).toHaveLength(0);
    expect(datos(await llamar("trabajo_estado")).trabajo).toBeNull();
    // También cuenta el tope del agente y se descuenta lo que el store ya tiene.
    const tope = servidor({ store, tope: 2 });
    expect((await tope.llamar("sync", { ...DIA, maxConsultas: 100 })).content[0].text).toContain("tope del agente 2");
    await store.fijarCursor("licitaciones", "2026-06-12");
    await store.fijarCursor("ordenes", "2026-06-12");
    // Con los cursores al día no hay días que listar: ni el tope de 2 niega el sync.
    expect((await tope.llamar("sync", { ...DIA, maxConsultas: 100, fuentes: ["licitaciones", "ordenes"] })).isError).toBeUndefined();
    await esperar(async () => !["planificando", "ejecutando"].includes((await estado(tope.llamar)).estado));
  });

  it("argumentos inválidos son isError", async () => {
    const { llamar, urls } = servidor({ store: storeMemoria() });
    for (const args of [{ maxConsultas: 5 }, { desde: "2026-06-12" }, { desde: "ayer", maxConsultas: 5 }, { desde: "2026-02-30", maxConsultas: 5 }, { desde: "2026-06-12", hasta: "2026-06-01", maxConsultas: 5 }, { desde: "2026-06-12", maxConsultas: 5, fuentes: ["otra"] }, { desde: "2026-06-12", maxConsultas: 0 }])
      expect((await llamar("sync", args)).isError, JSON.stringify(args)).toBe(true);
    expect(urls).toHaveLength(0);
  });

  it("un plan que pasa maxConsultas termina detenido sin ejecutar y deja el plan visible", async () => {
    const store = storeMemoria();
    const { llamar, urls } = servidor({ store });
    await llamar("sync", { ...DIA, maxConsultas: 3 }); // alcanza para los 3 listados, no para los detalles
    await esperar(async () => !["planificando", "ejecutando"].includes((await estado(llamar)).estado));
    const t = await estado(llamar);
    expect(t).toMatchObject({ estado: "detenido", plan: { gastadas: 3, cabeHoy: true }, mensaje: expect.stringMatching(/El plan necesita unas \d+ consultas más.*No se ejecutó nada/) });
    expect(t.resultado).toBeUndefined();
    expect(detalles(urls)).toBe(0);
    expect(urls).toHaveLength(3);
    let n = 0;
    for await (const _ of store.todos()) n++;
    expect(n).toBe(0);
    // Y el espacio queda libre: se puede pedir otro.
    expect((await llamar("sync", { ...DIA, maxConsultas: 3 })).isError).toBeUndefined();
  });

  it("trabajo_cancelar a mitad de la ejecución guarda lo hecho, libera el lock y deja el estado cancelado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-mcp-"));
    try {
      const ruta = join(dir, "mp.json");
      const { gate, abrir } = compuerta();
      const { llamar, urls } = servidor({ abrirStore: () => storeArchivo(ruta), gate });
      expect((await llamar("trabajo_cancelar")).isError).toBe(true); // sin trabajo
      await llamar("sync", { ...DIA, maxConsultas: 100 });
      await esperar(() => detalles(urls) > 1); // el primer detalle quedó esperando en la compuerta
      expect(await estado(llamar)).toMatchObject({ estado: "ejecutando" });
      const cancelando = llamar("trabajo_cancelar");
      abrir();
      expect(datos(await cancelando).trabajo).toMatchObject({ estado: "cancelado", resultado: { nuevos: expect.any(Number) } });
      expect(await estado(llamar)).toMatchObject({ estado: "cancelado", fin: expect.any(String) });
      expect((await llamar("trabajo_cancelar")).isError).toBe(true); // ya no hay uno en curso
      const s = await storeArchivo(ruta); // el lock se soltó
      const guardados: string[] = [];
      for await (const p of s.todos()) guardados.push(p.codigo);
      expect(guardados.length).toBeGreaterThan(0); // lo pedido antes de cancelar quedó en disco
      expect(await s.cursor("licitaciones")).toBeUndefined(); // sin día completo no se mueve el cursor
      await s.cerrar!();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un segundo sync con uno corriendo es isError con un mensaje claro", async () => {
    const { gate, abrir } = compuerta();
    const { llamar, urls } = servidor({ store: storeMemoria(), gate });
    await llamar("sync", { ...DIA, maxConsultas: 100 });
    await esperar(() => detalles(urls) > 1);
    const r = await llamar("sync", { ...DIA, maxConsultas: 100 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Ya hay un trabajo en curso.*trabajo_estado.*trabajo_cancelar/);
    abrir();
    await esperar(async () => (await estado(llamar)).estado === "terminado");
  });

  it("mientras el job tiene el store, search y radar leen por su handle (sin error de lock) y el costo avisa del trabajo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-mcp-"));
    try {
      const ruta = join(dir, "mp.json");
      const previo = await storeArchivo(ruta);
      await previo.guardar([{ tipo: "orden_compra", codigo: "9-9-SE26", nombre: "OC insumos previa", estado: "aceptada", comprador: null, fechas: { cierre: null }, monto: null, items: [], oferentes: null, personales: null, origen: "v1", raw: null } as unknown as Proceso]);
      await previo.cerrar!();
      const { gate, abrir } = compuerta();
      const { llamar, urls } = servidor({ abrirStore: () => storeArchivo(ruta), gate });
      await llamar("sync", { ...DIA, maxConsultas: 100 });
      await esperar(() => detalles(urls) > 1);
      await expect(storeArchivo(ruta)).rejects.toThrow(/en uso/); // el job sí tiene el lock
      const d = datos(await llamar("search", { query: "insumos", tipo: "orden_compra" }));
      expect(d.notas).toEqual([]);
      expect(d.results.map((x: any) => x.id)).toEqual(["9-9-SE26"]);
      expect(d.costo.nota).toBe("incluye consultas del trabajo en curso");
      expect((await llamar("radar", { perfil: { pesos: { region: 1 } } })).isError).toBeUndefined(); // lee el mismo handle
      expect(datos(await llamar("cuota")).costo).not.toHaveProperty("nota");
      abrir();
      await esperar(async () => (await estado(llamar)).estado === "terminado");
      const sin = datos(await llamar("search", { query: "insumos", tipo: "orden_compra" })); // sin job: abre y cierra el suyo
      expect(sin.costo).not.toHaveProperty("nota");
      expect(sin.notas).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("si el gasto del agente llega al tope a mitad de camino, el job se detiene con el motivo y lo hecho queda guardado", async () => {
    const store = storeMemoria();
    const { gate, abrir } = compuerta();
    const { llamar, urls, mp } = servidor({ store, gate, tope: 16 }); // 3 listados + 11 del plan caben con 2 de sobra
    await llamar("sync", { ...DIA, maxConsultas: 100 });
    await esperar(() => detalles(urls) > 1);
    expect(await estado(llamar)).toMatchObject({ estado: "ejecutando", plan: { consultas: 11, gastadas: 3 } });
    mp.cuota.registrar(10); // consultas de más (p. ej. de otro proceso con el mismo ticket): el tope global las cuenta
    abrir();
    await esperar(async () => !["planificando", "ejecutando"].includes((await estado(llamar)).estado));
    const t = await estado(llamar);
    expect(t).toMatchObject({ estado: "detenido", mensaje: expect.stringContaining("tope diario del agente"), resultado: { nuevos: expect.any(Number) } });
    expect(datos(await llamar("cuota")).topeAgente.usadas).toBeGreaterThanOrEqual(16);
    let n = 0;
    for await (const _ of store.todos()) n++;
    expect(n).toBeGreaterThan(0); // se guardó el primer detalle
    expect((await llamar("sync", { ...DIA, maxConsultas: 100 })).isError).toBe(true); // y el tope sigue cortando
  });
});

describe("historial OCDS y análisis local", () => {
  const esperar = async (f: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("se acabó la espera");
  };
  const enCurso = (t: any) => ["planificando", "ejecutando"].includes(t?.estado);
  const estado = async (llamar: (n: string) => Promise<any>) => datos(await llamar("trabajo_estado")).trabajo;
  const fin = (llamar: (n: string) => Promise<any>) => esperar(async () => !enCurso(await estado(llamar)));

  const MOP = "MINISTERIO DE OBRAS PUBLICAS | Dirección de Vialidad";
  const SALUD = "SERVICIO DE SALUD | Hospital Regional";
  /** Release OCDS de una licitación adjudicada, a la medida de los filtros. */
  const lic = (n: number, titulo: string, o: { comprador?: string; unspsc?: string; inicio?: string } = {}) => ({
    ocid: `ocds-70d2nz-${n}-1-LE26`,
    tag: ["compiled"],
    date: "2026-01-20T18:30:00Z",
    buyer: { id: "CL-MP-1996", name: o.comprador ?? MOP },
    parties: [
      { id: "CL-MP-1996", roles: ["buyer"], identifier: { scheme: "CL-RUT", id: "612020000" }, address: { region: "Región del Biobío" } },
      { id: "CL-MP-555", roles: ["supplier"], identifier: { scheme: "CL-RUT", id: "76000000k" } },
    ],
    tender: {
      id: `${n}-1-LE26`,
      title: titulo,
      status: "complete",
      statusDetails: "8-Adjudicada",
      procurementMethodDetails: "Licitación Pública Entre 100 y 1000 UTM (LE)",
      value: { amount: 1_000_000, currency: "CLP" },
      tenderPeriod: { startDate: `${o.inicio ?? "2026-01-05"}T09:00:00Z`, endDate: "2026-01-15T15:00:00Z" },
      numberOfTenderers: 3,
      items: [{ id: "1", description: titulo, quantity: 1, unit: { name: "Unidad" }, classification: { scheme: "UNSPSC", id: o.unspsc ?? "44121701" } }],
    },
    awards: [{ id: "a1", date: "2026-01-18T12:00:00Z", suppliers: [{ id: "CL-MP-555", name: "Proveedor SpA | Proveedor SpA" }], items: [{ id: "1", quantity: 1, unit: { value: { amount: 1_000_000, currency: "CLP" } } }] }],
  });
  const cm = readFileSync(new URL("./fixtures/ocds/release-cm.json", import.meta.url), "utf8").trim();
  const LINEAS = [
    JSON.stringify(lic(1001, "Compra de papel higiénico", { unspsc: "14111500" })),
    JSON.stringify(lic(1002, "Servicio de aseo", { unspsc: "76111501", inicio: "2026-02-10" })),
    "esto no es json",
    JSON.stringify(lic(1003, "Papel fotocopia", { unspsc: "14111507", comprador: SALUD, inicio: "2026-03-01" })),
    JSON.stringify(lic(1004, "Aseo industrial", { unspsc: "76111501", comprador: SALUD, inicio: "2026-04-01" })),
    cm,
  ];
  /** Fetch falso del archivo anual: un .jsonl.gz armado con las releases de arriba. */
  const ocdsGz = () => {
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(gzipSync(LINEAS.join("\n") + "\n"));
    }) as typeof fetch;
    return { f, urls };
  };
  const codigos = async (s: Store) => {
    const r: string[] = [];
    for await (const p of s.todos()) r.push(p.codigo);
    return r.sort();
  };
  /** Importa y espera a que termine; devuelve el trabajo final. */
  async function importar(args: object, op: { store?: Store; ocds?: typeof fetch } = {}) {
    const store = op.store ?? storeMemoria();
    const { f, urls } = ocdsGz();
    const sv = servidor({ store, ocds: op.ocds ?? f });
    const r = await sv.llamar("ocds_importar", { anio: 2026, ...args });
    if (r.isError) return { ...sv, store, urls, r, t: undefined as any };
    await fin(sv.llamar);
    return { ...sv, store, urls, r, t: await estado(sv.llamar) };
  }

  describe("ocds_importar", () => {
    it("q: guarda solo lo que calza, responde al tiro y cuenta lo leído", async () => {
      const store = storeMemoria();
      const { f, urls } = ocdsGz();
      const { llamar } = servidor({ store, ocds: f });
      const r = await llamar("ocds_importar", { anio: 2026, q: "PAPEL" });
      expect(datos(r).trabajo).toMatchObject({ tipo: "ocds", estado: "planificando", parametros: { anio: 2026, q: "PAPEL", max: 5000 } });
      expect(datos(r).costo.consultas).toBe(0);
      await fin(llamar);
      const t = await estado(llamar);
      expect(t).toMatchObject({ tipo: "ocds", estado: "terminado", fin: expect.any(String), avance: { leidos: 5, aceptados: 2, guardados: 2, omitidos: 0, lineasMalas: 1 }, resultado: { aceptados: 2 } });
      expect(t.mensaje).toBeUndefined();
      expect(await codigos(store)).toEqual(["1001-1-LE26", "1003-1-LE26"]);
      expect(urls).toEqual([urlOcds(2026)]);
    });

    it("comprador, rubro (prefijo) y fechas: todos los filtros dados tienen que calzar", async () => {
      const cuales = async (args: object) => (await codigos((await importar(args)).store)).map((c) => c.slice(0, 4));
      expect(await cuales({ comprador: "salud" })).toEqual(["1003", "1004"]);
      expect(await cuales({ comprador: "vialidad" })).toEqual(["1000", "1001", "1002"]); // y la OC de Convenio Marco
      expect(await cuales({ rubro: "7611" })).toEqual(["1002", "1004"]);
      expect(await cuales({ rubro: "76111501" })).toEqual(["1002", "1004"]);
      expect(await cuales({ rubro: "14" })).toEqual(["1001", "1003"]);
      expect(await cuales({ rubro: "7611", desde: "2026-03-01" })).toEqual(["1004"]);
      expect(await cuales({ rubro: "7611", hasta: "2026-02-28" })).toEqual(["1002"]);
      expect(await cuales({ q: "aseo", comprador: "salud" })).toEqual(["1004"]);
      expect(await cuales({ q: "aseo", rubro: "14" })).toEqual([]);
      expect(await cuales({ q: "gas licuado" })).toHaveLength(1); // la OC de Convenio Marco: lee nombre y descripción
    });

    it("sin ningún filtro, o con argumentos inválidos, es isError y no deja trabajo ni baja nada", async () => {
      const { f, urls } = ocdsGz();
      const { llamar } = servidor({ store: storeMemoria(), ocds: f });
      const r = await llamar("ocds_importar", { anio: 2026 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/al menos un filtro/);
      for (const args of [{ q: "papel" }, { anio: 2009, q: "papel" }, { anio: 2999, q: "papel" }, { anio: 2026.5, q: "papel" }, { anio: 2026, q: "a" }, { anio: 2026, rubro: "44x" }, { anio: 2026, rubro: "123456789" }, { anio: 2026, q: "papel", max: 20_001 }, { anio: 2026, q: "papel", max: 0 }, { anio: 2026, q: "papel", desde: "ayer" }, { anio: 2026, q: "papel", desde: "2026-02-01", hasta: "2026-01-01" }])
        expect((await llamar("ocds_importar", args)).isError, JSON.stringify(args)).toBe(true);
      expect(datos(await llamar("trabajo_estado")).trabajo).toBeNull();
      expect(urls).toHaveLength(0);
    });

    it("max corta la lectura con un mensaje y guarda lo aceptado", async () => {
      const { t, store } = await importar({ q: "papel", max: 1 });
      expect(t).toMatchObject({ estado: "terminado", avance: { leidos: 1, aceptados: 1, guardados: 1 }, mensaje: expect.stringMatching(/llegar a max \(1\)/) });
      expect(await codigos(store)).toEqual(["1001-1-LE26"]);
    });

    it("guarda en lotes de 500", async () => {
      const muchas = Array.from({ length: 1203 }, (_, i) => JSON.stringify(lic(5000 + i, "Resma de papel")));
      const guardados: number[] = [];
      const store = storeMemoria();
      const guardar = store.guardar.bind(store);
      store.guardar = async (ps) => (guardados.push(ps.length), guardar(ps));
      const { t } = await importar({ q: "papel" }, { store, ocds: (async () => new Response(muchas.join("\n"))) as typeof fetch }); // sin gzip también se lee
      expect(guardados).toEqual([500, 500, 203]);
      expect(t.avance).toMatchObject({ leidos: 1203, aceptados: 1203, guardados: 1203 });
    });

    it("no pisa un proceso que el store ya tiene de la API, y sí actualiza uno que viene de OCDS", async () => {
      const store = storeMemoria();
      const api = { ...(await (async () => { const { store: s } = await importar({ q: "papel higienico" }); return s.obtener("1001-1-LE26"); })())!, nombre: "Papel de la API", origen: "v1" } as Proceso;
      const viejo = { ...api, codigo: "1003-1-LE26", nombre: "viejo", origen: "ocds" } as Proceso;
      await store.guardar([api, viejo]);
      const { t } = await importar({ q: "papel" }, { store });
      expect(t.avance).toMatchObject({ aceptados: 2, guardados: 1, omitidos: 1 });
      expect((await store.obtener("1001-1-LE26"))!).toMatchObject({ nombre: "Papel de la API", origen: "v1" });
      expect((await store.obtener("1003-1-LE26"))!).toMatchObject({ nombre: "Papel fotocopia", origen: "ocds" });
    });

    it("un error de descarga termina en error con lo ya aceptado guardado", async () => {
      const { t, store } = await importar({ q: "papel" }, { ocds: (async () => new Response("", { status: 503 })) as typeof fetch });
      expect(t).toMatchObject({ estado: "error", mensaje: expect.stringContaining("503") });
      expect(await codigos(store)).toEqual([]);
    });

    /** Respuesta que entrega las dos primeras líneas y se cuelga hasta que se aborta (como una descarga real). */
    const colgada = () =>
      (async (_u: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (c) => c.enqueue(new TextEncoder().encode(LINEAS.slice(0, 2).join("\n") + "\n")),
            pull: (c) => new Promise<void>((r) => init?.signal?.addEventListener("abort", () => (c.error(new DOMException("aborted", "AbortError")), r())))
          }),
        )) as typeof fetch;

    it("trabajo_cancelar detiene la descarga, guarda lo aceptado y deja el estado cancelado", async () => {
      const store = storeMemoria();
      const { llamar } = servidor({ store, ocds: colgada() });
      expect((await llamar("trabajo_cancelar")).isError).toBe(true);
      await llamar("ocds_importar", { anio: 2026, q: "aseo papel higienico servicio", max: 10 });
      await llamar("trabajo_cancelar"); // sin nada leído aún también cancela
      await fin(llamar);
      expect(await estado(llamar)).toMatchObject({ tipo: "ocds", estado: "cancelado" });

      const s2 = storeMemoria();
      const dos = servidor({ store: s2, ocds: colgada() });
      await dos.llamar("ocds_importar", { anio: 2026, rubro: "1" });
      await esperar(async () => ((await estado(dos.llamar)).avance?.aceptados ?? 0) >= 1);
      expect(enCurso(await estado(dos.llamar))).toBe(true);
      const c = datos(await dos.llamar("trabajo_cancelar")).trabajo;
      expect(c).toMatchObject({ estado: "cancelado", mensaje: expect.stringContaining("Cancelado"), avance: { aceptados: 1, guardados: 1 } });
      expect(await codigos(s2)).toEqual(["1001-1-LE26"]);
      expect((await dos.llamar("trabajo_cancelar")).isError).toBe(true);
    });

    it("un segundo trabajo mientras corre uno es isError, sea sync u ocds, y al terminar el espacio queda libre", async () => {
      const store = storeMemoria();
      const { llamar } = servidor({ store, ocds: colgada() });
      await llamar("ocds_importar", { anio: 2026, q: "aseo" });
      for (const [n, a] of [["ocds_importar", { anio: 2026, q: "aseo" }], ["sync", { desde: "2026-06-12", maxConsultas: 100 }]] as const) {
        const r = await llamar(n, a);
        expect(r.isError, n).toBe(true);
        expect(r.content[0].text).toMatch(/Ya hay un trabajo en curso \(ocds.*trabajo_estado.*trabajo_cancelar/);
      }
      await llamar("trabajo_cancelar");
      expect((await llamar("ocds_importar", { anio: 2026, q: "aseo" })).isError).toBeUndefined();
      await llamar("trabajo_cancelar");
    });

    it("con un sync corriendo, ocds_importar también se niega", async () => {
      let abrir!: () => void;
      const gate = new Promise<void>((r) => (abrir = r));
      const { llamar, urls } = servidor({ store: storeMemoria(), gate, ocds: ocdsGz().f });
      await llamar("sync", { desde: "2026-06-12", hasta: "2026-06-12", maxConsultas: 100 });
      await esperar(() => urls.filter((u) => /codigo=|compra-agil\/./.test(u)).length > 1);
      const r = await llamar("ocds_importar", { anio: 2026, q: "papel" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("sync");
      abrir();
      await fin(llamar);
    });

    it("gasta 0 consultas y no cuenta para el tope del agente: se importa aunque el tope ya se agotó", async () => {
      const store = storeMemoria();
      const { f } = ocdsGz();
      const { llamar, mp, urls } = servidor({ store, tope: 1, ocds: f });
      mp.cuota.registrar(5); // el agente ya pasó su tope
      expect((await llamar("sync", { desde: "2026-06-12", maxConsultas: 100 })).content[0].text).toContain("tope diario del agente");
      const r = await llamar("ocds_importar", { anio: 2026, q: "papel" });
      expect(r.isError).toBeUndefined();
      expect(datos(r).costo).toMatchObject({ consultas: 0, topeAgente: { limite: 1, usadas: 5 } });
      expect(datos(r).costo).not.toHaveProperty("nota");
      await fin(llamar);
      expect((await estado(llamar)).estado).toBe("terminado");
      expect(datos(await llamar("cuota")).topeAgente.usadas).toBe(5); // la importación no sumó nada
      expect(urls).toHaveLength(0); // y la API de Mercado Público ni se tocó
      expect(await codigos(store)).toHaveLength(2);
    });

    it("el costo de otra herramienta no se anota con el trabajo de OCDS en curso", async () => {
      const { llamar } = servidor({ store: storeMemoria(), ocds: colgada() });
      await llamar("ocds_importar", { anio: 2026, q: "papel" });
      expect(datos(await llamar("proveedor", { rut: "1-9" })).costo).not.toHaveProperty("nota");
      await llamar("trabajo_cancelar");
    });

    it("sin store no existe y sin `fetch` propio usa el global", async () => {
      expect((await servidor().rpc("tools/call", { name: "ocds_importar", arguments: { anio: 2026, q: "papel" } })).error.code).toBe(-32602);
      const global = vi.spyOn(globalThis, "fetch").mockImplementation(ocdsGz().f);
      try {
        const store = storeMemoria();
        const { f } = api();
        const sv = crearServidorMcp({ mp: new MercadoPublico({ ticket: "T", fetch: f, conversor: false, intervaloMs: 0 }), abrirStore: async () => store });
        await sv.manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ocds_importar", arguments: { anio: 2026, q: "papel" } } });
        await esperar(async () => (await codigos(store)).length === 2);
        expect(global).toHaveBeenCalledWith(urlOcds(2026), expect.anything());
      } finally {
        global.mockRestore();
      }
    });
  });

  describe("competidores, proximas_compras y precios", () => {
    const hoy = diaSantiago();
    const enPesos = (m: number) => ({ valor: m, moneda: "CLP" as const, clp: m, fechaValor: hoy, fuente: "identidad" });
    const prov = (rut: string, nombre: string) => ({ rut, nombre, codigo: null });
    const COD = 44121701;
    const base = (codigo: string, org: string, region: number, dia: string) => ({
      codigo,
      nombre: `Compra ${codigo}`,
      descripcion: null,
      estado: "aceptada",
      estadoGlosa: null,
      comprador: { codigoOrganismo: org, nombreOrganismo: `Org ${org}`, rutUnidad: null, codigoUnidad: null, nombreUnidad: null, region, comuna: null },
      fechas: { creacion: `${dia}T10:00:00-03:00`, publicacion: `${dia}T10:00:00-03:00`, cierre: null, adjudicacion: null, ultimoCambio: null },
      monto: enPesos(1000),
      items: [{ codigoProducto: 43211507, nombre: null, descripcion: null, cantidad: 1, unidad: "Unidad", precioUnitario: null, total: enPesos(1000), proveedor: null as any }],
      oferentes: null,
      personales: null,
      origen: "v1" as const,
      raw: null,
    });
    // 4 OC de un organismo de la RM cada 30 días (la última hace 5): la próxima cae en el futuro. Una la gana una persona natural.
    const ocs = [95, 65, 35, 5].map((d, i) => {
      const p = i === 3 ? prov("5000000-1", "Juan Pérez Soto") : prov("76000000-0", "Empresa SpA");
      const b = base(`1000-${i}-SE26`, "7248", 13, sumarDias(hoy, -d));
      return { ...b, tipo: "orden_compra" as const, tipoOrden: null, proveedor: p, procesoOrigen: null, items: [{ ...b.items[0]!, proveedor: p }] } as Proceso;
    });
    // 12 Compras Ágiles de la región 5, con un precio ganador de 100 a 1200 cada una.
    const agiles = Array.from({ length: 12 }, (_, i) => {
      const b = base(`${900 + i}-1-COT26`, "9999", 5, sumarDias(hoy, -(120 - i * 10)));
      return {
        ...b,
        tipo: "compra_agil" as const,
        ordenCompra: null,
        items: [{ ...b.items[0]!, codigoProducto: COD, unidad: "Unidad" }],
        cotizaciones: [{ proveedor: prov("77000000-3", "Otra Ltda"), monto: enPesos((i + 1) * 100), seleccionada: true, productos: [{ codigoProducto: COD, nombre: null, cantidad: 1, precioUnitario: enPesos((i + 1) * 100) }] }],
      } as CompraAgil;
    });
    const todos: Proceso[] = [...ocs, ...agiles];
    const semilla = async () => {
      const s = storeMemoria();
      await s.guardar(todos);
      return servidor({ store: s });
    };
    const sinCosto = ({ costo: _, ...r }: any) => r;

    it("competidores devuelve lo mismo que la función del radar, recortado y con la persona natural oculta", async () => {
      const { llamar } = await semilla();
      const directo = competidores(todos);
      const oculto = (x: any) => (x.proveedor.rut === "5000000-1" ? { ...x, proveedor: { rut: "[oculto]", nombre: "[oculto]", codigo: null } } : x);
      const r = datos(await llamar("competidores"));
      expect(sinCosto(r)).toEqual({ ...directo, competidores: directo.competidores.map(oculto), totalCompetidores: 3, truncado: false });
      expect(r.costo.consultas).toBe(0);
      expect(JSON.stringify(r)).not.toContain("Juan");
      expect(JSON.stringify(r)).not.toContain("5000000");
      // Filtros y recorte.
      const f = { rubros: ["4412"], regiones: [5] };
      expect(sinCosto(datos(await llamar("competidores", f)))).toMatchObject({ procesos: 12, victorias: 12, competidores: [{ proveedor: { nombre: "Otra Ltda" }, victorias: 12 }] });
      expect(datos(await llamar("competidores", f)).competidores).toEqual(competidores(todos, f).competidores);
      const uno = datos(await llamar("competidores", { max: 1 }));
      expect(uno).toMatchObject({ totalCompetidores: 3, truncado: true });
      expect(uno.competidores).toHaveLength(1);
      // Con su RUT pedido, el propio proveedor sí se ve.
      const mio = datos(await llamar("competidores", { rut: "5000000-1" }));
      expect(mio.competidores.find((x: any) => x.eresTu)).toMatchObject({ proveedor: { nombre: "Juan Pérez Soto" } });
      for (const args of [{ rubros: ["abc"] }, { rubros: "4412" }, { regiones: [99] }, { organismos: [7248] }, { max: 0 }]) expect((await llamar("competidores", args)).isError, JSON.stringify(args)).toBe(true);
    });

    it("proximas_compras devuelve lo mismo que la función del radar, filtrado por región y recortado", async () => {
      const { llamar } = await semilla();
      const directo = proximasCompras(todos, { ahora: new Date() });
      expect(directo.map((x) => x.region!).sort((a, b) => a - b)).toEqual([5, 13]);
      expect(datos(await llamar("proximas_compras"))).toMatchObject({ proximas: directo, total: 2, truncado: false, costo: { consultas: 0 } });
      expect(datos(await llamar("proximas_compras", { regiones: [13] })).proximas).toEqual(directo.filter((x) => x.region === 13));
      expect(datos(await llamar("proximas_compras", { rubros: [4321] })).proximas).toEqual(proximasCompras(todos, { ahora: new Date(), rubros: [4321] }));
      expect(datos(await llamar("proximas_compras", { max: 1 }))).toMatchObject({ total: 2, truncado: true, proximas: [expect.anything()] });
      expect(datos(await llamar("proximas_compras", { regiones: [1] }))).toMatchObject({ proximas: [], total: 0 });
      expect((await llamar("proximas_compras", { rubros: ["x"] })).isError).toBe(true);
    });

    it("precios: rango de lo ganado, o precio sugerido con costo, igual que el radar", async () => {
      const { llamar } = await semilla();
      const rango = rangoDePrecio(COD, agiles, { soloSeleccionadas: true });
      expect(rango).toMatchObject({ n: 12, p50: 650 });
      const r = datos(await llamar("precios", { codigoProducto: COD }));
      expect(r).toMatchObject({ ...rango, comprasAgiles: 12, costo: { consultas: 0 } });
      expect(r.insuficiente).toBeUndefined();
      const { curva, costo, ...sug } = precioSugerido(COD, agiles, { costo: 300 }) as any;
      const s = datos(await llamar("precios", { codigoProducto: COD, costo: 300 }));
      expect(s).toMatchObject({ ...sug, costoUnitario: costo, puntosDeCurva: curva.length, costo: { consultas: 0 } });
      expect(s).not.toHaveProperty("curva");
      expect(datos(await llamar("precios", { codigoProducto: COD, unidad: "caja" }))).toMatchObject({ insuficiente: true, n: 0 }); // otra unidad: sin precios
      for (const args of [{}, { codigoProducto: "44121701" }, { codigoProducto: 1.5 }, { codigoProducto: COD, costo: -1 }, { codigoProducto: COD, costo: "mucho" }]) expect((await llamar("precios", args)).isError, JSON.stringify(args)).toBe(true);
    });

    it("precios insuficiente se entrega como dato con la pista de traer Compra Ágil con sync", async () => {
      const { llamar } = await semilla();
      const r = await llamar("precios", { codigoProducto: 43211507 }); // solo hay OC de este producto: ninguna Compra Ágil
      expect(r.isError).toBeUndefined();
      expect(datos(r)).toMatchObject({ insuficiente: true, n: 0, motivo: "muestra insuficiente", comprasAgiles: 12, pista: expect.stringMatching(/`sync`.*compra_agil.*OCDS no trae Compra Ágil/) });
      const caro = datos(await llamar("precios", { codigoProducto: COD, costo: 5000 }));
      expect(caro).toMatchObject({ insuficiente: true, motivo: "costo sobre los precios ganadores", pista: expect.stringContaining("costo") });
      expect(caro.pista).not.toContain("sync");
    });

    it("con el store vacío son isError con el camino para llenarlo; las descripciones dicen de dónde salen los datos", async () => {
      const { llamar, rpc } = servidor({ store: storeMemoria() });
      for (const [n, a] of [["competidores", {}], ["proximas_compras", {}], ["precios", { codigoProducto: COD }]] as const) {
        const r = await llamar(n, a);
        expect(r.isError, n).toBe(true);
        expect(r.content[0].text).toMatch(/ocds_importar.*sync/);
      }
      const tools = (await rpc("tools/list")).result.tools;
      const d = (n: string) => tools.find((t: any) => t.name === n).description;
      expect(d("competidores")).toMatch(/OCDS.*Compra Ágil.*`sync`.*0 consultas/s);
      expect(d("proximas_compras")).toMatch(/0 consultas.*OCDS no trae.*`sync`/s);
      expect(d("precios")).toMatch(/Compra Ágil.*0 consultas.*`sync`.*OCDS no trae Compra Ágil/s);
      expect(d("ocds_importar")).toMatch(/0 consultas.*tope del agente/s);
    });

    it("mientras un trabajo tiene el store (lock), el análisis lee por su handle", async () => {
      const dir = mkdtempSync(join(tmpdir(), "mp-mcp-"));
      try {
        const ruta = join(dir, "mp.json");
        const previo = await storeArchivo(ruta);
        await previo.guardar(todos);
        await previo.cerrar!();
        const { llamar } = servidor({ abrirStore: () => storeArchivo(ruta), ocds: (async (_u: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({ pull: (c) => new Promise<void>((r) => init?.signal?.addEventListener("abort", () => (c.error(new DOMException("aborted", "AbortError")), r()))) }))) as typeof fetch });
        await llamar("ocds_importar", { anio: 2026, q: "papel" });
        await esperar(async () => (await estado(llamar)).estado === "ejecutando");
        await expect(storeArchivo(ruta)).rejects.toThrow(/en uso/);
        expect(datos(await llamar("competidores")).totalCompetidores).toBe(3);
        expect(datos(await llamar("proximas_compras")).total).toBe(2);
        expect(datos(await llamar("precios", { codigoProducto: COD })).n).toBe(12);
        await llamar("trabajo_cancelar");
        await (await storeArchivo(ruta)).cerrar!(); // el lock se soltó
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("robustez del servidor", () => {
  const nulos = { creacion: null, publicacion: null, cierre: null, adjudicacion: null, ultimoCambio: null };
  const ocStore = {
    tipo: "orden_compra", codigo: "9-9-SE26", nombre: "OC insumos", descripcion: null, estado: "aceptada", estadoGlosa: null,
    comprador: { codigoOrganismo: "7248", nombreOrganismo: "Org", rutUnidad: null, codigoUnidad: null, nombreUnidad: null, region: 13, comuna: null },
    fechas: nulos, monto: null, items: [], oferentes: null, personales: null, origen: "v1", tipoOrden: null, proveedor: { rut: "76000000-0", nombre: "Empresa SpA", codigo: null }, procesoOrigen: null, raw: null,
  } as unknown as Proceso;
  const perfil = { pesos: { region: 1 } };
  const conTmp = async (f: (ruta: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "mp-mcp-"));
    try {
      await f(join(dir, "mp.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const esperar = async (f: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("se acabó la espera");
  };
  const DIA = { desde: "2026-06-12", hasta: "2026-06-12" };
  const detalles = (urls: string[]) => urls.filter((u) => /codigo=|compra-agil\/./.test(u)).length;
  const terminado = async (llamar: (n: string) => Promise<any>) => !["planificando", "ejecutando"].includes(datos(await llamar("trabajo_estado")).trabajo.estado);

  it("radar, competidores y search en paralelo sobre un storeArchivo real no chocan por el lock", async () => {
    await conTmp(async (ruta) => {
      const previo = await storeArchivo(ruta);
      await previo.guardar([ocStore]);
      await previo.cerrar!();
      const { llamar } = servidor({ abrirStore: () => storeArchivo(ruta) });
      const rs = await Promise.all([llamar("radar", { perfil }), llamar("competidores"), llamar("search", { query: "insumos", tipo: "orden_compra" }), llamar("radar", { perfil }), llamar("proximas_compras")]);
      for (const r of rs) expect(r.isError, r.content[0].text).toBeUndefined();
      expect(datos(rs[2]!).notas).toEqual([]);
      expect(datos(rs[2]!).results.map((x: any) => x.id)).toEqual(["9-9-SE26"]);
      await (await storeArchivo(ruta)).cerrar!(); // y no quedó ningún lock
    });
  });

  it("lecturas lanzadas junto con un sync: el sync arranca y las lecturas responden sin error de lock", async () => {
    await conTmp(async (ruta) => {
      const previo = await storeArchivo(ruta);
      await previo.guardar([ocStore]);
      await previo.cerrar!();
      const { llamar } = servidor({ abrirStore: () => storeArchivo(ruta) });
      const rs = await Promise.all([llamar("radar", { perfil }), llamar("sync", { ...DIA, maxConsultas: 100 }), llamar("search", { query: "insumos", tipo: "orden_compra" }), llamar("competidores")]);
      for (const r of rs) expect(r.isError, r.content[0].text).toBeUndefined();
      expect(datos(rs[2]!).notas).toEqual([]);
      await esperar(() => terminado(llamar));
      await (await storeArchivo(ruta)).cerrar!();
    });
  });

  it("si el store no abre es isError con un mensaje corto, sin rutas, pid ni host, y no deja trabajo", async () => {
    const abrirStore = () => Promise.reject(new Error("/home/ana/mp.json está en uso por otro proceso (/home/ana/mp.json.lock: pid 4242 host maquina-ana)"));
    const { llamar } = servidor({ abrirStore });
    for (const [n, a] of [["radar", { perfil }], ["competidores", {}], ["proximas_compras", {}], ["sync", { ...DIA, maxConsultas: 10 }], ["ocds_importar", { anio: 2026, q: "papel" }]] as const) {
      const r = await llamar(n, a);
      expect(r.isError, n).toBe(true);
      expect(r.content[0].text, n).toContain("No se pudo abrir el store local");
      expect(r.content[0].text, n).not.toMatch(/ana|pid|host|4242|\.lock/);
    }
    expect(datos(await llamar("trabajo_estado")).trabajo).toBeNull();
  });

  it("los mensajes de store vacío sugieren primero la herramienta y la terminal con la misma MP_STORE (sin ruta si no se conoce)", async () => {
    const con = await servidor({ store: storeMemoria(), rutaStore: "/datos/mp.json" }).llamar("radar", { perfil });
    expect(con.isError).toBe(true);
    expect(con.content[0].text).toMatch(/herramienta `ocds_importar`.*`sync`.*`MP_STORE=\/datos\/mp\.json npx mercadopublico sync --desde AAAA-MM-DD`/s);
    const sin = (await servidor({ store: storeMemoria() }).llamar("competidores")).content[0].text;
    expect(sin).toContain("`npx mercadopublico sync --desde AAAA-MM-DD`");
    expect(sin).not.toContain("MP_STORE=");
    const espacios = (await servidor({ store: storeMemoria(), rutaStore: "/mi carpeta/mp.json" }).llamar("radar", { perfil })).content[0].text;
    expect(espacios).toContain('MP_STORE="/mi carpeta/mp.json" npx');
    // El precheck del sync también manda a la terminal con la misma ruta.
    const caro = await servidor({ store: storeMemoria(), rutaStore: "/datos/mp.json" }).llamar("sync", { desde: "2026-01-01", hasta: "2026-06-12", maxConsultas: 5 });
    expect(caro.content[0].text).toContain("MP_STORE=/datos/mp.json npx mercadopublico sync");
    const { rpc } = servidor({ store: storeMemoria() });
    const tools = (await rpc("tools/list")).result.tools;
    expect(tools.find((t: any) => t.name === "radar").description).toContain("herramienta `sync`");
    expect(tools.find((t: any) => t.name === "sync").description).toMatch(/MP_STORE/);
  });

  it("radar: perfil, pesos o decisiones inválidos son isError, no -32603", async () => {
    const { rpc } = servidor({ store: await (async () => { const s = storeMemoria(); await s.guardar([ocStore]); return s; })() });
    const llamar = (a: object) => rpc("tools/call", { name: "radar", arguments: a });
    for (const a of [{ perfil: { pesos: {} } }, { perfil: { pesos: { rubro: "a" } } }, { perfil, decisiones: [null] }, { perfil, decisiones: [{ codigo: "x", decision: "quizas" }] }, { perfil, decisiones: [{ decision: "postular" }] }, { perfil, decisiones: "x" }]) {
      const r = await llamar(a);
      expect(r.error, JSON.stringify(a)).toBeUndefined();
      expect(r.result.isError, JSON.stringify(a)).toBe(true);
    }
    expect((await llamar({ perfil, decisiones: [{ codigo: "9-9-SE26", decision: "postular" }] })).result.isError).toBeUndefined();
  });

  it("radar y competidores no filtran el nombre ni el RUT de una persona natural (en `porque` ni en `lectura`)", async () => {
    const natural = (codigo: string) => ({ ...(ocStore as any), codigo, nombre: `OC ${codigo}`, proveedor: { rut: "12.345.678-5", nombre: "Juan Pérez Soto", codigo: null } }) as Proceso;
    const abierta = { ...(ocStore as any), tipo: "licitacion", codigo: "1-1-L126", nombre: "Licitación abierta", estado: "publicada", tipoLicitacion: "L1", tipoLicitacionGlosa: null, proveedor: undefined, tipoOrden: undefined, procesoOrigen: undefined, fechas: { ...nulos, cierre: new Date(Date.now() + 5 * 86_400_000).toISOString() }, items: [{ codigoProducto: 43211507, nombre: null, descripcion: null, cantidad: 1, unidad: null, precioUnitario: null, total: null, proveedor: null }] } as Proceso;
    const historia = ["a", "b", "c"].map((c) => ({ ...natural(c), items: [{ codigoProducto: 43211507, nombre: null, descripcion: null, cantidad: 1, unidad: null, precioUnitario: null, total: null, proveedor: null }] }) as Proceso);
    const s = storeMemoria();
    await s.guardar([abierta, ...historia]);
    const { llamar } = servidor({ store: s });
    const radar = await llamar("radar", { perfil: { pesos: { incumbente: 1 }, umbralRevisar: 0 } }); // umbralRevisar 0: aun con el incumbente dominando entra en la agenda
    expect(radar.isError).toBeUndefined();
    expect(radar.content[0].text).toContain("Un proveedor persona natural se llevó 3 de 3");
    expect(radar.content[0].text).not.toMatch(/Juan|12\.?345\.?678/);
    const comp = await llamar("competidores");
    expect(datos(comp).lectura).toBe("Concentrado: un proveedor persona natural y pocos más se llevan casi todo.");
    expect(comp.content[0].text).not.toMatch(/Juan|12\.?345\.?678/);
  });

  describe("costo", () => {
    it("un error de herramienta también informa el costo (consultas gastadas) en structuredContent y en el texto", async () => {
      const falla = (async () => new Response("", { status: 400 })) as typeof fetch;
      const mp = new MercadoPublico({ ticket: "T", fetch: falla, conversor: false, intervaloMs: 0 });
      const s = crearServidorMcp({ mp });
      const r = ((await s.manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: { id: "1509-5-LE26" } } })) as any).result;
      expect(r.isError).toBe(true);
      expect(r.structuredContent.costo.consultas).toBeGreaterThan(0);
      expect(r.structuredContent.costo).toMatchObject({ restanteHoy: expect.any(Number), topeAgente: { limite: 1000 } });
      expect(r.content[0].text).toMatch(new RegExp(`\\(costo: ${r.structuredContent.costo.consultas} consultas\\)$`));
      // Un error de uso (sin consultar) informa 0.
      const uso = await servidor().llamar("fetch", { id: "hola" });
      expect(uso.structuredContent.costo.consultas).toBe(0);
      expect(uso.content[0].text).toContain("(costo: 0 consultas)");
    });

    it("al cruzar la medianoche de Santiago el costo de la llamada no se pierde (usadas vuelve a 0)", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T23:59:59-03:00") });
      try {
        const { f } = api({ sinLicitacion: ["1509-5-L114"] }); // licitación que no existe: 2 consultas
        let n = 0;
        const cruza = (async (u: string | URL | Request, i?: RequestInit) => {
          if (++n === 1) vi.setSystemTime(new Date("2026-10-15T00:00:05-03:00"));
          return f(u, i);
        }) as typeof fetch;
        const mp = new MercadoPublico({ ticket: "T", fetch: cruza, conversor: false, intervaloMs: 0, cuota: { dia: "2026-10-14", usadas: 500 } });
        const s = crearServidorMcp({ mp });
        const r = ((await s.manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: { id: "1509-5-L114" } } })) as any).result;
        expect(r.structuredContent.costo.consultas).toBeGreaterThan(0); // antes: max(0, 1 - 500) = 0
      } finally {
        vi.useRealTimers();
      }
    });

    it("maxConsultas del sync se sigue contando después de medianoche", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T23:59:00-03:00") });
      try {
        let abrir!: () => void;
        const gate = new Promise<void>((r) => (abrir = r));
        const { f, urls } = api({ gate });
        const mp = new MercadoPublico({ ticket: "T", fetch: f, conversor: false, intervaloMs: 0, cuota: { dia: "2026-10-14", usadas: 900 } });
        const s = crearServidorMcp({ mp, abrirStore: async () => store });
        const store = storeMemoria();
        const llamar = async (name: string, args: object = {}) => ((await s.manejar({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any).result;
        await llamar("sync", { ...DIA, maxConsultas: 20 });
        await esperar(() => detalles(urls) > 1);
        vi.setSystemTime(new Date("2026-10-15T00:01:00-03:00"));
        mp.cuota.registrar(20); // otro consumidor ya gastó 20 en el día nuevo
        abrir();
        await esperar(() => terminado(llamar));
        expect(datos(await llamar("trabajo_estado")).trabajo).toMatchObject({ estado: "detenido", mensaje: expect.stringContaining("se alcanzó maxConsultas (20)") });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("cerrar durante un sync lo aborta y deja el store reabrible; sin trabajo no hace nada", async () => {
    await conTmp(async (ruta) => {
      const { llamar, urls, s } = servidor({ abrirStore: () => storeArchivo(ruta), gate: new Promise(() => {}) }); // la compuerta no se abre: cerrar tiene que cortar la consulta en vuelo
      await s.cerrar(); // sin trabajo
      await llamar("sync", { ...DIA, maxConsultas: 100 });
      await esperar(() => detalles(urls) > 1); // el job está a media ejecución, con el lock
      await expect(storeArchivo(ruta)).rejects.toThrow(/en uso/);
      await s.cerrar();
      expect(datos(await llamar("trabajo_estado")).trabajo).toMatchObject({ estado: "cancelado" });
      await (await storeArchivo(ruta)).cerrar!(); // el lock se soltó
    });
  });

  it("sin `version` el serverInfo no inventa una", async () => {
    const mp = new MercadoPublico({ ticket: "T", fetch: api().f, conversor: false, intervaloMs: 0 });
    const r = ((await crearServidorMcp({ mp }).manejar({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as any).result;
    expect(r.serverInfo.version).toBe("0.0.0-desconocida");
  });
});

describe("servirStdio", () => {
  async function correr(lineas: string[], servidor: { manejar(m: unknown): Promise<object | null> }) {
    let out = "";
    await servirStdio(servidor, Readable.from(lineas.map((l) => `${l}\n`)), { write: (s: string) => (out += s) });
    return out.trim() ? out.trim().split("\n").map((l) => JSON.parse(l)) : [];
  }

  it("JSON roto es -32700 con id null, las notificaciones no responden y cada petición recibe su respuesta", async () => {
    const { s } = servidor();
    const r = await correr(
      [
        "{no es json",
        "",
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
        JSON.stringify({ jsonrpc: "2.0", id: "dos", method: "tools/list" }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nada" }),
      ],
      s,
    );
    expect(r[0]).toMatchObject({ id: null, error: { code: -32700 } });
    const porId = Object.fromEntries(r.slice(1).map((x) => [x.id, x]));
    expect(r).toHaveLength(4);
    expect(porId[1].result.protocolVersion).toBe("2025-11-25");
    expect(porId.dos.result.tools).toHaveLength(6);
    expect(porId[3].error.code).toBe(-32601);
  });

  it("atiende sin esperar: un ping responde antes que una petición lenta, y se espera a todas antes de terminar", async () => {
    const lento = { manejar: async (m: any) => (m.method === "lento" ? (await new Promise((r) => setTimeout(r, 30)), { id: m.id, result: "lento" }) : { id: m.id, result: "rapido" }) };
    const r = await correr([JSON.stringify({ id: 1, method: "lento" }), JSON.stringify({ id: 2, method: "ping" })], lento);
    expect(r.map((x) => x.id)).toEqual([2, 1]);
  });

  it("al terminar la entrada, y después de responder todo, cierra el servidor", async () => {
    const orden: string[] = [];
    const sv = {
      manejar: async () => (await new Promise((r) => setTimeout(r, 20)), orden.push("respuesta"), { jsonrpc: "2.0", id: 1, result: {} }),
      cerrar: async () => void orden.push("cerrar"),
    };
    await correr([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })], sv);
    expect(orden).toEqual(["respuesta", "cerrar"]);
  });
});
