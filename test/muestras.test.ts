// Corpus de respuestas reales anonimizadas (scripts/muestras.ts → test/fixtures/muestras). Cada muestra pasa por el parser
// público: nunca lanza, cumple invariantes del modelo y queda en un snapshot (sin `raw`) para que todo cambio del parser
// se vea como diff en test/__snapshots__/muestras/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codigos, parseCompraAgil, parseLicitacion, parseOrdenCompra, type Proceso } from "../src/index.js";

const dir = new URL("./fixtures/muestras/", import.meta.url);
const leer = (rel: string) => JSON.parse(readFileSync(new URL(rel, dir), "utf8"));
const archivos = (sub: string) => (existsSync(new URL(sub, dir)) ? readdirSync(new URL(sub, dir)).filter((f) => f.endsWith(".json") && f !== "listado-p1.json").map((f) => sub + f) : []);

type Caso = { archivo: string; raw: Record<string, unknown>; parse: () => Proceso };
const casos: Caso[] = [
  ...archivos("v1/licitaciones/").map((archivo) => {
    const raw = leer(archivo).Listado[0];
    return { archivo, raw, parse: () => parseLicitacion(raw) };
  }),
  ...archivos("v1/ordenes/").map((archivo) => {
    const raw = leer(archivo).Listado[0];
    return { archivo, raw, parse: () => parseOrdenCompra(raw) };
  }),
  ...archivos("v2/").map((archivo) => {
    const raw = leer(archivo).payload;
    return { archivo, raw, parse: () => parseCompraAgil(raw, { detalle: true }) };
  }),
];

const ESTADOS = new Set<string>([
  ...Object.values(codigos.ESTADO_LICITACION).map((e) => e[0]),
  ...Object.values(codigos.ESTADO_OC).map((e) => e[0]),
  ...["publicada", "cerrada", "desierta", "cancelada", "proveedor_seleccionado", "oc_emitida"],
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
const sinRaw = ({ raw: _, ...p }: Proceso) => p;

/** Todos los objetos con forma de Monto dentro del proceso parseado. */
function montos(x: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(x)) for (const v of x) montos(v, out);
  else if (x && typeof x === "object") {
    if ("valor" in x && "moneda" in x) out.push(x as Record<string, unknown>);
    else for (const v of Object.values(x)) montos(v, out);
  }
  return out;
}

const enRuta = (raw: unknown, ruta: string) => ruta.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), raw);

describe.runIf(casos.length)("muestras reales", () => {
  it.each(casos)("$archivo", async ({ archivo, raw, parse }) => {
    let p!: Proceso;
    expect(() => (p = parse())).not.toThrow();

    expect(p.codigo).toBe(archivo.split("/").pop()!.replace(/\.json$/, ""));

    // Estado conocido; si no, la glosa es el texto que mandó la API.
    if (!ESTADOS.has(p.estado)) expect(p.estadoGlosa).toBe(String(raw.Estado ?? (raw.estado as { glosa?: string } | undefined)?.glosa ?? null));

    for (const [k, f] of Object.entries(p.fechas)) expect(f === null || ISO.test(f), `fechas.${k} = ${f}`).toBe(true);

    for (const m of montos(sinRaw(p))) {
      expect(Number.isFinite(m.valor), JSON.stringify(m)).toBe(true);
      if (m.moneda === "CLP") expect(m.clp).toBe(m.valor);
      else expect(m.clp, `sin convertir: ${JSON.stringify(m)}`).toBeNull();
    }

    // UNSPSC tiene 8 dígitos; el MOP (O1) usa su propio catálogo de 9 (p. ej. 101101001).
    // Convenio Marco manda CodigoProducto 0: debe quedar null.
    for (const i of p.items) expect(i.codigoProducto === null || /^\d{8,9}$/.test(String(i.codigoProducto)), `codigoProducto ${i.codigoProducto}`).toBe(true);

    for (const ruta of Object.keys(p.personales ?? {})) expect(enRuta(raw, ruta), ruta).toBeDefined();

    await expect(`${JSON.stringify(sinRaw(p), null, 2)}\n`).toMatchFileSnapshot(`./__snapshots__/muestras/${p.codigo}.json`);
  });

  // Hallazgo del corpus, ya resuelto (regresión en test/avisos.test.ts).
  const adjudicadas = casos.filter((c) => c.archivo.includes("/licitaciones/") && JSON.stringify(c.raw).includes('"MontoUnitario"'));
  it.runIf(adjudicadas.length)("total del ítem adjudicado: la API manda Items.Listado[].Adjudicacion.Cantidad (no CantidadAdjudicada)", () => {
    for (const c of adjudicadas) for (const i of c.parse().items) if (i.precioUnitario) expect(i.total, c.archivo).not.toBeNull();
  });
});
