import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/v1/${n}.json`, import.meta.url), "utf8");

async function correr(argv: string[], { env = { MP_TICKET: "T-SECRETO" } as Record<string, string>, cuerpo = fixture("licitacion-detalle") } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mp-cli-"));
  let out = "";
  let err = "";
  const urls: string[] = [];
  const codigo = await main(argv, {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    env: { ...env, MERCADOPUBLICO_HOME: home },
    fetch: async (url) => {
      urls.push(String(url));
      return String(url).includes("mercadopublico.cl") ? new Response(cuerpo) : new Response("", { status: 404 });
    },
  });
  return { codigo, out, err, urls, home };
}

describe("cli", () => {
  it("oculta datos personales por defecto y los muestra con --incluir-personales", async () => {
    const oculto = await correr(["licitacion", "1509-5-LE26"]);
    expect(oculto.codigo).toBe(0);
    expect(oculto.out).not.toContain("pagos@ejemplo.invalid");
    expect(oculto.out).toContain("[oculto]");
    expect(JSON.parse(oculto.out).personales).toBeNull();

    const visible = await correr(["licitacion", "1509-5-LE26", "--incluir-personales"]);
    expect(visible.out).toContain("pagos@ejemplo.invalid");
  });

  it("csv con comillas RFC 4180", async () => {
    const cuerpo = JSON.stringify({ Cantidad: 1, Listado: [{ CodigoExterno: "1-1-L1", Nombre: 'Compra de "papel", lápices', CodigoEstado: 5 }] });
    const { codigo, out } = await correr(["licitaciones", "--formato", "csv"], { cuerpo });
    expect(codigo).toBe(0);
    const [cabecera, fila] = out.split("\r\n");
    expect(cabecera).toBe("tipo,codigo,nombre,estado,comprador.nombreOrganismo,comprador.region,fechas.publicacion,fechas.cierre,monto.valor,monto.moneda,monto.clp");
    expect(fila).toContain('1-1-L1,"Compra de ""papel"", lápices",publicada');
  });

  it("guarda la cuota entre ejecuciones y nunca el ticket", async () => {
    const r = await correr(["licitaciones", "--sin-conversion"], { cuerpo: fixture("licitaciones-listado") });
    const guardada = readFileSync(join(r.home, "cuota.json"), "utf8");
    expect(JSON.parse(guardada)).toMatchObject({ usadas: 1 });
    expect(guardada).not.toContain("T-SECRETO");
  });

  it("sin ticket: error claro", async () => {
    const { codigo, err } = await correr(["licitaciones"], { env: {} });
    expect(codigo).toBe(2);
    expect(err).toContain("MP_TICKET");
  });

  it("error de uso: exit 2", async () => {
    expect((await correr(["nada"])).codigo).toBe(2);
    expect((await correr(["licitaciones", "--opcion-inventada"])).codigo).toBe(2);
    expect((await correr(["licitaciones", "--dia", "13-10-2026"])).codigo).toBe(2);
  });

  it("error de la API: una línea, exit 1, sin stack", async () => {
    const { codigo, err } = await correr(["oc", "X"], { cuerpo: fixture("error-10300") });
    expect(codigo).toBe(1);
    expect(err.trim().split("\n")).toHaveLength(1);
  });
});
