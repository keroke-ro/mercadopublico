// Generadores y verificadores compartidos por las propiedades.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { expect } from "vitest";
import type { Monto, Proceso } from "../../src/modelo.js";

const leer = (r: string) => JSON.parse(readFileSync(new URL(`../fixtures/${r}`, import.meta.url), "utf8"));
export const v1 = (n: string) => leer(`v1/${n}.json`).Listado[0] as unknown;
export const v2Detalle = () => leer("v2/detalle.json").payload as unknown;
export const v2Listado = () => leer("v2/listado-p1.json").payload.items[0] as unknown;
export const ocdsCm = () => leer("ocds/release-cm.json") as unknown;

/** Licitación OCDS con parties, tenderers y awards (la misma forma que test/ocds.test.ts). */
export const ocdsLicitacion = (): unknown => ({
  ocid: "ocds-70d2nz-1000-1-LE26",
  tag: ["compiled"],
  date: "2026-01-20T18:30:00Z",
  buyer: { id: "CL-MP-1996", name: "MINISTERIO DE OBRAS PUBLICAS | Dirección de Vialidad" },
  parties: [
    {
      id: "CL-MP-1996",
      roles: ["buyer"],
      identifier: { scheme: "CL-RUT", id: "612020000" },
      address: { region: "Región del Biobío", locality: "Concepción" },
      contactPoint: { name: "Juana Pérez", email: "juana@example.cl", telephone: "56-41-1234567" },
    },
    { id: "CL-MP-555", roles: ["supplier"], name: "Juan Soto", identifier: { scheme: "CL-RUT", id: "123456785", legalName: "Juan Soto" } },
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
    tenderers: [{ id: "CL-MP-555", name: "Juan Soto | Juan Soto" }],
    items: [{ id: "1", description: "Aseo oficinas", quantity: 12, unit: { name: "Mes" }, classification: { scheme: "UNSPSC", id: "76111501" } }],
  },
  awards: [
    {
      id: "a1",
      date: "2026-01-18T12:00:00Z",
      status: "active",
      suppliers: [{ id: "CL-MP-555", name: "Juan Soto | Juan Soto" }],
      items: [{ id: "1", quantity: 12, unit: { value: { amount: 40, currency: "CLF" } } }],
    },
  ],
});

/** Hora de pared plausible (1970–2100, donde Santiago siempre está en -03 o -04), con o sin Z/offset/fracción. */
export const fechaTexto = fc
  .tuple(
    fc.date({ min: new Date("1970-01-02T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z"), noInvalidDate: true }),
    fc.constantFrom("", "Z", "-03:00", ".567", ".0310349Z"),
    fc.boolean(),
  )
  .map(([d, cola, soloDia]) => (soloDia ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 19) + cola));

type Cambio = { valor: unknown } | { borrar: true } | { tipo: true };
const cambio: fc.Arbitrary<Cambio> = fc.oneof(
  fc.constant<Cambio>({ borrar: true }),
  fc.constant<Cambio>({ tipo: true }),
  fc
    .oneof(
      fc.constantFrom<unknown>(null, "", " ", 0, -1, 4.5, 1e308, -1e308, Number.MAX_SAFE_INTEGER, "1.234,5", "NaN", "Infinity", "toString", "__proto__", [], {}),
      fc.string({ unit: "grapheme", maxLength: 12 }),
      fc.string({ unit: "binary", maxLength: 6 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.jsonValue({ maxDepth: 2 }),
      fechaTexto,
    )
    .map((valor) => ({ valor })),
);

/** Rutas a todos los nodos (claves de objetos e índices de listas). */
function rutas(x: unknown, base: (string | number)[] = [], out: (string | number)[][] = []) {
  if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      const r = [...base, Array.isArray(x) ? Number(k) : k];
      out.push(r);
      rutas(v, r, out);
    }
  return out;
}

const cambiarTipo = (v: unknown): unknown =>
  typeof v === "number" ? String(v) : typeof v === "string" ? (Number.isFinite(Number(v)) && v.trim() ? Number(v) : 7) : v === null ? true : typeof v === "boolean" ? String(v) : Array.isArray(v) ? v[0] ?? "x" : JSON.stringify(v);

/** La base con 1 a 8 cambios: borrar claves, cambiar tipos, nulls, vacíos, números enormes, unicode, fechas. */
export function mutado(base: () => unknown): fc.Arbitrary<unknown> {
  return fc.array(fc.tuple(fc.nat(), cambio), { minLength: 1, maxLength: 8 }).map((cambios) => {
    const x = base();
    for (const [i, c] of cambios) {
      const rs = rutas(x);
      if (!rs.length) break;
      const r = rs[i % rs.length]!;
      const padre = r.slice(0, -1).reduce<any>((o, k) => o[k], x);
      const k = r[r.length - 1]!;
      if ("borrar" in c) Array.isArray(padre) ? padre.splice(k as number, 1) : delete padre[k];
      else padre[k] = "tipo" in c ? cambiarTipo(padre[k]) : c.valor;
    }
    return x;
  });
}

export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[34]:00$/;
const MONEDAS = ["CLP", "CLF", "UTM", "USD", "EUR"];

function montoOk(m: Monto | null) {
  if (m === null) return;
  expect(Number.isFinite(m.valor)).toBe(true);
  expect(MONEDAS).toContain(m.moneda);
  if (m.moneda === "CLP") expect(m.clp).toBe(m.valor);
  else expect(m.clp).toBeNull();
}

const nulOStr = (x: unknown) => expect(x === null || typeof x === "string").toBe(true);
const nulOFinito = (x: unknown) => expect(x === null || (typeof x === "number" && Number.isFinite(x))).toBe(true);
const codigoOk = (x: unknown) => expect(x === null || (Number.isSafeInteger(x) && (x as number) > 0)).toBe(true);

/** Ningún string del modelo (fuera de raw) es la conversión de un objeto. */
function sinObjetos(x: unknown): void {
  if (typeof x === "string") expect(x).not.toContain("[object ");
  else if (x && typeof x === "object") for (const v of Object.values(x)) sinObjetos(v);
}

/** Un Proceso bien formado: campos obligatorios con su tipo, fechas ISO con offset de Santiago, montos sanos. */
export function bienFormado(p: Proceso, raw: unknown) {
  expect(p.raw).toBe(raw);
  expect(typeof p.codigo).toBe("string");
  expect(typeof p.nombre).toBe("string");
  expect(typeof p.estado).toBe("string");
  expect(p.estado.length).toBeGreaterThan(0);
  nulOStr(p.descripcion);
  nulOStr(p.estadoGlosa);
  expect(["v1", "v2", "ocds"]).toContain(p.origen);
  expect(Object.keys(p.fechas).sort()).toEqual(["adjudicacion", "cierre", "creacion", "publicacion", "ultimoCambio"]);
  for (const f of Object.values(p.fechas)) if (f !== null) expect(f).toMatch(ISO);
  montoOk(p.monto);
  expect(p.oferentes === null || (Number.isSafeInteger(p.oferentes) && p.oferentes >= 0)).toBe(true);
  if (p.comprador) {
    const r = p.comprador.region;
    expect(r === null || (Number.isInteger(r) && r >= 1 && r <= 16)).toBe(true);
    for (const k of ["codigoOrganismo", "nombreOrganismo", "rutUnidad", "codigoUnidad", "nombreUnidad", "comuna"] as const) nulOStr(p.comprador[k]);
  }
  expect(Array.isArray(p.items)).toBe(true);
  for (const i of p.items) {
    codigoOk(i.codigoProducto);
    nulOFinito(i.cantidad);
    nulOStr(i.nombre);
    nulOStr(i.descripcion);
    nulOStr(i.unidad);
    montoOk(i.precioUnitario);
    montoOk(i.total);
  }
  if (p.personales !== null) for (const v of Object.values(p.personales)) expect(typeof v).toBe("string");
  if (p.tipo === "compra_agil")
    for (const c of p.cotizaciones) {
      montoOk(c.monto);
      expect(typeof c.seleccionada).toBe("boolean");
      for (const pr of c.productos) {
        codigoOk(pr.codigoProducto);
        nulOFinito(pr.cantidad);
        montoOk(pr.precioUnitario);
      }
    }
  sinObjetos({ ...p, raw: null });
}
