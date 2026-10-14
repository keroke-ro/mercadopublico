// Fija los nombres exportados en runtime: agregar o quitar una exportación pública obliga a tocar esta lista.
import { expect, test } from "vitest";
import * as raiz from "../../src/index.js";
import * as radar from "../../src/radar/index.js";

test("exportaciones de mercadopublico", () => {
  expect(Object.keys(raiz).sort()).toEqual([
    "CAMPOS_PERSONALES",
    "CIRCUITO",
    "Circuito",
    "Cuota",
    "MercadoPublico",
    "MercadoPublicoError",
    "PRESUPUESTO_REINTENTOS",
    "RITMO",
    "Transporte",
    "UMBRALES_CUOTA",
    "cadenaPorDefecto",
    "codigos",
    "conversorBancoCentral",
    "conversorEncadenado",
    "conversorMindicador",
    "conversorParidadChileCompra",
    "conversorPorDefecto",
    "convertirMontos",
    "cuotaArchivo",
    "desdeOcds",
    "diaSantiago",
    "formatearRut",
    "isoSantiago",
    "leerOcds",
    "normalizarFecha",
    "ocultarPersonales",
    "parseCompraAgil",
    "parseLicitacion",
    "parseOrdenCompra",
    "storeArchivo",
    "storeMemoria",
    "urlOcds",
  ]);
});

test("exportaciones de mercadopublico/radar", () => {
  expect(Object.keys(radar).sort()).toEqual(["AJUSTES", "MUESTRA_MINIMA", "calibrar", "competidores", "decidir", "pesos", "precioSugerido", "priorizar", "proximasCompras", "rangoDePrecio", "resumenRadar"]);
});
