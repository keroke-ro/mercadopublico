// Regresiones de la revisión final de resiliencia (un caso por hallazgo).
import { describe, expect, it, vi } from "vitest";
import type { Evento } from "../src/eventos.js";
import { Transporte } from "../src/http.js";
import { Licitaciones } from "../src/v1/licitaciones.js";

const json = (cuerpo: unknown, status = 200) => new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status });
const OK = { Cantidad: 0, Listado: [] };

function con(respuestas: Response[], extra: Partial<ConstructorParameters<typeof Transporte>[0]> = {}) {
  let llamadas = 0;
  const t = new Transporte({
    ticket: "TICKET-SECRETO",
    intervaloMs: 0,
    dormir: async () => {},
    fetch: async () => (llamadas++, respuestas.shift() ?? json(OK)),
    ...extra,
  });
  return { t, llamadas: () => llamadas };
}

describe("429 de la v1", () => {
  it.each([
    ["sin cuerpo", json("", 429)],
    ["con HTML de un proxy", json("<html>Too Many Requests</html>", 429)],
  ])("%s es freno por ritmo: se reintenta y no agota la cuota local", async (_, r) => {
    const { t, llamadas } = con([r]);
    await expect(t.v1("x.json")).resolves.toEqual(OK);
    expect(llamadas()).toBe(2);
    expect(t.cuota.restante).toBeGreaterThan(9_000);
  });

  it("con mensaje de cuota sí es cuota agotada", async () => {
    const { t } = con([json({ Codigo: 429, Mensaje: "Superó el límite diario de consultas" }, 429)]);
    await expect(t.v1("x.json")).rejects.toMatchObject({ tipo: "cuota_agotada" });
    expect(t.cuota.restante).toBe(0);
  });
});

describe("5xx de la v1 con Codigo", () => {
  it("un Codigo que es 5xx HTTP es falla del servidor (se reintenta); un Codigo propio con 500 es del pedido", async () => {
    const a = con([json({ Codigo: 500, Mensaje: "Error interno" }, 500)]);
    await expect(a.t.v1("x.json")).resolves.toEqual(OK);
    expect(a.llamadas()).toBe(2);
    const b = con([json({ Codigo: 10300, Mensaje: "El formato del parametro fechas es incorrecto" }, 500)]);
    await expect(b.t.v1("x.json")).rejects.toMatchObject({ tipo: "parametros" });
    expect(b.llamadas()).toBe(1);
  });
});

describe("circuito y cuota", () => {
  it("si la cuota local se acabó cuando termina el enfriamiento, el circuito no queda trabado en semiabierto", async () => {
    let ahora = new Date("2026-10-14T12:00:00-03:00");
    let caida = true;
    const t = new Transporte({
      ticket: "T",
      intervaloMs: 0,
      reintentos: 0,
      limiteDiario: 3,
      ahora: () => ahora,
      dormir: async () => {},
      circuito: { umbral: 2, enfriamientoMs: 1000 },
      fetch: async () => (caida ? json({}, 503) : json(OK)),
    });
    await expect(t.v1("a")).rejects.toMatchObject({ tipo: "servidor" });
    await expect(t.v1("a")).rejects.toMatchObject({ tipo: "servidor" });
    await expect(t.v1("a")).rejects.toMatchObject({ tipo: "circuito_abierto" });
    t.cuota.registrar(10); // se agotó la cuota local
    ahora = new Date(ahora.getTime() + 2000);
    await expect(t.v1("a")).rejects.toMatchObject({ tipo: "cuota_insuficiente" });
    // Al día siguiente la API está sana: la sonda pasa y el circuito se cierra.
    caida = false;
    ahora = new Date("2026-10-15T09:00:00-03:00");
    await expect(t.v1("a")).resolves.toEqual(OK);
    expect(t.salud().v1.estado).toBe("cerrado");
  });
});

describe("ticket", () => {
  it("la causa de un error de red no lleva el ticket (Bun lo pone en path, Deno en el mensaje)", async () => {
    const t = new Transporte({
      ticket: "TICKET-SECRETO",
      intervaloMs: 0,
      reintentos: 0,
      fetch: async (u) => {
        throw Object.assign(new TypeError(`fetch failed: ${String(u)}`), { path: String(u), code: "ECONNREFUSED" });
      },
    });
    const e = (await t.v1("x.json").catch((x: unknown) => x)) as Error & { cause: unknown };
    expect(e).toMatchObject({ tipo: "red" });
    const todo = JSON.stringify({ m: e.message, c: e.cause, s: String(e.cause), stack: (e.cause as Error).stack });
    expect(todo).not.toContain("TICKET-SECRETO");
    expect((e.cause as { code?: string }).code).toBe("ECONNREFUSED");
  });
});

describe("avisos", () => {
  it("un campo nuevo repetido en muchos procesos genera un solo evento por cliente", async () => {
    const eventos: Evento[] = [];
    const item = (n: number) => ({ CodigoExterno: `1-${n}-L126`, Nombre: "x", CodigoEstado: 5, FechaCierre: null, CampoNuevo: n });
    const cuerpo = { Cantidad: 50, Listado: Array.from({ length: 50 }, (_, i) => item(i)) };
    const t = new Transporte({ ticket: "T", intervaloMs: 0, alEvento: (e) => eventos.push(e), fetch: async () => json(cuerpo) });
    const l = new Licitaciones(t);
    await l.delDia("2026-10-10");
    await l.delDia("2026-10-11");
    const avisos = eventos.filter((e) => e.tipo === "aviso" && e.ruta.includes("CampoNuevo"));
    expect(avisos).toHaveLength(1);
  });
});

describe("cancelación", () => {
  it("cancelar desde el hook de reintento no deja un timer de backoff vivo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const c = new AbortController();
      const t = new Transporte({
        ticket: "T",
        intervaloMs: 0,
        esperaBaseMs: 60_000,
        alEvento: (e) => e.tipo === "reintento" && c.abort(),
        fetch: async () => json({}, 503),
      });
      await expect(t.v1("x.json", {}, { signal: c.signal })).rejects.toMatchObject({ tipo: "cancelada" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
