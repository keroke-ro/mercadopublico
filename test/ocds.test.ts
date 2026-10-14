import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Licitacion, OrdenCompra, Proceso } from "../src/modelo.js";
import { CAMPOS_PERSONALES_OCDS, leerOcds, urlOcds } from "../src/ocds.js";
import { OCULTO, ocultarPersonales } from "../src/personales.js";

// Línea real de OCP (docs/api-notes.md §7): OC de Convenio Marco.
const cm = readFileSync(new URL("./fixtures/ocds/release-cm.json", import.meta.url), "utf8").trim();

const licitacion = {
  ocid: "ocds-70d2nz-1000-1-LE26",
  tag: ["compiled"],
  date: "2026-01-20T18:30:00Z",
  buyer: { id: "CL-MP-1996", name: "MINISTERIO DE OBRAS PUBLICAS | Dirección de Vialidad" },
  parties: [
    {
      id: "CL-MP-1996",
      roles: ["buyer", "procuringEntity"],
      identifier: { scheme: "CL-RUT", id: "612020000" },
      additionalIdentifiers: [{ scheme: "CL-MP", id: "7248" }],
      address: { region: "Región del Biobío", locality: "Concepción" },
      contactPoint: { name: "Juana Pérez", email: "juana@example.cl", telephone: "56-41-1234567" },
    },
    { id: "CL-MP-555", roles: ["supplier"], identifier: { scheme: "CL-RUT", id: "76000000k" } },
  ],
  tender: {
    id: "1000-1-LE26",
    title: "Servicio de aseo",
    status: "complete",
    statusDetails: "8-Adjudicada",
    procurementMethodDetails: "Licitación Pública Entre 100 y 1000 UTM (LE)",
    value: { amount: 1200, currency: "CLF" },
    tenderPeriod: { startDate: "2026-01-05T09:00:00Z", endDate: "2026-01-15T15:00:00Z" },
    numberOfTenderers: 3,
    items: [
      { id: "1", description: "Aseo oficinas", quantity: 12, unit: { name: "Mes" }, classification: { scheme: "UNSPSC", id: "76111501" } },
      { id: "2", description: "Aseo bodegas", quantity: 1, unit: { name: "Mes" }, classification: { scheme: "UNSPSC", id: "76111501" } },
    ],
  },
  awards: [
    {
      id: "a1",
      date: "2026-01-18T12:00:00Z",
      suppliers: [{ id: "CL-MP-555", name: "Proveedor SpA | Juan Soto" }],
      items: [{ id: "1", quantity: 12, unit: { value: { amount: 40, currency: "CLF" } } }],
    },
  ],
};

// Trato directo dentro de un record package, como los del publisher.
const td = {
  version: "1.1",
  records: [
    {
      ocid: "ocds-70d2nz-2097-241-TD26",
      compiledRelease: {
        ocid: "ocds-70d2nz-2097-241-TD26",
        date: "2026-02-11T09:00:00Z",
        tender: { id: "2097-241-TD26", procurementMethod: "direct" },
        awards: [
          {
            date: "2026-02-10T10:00:00Z",
            title: "Arriendo de grúa",
            statusDetails: "6-Orden de Compra aceptada por el proveedor",
            value: { amount: 1000, currency: "USD" },
            suppliers: [{ id: "CL-MP-9", name: "GRUAS SA | GRUAS SA" }],
          },
        ],
      },
    },
  ],
};

const texto = [JSON.stringify(licitacion), cm, '{"ocid":"ocds-70d2nz-roto",', "", `${JSON.stringify(td)}\r`].join("\n");
const bytes = new TextEncoder().encode(texto);

function enTrozos(b: Uint8Array, n: number, alCancelar?: () => void) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= b.length) c.close();
      else c.enqueue(b.slice(i, (i += n)));
    },
    cancel: alCancelar,
  });
}

async function leer(fuente: Parameters<typeof leerOcds>[0], extra: Parameters<typeof leerOcds>[1] = {}) {
  const errores: number[] = [];
  const procesos: Proceso[] = [];
  for await (const p of leerOcds(fuente, { ...extra, alError: (_l, _e, n) => errores.push(n) })) procesos.push(p);
  return { procesos, errores };
}

describe("leerOcds", () => {
  it("lee en trozos chicos, traduce licitación, CM y TD, y salta la línea rota contándola", async () => {
    const { procesos, errores } = await leer(enTrozos(bytes, 7));
    expect(errores).toEqual([3]);
    expect(procesos.map((p) => [p.tipo, p.codigo])).toEqual([
      ["licitacion", "1000-1-LE26"],
      ["orden_compra", "1000-3-CM26"],
      ["orden_compra", "2097-241-TD26"],
    ]);

    const l = procesos[0] as Licitacion;
    expect(l).toMatchObject({
      estado: "adjudicada",
      estadoGlosa: "Adjudicada",
      tipoLicitacion: "LE",
      origen: "ocds",
      oferentes: 3,
      monto: { valor: 1200, moneda: "CLF", clp: null },
      comprador: {
        codigoOrganismo: null,
        nombreOrganismo: "MINISTERIO DE OBRAS PUBLICAS",
        nombreUnidad: "Dirección de Vialidad",
        codigoUnidad: "1996",
        rutUnidad: "61202000-0",
        region: 8,
        comuna: "Concepción",
      },
      // La Z se lee como hora de pared de Santiago.
      fechas: { publicacion: "2026-01-05T09:00:00-03:00", cierre: "2026-01-15T15:00:00-03:00", adjudicacion: "2026-01-18T12:00:00-03:00" },
      personales: {
        "parties.0.contactPoint.name": "Juana Pérez",
        "parties.0.contactPoint.email": "juana@example.cl",
        "parties.0.contactPoint.telephone": "56-41-1234567",
        "awards.0.suppliers.0.name": "Proveedor SpA | Juan Soto",
      },
    });
    expect(l.items[0]).toMatchObject({
      codigoProducto: 76111501,
      cantidad: 12,
      precioUnitario: { valor: 40, moneda: "CLF" },
      proveedor: { rut: "76000000-K", nombre: "Proveedor SpA", codigo: "555" },
    });
    expect(l.items[1]).toMatchObject({ precioUnitario: null, proveedor: null });

    const c = procesos[1] as OrdenCompra;
    expect(c).toMatchObject({
      nombre: "Adquisición de gas licuado a granel según Orden de Compra: 1000-3-CM26",
      estado: "recepcion_conforme",
      estadoGlosa: "Orden de Compra recepcionada conforme",
      tipoOrden: "CM",
      procesoOrigen: "2239-1-LR25",
      proveedor: { nombre: "ABASTIBLE S.A.", codigo: "26592" },
      comprador: { nombreUnidad: "Dirección de Vialidad - VIII Región - Provincia Bio Bio", region: null },
      fechas: { creacion: "2026-03-26T16:07:44-03:00", ultimoCambio: "2026-03-26T16:07:44-03:00" },
      monto: { valor: 269951.5, moneda: "CLP", clp: 269951.5, fechaValor: "2026-03-26", fuente: "identidad" },
      personales: null,
    });
    expect(c.items[0]).toMatchObject({ codigoProducto: null, cantidad: 698, precioUnitario: { valor: 325 }, total: { valor: 226850 } });

    expect(procesos[2]).toMatchObject({ estado: "aceptada", nombre: "Arriendo de grúa", monto: { valor: 1000, moneda: "USD", clp: null }, raw: { ocid: "ocds-70d2nz-2097-241-TD26" } });

    const oculto = ocultarPersonales(l, new Set(CAMPOS_PERSONALES_OCDS)).raw as typeof licitacion;
    expect(oculto.parties[0]!.contactPoint).toBe(OCULTO);
  });

  it("detecta gzip por los bytes mágicos aunque lleguen de a uno, y acepta Response y URL", async () => {
    const gz = gzipSync(bytes);
    const r1 = await leer(enTrozos(gz, 1));
    const r2 = await leer(new Response(gz));
    const urls: string[] = [];
    const r3 = await leer("https://ejemplo/2026.jsonl.gz", {
      fetch: async (u) => (urls.push(String(u)), new Response(gz)),
    });
    for (const r of [r1, r2, r3]) {
      expect(r.procesos.map((p) => p.codigo)).toEqual(["1000-1-LE26", "1000-3-CM26", "2097-241-TD26"]);
      expect(r.errores).toEqual([3]);
    }
    expect(urls).toEqual(["https://ejemplo/2026.jsonl.gz"]);
  });

  it("cancela la descarga si el consumidor deja de leer", async () => {
    let cancelado = false;
    for await (const _ of leerOcds(enTrozos(bytes, 64, () => (cancelado = true)))) break;
    expect(cancelado).toBe(true);
  });

  it("falla si la descarga responde error", async () => {
    await expect(leer("https://x", { fetch: async () => new Response("", { status: 404 }) })).rejects.toMatchObject({ tipo: "no_encontrado" });
  });

  it("urlOcds apunta al espejo de OCP", () => {
    expect(urlOcds(2026)).toBe("https://data.open-contracting.org/en/publication/144/download?name=2026.jsonl.gz");
    expect(urlOcds("full")).toContain("name=full.jsonl.gz");
  });
});
