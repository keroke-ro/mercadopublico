import { describe, expect, it } from "vitest";
import { Cuota, Transporte } from "../src/http.js";

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status });

describe("cuota", () => {
  it("un 429 de cuota agotada deja la cuenta local en cero y no se vuelve a consultar", async () => {
    let llamadas = 0;
    const t = new Transporte({ ticket: "T", intervaloMs: 0, dormir: async () => {}, fetch: async () => (llamadas++, json({ Codigo: 429, Mensaje: "límite diario" }, 429)) });
    await expect(t.v1("x.json")).rejects.toMatchObject({ tipo: "cuota_agotada" });
    expect(t.cuota.restante).toBe(0);
    await expect(t.v1("x.json")).rejects.toMatchObject({ tipo: "cuota_insuficiente" });
    expect(llamadas).toBe(1);
  });

  it("no modifica el estado que se le pasa", () => {
    const guardado = { dia: "2026-10-14", usadas: 5 };
    const c = new Cuota(100, guardado, () => new Date("2026-10-14T12:00:00-03:00"));
    c.registrar(3);
    expect(guardado.usadas).toBe(5);
    expect(c.usadas).toBe(8);
  });
});

describe("errores v2", () => {
  it("un 500 sin sobre muestra el mensaje de la API, no solo el status", async () => {
    const t = new Transporte({ ticket: "T", intervaloMs: 0, reintentos: 0, fetch: async () => json({ codigo: "ERROR_INTERNO", mensaje: "Servicio no disponible" }, 500) });
    await expect(t.v2("compra-agil")).rejects.toMatchObject({ tipo: "servidor", message: "Servicio no disponible", codigo: "ERROR_INTERNO" });
  });
});
