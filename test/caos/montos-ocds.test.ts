// Caos en las fuentes sin ticket: la cadena de conversores de montos y la descarga OCDS en streaming.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Licitacion, Proceso } from "../../src/modelo.js";
import { conversorBancoCentral, conversorEncadenado, conversorMindicador, conversorParidadChileCompra, convertirMontos, type Conversor } from "../../src/monto.js";
import { leerOcds } from "../../src/ocds.js";
import { OCDS_GZ, OCDS_MALAS, OCDS_VALIDAS, VALOR, cliente, levantar, medir, sinTicket, vigilarRechazos, type Servidor } from "./servidor.js";

let srv: Servidor;
const sueltos = vigilarRechazos();
beforeAll(async () => void (srv = await levantar()));
afterEach(() => srv.reiniciar());
afterAll(async () => {
  await srv.cerrar();
  expect(sueltos).toEqual([]);
});

/** Cliente con la cadena por defecto (mindicador → Banco Central → paridad) apuntada al servidor y sus circuitos en salud(). */
function conCadena(timeoutMs = 100) {
  let cadena: Conversor = async () => null;
  const c = cliente(srv, { conversor: (m, d) => cadena(m, d) });
  const o = { timeoutMs, alEvento: (e: Parameters<NonNullable<typeof c.mp.http.alEvento>>[0]) => c.eventos.push(e) };
  const k = c.mp.http.circuitos;
  cadena = conversorEncadenado(
    conversorMindicador({ ...o, url: srv.urlMindicador, circuito: k.mindicador }),
    conversorBancoCentral({ ...o, url: srv.urlBancoCentral, circuito: k.bcentral }),
    conversorParidadChileCompra({ ...o, url: srv.urlParidad, circuito: k.paridad }),
  );
  return { ...c, cadena };
}

const conversiones = (c: ReturnType<typeof conCadena>) => c.de("conversion").map((e) => [e.fuente, e.ok]);

describe("cadena de conversores sobre sockets reales", () => {
  it("mindicador colgado: el timeout corta, responde el Banco Central y no se vuelve a esperar a mindicador", async () => {
    srv.siempre("mindicador", { colgar: true });
    const c = conCadena();
    const r = await medir(c.mp.licitaciones.porCodigo("1000-7-LE26"));
    expect(r.ms).toBeLessThan(1000);
    expect(r.valor?.monto).toEqual({ valor: 100, moneda: "CLF", clp: 100 * VALOR.uf, fechaValor: "2026-10-06", fuente: "bcentral.cl" });
    await srv.cerrada(srv.de("mindicador")[0]!);

    const otra = await medir(c.mp.licitaciones.porCodigo("1000-7-LE26"));
    expect(otra.valor?.monto?.fuente).toBe("bcentral.cl");
    expect(srv.de("mindicador")).toHaveLength(1); // la falla queda en caché un rato
    expect(conversiones(c)).toEqual([["mindicador", false], ["bcentral", true], ["mindicador", false], ["bcentral", true]]);
    expect(c.mp.salud().mindicador).toMatchObject({ estado: "cerrado", fallas: 1 });
  });

  it("Banco Central devuelve HTML sin la tabla: sigue la paridad mensual de ChileCompra", async () => {
    srv.siempre("mindicador", { status: 503, cuerpo: "" });
    srv.siempre("bcentral", (l) => (l.url.pathname.endsWith("Serie.aspx") ? { cuerpo: "<html><select><option selected=\"selected\" value=\"2026\">2026</option></select><p>Mantención</p></html>" } : undefined));
    const c = conCadena();
    const l = (await c.mp.licitaciones.porCodigo("1000-8-LE26")) as Licitacion;
    expect(l.monto).toEqual({ valor: 10, moneda: "USD", clp: Math.round(10 * (VALOR.dolar + 0.5)), fechaValor: "2026-10-01", fuente: "chilecompra:ParidadMoneda (mensual)" });
    expect(conversiones(c)).toEqual([["mindicador", false], ["bcentral", false], ["paridad", true]]);
    expect(c.mp.salud().bcentral).toMatchObject({ estado: "cerrado", fallas: 0 }); // respondió: no es una caída
  });

  it("todo caído: clp null, un evento por intento, y los circuitos abiertos no vuelven a tocar el servidor por cada monto", async () => {
    srv.siempre("mindicador", { status: 503, cuerpo: "" });
    srv.siempre("bcentral", { colgar: true });
    srv.siempre("paridad", { cortarEn: 0 });
    const c = conCadena(50);
    // Una licitación en UF por año: cada año es otra serie de mindicador (otra descarga).
    const base = (await c.mp.licitaciones.porCodigo("1000-7-LE26")) as Proceso;
    const montos: (number | null | undefined)[] = [base.monto?.clp];
    for (let anio = 2019; anio <= 2025; anio++) {
      const p = await convertirMontos({ ...base, monto: { ...base.monto!, clp: null }, fechas: { ...base.fechas, publicacion: `${anio}-06-02T12:00:00` } }, c.cadena);
      montos.push(p.monto?.clp);
    }
    expect(montos).toEqual(Array(8).fill(null));
    expect(srv.de("mindicador")).toHaveLength(5); // CIRCUITO.umbral: después falla rápido sin pedir
    expect(srv.de("bcentral")).toHaveLength(1); // la falla de la página de enlaces queda en caché
    expect(srv.de("paridad")).toHaveLength(1);
    expect(c.mp.salud()).toMatchObject({ mindicador: { estado: "abierto", fallas: 5 }, bcentral: { estado: "cerrado", fallas: 1 }, paridad: { estado: "cerrado", fallas: 1 } });
    expect(c.de("conversion")).toHaveLength(8 * 3);
    expect(c.de("conversion").every((e) => !e.ok && e.moneda === "CLF")).toBe(true);
    expect(c.de("circuito")).toEqual([{ tipo: "circuito", fuente: "mindicador", estado: "abierto", fallas: 5 }]);
    expect(sinTicket(c.eventos, srv.de("mindicador").map((l) => l.url.href))).toBe(true);
  });
});

describe("conversores: respuestas 200 que no son la serie", () => {
  it("mindicador detrás de una página HTML (antibots) con 200: cuenta como caída y el circuito se abre igual", async () => {
    srv.siempre("mindicador", { cuerpo: "<html>Checking your browser…</html>", headers: { "content-type": "text/html" } });
    const c = conCadena();
    const base = (await c.mp.licitaciones.porCodigo("1000-7-LE26")) as Proceso;
    expect(base.monto?.fuente).toBe("bcentral.cl");
    for (let anio = 2019; anio <= 2025; anio++) {
      await convertirMontos({ ...base, monto: { ...base.monto!, clp: null }, fechas: { ...base.fechas, publicacion: `${anio}-06-02T12:00:00` } }, c.cadena);
    }
    expect(srv.de("mindicador")).toHaveLength(5);
    expect(c.mp.salud().mindicador).toMatchObject({ estado: "abierto", fallas: 5 });
  });
});

describe("OCDS en streaming", () => {
  const leer = async (url: string, o: Parameters<typeof leerOcds>[1] = {}) => {
    const ps: Proceso[] = [];
    const malas: number[] = [];
    let error: unknown;
    try {
      for await (const p of leerOcds(url, { ...o, alError: (_, __, n) => malas.push(n) })) ps.push(p);
    } catch (e) {
      error = e;
    }
    return { ps, malas, error };
  };

  it("gzip en trozos chicos con pausas: lee todo y cuenta las líneas malas con su número", async () => {
    srv.fallar("ocds", { goteo: { trozo: 97, pausaMs: 1 } });
    const r = await leer(srv.urlOcds);
    expect(r.error).toBeUndefined();
    expect(r.ps).toHaveLength(OCDS_VALIDAS);
    expect(r.ps[0]).toMatchObject({ codigo: "9000-1-CM26", tipo: "orden_compra", origen: "ocds" });
    expect(r.malas).toEqual([21, 42]);
    expect(OCDS_MALAS).toHaveLength(2);
  });

  // Semántica: leerOcds entrega cada release completa que alcanzó a llegar y después el iterador lanza el error de la
  // descarga tal cual (fetch: TypeError "terminated"; gzip truncado: error del descompresor). La línea a medias no se
  // entrega ni pasa por alError: no es una línea mala, es una descarga incompleta.
  it.each([
    ["conexión cortada a mitad (socket destruido)", { cortarEn: Math.floor(OCDS_GZ.length / 2) }],
    ["cierre limpio con el gzip truncado", { cortarEn: Math.floor(OCDS_GZ.length / 2), limpio: true }],
  ])("%s: entrega lo leído y lanza", async (_, falla) => {
    srv.fallar("ocds", falla);
    const r = await leer(srv.urlOcds);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.ps.length).toBeGreaterThan(0);
    expect(r.ps.length).toBeLessThan(OCDS_VALIDAS);
    expect(r.ps.map((p) => p.codigo)).toEqual(r.ps.map((_, i) => `9000-${i + 1}-CM26`)); // en orden, sin huecos
    expect(r.malas.every((n) => n === 21 || n === 42)).toBe(true);
  });

  it("cancelar con el signal a mitad de la descarga: lanza en < 100 ms y el servidor ve el socket cerrado", async () => {
    srv.fallar("ocds", { goteo: { trozo: 64, pausaMs: 20 } });
    const ac = new AbortController();
    const p = leer(srv.urlOcds, { signal: ac.signal });
    const l = await srv.llegada("ocds");
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const { valor, ms } = await medir(p);
    expect(ms).toBeLessThan(100);
    expect((valor?.error as Error)?.name).toBe("AbortError");
    await srv.cerrada(l);
  });

  it("dejar de leer antes del final (--max): se suelta la conexión", async () => {
    srv.fallar("ocds", { goteo: { trozo: 256, pausaMs: 5 } });
    const it = leerOcds(srv.urlOcds);
    for await (const p of it) if (p.codigo === "9000-3-CM26") break;
    await srv.cerrada((await srv.llegada("ocds"))!);
  });
});
