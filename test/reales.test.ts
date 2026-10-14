// Fixtures grabados de la API real (npm run fixtures:grabar), anonimizados. Si no existen, se saltan.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLicitacion, parseOrdenCompra } from "../src/v1/parse.js";

const ruta = (n: string) => new URL(`./fixtures/v1/${n}.real.json`, import.meta.url);
const leer = (n: string) => JSON.parse(readFileSync(ruta(n), "utf8")).Listado[0];

describe.runIf(existsSync(ruta("licitacion-detalle")))("fixtures reales v1", () => {
  it("licitación: comprador, región, fechas con offset, ítems UNSPSC y personales marcados", () => {
    const l = parseLicitacion(leer("licitacion-detalle"));
    expect(l.codigo).toMatch(/-L[A-Z0-9]\d{2}$/);
    expect(l.comprador?.region).toBeGreaterThan(0);
    expect(l.fechas.publicacion).toMatch(/T\d{2}:\d{2}:\d{2}-0[34]:00$/);
    expect(l.items.length).toBeGreaterThan(0);
    expect(l.items.every((i) => (i.codigoProducto ?? 0) > 10_000_000)).toBe(true);
    expect(Object.keys(l.personales ?? {})).toContain("Comprador.NombreUsuario");
  });

  it("OC: el total del ítem se calcula cuando la API lo manda en 0 y el origen sale del nombre", () => {
    const o = parseOrdenCompra(leer("oc-detalle"));
    for (const i of o.items) if (i.precioUnitario && i.cantidad) expect(i.total?.valor).toBe(i.precioUnitario.valor * i.cantidad);
    if (o.tipoOrden === "AG") expect(o.procesoOrigen).toMatch(/-COT\d{2}$/);
    expect(o.monto?.clp).toBeGreaterThan(0);
  });
});
