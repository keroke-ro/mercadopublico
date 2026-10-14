import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MercadoPublico, desdeOcds, ocultarPersonales } from "../src/index.js";
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

  it("en OCDS tapa en raw los nombres y RUT de persona natural que el parser anotó, no los de empresas", () => {
    const juan = { id: "CL-MP-1", name: "JUAN PEREZ SOTO | JUAN PEREZ SOTO" };
    const andes = { id: "CL-MP-2", name: "COMERCIAL ANDES | COMERCIAL ANDES" };
    const [p] = desdeOcds({
      ocid: "ocds-70d2nz-1-1-LE26",
      parties: [
        { ...juan, roles: ["supplier", "tenderer"], identifier: { scheme: "CL-RUT", id: "123456785", legalName: "JUAN PEREZ SOTO" } },
        { ...andes, roles: ["tenderer"], identifier: { scheme: "CL-RUT", id: "760000001" } },
        { id: "CL-MP-3", name: "Proveedor SpA | Juana Díaz", roles: ["tenderer"], identifier: { scheme: "CL-RUT", id: "770000002" } },
      ],
      tender: { id: "1-1-LE26", tenderers: [andes, juan, { id: "CL-MP-3", name: "Proveedor SpA | Juana Díaz" }] },
      awards: [{ id: "a", suppliers: [juan] }],
    });
    expect(Object.keys(p!.personales ?? {})).toContain("tender.tenderers.1.name");
    const texto = JSON.stringify(ocultarPersonales(p!).raw);
    for (const x of ["JUAN PEREZ", "123456785", "Juana Díaz"]) expect(texto).not.toContain(x);
    expect(texto).toContain("COMERCIAL ANDES");
    expect(texto).toContain("760000001");
    expect(texto).toContain("770000002"); // la empresa con sucursal a nombre de persona conserva su RUT
  });
});

describe("texto libre", () => {
  it("tapa correos y teléfonos chilenos sin tocar códigos, montos ni fechas", async () => {
    const { taparTextoLibre } = await import("../src/personales.js");
    const t = "CONTACTO BODEGA: Fulana:  226126832, fulana.tal@redsalud.gob.cl / +56 9 8765 4321 / 912345678";
    expect(taparTextoLibre(t)).toBe("CONTACTO BODEGA: Fulana:  [oculto], [oculto] / [oculto] / [oculto]");
    const seguro = "ID:1002772-2662-COT26,(AG,TRANSV,2204005003,APG) monto 1200000 el 2026-10-14 RUT 61.608.205-1";
    expect(taparTextoLibre(seguro)).toBe(seguro);
  });
});
