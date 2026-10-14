// Casos que dejó vivos Stryker en src/monto.ts (ver stryker.config.json). fetch falso, sin red.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Evento } from "../../src/eventos.js";
import { Circuito } from "../../src/http.js";
import type { Monto, Proceso } from "../../src/modelo.js";
import {
  cadenaPorDefecto,
  conversorBancoCentral,
  conversorMindicador,
  conversorParidadChileCompra,
  convertirMontos,
  leerSerieBancoCentral,
} from "../../src/monto.js";

afterEach(() => vi.unstubAllGlobals());

const serie = (...pares: [string, number | null][]) => ({ serie: pares.map(([d, valor]) => ({ fecha: `${d}T03:00:00.000Z`, valor })) });
const responder = (r: (url: string, init?: RequestInit) => Response) => {
  const llamadas: string[] = [];
  const fetch: typeof globalThis.fetch = async (u, init) => (llamadas.push(String(u)), r(String(u), init));
  return { fetch, llamadas };
};

describe("descargar (vía mindicador)", () => {
  it("un 5xx es caída del circuito; un 4xx no (la fuente responde)", async () => {
    for (const [status, fallas] of [[500, 1], [503, 1], [404, 0]] as const) {
      const circuito = new Circuito("mindicador");
      const { fetch } = responder(() => new Response("", { status }));
      expect(await conversorMindicador({ fetch, circuito })("USD", "2026-10-09")).toBeNull();
      expect(circuito.fallas).toBe(fallas);
    }
  });

  it("usa la URL pública por defecto y avisa cada intento con su fuente", async () => {
    const eventos: Evento[] = [];
    const { fetch, llamadas } = responder(() => Response.json(serie(["2026-10-09", 947.5])));
    await conversorMindicador({ fetch, alEvento: (e) => void eventos.push(e) })("USD", "2026-10-09");
    expect(llamadas).toEqual(["https://mindicador.cl/api/dolar/2026"]);
    expect(eventos).toEqual([{ tipo: "conversion", fuente: "mindicador", ok: true, moneda: "USD", dia: "2026-10-09" }]);
  });

  it("busca hasta 7 días atrás y salta valores que no son número", async () => {
    const { fetch } = responder(() => Response.json(serie(["2026-10-02", 900], ["2026-10-08", null])));
    const c = conversorMindicador({ fetch });
    expect(await c("USD", "2026-10-09")).toEqual({ valor: 900, fechaValor: "2026-10-02", fuente: "mindicador.cl" });
    expect(await c("USD", "2026-10-10")).toBeNull(); // 8 días: ya no
  });
});

describe("Banco Central", () => {
  const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  it("lee los doce meses; salta filas sin día en la primera celda y tolera espacios", () => {
    const celdas = MESES.map((m, i) => `<td><span id="gr_ctl02_${m}">${i + 1},5</span></td>`).join("");
    const html = `<table><tr><th>Día</th></tr><tr><td><b>x</b></td><td> 7 </td><td><span id="gr_ctl03_Enero">1</span></td></tr><tr><td> 3 </td>${celdas}</tr></table>`;
    const d = leerSerieBancoCentral(html, "2025");
    expect([...d]).toEqual(MESES.map((_, i) => [`2025-${String(i + 1).padStart(2, "0")}-03`, i + 1.5]));
  });

  it("año pasado: el postback lleva los campos del formulario y la cookie de la sesión", async () => {
    const pagina = (anio: string, extra = "") =>
      `<option selected="selected" value="${anio}">${anio}</option>${extra}<tr><td>2</td><td><span id="gr_ctl02_Enero">${anio === "2024" ? "900,5" : "1"}</span></td></tr>`;
    const ocultos = ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "hdnFrecuencia"].map((n) => `<input name="${n}" value="v${n}" />`).join("");
    let post: { cuerpo: URLSearchParams; headers: Headers } | undefined;
    const { fetch, llamadas } = responder((url, init) => {
      if (url.endsWith("Indicadoresdiarios.aspx")) return new Response(`<a href="Serie.aspx?gcode=PRE_TCO&amp;param=pTCO">x</a>`);
      if (init?.method === "POST") {
        post = { cuerpo: new URLSearchParams(String(init.body)), headers: new Headers(init.headers) };
        return new Response(pagina("2024"));
      }
      const h = new Headers();
      h.append("set-cookie", "a=1; path=/");
      h.append("set-cookie", "b=2; HttpOnly");
      return new Response(pagina("2026", ocultos), { headers: h });
    });
    expect(await conversorBancoCentral({ fetch })("USD", "2024-01-02")).toEqual({ valor: 900.5, fechaValor: "2024-01-02", fuente: "bcentral.cl" });
    expect(llamadas[0]).toBe("https://si3.bcentral.cl/Indicadoressiete/secure/Indicadoresdiarios.aspx");
    expect(Object.fromEntries(post!.cuerpo)).toEqual({
      __EVENTTARGET: "DrDwnFechas",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      __VIEWSTATE: "v__VIEWSTATE",
      __VIEWSTATEGENERATOR: "v__VIEWSTATEGENERATOR",
      __EVENTVALIDATION: "v__EVENTVALIDATION",
      DrDwnFechas: "2024",
      hdnFrecuencia: "vhdnFrecuencia",
    });
    expect(post!.headers.get("cookie")).toBe("a=1; b=2");
  });

  it("un campo oculto que falta va vacío y sin cookie no se manda el header", async () => {
    let post: { cuerpo: URLSearchParams; headers: Headers } | undefined;
    const { fetch } = responder((url, init) => {
      if (url.endsWith("Indicadoresdiarios.aspx")) return new Response(`<a href="Serie.aspx?gcode=PRE_TCO&amp;param=pTCO">x</a>`);
      if (init?.method === "POST") post = { cuerpo: new URLSearchParams(String(init.body)), headers: new Headers(init.headers) };
      return new Response(`<option selected="selected" value="2026">2026</option>`);
    });
    expect(await conversorBancoCentral({ fetch })("USD", "2024-01-02")).toBeNull();
    expect(post!.cuerpo.get("__VIEWSTATE")).toBe("");
    expect(post!.headers.has("cookie")).toBe(false);
  });

  it("sin enlace para la moneda no pide la serie", async () => {
    const { fetch, llamadas } = responder(() => new Response(`<a href="Serie.aspx?gcode=UF&amp;param=pUF">x</a>`));
    expect(await conversorBancoCentral({ fetch, url: "https://bc/" })("USD", "2026-10-09")).toBeNull();
    expect(llamadas).toEqual(["https://bc/Indicadoresdiarios.aspx"]);
  });
});

describe("Paridad ChileCompra", () => {
  it("lee el CSV con LF o CRLF, comillas, espacios y coma decimal; salta filas incompletas", async () => {
    const csv = [
      `"Anio";"Mes";"Moneda";"Nombre";"VMCLP"`,
      `2025; 3 ;"USD";"Dólar";"950,5"`,
      `2025;4;UF;Uf;39000,1\r`,
      `2025;6;USD;Dolar;`,
      `2025;7;USD;Dolar;abc`,
      `;8;USD;Dolar;1`,
      `2025;;USD;Dolar;1`,
      `2025;9;XXX;Otra;1`,
    ].join("\n");
    const { fetch, llamadas } = responder(() => new Response(csv));
    const c = conversorParidadChileCompra({ fetch });
    expect(await c("USD", "2025-03-15")).toEqual({ valor: 950.5, fechaValor: "2025-03-01", fuente: "chilecompra:ParidadMoneda (mensual)" });
    expect(await c("CLF", "2025-04-02")).toMatchObject({ valor: 39000.1 });
    for (const dia of ["2025-06-01", "2025-07-01", "2025-08-01", "2025-09-01"]) expect(await c("USD", dia)).toBeNull();
    expect(llamadas).toEqual(["https://transparenciachc.blob.core.windows.net/oc-da/ParidadMoneda.csv"]);
  });

  it("sin columna VMCLP no hay tabla", async () => {
    const { fetch } = responder(() => new Response(`VMCLP;Anio;Mes;Moneda\n1;2025;3;USD`));
    expect(await conversorParidadChileCompra({ fetch })("USD", "2025-03-01")).toBeNull();
  });
});

describe("cadenaPorDefecto", () => {
  it("usa los circuitos y el hook que se le pasan, en orden mindicador → bcentral → paridad", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const circuitos = { mindicador: new Circuito("mindicador"), bcentral: new Circuito("bcentral"), paridad: new Circuito("paridad") };
    const eventos: Evento[] = [];
    expect(await cadenaPorDefecto({ circuitos, alEvento: (e) => void eventos.push(e) })("USD", "2026-10-09")).toBeNull();
    expect(eventos.map((e) => e.tipo === "conversion" && `${e.fuente} ${e.ok}`)).toEqual(["mindicador false", "bcentral false", "paridad false"]);
    expect([circuitos.mindicador.fallas, circuitos.bcentral.fallas, circuitos.paridad.fallas]).toEqual([1, 1, 1]);
  });
});

describe("convertirMontos", () => {
  it("no vuelve a convertir un monto que ya tiene clp", async () => {
    const usd: Monto = { valor: 10, moneda: "USD", clp: 9000, fechaValor: "2026-10-01", fuente: "x" };
    const p = { tipo: "licitacion", fechas: { publicacion: "2026-10-09T10:00:00-03:00" }, monto: usd, items: [] } as unknown as Proceso;
    const conversor = vi.fn(async () => ({ valor: 1, fechaValor: "2026-10-09", fuente: "y" }));
    expect((await convertirMontos(p, conversor)).monto).toEqual(usd);
    expect(conversor).not.toHaveBeenCalled();
  });
});
