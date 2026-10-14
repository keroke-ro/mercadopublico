// Caos sobre sockets reales: lentitud, cortes, cuerpos raros, tormentas de 10500, cuota, circuito, concurrencia y
// cancelación. Lo mismo con fetch falso ya está en test/resiliencia.test.ts; aquí importa el socket y el reloj reales.
import { getEventListeners } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MercadoPublicoError } from "../../src/errores.js";
import { cliente, levantar, medir, sinTicket, vigilarRechazos, type Respuesta, type Ruta, type Servidor } from "./servidor.js";

let srv: Servidor;
const sueltos = vigilarRechazos();
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

beforeAll(async () => void (srv = await levantar()));
afterEach(() => srv.reiniciar());
afterAll(async () => {
  await srv.cerrar();
  expect(sueltos).toEqual([]);
});

const r10500 = (status: number): Respuesta => ({ status, cuerpo: { Codigo: 10500, Mensaje: "Lo sentimos. Hemos detectado que existen peticiones simultáneas." } });
const intervalos = (t: number[]) => t.slice(1).map((x, i) => x - t[i]!);

describe("lentitud y cortes", () => {
  it("headers después del timeout: error de red, se reintenta, cuenta en la cuota y el servidor ve el socket cerrado", async () => {
    srv.fallar("lic", { demoraMs: 2000 });
    const { mp, eventos, de } = cliente(srv, { timeoutMs: 500 }); // holgado: el reintento (normal) no debe expirar con carga
    const r = await medir(mp.licitaciones.porCodigo("1000-1-LE26"));
    expect(r.valor?.codigo).toBe("1000-1-LE26");
    expect(r.ms).toBeLessThan(2000); // no esperó la demora del servidor (los eventos de abajo lo prueban sin reloj)
    expect(mp.cuota.usadas).toBe(2);
    expect(de("consulta").map((e) => [e.status, e.intento])).toEqual([[null, 1], [200, 2]]);
    expect(de("reintento").map((e) => e.motivo)).toEqual(["red"]);
    await srv.cerrada(srv.de("lic")[0]!);
    expect(sinTicket(eventos)).toBe(true);
  });

  it("headers rápidos y cuerpo a goteo más allá del timeout: el timeout cubre el cuerpo", async () => {
    srv.fallar("lic", { goteo: { trozo: 64, pausaMs: 30 } });
    const { mp, de } = cliente(srv, { timeoutMs: 500 }); // el goteo completo tarda ≥ 1,7 s
    const r = await medir(mp.licitaciones.porCodigo("1000-2-LE26"));
    expect(r.valor?.codigo).toBe("1000-2-LE26");
    expect(de("consulta").map((e) => e.status)).toEqual([200, 200]); // el primero llegó a dar status, después se cortó
    expect(de("reintento").map((e) => e.motivo)).toEqual(["red"]);
    await srv.cerrada(srv.de("lic")[0]!);
  });

  it("siempre lento: entrega 'red' tras los reintentos, sin el ticket", async () => {
    srv.siempre("lic", { demoraMs: 1000 });
    const { mp, eventos } = cliente(srv, { timeoutMs: 50, reintentos: 2 });
    const e = (await mp.licitaciones.delDia("2026-10-01").catch((x: unknown) => x)) as MercadoPublicoError;
    expect(e).toMatchObject({ tipo: "red" });
    expect(srv.de("lic")).toHaveLength(3);
    expect(mp.cuota.usadas).toBe(3);
    expect(sinTicket(e, eventos)).toBe(true);
  });

  it("socket destruido a mitad del cuerpo o justo después de los headers: red y reintento, sin caerse", async () => {
    srv.fallar("lic", { cortarEn: 100 }, { cortarEn: 0 });
    const { mp, de } = cliente(srv);
    expect((await mp.licitaciones.porCodigo("1000-3-LE26"))?.codigo).toBe("1000-3-LE26");
    expect(de("reintento").map((e) => e.motivo)).toEqual(["red", "red"]);
    expect(mp.cuota.usadas).toBe(3);
  });

  it("cuerpo truncado que termina limpio (sin content-length): respuesta_invalida, no se reintenta", async () => {
    srv.fallar("lic", { cortarEn: 100, limpio: true });
    const { mp } = cliente(srv);
    await expect(mp.licitaciones.porCodigo("1000-3-LE26")).rejects.toMatchObject({ tipo: "respuesta_invalida" });
    expect(srv.de("lic")).toHaveLength(1);
    expect(mp.salud().v1.fallas).toBe(1); // pero cuenta como caída para el circuito
  });
});

describe("HTTP 200 con un cuerpo que no es la API", () => {
  it.each<[string, Respuesta]>([
    ["página HTML de mantención", { cuerpo: "<html><body>Sitio en mantención</body></html>", headers: { "content-type": "text/html" } }],
    ["cuerpo vacío", { cuerpo: "" }],
    ["JSON array", { cuerpo: [1, 2, 3] }],
    ["JSON número", { cuerpo: 42 }],
    ["JSON null", { cuerpo: null }],
    ["gzip sin content-encoding", { gzip: "crudo" }],
  ])("%s: respuesta_invalida sin reintento, cuenta como caída", async (_, falla) => {
    srv.fallar("lic", falla);
    const { mp, eventos } = cliente(srv);
    const e = await mp.licitaciones.delDia("2026-10-01").catch((x: unknown) => x);
    expect(e).toMatchObject({ tipo: "respuesta_invalida", status: 200 });
    expect(srv.de("lic")).toHaveLength(1);
    expect(mp.cuota.usadas).toBe(1);
    expect(mp.salud().v1).toMatchObject({ estado: "cerrado", fallas: 1 });
    expect(sinTicket(e, eventos)).toBe(true);
  });

  it("gzip con content-encoding y content-type equivocado: se lee igual", async () => {
    srv.fallar("lic", { gzip: "header", headers: { "content-type": "text/html" } });
    const { mp } = cliente(srv);
    expect((await mp.licitaciones.delDia("2026-10-01")).map((l) => l.codigo)).toEqual(["1000-1-LE26", "1000-2-LE26", "1000-3-LE26"]);
  });
});

describe("tormenta de 10500", () => {
  it.each([429, 500, 200])("con HTTP %i: la pausa real entre consultas sube con cada rechazo y baja tras los éxitos", async (status) => {
    srv.fallar("lic", r10500(status), r10500(status), r10500(status));
    const { mp, de, inicios } = cliente(srv, { intervaloMs: 10, ritmo: { factor: 2, maximoMs: 80, exitos: 2, pasoMs: 30 } });
    expect(await mp.licitaciones.delDia("2026-10-01")).toHaveLength(3);
    expect(de("reintento").map((e) => e.motivo)).toEqual(["simultaneas", "simultaneas", "simultaneas"]);
    expect(de("ritmo").map((e) => e.intervaloMs)).toEqual([20, 40, 80]);
    for (let i = 0; i < 6; i++) await mp.licitaciones.delDia("2026-10-02");
    expect(de("ritmo").map((e) => e.intervaloMs)).toEqual([20, 40, 80, 50, 20, 10]);
    expect(mp.salud().v1.intervaloMs).toBe(10);
    // Entre inicios de fetch en el cliente, no entre llegadas al servidor (con carga una se atrasa y la siguiente no, y
    // el hueco "se achica"). 5 ms de holgura: el ritmo usa Date (ms enteros) y setTimeout cuenta desde el reloj del
    // loop, que Node cachea al inicio de cada vuelta, así que puede disparar un poco antes de lo pedido (con load ~25
    // se vio 2 ms antes).
    const esperado = [20, 40, 80, 80, 50, 50, 20, 20, 10];
    expect(inicios).toHaveLength(10);
    intervalos(inicios).forEach((g, i) => expect(g).toBeGreaterThanOrEqual(esperado[i]! - 5));
    expect(mp.cuota.usadas).toBe(10);
  });

  it("presupuesto de reintentos: una consulta usa sus reintentos; la siguiente, sin presupuesto, falla al primer intento", async () => {
    srv.siempre("lic", r10500(429));
    const { mp, de } = cliente(srv, { reintentos: 4, presupuestoReintentos: 0.1 });
    await expect(mp.licitaciones.delDia("2026-10-01")).rejects.toMatchObject({ tipo: "simultaneas" });
    expect(srv.de("lic")).toHaveLength(5);
    await expect(mp.licitaciones.delDia("2026-10-01")).rejects.toMatchObject({ tipo: "simultaneas" });
    expect(srv.de("lic")).toHaveLength(6);
    expect(de("reintento")).toHaveLength(4);
    expect(mp.cuota.usadas).toBe(6);
  });
});

describe("cuota agotada", () => {
  const nok = { success: "NOK", trace: null, payload: null, errors: [{ codigo: "429", mensaje: "Se ha alcanzado el límite de solicitudes permitido. Intente nuevamente más tarde.", detalle: null }] };
  it.each<[string, Ruta, Respuesta]>([
    ["v1 HTTP 429 con mensaje de cuota", "lic", { status: 429, cuerpo: { Codigo: 429, Mensaje: "Ha superado el límite diario de solicitudes" } }],
    ["v1 HTTP 200 con mensaje de límite diario", "lic", { status: 200, cuerpo: { Codigo: 10001, Mensaje: "Ha superado el límite diario de solicitudes" } }],
    ["v2 HTTP 429 NOK (guía §4.2)", "v2", { status: 429, cuerpo: nok, headers: { "retry-after": "3600" } }],
    ["v2 HTTP 200 NOK con código 429", "v2", { status: 200, cuerpo: nok }],
  ])("%s → cuota_agotada, sin reintentar", async (_, ruta, falla) => {
    srv.fallar(ruta, falla);
    const { mp, de } = cliente(srv);
    const p = ruta === "lic" ? mp.licitaciones.delDia("2026-10-01") : mp.compraAgil.pagina({}, 1);
    await expect(p).rejects.toMatchObject({ tipo: "cuota_agotada" });
    expect(srv.de(ruta)).toHaveLength(1);
    expect(de("reintento")).toEqual([]);
    expect(mp.salud()[ruta === "lic" ? "v1" : "v2"]).toMatchObject({ estado: "cerrado", fallas: 0 }); // el servicio responde
  });

  // En la v1 un 429 sin mensaje de cuota es freno por ritmo (un 10500 cortado, un proxy): se reintenta.
  it.each<[string, Respuesta]>([
    ["v1 HTTP 429 sin cuerpo", { status: 429, cuerpo: "" }],
    ["v1 HTTP 429 con HTML", { status: 429, cuerpo: "<html>Too Many Requests</html>", headers: { "content-type": "text/html" } }],
    ["v1 HTTP 429 con JSON sin mensaje de cuota", { status: 429, cuerpo: { Mensaje: "Too Many Requests" } }],
  ])("%s → simultaneas, se reintenta y responde", async (_, falla) => {
    srv.fallar("lic", falla);
    const { mp, de } = cliente(srv);
    expect(await mp.licitaciones.delDia("2026-10-01")).toHaveLength(3);
    expect(srv.de("lic")).toHaveLength(2);
    expect(de("reintento").map((e) => e.motivo)).toEqual(["simultaneas"]);
    expect(mp.cuota.usadas).toBe(2);
    expect(mp.cuota.restante).toBeGreaterThan(0);
  });
});

describe("circuito de la v2 ante success ERROR con HTTP 500", () => {
  it("se abre tras el umbral, falla rápido sin tocar el servidor, sonda tras el enfriamiento y se cierra; salud() lo refleja", async () => {
    const error = { success: "ERROR", trace: null, payload: null, errors: [{ codigo: "ERROR_INTERNO", mensaje: "Servicio no disponible" }] };
    srv.fallar("v2", { status: 500, cuerpo: error }, { status: 500, cuerpo: { codigo: "ERROR_INTERNO", mensaje: "Servicio no disponible…" } });
    srv.fallar("v2det", { status: 500, cuerpo: error });
    const { mp, de, eventos } = cliente(srv, { reintentos: 0, circuito: { umbral: 3, enfriamientoMs: 200 } });
    await expect(mp.compraAgil.pagina({}, 1)).rejects.toMatchObject({ tipo: "servidor", message: "Servicio no disponible" });
    await expect(mp.compraAgil.detalle("3000-1-COT26")).rejects.toMatchObject({ tipo: "servidor" });
    expect(mp.salud().v2).toMatchObject({ estado: "cerrado", fallas: 2 });
    await expect(mp.compraAgil.pagina({}, 1)).rejects.toMatchObject({ tipo: "servidor" });
    expect(mp.salud().v2).toMatchObject({ estado: "abierto", fallas: 3 });

    // Falla rápido = sin tocar el servidor (se cuenta abajo), no un tiempo: con carga cualquier umbral en ms es frágil.
    await expect(mp.compraAgil.pagina({}, 1)).rejects.toMatchObject({ tipo: "circuito_abierto" });
    await expect(mp.compraAgil.detalle("3000-1-COT26")).rejects.toMatchObject({ tipo: "circuito_abierto" });
    expect(srv.de("v2").length + srv.de("v2det").length).toBe(3);
    expect(mp.cuota.usadas).toBe(3);
    expect((await mp.licitaciones.delDia("2026-10-01")).length).toBe(3); // la v1 sigue
    expect(mp.salud().v1.estado).toBe("cerrado");

    await new Promise((r) => setTimeout(r, 210));
    srv.fallar("v2", { demoraMs: 50 });
    const sonda = mp.compraAgil.pagina({}, 1);
    await srv.llegada("v2", 3);
    expect(mp.salud().v2.estado).toBe("semiabierto");
    expect((await sonda).totalResultados).toBe(3);
    expect(mp.salud().v2).toMatchObject({ estado: "cerrado", fallas: 0 });
    expect(de("circuito").map((e) => [e.fuente, e.estado])).toEqual([["v2", "abierto"], ["v2", "semiabierto"], ["v2", "cerrado"]]);
    expect(sinTicket(eventos)).toBe(true);
    expect(srv.de("v2").every((l) => l.headers.ticket !== undefined && !l.url.search.includes("ticket"))).toBe(true);
  });
});

describe("concurrencia", () => {
  it("muchas llamadas en paralelo (con 10500, 5xx y timeouts mezclados): nunca dos pedidos a la vez en el servidor", async () => {
    for (const r of ["lic", "oc", "v2", "v2det"] as const) srv.siempre(r, (l) => ({ demoraMs: 2 + (l.n % 3) }));
    srv.fallar("lic", r10500(429), undefined, { status: 503, cuerpo: "" }, { demoraMs: 500 });
    srv.fallar("v2det", undefined, { status: 429, cuerpo: { success: "NOK", errors: [{ codigo: "10500", mensaje: "peticiones simultáneas" }] } });
    const { mp } = cliente(srv, { timeoutMs: 250 }); // corta la demora de 500 ms; con carga, 100 ms cortaba también las normales
    const tareas: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      tareas.push(mp.licitaciones.porCodigo(`1000-${(i % 6) + 1}-LE26`));
      tareas.push(mp.ordenes.delDia("2026-10-01"));
      tareas.push(mp.compraAgil.detalle(`3000-${(i % 3) + 1}-COT26`));
      tareas.push(mp.compraAgil.pagina({}, 1));
    }
    const r = await Promise.allSettled(tareas);
    expect(r.filter((x) => x.status === "rejected")).toEqual([]);
    expect(srv.maxEnVuelo).toMatchObject({ v1: 1, v2: 1 });
    // Una sola cola para las dos API: entre llegadas consecutivas, la anterior ya había terminado.
    expect(srv.llegadas.length).toBe(mp.cuota.usadas);
  });
});

describe("cancelación sobre sockets reales", () => {
  it("con la consulta en vuelo: rechaza de inmediato, el servidor ve el socket cerrado y no hay reintento", async () => {
    srv.fallar("lic", { colgar: true });
    const { mp, de } = cliente(srv, { timeoutMs: 30_000 });
    const ac = new AbortController();
    const antes = timers();
    const p = mp.licitaciones.delDia("2026-10-01", { signal: ac.signal });
    const l = await srv.llegada("lic");
    ac.abort();
    const r = await medir(p);
    expect(r.error).toMatchObject({ tipo: "cancelada" });
    expect(r.ms).toBeLessThan(1000); // la alternativa es 10-60 s o nunca; con carga, 100 ms no alcanza
    await srv.cerrada(l);
    expect(de("reintento")).toEqual([]);
    expect(mp.cuota.usadas).toBe(1);
    expect(timers()).toBeLessThanOrEqual(antes);
  });

  it("en la pausa del ritmo: rechaza de inmediato sin llegar al servidor ni gastar cuota", async () => {
    const { mp } = cliente(srv, { intervaloMs: 10_000 });
    await mp.licitaciones.delDia("2026-10-01");
    const antes = timers();
    const ac = new AbortController();
    const p = mp.licitaciones.delDia("2026-10-02", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const r = await medir(p);
    expect(r.error).toMatchObject({ tipo: "cancelada" });
    expect(r.ms).toBeLessThan(1000); // la alternativa es 10-60 s o nunca; con carga, 100 ms no alcanza
    expect(srv.de("lic")).toHaveLength(1);
    expect(mp.cuota.usadas).toBe(1);
    expect(timers()).toBeLessThanOrEqual(antes);
  });

  it("en el backoff: rechaza de inmediato y no vuelve a pedir", async () => {
    srv.fallar("lic", { status: 503, cuerpo: "" });
    const { mp, de } = cliente(srv, { esperaBaseMs: 60_000 });
    const antes = timers();
    const ac = new AbortController();
    const p = mp.licitaciones.delDia("2026-10-01", { signal: ac.signal });
    while (!de("reintento").length) await new Promise((r) => setTimeout(r, 2));
    ac.abort();
    const r = await medir(p);
    expect(r.error).toMatchObject({ tipo: "cancelada" });
    expect(r.ms).toBeLessThan(1000); // la alternativa es 10-60 s o nunca; con carga, 100 ms no alcanza
    await new Promise((r) => setTimeout(r, 20));
    expect(srv.de("lic")).toHaveLength(1);
    expect(timers()).toBeLessThanOrEqual(antes);
  });

  it("las que esperaban turno en la cola salen todas sin consultar", async () => {
    srv.fallar("lic", { colgar: true });
    const { mp } = cliente(srv);
    const ac = new AbortController();
    const ps = [1, 2, 3, 4].map((i) => medir(mp.licitaciones.porCodigo(`1000-${i}-LE26`, { signal: ac.signal })));
    await srv.llegada("lic");
    ac.abort();
    const rs = await Promise.all(ps);
    expect(rs.every((r) => (r.error as MercadoPublicoError)?.tipo === "cancelada" && r.ms < 1000)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(srv.de("lic")).toHaveLength(1);
    expect(mp.cuota.usadas).toBe(1);
  });

  it("un signal de larga vida no acumula listeners consulta tras consulta", async () => {
    const { mp } = cliente(srv);
    const ac = new AbortController();
    for (let i = 0; i < 20; i++) await mp.licitaciones.delDia("2026-10-01", { signal: ac.signal });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
});
