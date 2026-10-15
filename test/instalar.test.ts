import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { conServidor, corta, entradaMcp, leerConfig, monto, perfilDesde, rutasClientes } from "../src/instalar.js";

const dirs: string[] = [];
const temporal = () => dirs[dirs.push(mkdtempSync(join(tmpdir(), "mp-init-"))) - 1]!;
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("instalador: piezas puras", () => {
  it("conServidor agrega o reemplaza mercadopublico sin tocar lo demás, y no pisa un JSON roto", () => {
    const entrada = { command: "npx", args: ["-y", "mercadopublico", "mcp"] };
    expect(JSON.parse(conServidor(null, entrada))).toEqual({ mcpServers: { mercadopublico: entrada } });
    const antes = JSON.stringify({ globalShortcut: "x", mcpServers: { otro: { command: "a" }, mercadopublico: { command: "viejo" } } });
    expect(JSON.parse(conServidor(antes, entrada))).toEqual({ globalShortcut: "x", mcpServers: { otro: { command: "a" }, mercadopublico: entrada } });
    expect(() => conServidor("{ roto", entrada)).toThrow();
    expect(() => conServidor("[]", entrada)).toThrow();
  });

  it("entradaMcp usa el npx junto a node con su PATH (apps de escritorio sin el PATH de la terminal), salvo en Windows", () => {
    expect(entradaMcp("darwin", "/Users/a/.nvm/versions/node/v22/bin/node", () => true)).toEqual({
      command: "/Users/a/.nvm/versions/node/v22/bin/npx",
      args: ["-y", "mercadopublico", "mcp"],
      env: { PATH: "/Users/a/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin" },
    });
    expect(entradaMcp("darwin", "/usr/local/bin/node", () => true).env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin" });
    expect(entradaMcp("darwin", "/x/node", () => false)).toEqual({ command: "npx", args: ["-y", "mercadopublico", "mcp"] });
    expect(entradaMcp("win32", "C:\\node\\node.exe", () => true).command).toBe("npx");
  });

  it("rutasClientes por plataforma", () => {
    expect(rutasClientes("darwin", "/h", {})["claude-desktop"]).toBe("/h/Library/Application Support/Claude/claude_desktop_config.json");
    expect(rutasClientes("linux", "/h", { XDG_CONFIG_HOME: "/c" })["claude-desktop"]).toBe("/c/Claude/claude_desktop_config.json");
    expect(rutasClientes("win32", "/h", { APPDATA: "/ad" })["claude-desktop"]).toContain(join("/ad", "Claude"));
    expect(rutasClientes("linux", "/h", {}).cursor).toBe("/h/.cursor/mcp.json");
  });

  it("monto entiende cómo escribe la gente; lo que no es monto es NaN", () => {
    expect(monto("200.000")).toBe(200_000);
    expect(monto("$1.500.000")).toBe(1_500_000);
    expect(monto("5 millones")).toBe(5_000_000);
    expect(monto("2,5M")).toBe(2_500_000);
    expect(monto("")).toBeUndefined();
    expect(monto("mucho")).toBeNaN();
  });

  it("perfilDesde apaga los pesos de lo que no se contestó", () => {
    const p = perfilDesde({ rubros: ["4213"], regiones: [], capacidad: 3 });
    expect(p).toEqual({ pesos: { rubro: 3, region: 0, monto: 0, diasAlCierre: 2, competencia: 1, incumbente: 2 }, rubros: ["4213"], capacidad: 3 });
    expect(perfilDesde({ rubros: ["43"], regiones: [13], montoMax: 1, rut: "76.123.456-7", capacidad: 5 })).toMatchObject({ pesos: { region: 1, monto: 2 }, regiones: [13], montoMax: 1, rut: "76.123.456-7" });
  });

  it("corta abrevia el home", () => {
    expect(corta("/h/.mercadopublico/perfil.json", "/h")).toBe("~/.mercadopublico/perfil.json");
    expect(corta("/otro/x", "/h")).toBe("/otro/x");
  });
});

describe("cli con config.json", () => {
  it("usa el ticket, el store y el perfil que guardó init; MP_TICKET y los flags mandan", async () => {
    const home = temporal();
    const store = join(home, "mp.json");
    writeFileSync(join(home, "perfil.json"), JSON.stringify({ pesos: { region: 1 } }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ ticket: "T-GUARDADO", store, perfil: join(home, "perfil.json") }));
    const urls: string[] = [];
    let err = "";
    const io = (env: Record<string, string>) => ({
      stdout: { write: () => true },
      stderr: { write: (s: string) => ((err += s), true) },
      env: { MERCADOPUBLICO_HOME: home, ...env },
      fetch: async (u: unknown) => (urls.push(String(u)), new Response(JSON.stringify({ Cantidad: 0, Listado: [] }))),
    });
    expect(await main(["licitacion", "1509-5-L114", "--formato", "json"], io({}))).toBe(1); // no existe, pero llamó con el ticket guardado
    expect(urls.at(-1)).toContain("ticket=T-GUARDADO");
    await main(["licitacion", "1509-5-L114", "--formato", "json"], io({ MP_TICKET: "T-ENV" }));
    expect(urls.at(-1)).toContain("ticket=T-ENV");

    // radar sin flags: perfil y store de config.json
    expect(await main(["radar"], io({}))).toBe(2);
    expect(err).toContain(`El store ${store} está vacío`);
  });

  it("config.json roto da un error claro; config.json se lee aunque no exista", async () => {
    const home = temporal();
    expect(await leerConfig(join(home, "no-existe"))).toEqual({});
    mkdirSync(join(home, "h"));
    writeFileSync(join(home, "h", "config.json"), "{ roto");
    await expect(leerConfig(join(home, "h"))).rejects.toThrow("no es JSON válido");
  });

  it("init con argumentos de más es error de uso", async () => {
    let err = "";
    expect(await main(["init", "x"], { stdout: { write: () => true }, stderr: { write: (s: string) => ((err += s), true) }, env: { MERCADOPUBLICO_HOME: temporal() } })).toBe(2);
    expect(err).toContain("Sobran argumentos");
  });
});

