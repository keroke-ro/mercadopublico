import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storeArchivo } from "../src/store.js";
import { parseLicitacion } from "../src/v1/parse.js";

const lic = (codigo: string) => parseLicitacion({ CodigoExterno: codigo, Nombre: codigo, CodigoEstado: 5 });
const dir = () => mkdtempSync(join(tmpdir(), "mp-store-"));

describe("storeArchivo", () => {
  it("persiste procesos y cursor juntos, y se relee igual", async () => {
    const ruta = join(dir(), "mp.json");
    const s = await storeArchivo(ruta);
    await s.guardarConCursor!([lic("A")], "licitaciones", "2026-06-01");
    await s.guardar([lic("B")]);
    await s.cerrar!();
    const t = await storeArchivo(ruta);
    expect((await t.obtener("A"))?.codigo).toBe("A");
    expect((await t.obtener("B"))?.codigo).toBe("B");
    expect(await t.cursor("licitaciones")).toBe("2026-06-01");
    await t.cerrar!();
  });

  it("un segundo proceso no puede abrir el mismo store; tras cerrar sí", async () => {
    const ruta = join(dir(), "mp.json");
    const s = await storeArchivo(ruta);
    const lock = JSON.parse(readFileSync(`${ruta}.lock`, "utf8"));
    expect(lock).toMatchObject({ pid: process.pid, host: hostname() });
    await expect(storeArchivo(ruta)).rejects.toThrow(/en uso por otro proceso/);
    await s.cerrar!();
    expect(existsSync(`${ruta}.lock`)).toBe(false);
    await expect(s.guardar([lic("A")])).rejects.toThrow(/cerró/);
    await (await storeArchivo(ruta)).cerrar!();
  });

  it("roba un lock de un proceso muerto o que dejó de renovarlo", async () => {
    const ruta = join(dir(), "mp.json");
    const muerto = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(`${ruta}.lock`, JSON.stringify({ pid: muerto, host: hostname(), desde: "2026-01-01T00:00:00Z" }));
    await (await storeArchivo(ruta)).cerrar!();

    writeFileSync(`${ruta}.lock`, JSON.stringify({ pid: process.pid, host: "otra-maquina" }));
    await expect(storeArchivo(ruta)).rejects.toThrow(/en uso/);
    const viejo = new Date(Date.now() - 11 * 60_000);
    utimesSync(`${ruta}.lock`, viejo, viejo);
    await (await storeArchivo(ruta)).cerrar!();
  });

  it("un archivo dañado se aparta y falla con un mensaje claro, sin partir vacío en silencio", async () => {
    const d = dir();
    const ruta = join(d, "mp.json");
    writeFileSync(ruta, '{"procesos": {"A": ');
    await expect(storeArchivo(ruta)).rejects.toThrow(/dañado.*corrupto-/);
    const aparte = readdirSync(d).filter((f) => f.startsWith("mp.json.corrupto-"));
    expect(aparte).toHaveLength(1);
    expect(readFileSync(join(d, aparte[0]!), "utf8")).toBe('{"procesos": {"A": ');
    expect(existsSync(ruta)).toBe(false);
    expect(existsSync(`${ruta}.lock`)).toBe(false);

    writeFileSync(ruta, "[]"); // JSON válido pero no es un store
    await expect(storeArchivo(ruta)).rejects.toThrow(/dañado/);
  });
});
