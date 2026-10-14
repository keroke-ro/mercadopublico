// Fixtures grabados de la API real (npm run fixtures:grabar), anonimizados. Si no existen, se saltan.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Aviso } from "../src/eventos.js";
import { parseLicitacion, parseOrdenCompra } from "../src/v1/parse.js";
import { parseCompraAgil } from "../src/v2/parse.js";

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

const rutaV2 = (n: string) => new URL(`./fixtures/v2/${n}.real.json`, import.meta.url);

describe.runIf(existsSync(rutaV2("detalle")))("fixtures reales v2", () => {
  const leerV2 = (n: string) => JSON.parse(readFileSync(rutaV2(n), "utf8")).payload;

  it("listado y detalle: fechas sin T ni zona salen en hora de Santiago y no hay avisos", () => {
    const avisos: Aviso[] = [];
    const avisar = (a: Aviso) => avisos.push(a);
    for (const raw of leerV2("listado-p1").items) {
      const ca = parseCompraAgil(raw, { detalle: false, avisar });
      expect(ca.fechas.publicacion).toMatch(/T\d{2}:\d{2}:00-0[34]:00$/);
      expect(ca.fechas.publicacion!.slice(11, 16)).toBe(raw.fechas.fecha_publicacion.slice(11, 16)); // la hora de pared no se mueve
    }
    const d = parseCompraAgil(leerV2("detalle"), { detalle: true, avisar });
    expect(d.fechas.cierre).not.toBeNull();
    expect(avisos).toEqual([]);
  });

  it("OC en la raíz y selección como 0/1, como los manda la API real", () => {
    const d = parseCompraAgil(
      { ...leerV2("detalle"), id_orden_compra: 54184770, proveedores_cotizando: [{ monto_total: 1, proveedor_seleccionado: 1 }, { monto_total: 2, proveedor_seleccionado: 0 }] },
      { detalle: true },
    );
    expect(d.ordenCompra).toBe("54184770");
    expect(d.cotizaciones.map((c) => c.seleccionada)).toEqual([true, false]);
  });
});
