import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompraAgil, Licitacion, Monto } from "../src/modelo.js";
import {
  type Conversor,
  conversorEncadenado,
  conversorMindicador,
  conversorParidadChileCompra,
  convertirMontos,
} from "../src/monto.js";

afterEach(() => vi.useRealTimers());

/** fetch falso: responde según el final de la URL y anota cada llamada. */
function falso(rutas: Record<string, unknown>) {
  const llamadas: string[] = [];
  const fetch: typeof globalThis.fetch = async (u) => {
    const url = String(u);
    llamadas.push(url);
    const k = Object.keys(rutas).find((r) => url.endsWith(r));
    const v = k === undefined ? undefined : rutas[k];
    if (v instanceof Error) throw v;
    if (v === undefined) return new Response("", { status: 404 });
    return new Response(typeof v === "string" ? v : JSON.stringify(v));
  };
  return { fetch, llamadas };
}

// mindicador entrega la medianoche de Santiago en UTC (horario de verano: 03:00Z).
const serie = (...pares: [string, number][]) => ({ serie: pares.map(([d, valor]) => ({ fecha: `${d}T03:00:00.000Z`, valor })) });

describe("conversorMindicador", () => {
  it("en fin de semana usa el último día hábil e informa esa fecha", async () => {
    const { fetch } = falso({ "/dolar/2026": serie(["2026-10-08", 940], ["2026-10-09", 947.5]) });
    const c = conversorMindicador({ fetch });
    expect(await c("USD", "2026-10-11")).toEqual({ valor: 947.5, fechaValor: "2026-10-09", fuente: "mindicador.cl" });
  });

  it("pide un año por moneda y lo reutiliza, también al cruzar al año anterior", async () => {
    const { fetch, llamadas } = falso({ "/uf/2026": serie(["2026-01-05", 39800]), "/uf/2025": serie(["2025-12-31", 39727.08]) });
    const c = conversorMindicador({ fetch });
    await Promise.all([c("CLF", "2026-01-02"), c("CLF", "2026-01-02"), c("CLF", "2026-01-05")]);
    expect(await c("CLF", "2026-01-01")).toMatchObject({ valor: 39727.08, fechaValor: "2025-12-31" });
    expect(await c("CLF", "2026-01-05")).toMatchObject({ valor: 39800, fechaValor: "2026-01-05" });
    expect(llamadas.map((u) => u.slice(-7))).toEqual(["uf/2026", "uf/2025"]);
  });

  it("la UTM vale todo el mes", async () => {
    const { fetch } = falso({ "/utm/2026": serie(["2026-09-01", 71000], ["2026-10-01", 71721]) });
    expect(await conversorMindicador({ fetch })("UTM", "2026-10-20")).toMatchObject({ valor: 71721, fechaValor: "2026-10-01" });
  });

  it("si el servicio falla devuelve null sin lanzar, y no reintenta en cada monto", async () => {
    const { fetch, llamadas } = falso({ "/euro/2026": new TypeError("fetch failed") });
    const c = conversorMindicador({ fetch });
    expect(await c("EUR", "2026-10-10")).toBeNull();
    expect(await c("EUR", "2026-10-11")).toBeNull();
    expect(llamadas).toHaveLength(1);
  });

  it("reintenta una falla pasados 5 minutos y refresca el año en curso cada 12 h, no los pasados", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-13T12:00:00Z") });
    const rutas: Record<string, unknown> = { "/dolar/2025": serie(["2025-12-31", 900]) };
    const { fetch, llamadas } = falso(rutas);
    const c = conversorMindicador({ fetch });
    expect(await c("USD", "2026-10-09")).toBeNull(); // 2026 cae
    expect(await c("USD", "2025-12-31")).toMatchObject({ valor: 900 });
    rutas["/dolar/2026"] = serie(["2026-10-09", 947.5]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(await c("USD", "2026-10-09")).toMatchObject({ valor: 947.5 });
    rutas["/dolar/2026"] = serie(["2026-10-09", 947.5], ["2026-10-13", 950]);
    expect(await c("USD", "2026-10-13")).toMatchObject({ valor: 947.5 }); // aún en caché
    vi.advanceTimersByTime(12 * 3_600_000);
    expect(await c("USD", "2026-10-13")).toMatchObject({ valor: 950 });
    expect(await c("USD", "2025-12-31")).toMatchObject({ valor: 900 }); // el año pasado no se vuelve a pedir
    expect(llamadas.filter((u) => u.endsWith("/2025"))).toHaveLength(1);
  });
});

describe("conversorParidadChileCompra", () => {
  const csv = [
    '"YEAR";"MONTH";"MONEDA";"VMUSD";"VMUTM";"VMCLP";"VMCLF";"VMEUR"',
    '2026;9;"CLF";43,226364852307;0,570919465344297;40946,9149739583;1;37,5184766157092',
    '2026;9;"CLF";43,226364852307;0,570919465344297;40946,9149739583;1;37,5184766157092',
    '2026;9;"CLP";0,00105566841555215;1,39429176949568e-05;1;2,44218642756356e-05;0,000916271143737458',
    '2026;9;"UTM";75,7135944318155;1;71721;1,75156052771286;65,7158826999942',
    "",
  ].join("\r\n");

  it("lee ; y coma decimal, deduplica, descarga una vez y declara el mes", async () => {
    const { fetch, llamadas } = falso({ "ParidadMoneda.csv": csv });
    const c = conversorParidadChileCompra({ fetch });
    expect(await c("CLF", "2026-09-15")).toEqual({ valor: 40946.9149739583, fechaValor: "2026-09-01", fuente: "chilecompra:ParidadMoneda (mensual)" });
    expect(await c("UTM", "2026-09-30")).toMatchObject({ valor: 71721, fechaValor: "2026-09-01" });
    expect(await c("UTM", "2026-10-01")).toBeNull(); // el mes en curso aún no está
    expect(await c("USD", "2026-09-01")).toBeNull();
    expect(llamadas).toHaveLength(1);
  });

  it("una descarga fallida no queda en caché para siempre", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-13T12:00:00Z") });
    const rutas: Record<string, unknown> = {};
    const { fetch } = falso(rutas);
    const c = conversorParidadChileCompra({ fetch });
    expect(await c("CLF", "2026-09-15")).toBeNull();
    rutas["ParidadMoneda.csv"] = csv;
    expect(await c("CLF", "2026-09-15")).toBeNull(); // dentro de los 5 minutos
    vi.advanceTimersByTime(5 * 60_000);
    expect(await c("CLF", "2026-09-15")).toMatchObject({ valor: 40946.9149739583 });
  });
});

describe("conversorEncadenado", () => {
  it("gana el primero que responda; los errores cuentan como null", async () => {
    const vistos: string[] = [];
    const roto: Conversor = async () => {
      vistos.push("roto");
      throw new Error("x");
    };
    const nulo: Conversor = async () => (vistos.push("nulo"), null);
    const bueno: Conversor = async (_m, dia) => (vistos.push("bueno"), { valor: 2, fechaValor: dia, fuente: "b" });
    const nunca: Conversor = async () => (vistos.push("nunca"), null);
    expect(await conversorEncadenado(roto, nulo, bueno, nunca)("USD", "2026-10-01")).toEqual({ valor: 2, fechaValor: "2026-10-01", fuente: "b" });
    expect(vistos).toEqual(["roto", "nulo", "bueno"]);
    expect(await conversorEncadenado(nulo)("USD", "2026-10-01")).toBeNull();
  });
});

describe("convertirMontos", () => {
  const sin = (valor: number, moneda: Monto["moneda"]): Monto => ({ valor, moneda, clp: null, fechaValor: null, fuente: null });
  const clp = (valor: number): Monto => ({ valor, moneda: "CLP", clp: valor, fechaValor: "2026-10-11", fuente: "identidad" });
  const base = {
    codigo: "1-1-LE26",
    nombre: "x",
    descripcion: null,
    estado: "publicada",
    estadoGlosa: null,
    comprador: null,
    oferentes: null,
    personales: null,
    origen: "ocds" as const,
    raw: null,
  };
  const item = (precioUnitario: Monto | null, total: Monto | null) => ({
    codigoProducto: null, nombre: null, descripcion: null, cantidad: 1, unidad: null, precioUnitario, total, proveedor: null,
  });
  const espia = () => {
    const dias: string[] = [];
    const c: Conversor = async (m, dia) => (dias.push(`${m} ${dia}`), m === "EUR" ? null : { valor: 40000.4, fechaValor: "2026-10-09", fuente: "f" });
    return { c, dias };
  };

  it("usa el día del documento en Santiago, redondea a pesos, no toca CLP y no muta la entrada", async () => {
    const lic: Licitacion = {
      ...base,
      tipo: "licitacion",
      tipoLicitacion: "LE",
      tipoLicitacionGlosa: null,
      // 23:30 en Santiago ya es el 12 en UTC: debe usar el 11.
      fechas: { creacion: "2026-01-01T00:00:00-03:00", publicacion: "2026-10-11T23:30:00-03:00", cierre: null, adjudicacion: null, ultimoCambio: null },
      monto: sin(1.5, "CLF"),
      items: [item(clp(1000), sin(10, "USD")), item(sin(1, "EUR"), null)],
    };
    const copia = structuredClone(lic);
    const { c, dias } = espia();
    const out = await convertirMontos(lic, c);

    expect(dias.sort()).toEqual(["CLF 2026-10-11", "EUR 2026-10-11", "USD 2026-10-11"]);
    expect(out.monto).toEqual({ valor: 1.5, moneda: "CLF", clp: 60001, fechaValor: "2026-10-09", fuente: "f" });
    expect(out.items[0]!.precioUnitario).toEqual(clp(1000));
    expect(out.items[0]!.total).toMatchObject({ clp: 400004 });
    expect(out.items[1]!.precioUnitario).toEqual(sin(1, "EUR")); // sin valor: queda en null
    expect(out.tipoLicitacion).toBe("LE");
    expect(lic).toEqual(copia);
    expect(out).not.toBe(lic);
  });

  it("convierte cotizaciones de Compra Ágil, usa la creación si no hay publicación y sin fecha no convierte", async () => {
    const ca: CompraAgil = {
      ...base,
      tipo: "compra_agil",
      ordenCompra: null,
      fechas: { creacion: "2026-10-05T10:00:00-03:00", publicacion: null, cierre: null, adjudicacion: null, ultimoCambio: null },
      monto: null,
      items: [],
      cotizaciones: [{ proveedor: null, monto: sin(2, "USD"), seleccionada: true, productos: [{ codigoProducto: 1, nombre: null, cantidad: 1, precioUnitario: sin(1, "UTM") }] }],
    };
    const { c, dias } = espia();
    const out = await convertirMontos(ca, c);
    expect(dias.sort()).toEqual(["USD 2026-10-05", "UTM 2026-10-05"]);
    expect(out.cotizaciones[0]!.monto?.clp).toBe(80001);
    expect(out.cotizaciones[0]!.productos[0]!.precioUnitario?.clp).toBe(40000);

    const sinFecha = { ...ca, fechas: { ...ca.fechas, creacion: null } };
    const { c: c2, dias: d2 } = espia();
    expect((await convertirMontos(sinFecha, c2)).cotizaciones[0]!.monto?.clp).toBeNull();
    expect(d2).toEqual([]);
  });
});
