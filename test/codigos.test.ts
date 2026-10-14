// Cada corrección a la documentación oficial (src/v1/codigos.ts) tiene aquí su test.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRATO,
  ESTADO_FILTRO_OC,
  ESTADO_LICITACION,
  ESTADO_OC,
  ESTIMACION,
  FORMA_PAGO,
  MODALIDAD_PAGO,
  MONEDA,
  OBRAS,
  TIPO_ACTO_ADJUDICACION,
  TIPO_LICITACION,
  TIPO_OC,
  estado,
  familiaDesdeCodigo,
  glosa,
  regionCodigo,
  tipoDesdeCodigo,
  urlPublica,
} from "../src/v1/codigos.js";

describe("correcciones a la documentación", () => {
  it("estado de licitación: revocada y suspendida con los códigos de la web (18/19) y de OCDS (15/16)", () => {
    for (const c of [15, 18]) expect(estado(ESTADO_LICITACION, c)).toEqual({ estado: "revocada", glosa: "Revocada" });
    for (const c of [16, 19]) expect(estado(ESTADO_LICITACION, c)).toEqual({ estado: "suspendida", glosa: "Suspendida" });
  });

  it("estado de licitación: códigos que solo aparecen en OCDS (9, 11, 12, 14)", () => {
    expect(estado(ESTADO_LICITACION, 9).estado).toBe("adjudicada");
    for (const c of [11, 12, 14]) expect(estado(ESTADO_LICITACION, c).estado).toBe("cerrada");
  });

  it("tipos LQ, LR, H2 e I2 (solo en el PDF) y O1/O2 (solo en OCDS) existen", () => {
    for (const t of ["LQ", "LR", "H2", "I2", "O1", "O2"]) expect(glosa(TIPO_LICITACION, t)).not.toBeNull();
  });

  it("LP y B2 llegan hasta 2.000 UTM (PDF), no 'mayor a 1.000' (web)", () => {
    expect(glosa(TIPO_LICITACION, "LP")).toContain("inferior a 2.000 UTM");
    expect(glosa(TIPO_LICITACION, "B2")).toContain("inferior a 2.000 UTM");
  });

  it("moneda: UTM y EUR no están invertidas como en la tabla de OC de la web", () => {
    expect(glosa(MONEDA, "UTM")).toBe("Unidad Tributaria Mensual");
    expect(glosa(MONEDA, "EUR")).toBe("Euro");
  });

  it("estimación 3 (solo en el PDF)", () => {
    expect(glosa(ESTIMACION, 3)).toBe("Monto no es posible de estimar");
  });

  it("modalidad de pago 5 a 10 según el PDF, no la web", () => {
    expect([5, 6, 7, 8, 9, 10].map((c) => glosa(MODALIDAD_PAGO, c))).toEqual([
      "Pago Bimensual",
      "Contra Entrega Conforme",
      "Pagos Mensuales",
      "Por Estado de Avance",
      "Pago Trimestral",
      "Pago a 60 días",
    ]);
  });

  it("acto de adjudicación: 3 Acuerdo y 5 Otros (PDF), no al revés (web)", () => {
    expect(glosa(TIPO_ACTO_ADJUDICACION, 3)).toBe("Acuerdo");
    expect(glosa(TIPO_ACTO_ADJUDICACION, 5)).toBe("Otros");
  });

  it("Obras: 0 (PDF) y 1 (web) son No, 2 es Sí", () => {
    expect([0, "0", 1, 2].map((c) => glosa(OBRAS, c))).toEqual(["No", "No", "No", "Sí"]);
  });

  it("Contrato: 1/2 del PDF y el 'NO' del ejemplo de la web", () => {
    expect(glosa(CONTRATO, 2)).toBe("Se formaliza con la orden de compra");
    expect(glosa(CONTRATO, "NO")).toBe("No");
  });

  it("filtros de estado de OC: se envían con la errata literal de la web", () => {
    expect(ESTADO_FILTRO_OC.recepcion_parcial).toBe("recepcionaceptadacialmente");
    expect(ESTADO_FILTRO_OC.recepcion_conforme_incompleta).toBe("recepecionconformeincompleta");
  });

  it("forma de pago 48 y 49 (solo en la web)", () => {
    expect(glosa(FORMA_PAGO, 48)).toBe("A 45 días");
    expect(glosa(FORMA_PAGO, 49)).toBe("A más de 30 días");
  });
});

describe("enums abiertos", () => {
  it("un código desconocido da null, nunca lanza", () => {
    for (const c of [999, "XX", null, undefined, "", "toString", "__proto__", {}]) {
      expect(glosa(TIPO_LICITACION, c)).toBeNull();
      expect(estado(ESTADO_OC, c)).toEqual({ estado: "desconocido", glosa: null });
    }
  });

  it("glosa acepta número o string y tablas de tuplas", () => {
    expect(glosa(ESTADO_OC, "12")).toBe("Recepción Conforme");
    expect(glosa(TIPO_OC, 13)).toBe("Compra Ágil");
    expect(estado(ESTADO_OC, 4).estado).toBe("enviada_proveedor");
  });

  it("tipoDesdeCodigo", () => {
    expect(["1509-5-L114", "6945-12-LE26", "2239-1-LR25", "1057539-228-COT26", "basura"].map(tipoDesdeCodigo)).toEqual(["L1", "LE", "LR", "COT", null]);
  });

  it("regionCodigo desde nombre o número", () => {
    expect(
      ["Región Metropolitana de Santiago", "Región del Bío-Bío", "Región de Ñuble", "Región del Libertador General Bernardo O´Higgins", "Región de Los Ríos", "13", "99", "Marte", null].map(regionCodigo),
    ).toEqual([13, 8, 16, 6, 14, 13, null, null, null]);
  });
});

describe("familia y URL del proceso", () => {
  it("familiaDesdeCodigo: null si no es un código; COT y FTD son compra ágil", () => {
    expect(["basura", "", "1509-5-L1", "COT26"].map(familiaDesdeCodigo)).toEqual([null, null, null, null]);
    expect(["1057539-228-COT26", "1016414-13-FTD26"].map(familiaDesdeCodigo)).toEqual(["compra_agil", "compra_agil"]);
  });

  it("familiaDesdeCodigo acierta con todas las muestras reales (test/__snapshots__/muestras)", () => {
    const dir = new URL("./__snapshots__/muestras/", import.meta.url);
    const muestras = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(muestras.length).toBeGreaterThan(0);
    const malas = muestras
      .map((f) => ({ codigo: f.replace(/\.json$/, ""), tipo: JSON.parse(readFileSync(new URL(f, dir), "utf8")).tipo as string }))
      .filter(({ codigo, tipo }) => familiaDesdeCodigo(codigo) !== tipo)
      .map(({ codigo, tipo }) => `${codigo}: ${tipo} != ${familiaDesdeCodigo(codigo)}`);
    expect(malas).toEqual([]);
  });

  it("familiaDesdeCodigo: SE es orden de compra aunque esté en TIPO_LICITACION; R1 y DC caen en licitación", () => {
    expect(["1024-236-SE26", "1469-227-R126", "500977-115-DC26"].map(familiaDesdeCodigo)).toEqual(["orden_compra", "licitacion", "licitacion"]);
  });

  it("urlPublica: ficha de licitación y de OC; null en compra ágil", () => {
    expect(urlPublica("licitacion", "1509-5-L114")).toBe("https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=1509-5-L114");
    expect(urlPublica("orden_compra", "1002584-335-AG26")).toBe("https://www.mercadopublico.cl/PurchaseOrder/Modules/PO/DetailsPurchaseOrder.aspx?codigoOC=1002584-335-AG26");
    expect(urlPublica("compra_agil", "1057539-228-COT26")).toBeNull();
  });
});
