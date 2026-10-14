// Tests de tipos (vitest --typecheck.only): fallan si cambia la forma pública de los tipos.
import { describe, expectTypeOf, test } from "vitest";
import {
  MercadoPublico,
  MercadoPublicoError,
  type CompraAgil,
  type Licitacion,
  type OrdenCompra,
  type Proceso,
  type TipoError,
} from "../src/index.js";
import * as raiz from "../src/index.js";
import { priorizar, rangoDePrecio, type NombreFactor, type Oportunidad, type RangoDePrecio } from "../src/radar/index.js";

declare const mp: MercadoPublico;
declare const p: Proceso;

describe("modelo", () => {
  test("Proceso se estrecha por `tipo`", () => {
    expectTypeOf<Proceso["tipo"]>().toEqualTypeOf<"licitacion" | "orden_compra" | "compra_agil">();
    if (p.tipo === "licitacion") expectTypeOf(p).toEqualTypeOf<Licitacion>();
    else if (p.tipo === "orden_compra") expectTypeOf(p).toEqualTypeOf<OrdenCompra>();
    else expectTypeOf(p).toEqualTypeOf<CompraAgil>();
  });
});

describe("cliente", () => {
  test("porCodigo devuelve el tipo exacto o null", () => {
    expectTypeOf(mp.licitaciones.porCodigo).returns.toEqualTypeOf<Promise<Licitacion | null>>();
    expectTypeOf(mp.ordenes.porCodigo).returns.toEqualTypeOf<Promise<OrdenCompra | null>>();
    expectTypeOf(mp.compraAgil.detalle).returns.toEqualTypeOf<Promise<CompraAgil | null>>();
  });

  test("compraAgil.listar es un AsyncIterable<CompraAgil>", () => {
    expectTypeOf(mp.compraAgil.listar()).toMatchTypeOf<AsyncIterable<CompraAgil>>();
  });

  test("el ticket es obligatorio", () => {
    // @ts-expect-error falta ticket
    new MercadoPublico({});
  });
});

describe("errores", () => {
  test("MercadoPublicoError.tipo es la unión cerrada", () => {
    expectTypeOf<MercadoPublicoError["tipo"]>().toEqualTypeOf<TipoError>();
    expectTypeOf<TipoError>().toEqualTypeOf<
      "ticket_invalido" | "cuota_agotada" | "cuota_insuficiente" | "simultaneas" | "no_encontrado" | "parametros" | "servidor" | "red" | "respuesta_invalida" | "circuito_abierto" | "cancelada"
    >();
    expectTypeOf<MercadoPublicoError["reintentable"]>().toEqualTypeOf<boolean>();
  });
});

describe("radar", () => {
  test("priorizar y rangoDePrecio", () => {
    expectTypeOf(priorizar).returns.toEqualTypeOf<Oportunidad[]>();
    expectTypeOf<Oportunidad["proceso"]>().toEqualTypeOf<Proceso>();
    expectTypeOf<NombreFactor>().toEqualTypeOf<"rubro" | "region" | "monto" | "diasAlCierre" | "competencia">();
    expectTypeOf(rangoDePrecio).parameter(1).toEqualTypeOf<CompraAgil[]>();
    expectTypeOf(rangoDePrecio).returns.toEqualTypeOf<RangoDePrecio>();
    const r = {} as RangoDePrecio;
    if ("insuficiente" in r) expectTypeOf(r.motivo).toEqualTypeOf<"muestra insuficiente">();
    else expectTypeOf(r.p50).toEqualTypeOf<number>();
  });
});

describe("superficie", () => {
  test("la CLI no se exporta", () => {
    expectTypeOf(raiz).not.toHaveProperty("main");
    expectTypeOf(raiz).not.toHaveProperty("cli");
  });
});
