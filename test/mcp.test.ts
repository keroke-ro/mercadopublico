import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { argv, servir } from "../src/mcp.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/v1/${n}.json`, import.meta.url), "utf8");
const home = mkdtempSync(join(tmpdir(), "mp-mcp-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function sesion(mensajes: unknown[], cuerpo = fixture("licitacion-detalle")) {
  let out = "";
  await servir(main, {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: () => true },
    env: { MP_TICKET: "T", MERCADOPUBLICO_HOME: home },
    fetch: async (url) => (String(url).includes("mercadopublico.cl") ? new Response(cuerpo) : new Response("", { status: 404 })),
  }, Readable.from(mensajes.map((m) => (typeof m === "string" ? m : JSON.stringify(m)) + "\n")));
  return out.trim().split("\n").map((l) => JSON.parse(l));
}

describe("mcp", () => {
  it("initialize, tools/list y tools/call sin datos personales ni raw", async () => {
    const [init, lista, detalle] = await sesion([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "licitacion", arguments: { codigo: "1509-5-LE26" } } },
    ]);
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(lista.result.tools.map((t: { name: string }) => t.name)).toContain("compra_agil");
    const texto = detalle.result.content[0].text;
    expect(detalle.result.isError).toBeUndefined();
    expect(JSON.parse(texto)).toMatchObject({ tipo: "licitacion", personales: null });
    expect(texto).not.toContain("pagos@ejemplo.invalid");
    expect(texto).not.toContain('"raw"');
  });

  it("recorta listas a max y avisa el total", async () => {
    const [r] = await sesion([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "licitaciones", arguments: { max: 1 } } }], fixture("licitaciones-listado"));
    const datos = JSON.parse(r.result.content[0].text);
    expect(datos.mostrados).toBe(1);
    expect(datos.resultados).toHaveLength(1);
    expect(datos.total).toBeGreaterThan(1);
  });

  it("errores de uso vuelven como isError y JSON roto como -32700", async () => {
    const [malo, uso, desconocido] = await sesion([
      "{no es json",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "licitaciones", arguments: { dia: "ayer" } } },
      { jsonrpc: "2.0", id: 2, method: "nada" },
    ]);
    expect(malo.error.code).toBe(-32700);
    expect(uso.result.isError).toBe(true);
    expect(uso.result.content[0].text).toContain("AAAA-MM-DD");
    expect(desconocido.error.code).toBe(-32601);
  });

  it("argv: arrays separados por coma y max solo para compra-agil", () => {
    expect(argv("compra_agil", { region: [13, 5], q: "papel", max: 10 })).toEqual(["compra-agil", "--region", "13,5", "--q", "papel", "--max", "10", "--formato", "json"]);
    expect(argv("licitaciones", { estado: "adjudicada", max: 3, otro: "x" })).toEqual(["licitaciones", "--estado", "adjudicada", "--formato", "json"]);
  });
});
