import { describe, expect, it } from "vitest";
import { Cuota, Transporte } from "../src/http.js";
import { MercadoPublicoError } from "../src/errores.js";
import { ddmmaaaa, desdeHoraSantiago, isoSantiago, normalizarFecha, proximaMedianoche } from "../src/fecha.js";

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status });

function transporte(respuestas: (Response | Error)[], extra: Partial<ConstructorParameters<typeof Transporte>[0]> = {}) {
  const urls: string[] = [];
  const t = new Transporte({
    ticket: "T",
    dormir: async () => {},
    fetch: async (url) => {
      urls.push(String(url));
      const r = respuestas.shift()!;
      if (r instanceof Error) throw r;
      return r;
    },
    ...extra,
  });
  return { t, urls };
}

describe("Transporte", () => {
  it("reintenta ante 10500, 5xx y corte de red, y cuenta cada intento en la cuota", async () => {
    const { t, urls } = transporte([
      json({ Codigo: 10500, Mensaje: "Lo sentimos. Hemos detectado que existen peticiones simultáneas." }, 500),
      new TypeError("fetch failed"),
      json({}, 503),
      json({ Cantidad: 0, Listado: [] }),
    ]);
    await expect(t.v1("licitaciones.json", { codigo: "1-1-L1" })).resolves.toEqual({ Cantidad: 0, Listado: [] });
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("ticket=T");
    expect(t.cuota.usadas).toBe(4);
  });

  it.each([
    ["429 por cuota", json({ Codigo: 429, Mensaje: "límite de peticiones" }, 429), "cuota_agotada"],
    ["ticket inválido", json({ Codigo: 203, Mensaje: "Ticket no válido." }, 500), "ticket_invalido"],
    ["404", json({}, 404), "no_encontrado"],
  ])("no reintenta ante %s", async (_, res, tipo) => {
    const { t, urls } = transporte([res, json({})]);
    const err = (await t.v1("x.json").catch((e: unknown) => e)) as MercadoPublicoError;
    expect(err).toBeInstanceOf(MercadoPublicoError);
    expect(err.tipo).toBe(tipo);
    expect(urls).toHaveLength(1);
  });

  it.each([
    ["10300 con HTTP 500 (v1 manda el código, no el status)", json({ Codigo: 10300, Mensaje: "El formato del parametro fechas es incorrecto" }, 500), "parametros"],
    ["un 400 que menciona un límite que no es la cuota", json({ Codigo: 1, Mensaje: "La fecha supera el límite permitido" }, 400), "parametros"],
    ["200 con un cuerpo que no es objeto", json("Servicio no disponible"), "respuesta_invalida"],
  ])("tampoco reintenta %s", async (_, res, tipo) => {
    const { t, urls } = transporte([res, json({})]);
    await expect(t.v1("x.json")).rejects.toMatchObject({ tipo });
    expect(urls).toHaveLength(1);
  });

  it("se rinde después de los reintentos configurados", async () => {
    const { t, urls } = transporte(Array.from({ length: 5 }, () => json({}, 502)), { reintentos: 2 });
    await expect(t.v1("x.json")).rejects.toMatchObject({ tipo: "servidor" });
    expect(urls).toHaveLength(3);
  });

  it("serializa las consultas: nunca hay dos en vuelo", async () => {
    let enVuelo = 0;
    let maximo = 0;
    const t = new Transporte({
      intervaloMs: 0,
      ticket: "T",
      fetch: async () => {
        maximo = Math.max(maximo, ++enVuelo);
        await new Promise((r) => setTimeout(r, 5));
        enVuelo--;
        return json({ Listado: [] });
      },
    });
    await Promise.all([t.v1("a"), t.v1("b"), t.v1("c").catch(() => {})]);
    expect(maximo).toBe(1);
  });

  it("deja un intervalo mínimo entre consultas (la API da 10500 a consultas seriales muy seguidas)", async () => {
    const esperas: number[] = [];
    // Reloj fijo: con el real, una máquina cargada se come parte del segundo entre las dos consultas.
    const ahora = () => new Date("2026-10-13T12:00:00Z");
    const t = new Transporte({ ticket: "T", ahora, dormir: async (ms) => void esperas.push(ms), fetch: async () => json({ Listado: [] }) });
    await t.v1("a");
    await t.v1("b");
    expect(esperas).toEqual([1000]);
  });

  it("v2 manda el ticket en header y devuelve payload", async () => {
    let headers: Headers | undefined;
    const t = new Transporte({
      ticket: "T",
      fetch: async (_, init) => {
        headers = new Headers(init?.headers);
        return json({ success: "OK", trace: null, payload: { items: [1] }, errors: null });
      },
    });
    await expect(t.v2("compra-agil", { region: [13, 5] })).resolves.toEqual({ items: [1] });
    expect(headers?.get("ticket")).toBe("T");
  });

  it("v2 con success NOK es error tipado", async () => {
    const { t } = transporte([json({ success: "NOK", payload: null, errors: [{ codigo: "400", mensaje: "parámetro inválido", detalle: null }] }, 400)]);
    await expect(t.v2("x")).rejects.toMatchObject({ tipo: "parametros", message: "parámetro inválido" });
    const { t: t3 } = transporte([json({ success: "ERROR", payload: null, errors: [{ codigo: "ERROR_INTERNO", mensaje: "Servicio no disponible, intente nuevamente más tarde", detalle: "" }] }, 500)], { reintentos: 0 });
    await expect(t3.v2("x")).rejects.toMatchObject({ tipo: "servidor", message: "Servicio no disponible, intente nuevamente más tarde" });
    const { t: t2 } = transporte([json({ success: "NOK", payload: null, errors: [{ codigo: "429", mensaje: "Too many requests" }] }, 429)]);
    await expect(t2.v2("x")).rejects.toMatchObject({ tipo: "cuota_agotada" });
  });
});

describe("Cuota", () => {
  it("falla antes de empezar si no alcanza y se reinicia al cambiar el día en Santiago", () => {
    let ahora = new Date("2026-10-14T23:00:00-03:00");
    const c = new Cuota(100, { dia: "2026-10-14", usadas: 90 }, () => ahora);
    expect(() => c.exigir(20, "el sync")).toThrow(/el sync necesita unas 20 consultas y quedan 10/);
    expect(c.reinicia).toBe("2026-10-15T00:00:00-03:00");
    ahora = new Date("2026-10-15T00:30:00-03:00");
    expect(c.usadas).toBe(0);
  });
});

describe("fechas", () => {
  it("interpreta la hora de pared de Santiago con horario de verano e invierno", () => {
    expect(isoSantiago(desdeHoraSantiago("2026-01-15T15:00:00"))).toBe("2026-01-15T15:00:00-03:00");
    expect(isoSantiago(desdeHoraSantiago("2026-07-15T15:00:00"))).toBe("2026-07-15T15:00:00-04:00");
    expect(normalizarFecha("2026-07-15T19:00:00Z")).toBe("2026-07-15T15:00:00-04:00");
    expect(normalizarFecha(null)).toBeNull();
  });
  it("bordes del horario de verano en Santiago (2026-09-06 y 2026-04-05)", () => {
    // Inicio: de 00:00 se salta a 01:00; la hora inexistente avanza y no cae en el día anterior.
    expect(normalizarFecha("2026-09-06")).toBe("2026-09-06T01:00:00-03:00");
    expect(normalizarFecha("2026-09-06T00:30:00")).toBe("2026-09-06T01:30:00-03:00");
    expect(normalizarFecha("2026-09-06T02:00:00")).toBe("2026-09-06T02:00:00-03:00");
    expect(proximaMedianoche(new Date("2026-09-05T12:00:00-04:00"))).toBe("2026-09-06T01:00:00-03:00");
    // Fin: 23:30 del 4 de abril ocurre dos veces; gana la primera (-03).
    expect(normalizarFecha("2026-04-04T23:30:00")).toBe("2026-04-04T23:30:00-03:00");
    expect(normalizarFecha("2026-04-05T10:00:00")).toBe("2026-04-05T10:00:00-04:00");
  });
  it("formatos auxiliares", () => {
    expect(ddmmaaaa("2026-10-01")).toBe("01102026");
    expect(proximaMedianoche(new Date("2026-07-01T12:00:00Z"))).toBe("2026-07-02T00:00:00-04:00");
  });
});
