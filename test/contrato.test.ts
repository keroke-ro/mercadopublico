import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comparar, forma, reporte } from "../scripts/contrato.js";

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("contrato: forma y diferencias", () => {
  it("colapsa arreglos, ignora _fixture y una forma idéntica no difiere", () => {
    const f = forma({ _fixture: "x", a: [{ b: 1 }, { b: "2", c: null }], d: [] });
    expect([...f.keys()]).toEqual(["$", "$.a", "$.a[]", "$.a[].b", "$.a[].c", "$.d"]);
    expect([...f.get("$.a[].b")!]).toEqual(["number", "string"]);
    const lic = fixture("v1/licitacion-detalle");
    expect(comparar(forma(lic), forma({ ...lic, _fixture: undefined }))).toEqual({ agregados: [], eliminados: [], cambiados: [] });
  });

  it("detecta campos agregados, eliminados y tipos cambiados", () => {
    const antes = forma({ Listado: [{ Codigo: "1", Monto: 10, Viejo: "x", Comprador: { Rut: "1" } }] });
    const ahora = forma({ Listado: [{ Codigo: "1", Monto: "10", Nuevo: { a: 1 }, Comprador: { Rut: "1" } }] });
    expect(comparar(antes, ahora)).toEqual({
      agregados: ["$.Listado[].Nuevo"],
      eliminados: ["$.Listado[].Viejo"],
      cambiados: [{ ruta: "$.Listado[].Monto", antes: ["number"], ahora: ["string"] }],
    });
  });

  it("no da falsas alarmas por null ni por arreglos vacíos", () => {
    const antes = forma({ Fecha: "2026-01-01", Comprador: { Rut: "1" }, Items: [{ x: 1 }], Opcional: null });
    const ahora = forma({ Fecha: null, Comprador: null, Items: [], Opcional: 3 });
    expect(comparar(antes, ahora)).toEqual({ agregados: [], eliminados: [], cambiados: [] });
  });

  it("reporte en markdown", () => {
    const md = reporte([
      { nombre: "v1 OC detalle", d: { agregados: ["$.a"], eliminados: [], cambiados: [{ ruta: "$.b", antes: ["number"], ahora: ["string"] }] } },
      { nombre: "v2 Compra Ágil listado", error: "HTTP 500" },
      { nombre: "v1 BuscarComprador", d: { agregados: [], eliminados: [], cambiados: [] } },
    ]);
    expect(md).toContain("- agregado: `$.a`");
    expect(md).toContain("- tipo cambiado: `$.b` (number → string)");
    expect(md).toContain("Error: HTTP 500");
    expect(md).not.toContain("BuscarComprador");
    expect(reporte([])).toContain("Sin diferencias.");
  });
});
