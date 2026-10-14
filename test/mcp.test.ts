import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { servirStdio } from "../src/cli.js";
import { MercadoPublico, storeMemoria, type Proceso, type Store } from "../src/index.js";
import { crearServidorMcp } from "../src/mcp.js";

const fixture = (r: string) => readFileSync(new URL(`./fixtures/${r}.json`, import.meta.url), "utf8");
const VACIO = '{"Cantidad":0,"Listado":[]}';

/** Fetch falso con los fixtures; `sinLicitacion` son códigos que la API v1 no encuentra como licitación. */
function api({ sinLicitacion = [] as string[] } = {}) {
  const urls: string[] = [];
  const f = (async (u: string | URL | Request) => {
    const url = new URL(String(u));
    urls.push(url.pathname + url.search);
    const codigo = url.searchParams.get("codigo");
    if (url.hostname === "api2.mercadopublico.cl") return new Response(fixture(url.pathname.endsWith("compra-agil") ? "v2/listado-p1" : "v2/detalle"));
    if (url.pathname.endsWith("/licitaciones.json")) return new Response(codigo ? (sinLicitacion.includes(codigo) ? VACIO : fixture("v1/licitacion-detalle")) : fixture("v1/licitaciones-listado"));
    if (url.pathname.endsWith("/ordenesdecompra.json")) return new Response(fixture(codigo ? "v1/oc-detalle" : "v1/ordenes-listado"));
    if (url.pathname.endsWith("BuscarProveedor") || url.pathname.endsWith("BuscarComprador")) return new Response(fixture("v1/empresas-proveedor"));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, urls };
}

function servidor(op: { tope?: number; store?: Store; sinLicitacion?: string[] } = {}) {
  const { f, urls } = api(op);
  const mp = new MercadoPublico({ ticket: "T", fetch: f, conversor: false, intervaloMs: 0 });
  const s = crearServidorMcp({ mp, tope: op.tope, version: "9.9.9", abrirStore: op.store && (async () => op.store!) });
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
    expect(r).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mercadopublico", version: "9.9.9" }, resultType: "complete" });
    expect(r.instructions).toContain("search");
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");
  });

  it("server/discover con la forma de la spec 2026-07-28", async () => {
    const { rpc } = servidor();
    const r = (await rpc("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } })).result;
    expect(r).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
      capabilities: { tools: {} },
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

  it("tools/list: sin radar si no hay store, con radar si lo hay; ttlMs, cacheScope, title y annotations", async () => {
    const sin = (await servidor().rpc("tools/list")).result;
    expect(sin.tools.map((t: any) => t.name)).toEqual(["search", "fetch", "listar", "organismos", "proveedor", "cuota"]);
    expect(sin).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "private" });
    const con = (await servidor({ store: storeMemoria() }).rpc("tools/list")).result;
    expect(con.tools.map((t: any) => t.name)).toEqual(["search", "fetch", "listar", "organismos", "proveedor", "cuota", "radar"]);
    for (const t of con.tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: expect.any(Boolean) });
    }
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
    expect(datos(r).notas.join(" ")).toContain("bloqueado por sync");
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
});
