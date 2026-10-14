import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MercadoPublico, ocultarPersonales } from "../src/index.js";
import { OCULTO } from "../src/personales.js";

const fixture = readFileSync(new URL("./fixtures/v1/licitacion-detalle.json", import.meta.url), "utf8");

describe("datos personales", () => {
  it("el SDK los entrega marcados y ocultarPersonales los tapa en personales y en raw", async () => {
    const mp = new MercadoPublico({ ticket: "T", conversor: false, fetch: async () => new Response(fixture) });
    const lic = (await mp.licitaciones.porCodigo("x"))!;
    expect(lic.personales?.["Comprador.NombreUsuario"]).toBe("Funcionaria De Prueba");

    const limpia = ocultarPersonales(lic);
    expect(limpia.personales).toBeNull();
    const texto = JSON.stringify(limpia);
    expect(texto).not.toContain("Funcionaria De Prueba");
    expect(texto).not.toContain("11.111.111-1");
    expect(texto).toContain(OCULTO);
    // No toca lo que no es personal ni muta el original.
    expect(limpia.nombre).toBe(lic.nombre);
    expect(JSON.stringify(lic)).toContain("Funcionaria De Prueba");
  });
});
