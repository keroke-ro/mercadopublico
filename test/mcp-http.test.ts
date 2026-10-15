import { afterEach, describe, expect, it } from "vitest";
import { main, servirHttp } from "../src/cli.js";
import { MercadoPublico } from "../src/index.js";
import { crearServidorMcp, manejadorHttp } from "../src/mcp-http.js";

const mp = new MercadoPublico({ ticket: "T-SECRETO", fetch: (async () => new Response("", { status: 404 })) as typeof fetch, conversor: false, intervaloMs: 0 });
const servidor = crearServidorMcp({ mp });
const META = "io.modelcontextprotocol/protocolVersion";
const MODERNO = "2026-07-28";

const post = (cuerpo: unknown, headers: Record<string, string> = {}, url = "https://x.test/mcp/abc") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) });
const moderno = (method: string, params: object = {}) => ({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { [META]: MODERNO } } });
const cabModerno = (method: string, extra: Record<string, string> = {}) => ({ "mcp-protocol-version": MODERNO, "mcp-method": method, ...extra });

const h = manejadorHttp(servidor, { clave: "abc" });
const rpc = async (r: Response) => ({ status: r.status, cuerpo: (await r.json()) as any });

describe("mcp http", () => {
  it("solo POST: el resto es 405 con Allow", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await h(new Request("https://x.test/mcp/abc", { method }));
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });

  it("Origin presente y no permitido es 403; ausente o permitido pasa", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await h(post(msg, { origin: "https://malo.test" }))).status).toBe(403);
    expect((await h(post(msg))).status).toBe(200);
    expect((await manejadorHttp(servidor, { clave: "abc", origenes: ["https://ok.test"] })(post(msg, { origin: "https://ok.test" }))).status).toBe(200);
  });

  it("clave: falta o es mala es 401; sirve en la ruta y como Bearer", async () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await h(post(msg, {}, "https://x.test/mcp"))).status).toBe(401);
    expect((await h(post(msg, {}, "https://x.test/mcp/abd"))).status).toBe(401);
    expect((await h(post(msg, {}, "https://x.test/otro/abc"))).status).toBe(401);
    expect((await h(post(msg, { authorization: "Bearer otra" }, "https://x.test/mcp"))).status).toBe(401);
    expect((await h(post(msg, {}, "https://x.test/mcp/abc"))).status).toBe(200);
    expect((await h(post(msg, {}, "https://x.test/prefijo/mcp/abc/"))).status).toBe(200);
    expect((await h(post(msg, { authorization: "Bearer abc" }, "https://x.test/mcp"))).status).toBe(200);
  });

  it("sin clave configurada no hay autenticación", async () => {
    const r = await manejadorHttp(servidor)(post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "https://x.test/mcp"));
    expect(r.status).toBe(200);
  });

  it("una notificación es 202 sin cuerpo", async () => {
    const r = await h(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("initialize legacy: 200 JSON, sin Mcp-Session-Id ni SSE", async () => {
    const r = await h(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect((await r.json() as any).result.protocolVersion).toBe("2025-11-25");
  });

  it("moderno: con headers que calzan responde; Mcp-Name acepta base64", async () => {
    const lista = await rpc(await h(post(moderno("tools/list"), cabModerno("tools/list"))));
    expect(lista.status).toBe(200);
    expect(lista.cuerpo.result.tools.length).toBeGreaterThan(0);
    const llamada = moderno("tools/call", { name: "ñandú" });
    const b64 = `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode("ñandú")))}?=`;
    // Herramienta inexistente: llega al núcleo (200 con -32602), o sea pasó la validación de headers.
    expect((await rpc(await h(post(llamada, cabModerno("tools/call", { "mcp-name": b64 }))))).cuerpo.error.code).toBe(-32602);
  });

  it("moderno: header que no calza es 400 con -32020", async () => {
    const casos: [object, Record<string, string>][] = [
      [moderno("tools/list"), cabModerno("ping")],
      [moderno("tools/list"), { "mcp-protocol-version": MODERNO }],
      [moderno("tools/list"), { "mcp-method": "tools/list" }],
      [moderno("tools/list"), { ...cabModerno("tools/list"), "mcp-protocol-version": "2025-11-25" }],
      [moderno("tools/call", { name: "search" }), cabModerno("tools/call")],
      [moderno("tools/call", { name: "search" }), cabModerno("tools/call", { "mcp-name": "fetch" })],
    ];
    for (const [cuerpo, cab] of casos) {
      const r = await rpc(await h(post(cuerpo, cab)));
      expect(r.status).toBe(400);
      expect(r.cuerpo.error.code).toBe(-32020);
      expect(r.cuerpo.id).toBe(1);
    }
  });

  it("versión no soportada: 400 con -32022, en moderno y por header legacy", async () => {
    const malo = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [META]: "1900-01-01" } } };
    const a = await rpc(await h(post(malo, { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" })));
    expect([a.status, a.cuerpo.error.code, a.cuerpo.error.data.requested]).toEqual([400, -32022, "1900-01-01"]);
    const b = await rpc(await h(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1900-01-01" })));
    expect([b.status, b.cuerpo.error.code]).toEqual([400, -32022]);
    expect((await h(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-06-18" }))).status).toBe(200);
  });

  it("método desconocido: 404 en moderno y 200 en legacy", async () => {
    expect((await rpc(await h(post(moderno("nada/nada"), cabModerno("nada/nada"))))).status).toBe(404);
    const legacy = await rpc(await h(post({ jsonrpc: "2.0", id: 1, method: "nada/nada" })));
    expect([legacy.status, legacy.cuerpo.error.code]).toEqual([200, -32601]);
  });

  it("batch es 400 con -32600; JSON inválido es 400 con -32700", async () => {
    const batch = await rpc(await h(post([{ jsonrpc: "2.0", id: 1, method: "ping" }])));
    expect([batch.status, batch.cuerpo.error.code]).toEqual([400, -32600]);
    const malo = await rpc(await h(post("{no es json")));
    expect([malo.status, malo.cuerpo.error.code]).toEqual([400, -32700]);
    expect((await h(post('"texto"'))).status).toBe(400);
  });

  it("nunca manda Mcp-Session-Id ni devuelve la clave o el ticket", async () => {
    const respuestas = [
      await h(post({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
      await h(post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "https://x.test/mcp/mala")),
      await h(post("{", { authorization: "Bearer abc" })),
    ];
    for (const r of respuestas) {
      expect(r.headers.get("mcp-session-id")).toBeNull();
      const t = await r.text();
      expect(t).not.toContain("abc");
      expect(t).not.toContain("T-SECRETO");
    }
  });

  it("si el núcleo lanza, 500 genérico", async () => {
    const r = await manejadorHttp({ manejar: async () => Promise.reject(new Error("T-SECRETO")) })(post({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("T-SECRETO");
  });
});

describe("servirHttp (adaptador node:http)", () => {
  const abiertos: { close(): void }[] = [];
  afterEach(() => abiertos.splice(0).forEach((s) => s.close()));
  const levantar = async () => {
    const srv = await servirHttp(h, 0, "127.0.0.1");
    abiertos.push(srv);
    return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  };

  it("sirve POST y GET, y corta cuerpos de más de 1 MB con 413", async () => {
    const base = await levantar();
    const ok = await fetch(`${base}/mcp/abc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) });
    expect([ok.status, (await ok.json() as any).id]).toEqual([200, 7]);
    expect((await fetch(`${base}/mcp/abc`)).status).toBe(405);
    expect((await fetch(`${base}/mcp/mala`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/mcp/abc`, { method: "POST", body: "x".repeat(1_100_000) })).status).toBe(413);
  });

  it("un cuerpo de 2 MB recibe 413 (no un reset), con Content-Length o en chunks, y el servidor sigue vivo", async () => {
    const base = await levantar();
    const trozos = () => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 32; i++) c.enqueue(new Uint8Array(64 * 1024)); c.close(); } });
    for (let i = 0; i < 5; i++) {
      const conLargo = await fetch(`${base}/mcp/abc`, { method: "POST", body: "x".repeat(2_000_000) });
      expect(conLargo.status).toBe(413);
      const enChunks = await fetch(`${base}/mcp/abc`, { method: "POST", body: trozos(), duplex: "half" } as RequestInit);
      expect(enChunks.status).toBe(413);
    }
    expect((await fetch(`${base}/mcp/abc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })).status).toBe(200);
  });
});

describe("cli mcp --http", () => {
  const correr = (argv: string[], env: Record<string, string>) => {
    let err = "";
    return main(argv, { stdout: { write: () => true }, stderr: { write: (s: string) => (err += s) }, env: { MP_TICKET: "T", MERCADOPUBLICO_HOME: "/tmp/mp-http-test-nada", ...env } }).then((codigo) => ({ codigo, err }));
  };

  it("sin MP_MCP_CLAVE se niega a arrancar (código 2), también con --sin-clave fuera de localhost", async () => {
    for (const argv of [["mcp", "--http", "--host", "0.0.0.0"], ["mcp", "--http", "--sin-clave", "--host", "0.0.0.0"], ["mcp", "--http"]]) {
      const r = await correr(argv, {});
      expect(r.codigo).toBe(2);
      expect(r.err).toContain("MP_MCP_CLAVE");
    }
    expect((await correr(["mcp", "--http"], { MP_MCP_CLAVE: "" })).codigo).toBe(2);
  });

  it("MP_MCP_CLAVE de menos de 16 caracteres es error de uso", async () => {
    const r = await correr(["mcp", "--http"], { MP_MCP_CLAVE: "corta-15-chars!" });
    expect(r.codigo).toBe(2);
    expect(r.err).toMatch(/MP_MCP_CLAVE.*16 caracteres/);
  });

  it("las opciones de --http sin --http son error de uso", async () => {
    expect((await correr(["mcp", "--puerto", "9000"], {})).codigo).toBe(2);
  });
});
