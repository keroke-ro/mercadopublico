// Casos que dejó vivos Stryker en src/fecha.ts y src/util.ts (ver stryker.config.json).
import { describe, expect, it } from "vitest";
import { desdeHoraSantiago, isoSantiago } from "../../src/fecha.js";
import { avisador, entero, monto, num, revisar, str, type Avisar, type Esquema } from "../../src/util.js";

describe("desdeHoraSantiago", () => {
  it("acepta la forma de la API: sin segundos y con offset sin dos puntos", () => {
    expect(isoSantiago(desdeHoraSantiago("2026-10-01T10:00"))).toBe("2026-10-01T10:00:00-03:00");
    expect(desdeHoraSantiago("2026-10-01T10:00:00-0300").toISOString()).toBe("2026-10-01T13:00:00.000Z");
  });

  it("rechaza texto antes o después de la fecha, con el texto recortado en el mensaje", () => {
    expect(() => desdeHoraSantiago("Lunes 2026-10-01")).toThrow(new RangeError("Fecha inválida: Lunes 2026-10-01"));
    const largo = `2026-10-01T10:00:00${" basura".repeat(10)}`;
    expect(() => desdeHoraSantiago(largo)).toThrow(new RangeError(`Fecha inválida: ${largo.slice(0, 40)}`));
  });

  it("una fecha con forma válida pero inexistente es RangeError con el texto", () => {
    expect(() => desdeHoraSantiago("2026-13-45")).toThrow(new RangeError("Fecha inválida: 2026-13-45"));
  });
});

describe("num, entero, str", () => {
  it("decimales sin parte entera y exponentes de varias cifras o negativos", () => {
    expect(num(".25")).toBe(0.25);
    expect(num("1e10")).toBe(1e10);
    expect(num("1e-5")).toBe(1e-5);
    expect(num("2E+3")).toBe(2000);
  });

  it("miles con punto solo si todo el texto tiene esa forma", () => {
    expect(num("-1.234.567")).toBe(-1234567);
    for (const x of ["1.1.234.567", "1.234.567.8", "1,5.000"]) expect(num(x)).toBeNull();
  });

  it("entero rechaza negativos y fracciones", () => {
    expect(entero("7")).toBe(7);
    expect(entero(-1)).toBeNull();
    expect(entero(1.5)).toBeNull();
  });

  it("str acepta booleanos y bigint", () => {
    expect(str(true)).toBe("true");
    expect(str(10n)).toBe("10");
  });
});

describe("monto", () => {
  it("sin moneda (undefined, vacío o en blanco) es CLP", () => {
    for (const m of [undefined, null, "", "  "]) expect(monto(5, m, "2026-10-01")).toMatchObject({ moneda: "CLP", clp: 5 });
  });
});

describe("avisador y revisar", () => {
  const armar = () => {
    const avisos: string[] = [];
    const av: Avisar = (tipo, ruta, detalle) => void avisos.push(`${tipo} ${ruta}${detalle ? ` (${detalle})` : ""}`);
    return { avisos, av };
  };

  it("sin hook no hay avisador", () => {
    expect(avisador("v1", "X", undefined)).toBeNull();
  });

  it("solo revisa objetos", () => {
    const { avisos, av } = armar();
    for (const x of [null, "abc", 5, [{ a: 1 }]]) revisar(x, {}, "", av);
    expect(avisos).toEqual([]);
  });

  it("describe cada tipo distinto", () => {
    const e: Esquema = { lista: [{ a: "n" }], obj: { b: "s" }, mon: "m", n: "n", otra: [{ a: "n" }] };
    const { avisos, av } = armar();
    revisar({ lista: [{ a: 1 }, null, 3, "x", [1]], obj: [1], mon: 5, n: "1", otra: {} }, e, "r", av);
    revisar({ mon: "PESOS CHILENOS DE CHILE Y MAS" }, e, "r", av);
    expect(avisos).toEqual([
      "tipo_distinto r.lista[] (se esperaba object, llegó number)",
      "tipo_distinto r.lista[] (se esperaba object, llegó string)",
      "tipo_distinto r.lista[] (se esperaba object, llegó array)",
      "tipo_distinto r.obj (se esperaba object, llegó array)",
      "tipo_distinto r.mon (se esperaba string, llegó number)",
      "tipo_distinto r.n (se esperaba number, llegó string)",
      "tipo_distinto r.otra (se esperaba array, llegó object)",
      "valor_desconocido r.mon (moneda PESOS CHILENOS DE CH)",
    ]);
  });
});
