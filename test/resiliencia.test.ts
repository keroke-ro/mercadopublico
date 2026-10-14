import { describe, expect, it } from "vitest";
import { MercadoPublicoError } from "../src/errores.js";
import type { Evento } from "../src/eventos.js";
import { Circuito, Transporte, type OpcionesTransporte } from "../src/http.js";
import { MercadoPublico } from "../src/index.js";
import { conversorMindicador } from "../src/monto.js";
import { Empresas } from "../src/v1/empresas.js";
import { Licitaciones } from "../src/v1/licitaciones.js";
import { OrdenesCompra } from "../src/v1/ordenes.js";
import { CompraAgilApi } from "../src/v2/compra-agil.js";

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status });
const ok = () => json({ Cantidad: 0, Listado: [] });
const r10500 = () => json({ Codigo: 10500, Mensaje: "Lo sentimos. Hemos detectado que existen peticiones simultáneas." }, 429);

/** Reloj falso: `dormir` avanza el tiempo. `respuestas` se consumen en orden; sin más, responde vacío. */
function armar(respuestas: (Response | Error | (() => Response))[] = [], extra: Partial<OpcionesTransporte> = {}) {
  const reloj = { t: Date.parse("2026-10-13T12:00:00-03:00") };
  const eventos: Evento[] = [];
  const urls: string[] = [];
  const esperas: number[] = [];
  const t = new Transporte({
    ticket: "SECRETO",
    esperaBaseMs: 0,
    ahora: () => new Date(reloj.t),
    dormir: async (ms) => void (esperas.push(ms), (reloj.t += ms)),
    alEvento: (e) => void eventos.push(e),
    fetch: async (url) => {
      urls.push(String(url));
      const r = respuestas.shift() ?? ok;
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r() : r;
    },
    ...extra,
  });
  const de = <T extends Evento["tipo"]>(tipo: T) => eventos.filter((e): e is Extract<Evento, { tipo: T }> => e.tipo === tipo);
  return { t, reloj, eventos, urls, esperas, de };
}

describe("eventos", () => {
  it("consulta (sin ticket en la URL) y reintento, con el número de intento", async () => {
    const { t, de } = armar([new TypeError("fetch failed"), json({}, 503)]);
    await t.v1("licitaciones.json", { codigo: "1-1-L1" });
    const c = de("consulta");
    expect(c.map((e) => [e.status, e.intento])).toEqual([[null, 1], [503, 2], [200, 3]]);
    expect(c.every((e) => !e.url.includes("SECRETO") && e.url.includes("codigo=1-1-L1") && e.fuente === "v1")).toBe(true);
    expect(de("reintento").map((e) => [e.motivo, e.intento])).toEqual([["red", 2], ["servidor", 3]]);
  });

  it("cuota: avisa al cruzar 80%, 95% y al agotarse, una vez por día", async () => {
    const { t, reloj, de } = armar([], { limiteDiario: 20, intervaloMs: 0 });
    for (let i = 0; i < 20; i++) await t.v1("x");
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "cuota_insuficiente" });
    expect(de("cuota").map((e) => [e.usadas, e.restante])).toEqual([[16, 4], [19, 1], [20, 0]]);
    reloj.t += 86_400_000;
    for (let i = 0; i < 16; i++) await t.v1("x");
    expect(de("cuota")).toHaveLength(4);
  });

  it("un hook que lanza no rompe nada", async () => {
    const { t } = armar([json({}, 503)], { alEvento: () => { throw new Error("hook roto"); } });
    await expect(t.v1("x")).resolves.toEqual({ Cantidad: 0, Listado: [] });
  });
});

describe("ritmo adaptativo", () => {
  it("se duplica con cada 10500 hasta el máximo y baja de a un paso tras N éxitos", async () => {
    const { t, de, esperas } = armar([r10500(), r10500(), r10500()], { ritmo: { maximoMs: 3000, exitos: 2, pasoMs: 1000 } });
    await t.v1("x");
    expect(de("ritmo").map((e) => e.intervaloMs)).toEqual([2000, 3000]);
    expect(esperas.filter(Boolean)).toEqual([2000, 3000, 3000]); // la pausa ya usa el nuevo intervalo
    for (let i = 0; i < 5; i++) await t.v1("x");
    expect(de("ritmo").map((e) => e.intervaloMs)).toEqual([2000, 3000, 2000, 1000]);
    expect(t.salud().v1.intervaloMs).toBe(1000);
  });

  it("v1 y v2 llevan su propio ritmo; con intervaloMs 0 no hay pausa", async () => {
    const { t } = armar([r10500()]);
    await t.v1("x");
    expect(t.salud().v1.intervaloMs).toBe(2000);
    expect(t.salud().v2.intervaloMs).toBe(1000);
    const cero = armar([r10500(), r10500()], { intervaloMs: 0 });
    await cero.t.v1("x");
    expect(cero.esperas.filter((ms) => ms > 0)).toEqual([]);
  });
});

describe("circuit breaker", () => {
  const caida = () => json({}, 503);

  it("se abre tras K caídas seguidas, falla rápido sin gastar cuota y deja pasar una sonda tras el enfriamiento", async () => {
    const { t, reloj, urls, de } = armar([caida, caida, caida], { reintentos: 0, intervaloMs: 0, circuito: { umbral: 3, enfriamientoMs: 10_000 } });
    for (let i = 0; i < 3; i++) await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" });
    const err = (await t.v1("x").catch((e: unknown) => e)) as MercadoPublicoError;
    expect(err.tipo).toBe("circuito_abierto");
    expect(err.reintentable).toBe(false);
    expect(urls).toHaveLength(3);
    expect(t.cuota.usadas).toBe(3);
    expect(t.salud().v1).toMatchObject({ estado: "abierto", fallas: 3, ultimaFalla: "2026-10-13T12:00:00-03:00" });
    expect(t.salud().v2.estado).toBe("cerrado"); // independiente

    reloj.t += 10_000;
    await t.v1("x");
    expect(de("circuito").map((e) => e.estado)).toEqual(["abierto", "semiabierto", "cerrado"]);
    expect(t.salud().v1).toMatchObject({ estado: "cerrado", fallas: 0 });
  });

  it("una sonda fallida lo vuelve a abrir; los errores del pedido no cuentan como caída", async () => {
    const { t, reloj } = armar(
      [json({ Codigo: 10300, Mensaje: "parametro incorrecto" }, 500), caida, json({}, 404), caida, caida, caida],
      { reintentos: 0, intervaloMs: 0, circuito: { umbral: 2, enfriamientoMs: 1000 } },
    );
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "parametros" });
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" });
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "no_encontrado" }); // resetea la racha
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" });
    expect(t.salud().v1.estado).toBe("cerrado");
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" });
    expect(t.salud().v1.estado).toBe("abierto");
    reloj.t += 1000;
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" }); // la sonda
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "circuito_abierto" });
  });

  it("si se abre a mitad de los reintentos entrega el error real", async () => {
    const { t, urls } = armar([caida, caida, caida, caida], { intervaloMs: 0, circuito: { umbral: 2 } });
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" });
    expect(urls).toHaveLength(2);
  });

  it("los conversores tienen el suyo, y lo bloqueado no queda en caché", async () => {
    let t = 0;
    let cae = true;
    const llamadas: string[] = [];
    const eventos: Evento[] = [];
    const fetch: typeof globalThis.fetch = async (u) => {
      llamadas.push(String(u));
      if (cae) throw new TypeError("fetch failed");
      return json({ serie: [{ fecha: "2026-10-09T03:00:00.000Z", valor: 39000 }] });
    };
    const circuito = new Circuito("mindicador", { umbral: 2, enfriamientoMs: 1000, ahora: () => new Date(t) });
    const c = conversorMindicador({ fetch, circuito, alEvento: (e) => void eventos.push(e) });
    expect(await c("USD", "2026-10-09")).toBeNull();
    expect(await c("EUR", "2026-10-09")).toBeNull();
    expect(circuito.estado).toBe("abierto");
    expect(await c("CLF", "2026-10-09")).toBeNull();
    expect(llamadas).toHaveLength(2);
    cae = false;
    t += 1000;
    expect(await c("CLF", "2026-10-09")).toMatchObject({ valor: 39000 });
    expect(circuito.estado).toBe("cerrado");
    expect(eventos.filter((e) => e.tipo === "conversion").map((e) => e.tipo === "conversion" && e.ok)).toEqual([false, false, false, true]);
  });

  it("mp.salud() informa todas las fuentes", () => {
    const mp = new MercadoPublico({ ticket: "T", conversor: false });
    const s = mp.salud();
    expect(Object.keys(s).sort()).toEqual(["bcentral", "mindicador", "paridad", "v1", "v2"]);
    expect(s.v1).toEqual({ estado: "cerrado", fallas: 0, intervaloMs: 1000 });
    expect(s.paridad).toEqual({ estado: "cerrado", fallas: 0 });
  });
});

describe("presupuesto de reintentos", () => {
  it("con la ventana gastada no reintenta y entrega el último error; cada intento cuenta en la cuota", async () => {
    const caida = () => json({}, 503);
    const { t, urls } = armar([caida, ok, caida, ok], { reintentos: 1, presupuestoReintentos: 0.1, intervaloMs: 0 });
    await t.v1("x");
    await expect(t.v1("x")).rejects.toMatchObject({ tipo: "servidor" });
    expect(urls).toHaveLength(3);
    expect(t.cuota.usadas).toBe(3);
  });
});

describe("cancelación", () => {
  const abortar = () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 5);
    return c.signal;
  };
  const cancelada = { tipo: "cancelada" };

  it("corta el fetch en vuelo (respete o no el signal)", async () => {
    const respeta = armar([], {
      fetch: (_, init) => new Promise((_, mal) => init?.signal?.addEventListener("abort", () => mal(init.signal!.reason))),
    });
    await expect(respeta.t.v1("x", {}, { signal: abortar() })).rejects.toMatchObject(cancelada);
    const ignora = armar([], { fetch: () => new Promise(() => {}) });
    await expect(ignora.t.v2("x", {}, { signal: abortar() })).rejects.toMatchObject(cancelada);
  });

  it("corta la pausa del ritmo y el backoff de inmediato, con el dormir real", async () => {
    const { t, urls } = armar([], { dormir: undefined, ahora: undefined, intervaloMs: 60_000 });
    await t.v1("x");
    const t0 = performance.now();
    await expect(t.v1("x", {}, { signal: abortar() })).rejects.toMatchObject(cancelada); // esperaba 60 s
    const b = armar([json({}, 503)], { dormir: undefined, intervaloMs: 0, esperaBaseMs: 60_000 });
    await expect(b.t.v1("x", {}, { signal: abortar() })).rejects.toMatchObject(cancelada);
    // Las esperas eran de 60 s: el margen es para una máquina cargada, no para distinguir.
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(urls).toHaveLength(1);
    expect(b.urls).toHaveLength(1);
  });

  it("ya abortado no consulta ni gasta cuota; el timeout sigue siendo error de red", async () => {
    const { t, urls } = armar();
    await expect(t.v1("x", {}, { signal: AbortSignal.abort() })).rejects.toMatchObject(cancelada);
    expect(urls).toHaveLength(0);
    expect(t.cuota.usadas).toBe(0);
    const lento = armar([], {
      reintentos: 0,
      timeoutMs: 5,
      fetch: (_, init) => new Promise((_, mal) => init?.signal?.addEventListener("abort", () => mal(init.signal!.reason))),
    });
    await expect(lento.t.v1("x", {}, { signal: new AbortController().signal })).rejects.toMatchObject({ tipo: "red" });
  });

  it("llega desde los métodos públicos", async () => {
    const { t } = armar([], { fetch: () => new Promise(() => {}) });
    await expect(new Licitaciones(t).delDia("2026-10-01", { signal: abortar() })).rejects.toMatchObject(cancelada);
    await expect(new OrdenesCompra(t).porCodigo("1-1-SE26", { signal: AbortSignal.abort() })).rejects.toMatchObject(cancelada);
    await expect(new Empresas(t).buscarComprador({ signal: AbortSignal.abort() })).rejects.toMatchObject(cancelada);
    await expect(new CompraAgilApi(t).pagina({ ttlCambioMs: 60_000 }, 1, { signal: AbortSignal.abort() })).rejects.toMatchObject(cancelada);
    await expect(new CompraAgilApi(t).listar({ ttlCambioMs: 60_000 }, { signal: AbortSignal.abort() }).next()).rejects.toMatchObject(cancelada);
  });
});

describe("validación en la entrada (sin gastar consultas)", () => {
  const { t, urls } = armar();
  const lic = new Licitaciones(t);
  const oc = new OrdenesCompra(t);
  const ca = new CompraAgilApi(t);
  it.each([
    ["fecha con otro formato", () => lic.delDia("01-10-2026")],
    ["fecha que no existe", () => oc.delDia("2026-02-30")],
    ["dia de porOrganismo", () => lic.porOrganismo("6945", { dia: "" })],
    ["código con espacios", () => lic.porCodigo("1509 5 LE26")],
    ["organismo vacío", () => oc.porOrganismo(" ", { dia: "2026-10-01" })],
    ["estado de licitación desconocido", () => lic.porEstado("abierta" as never)],
    ["estado de OC desconocido", () => oc.porEstado("enviadaproveedor" as never)],
    ["estado de Compra Ágil desconocido", () => ca.pagina({ estado: ["abierta" as never] }, 1)],
    ["id con espacios", () => ca.pagina({ id: "1 2" }, 1)],
    ["detalle con espacios", () => ca.detalle("1-1 COT26")],
    ["RUT que no es RUT", () => new Empresas(t).buscarProveedor("hola")],
    ["RUT con DV inválido", () => new Empresas(t).buscarProveedor("70.017.820-x")],
  ])("%s", async (_, llamar) => {
    await expect(llamar()).rejects.toMatchObject({ tipo: "parametros" });
    expect(urls).toHaveLength(0);
  });
});
