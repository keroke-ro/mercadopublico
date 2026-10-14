// Casos que dejó vivos Stryker en src/http.ts (ver stryker.config.json). Sin red ni esperas reales.
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MercadoPublicoError, type TipoError } from "../../src/errores.js";
import type { Evento } from "../../src/eventos.js";
import { isoSantiago } from "../../src/fecha.js";
import { Circuito, Cuota, Transporte, type OpcionesTransporte } from "../../src/http.js";

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status });
const ok = () => json({ Cantidad: 0, Listado: [] });
const T0 = Date.parse("2026-10-13T12:00:00-03:00");

/** Reloj falso que avanza con `dormir`; `respuestas` se consumen en orden y luego responde vacío. */
function armar(respuestas: (Response | Error | (() => Response))[] = [], extra: Partial<OpcionesTransporte> = {}) {
  const reloj = { t: T0 };
  const eventos: Evento[] = [];
  const t = new Transporte({
    ticket: "T",
    intervaloMs: 0,
    esperaBaseMs: 0,
    ahora: () => new Date(reloj.t),
    dormir: async (ms) => void (reloj.t += ms),
    alEvento: (e) => void eventos.push(e),
    fetch: async () => {
      const r = respuestas.shift() ?? ok;
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r() : r;
    },
    ...extra,
  });
  const de = <K extends Evento["tipo"]>(tipo: K) => eventos.filter((e): e is Extract<Evento, { tipo: K }> => e.tipo === tipo);
  return { t, reloj, de };
}

const fallo = (p: Promise<unknown>) => p.then(() => expect.unreachable("debía fallar"), (e: unknown) => e as MercadoPublicoError);

const anyOriginal = AbortSignal.any;
afterEach(() => {
  AbortSignal.any = anyOriginal;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Cuota", () => {
  it("exigir deja pasar justo lo que queda y su mensaje dice qué no cabe", () => {
    const c = new Cuota(10, { dia: "2026-10-13", usadas: 5 }, () => new Date(T0));
    expect(() => c.exigir(5)).not.toThrow();
    expect(() => c.exigir(6)).toThrow("la operación necesita unas 6 consultas y quedan 5 de 10 hasta 2026-10-14T00:00:00-03:00");
  });

  it("agotar deja la cuenta en el límite y, si ya estaba, no vuelve a avisar", () => {
    const eventos: Evento[] = [];
    const c = new Cuota(10, { dia: "2026-10-13", usadas: 10 }, () => new Date(T0), (e) => void eventos.push(e));
    c.agotar();
    expect(eventos).toEqual([]);
    const d = new Cuota(10, { dia: "2026-10-13", usadas: 3 }, () => new Date(T0), (e) => void eventos.push(e));
    d.agotar();
    expect(d.restante).toBe(0);
    expect(eventos).toHaveLength(3); // 80%, 95% y 100%
  });

  it("sin cuota local, la consulta falla antes de salir y lo dice", async () => {
    const { t } = armar([], { limiteDiario: 1 });
    await t.v1("x");
    const e = await fallo(t.v1("x"));
    expect(e.tipo).toBe("cuota_insuficiente");
    expect(e.message).toMatch(/^la consulta necesita unas 1 consultas y quedan 0 de 1/);
  });
});

describe("Circuito", () => {
  const armarCircuito = () => {
    const reloj = { t: T0 };
    const eventos: Evento[] = [];
    const c = new Circuito("v1", { umbral: 1, enfriamientoMs: 1000, ahora: () => new Date(reloj.t), alEvento: (e) => void eventos.push(e) });
    return { c, reloj, eventos };
  };
  const err = (tipo: TipoError) => new MercadoPublicoError(tipo, tipo);

  it.each(["servidor", "red", "respuesta_invalida"] as const)("%s cuenta como caída", (tipo) => {
    const { c } = armarCircuito();
    c.anotar(err(tipo));
    expect(c.estado).toBe("abierto");
  });

  it("una cancelación con el circuito cerrado no lo abre", () => {
    const { c } = armarCircuito();
    c.anotar(err("cancelada"));
    expect(c.estado).toBe("cerrado");
    expect(() => c.exigir()).not.toThrow();
  });

  it("una respuesta inválida cuenta como caída; el mensaje dice cuándo se vuelve a probar o que hay una sonda", () => {
    const { c, reloj } = armarCircuito();
    c.anotar(err("respuesta_invalida"));
    expect(c.estado).toBe("abierto");
    expect(() => c.exigir()).toThrow(`v1 viene fallando (1 seguidas); se vuelve a probar después de ${isoSantiago(new Date(T0 + 1000))}`);
    reloj.t += 1000;
    c.exigir(); // la sonda pasa
    expect(c.estado).toBe("semiabierto");
    expect(() => c.exigir()).toThrow("v1 viene fallando (1 seguidas); hay una sonda en curso");
  });

  it.each([
    ["un error que no es del SDK", new Error("x")],
    ["una cancelación", err("cancelada")],
    ["un circuito abierto", err("circuito_abierto")],
  ])("%s en la sonda no decide: la próxima llamada vuelve a ser sonda", (_, e) => {
    const { c, reloj } = armarCircuito();
    c.falla();
    reloj.t += 1000;
    c.exigir();
    c.anotar(e);
    expect(c.estado).toBe("abierto");
    expect(c.fallas).toBe(1);
    c.exigir(); // sin esperar otro enfriamiento
    expect(c.estado).toBe("semiabierto");
    c.anotar();
    expect(c.salud()).toMatchObject({ estado: "cerrado", fallas: 0 });
  });

  it("avisa solo los cambios de estado", () => {
    const { c, eventos } = armarCircuito();
    c.exito();
    c.falla();
    c.falla();
    expect(eventos).toEqual([{ tipo: "circuito", fuente: "v1", estado: "abierto", fallas: 1 }]);
  });

  it("sin reloj inyectado usa el real", () => {
    const c = new Circuito("v2");
    c.falla();
    expect(Math.abs(Date.parse(c.salud().ultimaFalla!) - Date.now())).toBeLessThan(5000);
  });
});

describe("Transporte: errores de la API", () => {
  /** Error de una sola consulta, sin reintentos. */
  const error = (api: "v1" | "v2", cuerpo: string | Response, status = 200) => {
    const { t } = armar([typeof cuerpo === "string" ? new Response(cuerpo, { status }) : cuerpo], { reintentos: 0 });
    return fallo(api === "v1" ? t.v1("x") : t.v2("x"));
  };
  const e1 = (cuerpo: unknown, status = 200) => error("v1", JSON.stringify(cuerpo), status);
  const e2 = (cuerpo: unknown, status = 200) => error("v2", JSON.stringify(cuerpo), status);

  it("v1: el Codigo manda aunque el HTTP sea 200", async () => {
    expect(await e1({ Codigo: 203, Mensaje: "Ticket no válido." })).toMatchObject({ tipo: "ticket_invalido", status: 200, codigo: 203 });
    expect(await e1({ Codigo: 10500, Mensaje: "otra cosa" }, 500)).toMatchObject({ tipo: "simultaneas" });
    expect(await e1({ Codigo: 999, Mensaje: "Se alcanzó el límite diario" }, 500)).toMatchObject({ tipo: "cuota_agotada" });
    // Sin Mensaje, el texto del error es el status.
    expect(await e1({ Codigo: 123 }, 400)).toMatchObject({ tipo: "parametros", message: "HTTP 400" });
  });

  it("v1: un listado con campos `success`/`errors` no es un error v2", async () => {
    const { t } = armar([json({ Cantidad: 0, success: "NOK", errors: ["x"] })]);
    await expect(t.v1("x")).resolves.toEqual({ Cantidad: 0, success: "NOK", errors: ["x"] });
  });

  it("v2: success true con errors no es error", async () => {
    const { t } = armar([json({ success: true, errors: [{ mensaje: "aviso" }], payload: 7 })]);
    await expect(t.v2("x")).resolves.toBe(7);
  });

  it("v2: errores en texto, null o varios se unen sin romperse", async () => {
    expect(await e2({ success: "NOK", errors: ["texto plano", { mensaje: "otro" }] }, 409)).toMatchObject({ tipo: "parametros", message: "texto plano; otro" });
    expect(await e2({ success: "NOK", errors: [null] }, 400)).toMatchObject({ tipo: "parametros", message: "null" });
    expect(await e2({ success: "NOK", errors: [{ codigo: "X", mensaje: "Peticiones simultaneas" }] }, 400)).toMatchObject({ tipo: "simultaneas" });
  });

  it("v2: sin mensaje decide el status", async () => {
    expect(await e2({}, 429)).toMatchObject({ tipo: "cuota_agotada", message: "HTTP 429" });
    expect(await e2({ foo: 1 }, 400)).toMatchObject({ tipo: "parametros", status: 400 });
    expect(await e2({}, 422)).toMatchObject({ tipo: "parametros" });
    expect(await e2({}, 418)).toMatchObject({ tipo: "respuesta_invalida", message: "HTTP 418" });
  });

  it("cada formato de error se lee solo en su API", async () => {
    // v1: un Codigo junto a un Listado es un listado; un {mensaje} suelto no es error v1.
    const { t } = armar([json({ Codigo: 0, Mensaje: "ok", Listado: [] })]);
    await expect(t.v1("x")).resolves.toEqual({ Codigo: 0, Mensaje: "ok", Listado: [] });
    expect(await e1({ mensaje: "x" }, 400)).toMatchObject({ tipo: "parametros", message: "HTTP 400" });
    // v2: ni un {Codigo} de v1 ni success "OK" con errors son error.
    const b = armar([json({ Codigo: 5, Mensaje: "x", payload: 1 }), json({ success: "OK", errors: ["aviso"], payload: 2 }), json({ mensaje: "hola", payload: 3 })]);
    await expect(b.t.v2("x")).resolves.toBe(1);
    await expect(b.t.v2("x")).resolves.toBe(2);
    await expect(b.t.v2("x")).resolves.toBe(3);
  });

  it("v2: error sin sobre {codigo, mensaje} desde el 400; un mensaje que no es texto no cuenta", async () => {
    expect(await e2({ codigo: "X", mensaje: "malo" }, 400)).toMatchObject({ tipo: "parametros", message: "malo", codigo: "X" });
    expect(await e2({ mensaje: 5 }, 400)).toMatchObject({ tipo: "parametros", message: "HTTP 400" });
  });

  it("cuota agotada solo con mensaje de cuota y código, o el 429 de la v2", async () => {
    expect(await e2({ success: "NOK", errors: ["Se alcanzó la cuota"] }, 400)).toMatchObject({ tipo: "parametros" });
    expect(await e2({ success: "NOK", errors: [{ codigo: "429", mensaje: "Too many" }] })).toMatchObject({ tipo: "cuota_agotada" });
    expect(await e2({}, 403)).toMatchObject({ tipo: "ticket_invalido" });
  });

  it("ticket inválido: en la v1 por texto (con o sin tilde), en la v2 no", async () => {
    for (const m of ["Ticket no es válido", "Ticket inválido", "El ticket ingresado no existe"]) {
      expect(await e1({ Codigo: 1, Mensaje: m }, 400)).toMatchObject({ tipo: "ticket_invalido" });
    }
    expect(await e2({ success: "NOK", errors: [{ codigo: "X", mensaje: "Ticket inválido" }] }, 400)).toMatchObject({ tipo: "parametros" });
  });

  it("v1: un Codigo 5xx es del servidor; 600 ya no", async () => {
    expect(await e1({ Codigo: 599, Mensaje: "x" }, 200)).toMatchObject({ tipo: "servidor" });
    expect(await e1({ Codigo: 600, Mensaje: "x" }, 200)).toMatchObject({ tipo: "parametros" });
  });

  it("un 200 que no es objeto o no es JSON es respuesta inválida; un 5xx con HTML es del servidor", async () => {
    expect(await e1("Servicio no disponible")).toMatchObject({ tipo: "respuesta_invalida", status: 200, message: "La API respondió un JSON inesperado" });
    expect(await error("v1", "no es json")).toMatchObject({ tipo: "respuesta_invalida", status: 200, message: "La API respondió algo que no es JSON" });
    expect(await error("v1", "<html>caído</html>", 502)).toMatchObject({ tipo: "servidor", status: 502 });
  });
});

describe("Transporte: red", () => {
  it("sin ticket no arma nada", () => {
    expect(() => new Transporte({ ticket: "" })).toThrow(
      expect.objectContaining({ tipo: "ticket_invalido", message: "Falta el ticket de la API de Mercado Público" }),
    );
  });

  it("sin fetch inyectado usa el global", async () => {
    const f = vi.fn(async () => ok());
    vi.stubGlobal("fetch", f);
    const t = new Transporte({ ticket: "T", intervaloMs: 0 });
    await expect(t.v1("x")).resolves.toEqual({ Cantidad: 0, Listado: [] });
    expect(f).toHaveBeenCalledOnce();
  });

  it("arma la URL sin parámetros vacíos ni barras dobles, y pide JSON", async () => {
    const pedidos: { url: string; accept: string | null }[] = [];
    const { t } = armar([], {
      baseV1: "https://h/api/",
      fetch: async (u, init) => (pedidos.push({ url: String(u), accept: new Headers(init?.headers).get("accept") }), ok()),
    });
    await t.v1("/x.json", { a: undefined, b: null, c: "", d: 0, e: [1, 2] });
    expect(pedidos).toEqual([{ url: "https://h/api/x.json?d=0&e=1%2C2&ticket=T", accept: "application/json" }]);
  });

  it("el error de red no lleva el ticket en la causa", async () => {
    const conCodigo = Object.assign(new Error("GET https://h/?ticket=SECRETO falló"), { code: "ECONNRESET", cause: { code: "UND_ERR" } });
    const a = armar([conCodigo], { reintentos: 0, ticket: "SECRETO" });
    const e = await fallo(a.t.v1("x"));
    expect(e.cause).toMatchObject({ name: "Error", message: "GET https://h/?ticket=*** falló", code: "ECONNRESET", cause: { code: "UND_ERR" } });
    const b = armar([], { reintentos: 0, ticket: "SECRETO", fetch: () => Promise.reject("texto con SECRETO") });
    const c = (await fallo(b.t.v1("x"))).cause as Error;
    expect([c.name, c.message, "code" in c]).toEqual(["Error", "texto con ***", false]);
  });

  it("cancelar durante el fetch no cuenta como caída", async () => {
    const c = new AbortController();
    const { t } = armar([], { reintentos: 0, fetch: () => (c.abort(), Promise.reject(new Error("abortado"))) });
    expect(await fallo(t.v1("x", {}, { signal: c.signal }))).toMatchObject({ tipo: "cancelada" });
    await new Promise((r) => setImmediate(r));
    expect(t.salud().v1.fallas).toBe(0);
  });

  it("sin AbortSignal.any tampoco deja listeners en el signal del usuario", async () => {
    (AbortSignal as { any?: unknown }).any = undefined;
    const c = new AbortController();
    const { t } = armar();
    await t.v1("a", {}, { signal: c.signal });
    await new Promise((r) => setImmediate(r));
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });

  it("cada circuito lleva el nombre de su fuente", () => {
    const { t } = armar();
    for (const [f, c] of Object.entries(t.circuitos)) expect(c.fuente).toBe(f);
  });

  it("avisa una vez por origen, tipo y ruta", () => {
    const { t, de } = armar();
    t.avisar({ tipo: "campo_nuevo", origen: "v1", ruta: "a" });
    t.avisar({ tipo: "campo_nuevo", origen: "v1", ruta: "a", codigo: "otro" });
    t.avisar({ tipo: "campo_nuevo", origen: "v1", ruta: "b" });
    t.avisar({ tipo: "tipo_distinto", origen: "v1", ruta: "a" });
    expect(de("aviso").map((e) => `${e.aviso} ${e.ruta}`)).toEqual(["campo_nuevo a", "campo_nuevo b", "tipo_distinto a"]);
  });

  it("el evento consulta mide lo que tardó", async () => {
    const { t, reloj, de } = armar([], { fetch: async () => ((reloj.t += 50), ok()) });
    await t.v1("x");
    expect(de("consulta")[0]).toMatchObject({ ms: 50, status: 200, intento: 1 });
  });

  it("un corte al conectar o a mitad de la respuesta es error de red con la causa", async () => {
    const corte = new TypeError("fetch failed");
    const { t } = armar([corte], { reintentos: 0 });
    expect(await fallo(t.v1("x"))).toMatchObject({ tipo: "red", message: "No se pudo conectar con api.mercadopublico.cl", cause: corte });
    const mitad = new Error("socket hang up");
    const r = { status: 200, ok: true, text: () => Promise.reject(mitad) } as unknown as Response;
    const b = armar([() => r], { reintentos: 0 });
    expect(await fallo(b.t.v1("x"))).toMatchObject({ tipo: "red", message: "Se cortó la respuesta de api.mercadopublico.cl", cause: mitad });
  });

  it("cancelar mientras llega el cuerpo no cuenta como caída", async () => {
    const c = new AbortController();
    const r = { status: 200, ok: true, text: () => (c.abort(), new Promise(() => {})) } as unknown as Response;
    const { t } = armar([() => r], { reintentos: 0 });
    expect(await fallo(t.v1("x", {}, { signal: c.signal }))).toMatchObject({ tipo: "cancelada" });
    await new Promise((r) => setImmediate(r));
    expect(t.salud().v1.fallas).toBe(0);
    // y la cola no queda trabada esperando ese cuerpo
    await expect(t.v1("y")).resolves.toEqual({ Cantidad: 0, Listado: [] });
  }, 1000);

  it.each([
    ["AbortSignal.any", false],
    ["sin AbortSignal.any (Node 20.0-20.2)", true],
  ])("con %s el signal del usuario llega al fetch", async (_, sinAny) => {
    if (sinAny) (AbortSignal as { any?: unknown }).any = undefined;
    let senal: AbortSignal | undefined;
    let abortadaAlLlamar = true;
    const c = new AbortController();
    const { t } = armar([], {
      fetch: (_, init) => {
        senal = init!.signal!;
        abortadaAlLlamar = senal.aborted;
        return new Promise(() => {});
      },
    });
    const p = fallo(t.v1("x", {}, { signal: c.signal }));
    await vi.waitFor(() => expect(senal).toBeDefined());
    expect(abortadaAlLlamar).toBe(false);
    c.abort("basta");
    expect(senal!.aborted).toBe(true);
    expect(senal!.reason).toBe("basta");
    expect(await p).toMatchObject({ tipo: "cancelada", message: "Consulta cancelada", cause: "basta" });
  });

  it("sin signal del usuario igual corta por timeout", async () => {
    const { t } = armar([], {
      reintentos: 0,
      timeoutMs: 1,
      fetch: (_, init) => new Promise((_, mal) => init?.signal?.addEventListener("abort", () => mal(init.signal!.reason))),
    });
    expect(await fallo(t.v1("x"))).toMatchObject({ tipo: "red" });
  });

  it("no deja listeners colgados en el signal del usuario", async () => {
    const c = new AbortController();
    const { t } = armar([], { intervaloMs: 100 });
    await t.v1("a", {}, { signal: c.signal });
    await t.v1("b", {}, { signal: c.signal }); // con pausa de ritmo
    await new Promise((r) => setImmediate(r)); // el finally de cancelable corre después de resolver
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });
});

describe("Transporte: dormir real (timers falsos)", () => {
  const armarReal = (intervaloMs = 1000) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const urls: string[] = [];
    const t = new Transporte({ ticket: "T", intervaloMs, ahora: () => new Date(T0), fetch: async (u) => (urls.push(String(u)), ok()) });
    return { t, urls };
  };

  it("espera el intervalo, sin signal y con signal, y no deja nada pendiente", async () => {
    const { t, urls } = armarReal();
    await t.v1("a");
    const p = t.v1("b");
    await vi.advanceTimersByTimeAsync(999);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(urls).toHaveLength(2);

    const c = new AbortController();
    const q = t.v1("c", {}, { signal: c.signal });
    await vi.advanceTimersByTimeAsync(1000);
    await q;
    expect(urls).toHaveLength(3);
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("al cancelar la pausa suelta el timer", async () => {
    const { t, urls } = armarReal();
    await t.v1("a");
    const c = new AbortController();
    const p = fallo(t.v1("b", {}, { signal: c.signal }));
    await vi.advanceTimersByTimeAsync(10);
    c.abort();
    expect(await p).toMatchObject({ tipo: "cancelada" });
    expect(vi.getTimerCount()).toBe(0);
    expect(urls).toHaveLength(1);
  });
});

describe("Transporte: backoff, ritmo y presupuesto", () => {
  it("backoff exponencial con jitter entre la mitad y el total", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { t, de } = armar([json({}, 502), json({}, 502), json({}, 502), json({}, 502)], { esperaBaseMs: 1000 });
    await t.v1("x");
    expect(de("reintento").map((e) => e.esperaMs)).toEqual([750, 1500, 3000, 6000]);
  });

  it("la espera base por defecto es 1 s, y solo un 10500 sube la pausa", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { t, de } = armar([json({}, 502)], { esperaBaseMs: undefined, intervaloMs: 100 });
    await t.v1("x");
    expect(de("reintento").map((e) => e.esperaMs)).toEqual([750]);
    expect(de("ritmo")).toEqual([]);
  });

  it("baja la pausa justo al llegar a `exitos` éxitos seguidos", async () => {
    const r10500 = () => json({ Codigo: 10500, Mensaje: "simultáneas" }, 429);
    const { t, de } = armar([r10500()], { intervaloMs: 100, ritmo: { exitos: 2 } });
    await t.v1("a"); // 10500 y reintento exitoso: 1 éxito
    await t.v1("b"); // 2 éxitos
    expect(de("ritmo").map((e) => e.intervaloMs)).toEqual([200, 100]);
  });

  it("los reintentos se limitan al 30% de los últimos 100 intentos, no de toda la historia", async () => {
    let caido = false;
    const { t, de } = armar([], { reintentos: 2, circuito: { umbral: 1e9 }, fetch: async () => (caido ? json({}, 502) : ok()) });
    for (let i = 0; i < 100; i++) await t.v1("x");
    caido = true;
    for (let i = 0; i < 20; i++) await t.v1("x").catch(() => {});
    expect(de("reintento")).toHaveLength(30);
  });
});
