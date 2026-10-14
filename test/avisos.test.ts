// Avisos de cambios en la API: los parsers notan campos nuevos, faltantes, tipos distintos y códigos desconocidos
// sin cambiar el resultado. También los hallazgos del corpus real (test/fixtures/muestras) que tocaron los parsers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Aviso } from "../src/eventos.js";
import { normalizarFecha } from "../src/fecha.js";
import { desdeOcds } from "../src/ocds.js";
import { regionCodigo, tipoDesdeCodigo } from "../src/v1/codigos.js";
import { parseLicitacion, parseOrdenCompra } from "../src/v1/parse.js";
import { parseCompraAgil } from "../src/v2/parse.js";

const json = (r: string) => JSON.parse(readFileSync(new URL(`./fixtures/${r}`, import.meta.url), "utf8"));
const v1 = (n: string) => json(`v1/${n}.json`).Listado as Record<string, any>[];
const clon = <T>(x: T): T => structuredClone(x);

/** Avisos de un parseo, como "tipo ruta". */
function avisos(f: (avisar: (a: Aviso) => void) => unknown): string[] {
  const out: string[] = [];
  f((a) => out.push(`${a.tipo} ${a.ruta}`));
  return out;
}

describe("fixtures reales: sin avisos", () => {
  it.each(["licitacion-detalle.real", "licitaciones-listado.real", "licitacion-detalle"])("licitación %s", (n) => {
    for (const x of v1(n)) expect(avisos((avisar) => parseLicitacion(x, { avisar }))).toEqual([]);
  });
  it.each(["oc-detalle.real", "ordenes-listado.real"])("OC %s", (n) => {
    for (const x of v1(n)) expect(avisos((avisar) => parseOrdenCompra(x, { avisar }))).toEqual([]);
  });
  it("v2 detalle y listado (reconstruidos)", () => {
    expect(avisos((avisar) => parseCompraAgil(json("v2/detalle.json").payload, { detalle: true, avisar }))).toEqual([]);
    for (const x of json("v2/listado-p1.json").payload.items) expect(avisos((avisar) => parseCompraAgil(x, { detalle: false, avisar }))).toEqual([]);
  });
  it("OCDS CM real", () => {
    expect(avisos((avisar) => desdeOcds(json("ocds/release-cm.json"), { avisar }))).toEqual([]);
  });
  it("el listado v2 de prueba trae un campo nuevo y un monto en string", () => {
    const [x] = json("v2/listado-p2.json").payload.items;
    expect(avisos((avisar) => parseCompraAgil(x, { detalle: false, avisar }))).toEqual([
      "tipo_distinto payload.items[].montos.monto_disponible",
      "campo_nuevo payload.items[].campo_nuevo_no_documentado",
    ]);
  });
});

const muestras = new URL("./fixtures/muestras/v1/", import.meta.url);
describe.runIf(existsSync(muestras))("corpus real (test/fixtures/muestras)", () => {
  it("solo avisa lo que de verdad está fuera de las tablas: Modalidad 0 y 11, y una licitación de prueba tipo DC", () => {
    const todos = new Set<string>();
    for (const [dir, parse] of [["licitaciones", parseLicitacion], ["ordenes", parseOrdenCompra]] as const)
      for (const f of readdirSync(new URL(`${dir}/`, muestras)))
        parse(JSON.parse(readFileSync(new URL(`${dir}/${f}`, muestras), "utf8")).Listado[0], { avisar: (a) => todos.add(`${a.tipo} ${a.ruta} ${a.detalle}`) });
    expect([...todos].sort()).toEqual([
      "valor_desconocido Listado[].Modalidad Modalidad 0",
      "valor_desconocido Listado[].Modalidad Modalidad 11",
      "valor_desconocido Listado[].Tipo Tipo DC",
    ]);
  });
});

describe("fixtures mutados", () => {
  const lic = () => clon(v1("licitacion-detalle.real")[0]!);
  const oc = () => clon(v1("oc-detalle.real")[0]!);

  it("campo nuevo, con ruta y código; uno solo aunque se repita en cada ítem", () => {
    const x = lic();
    x.Comprador.CorreoUnidad = "x";
    for (const i of x.Items.Listado) i.Garantia = 1;
    const vistos: Aviso[] = [];
    parseLicitacion(x, { avisar: (a) => vistos.push(a) });
    expect(vistos).toEqual([
      { tipo: "campo_nuevo", origen: "v1", ruta: "Listado[].Comprador.CorreoUnidad", codigo: "1000-24-LE26" },
      { tipo: "campo_nuevo", origen: "v1", ruta: "Listado[].Items.Listado[].Garantia", codigo: "1000-24-LE26" },
    ]);
  });

  it("campo faltante: en el detalle exige más que en el listado", () => {
    const x = lic();
    delete x.Comprador;
    delete x.Nombre;
    expect(avisos((avisar) => parseLicitacion(x, { avisar }))).toEqual(["campo_faltante Listado[].Nombre", "campo_faltante Listado[].Comprador"]);
    // El listado no trae Comprador ni Fechas y no es un faltante.
    expect(avisos((avisar) => parseLicitacion({ CodigoExterno: "1-1-LE26", Nombre: "x", CodigoEstado: 5, FechaCierre: null }, { avisar }))).toEqual([]);
    const o = oc();
    delete o.Proveedor;
    o.Fechas.FechaCreacion = null;
    expect(avisos((avisar) => parseOrdenCompra(o, { avisar }))).toEqual(["campo_faltante Listado[].Proveedor", "campo_faltante Listado[].Fechas.FechaCreacion"]);
  });

  it("tipo distinto: string donde va number, objeto donde va string, lista donde va objeto", () => {
    const x = lic();
    x.CodigoEstado = "5";
    x.Nombre = { es: "x" };
    x.Items.Listado[0].Cantidad = "780";
    x.Fechas = [];
    expect(avisos((avisar) => parseLicitacion(x, { avisar }))).toEqual([
      "tipo_distinto Listado[].Nombre",
      "tipo_distinto Listado[].CodigoEstado",
      "tipo_distinto Listado[].Fechas",
      "tipo_distinto Listado[].Items.Listado[].Cantidad",
      "campo_faltante Listado[].Fechas.FechaPublicacion",
    ]);
  });

  it("código desconocido: estado, tipo, moneda y región; el parseo no inventa", () => {
    const o = oc();
    o.CodigoEstado = 99;
    o.Estado = "Archivada";
    o.CodigoTipo = "42";
    o.TipoMoneda = "BTC";
    o.Items.Listado[0].Moneda = "BTC";
    o.Comprador.RegionUnidad = "Región de la Luna";
    const vistos = avisos((avisar) => {
      const p = parseOrdenCompra(o, { avisar });
      expect(p.estado).toBe("archivada");
      expect(p.monto).toBeNull();
      expect(p.comprador?.region).toBeNull();
    });
    expect(vistos).toEqual([
      "valor_desconocido Listado[].TipoMoneda",
      "valor_desconocido Listado[].Items.Listado[].Moneda",
      "valor_desconocido Listado[].CodigoEstado",
      "valor_desconocido Listado[].CodigoTipo",
      "valor_desconocido Listado[].Comprador.RegionUnidad",
    ]);
  });

  it("v2: estado nuevo, moneda desconocida en una cotización, faltantes del detalle", () => {
    const x = clon(json("v2/detalle.json").payload);
    x.estado.codigo = "en_evaluacion";
    x.proveedores_cotizando[0].moneda = "BTC";
    delete x.productos_solicitados;
    expect(avisos((avisar) => parseCompraAgil(x, { detalle: true, avisar }))).toEqual([
      "valor_desconocido payload.proveedores_cotizando[].moneda",
      "campo_faltante payload.productos_solicitados",
      "valor_desconocido payload.estado.codigo",
    ]);
  });

  it("OCDS: campo nuevo en la raíz, status y statusDetails desconocidos; lo abierto no avisa", () => {
    const r = json("ocds/release-cm.json");
    r.secondStage = {};
    r.tender.status = "suspended";
    r.tender.otraExtension = 1; // tender es abierto: OCDS tiene extensiones
    r.awards[0].statusDetails = "99-Orden de Compra archivada";
    expect(avisos((avisar) => desdeOcds(r, { avisar }))).toEqual([
      "campo_nuevo secondStage",
      "valor_desconocido tender.status",
      "valor_desconocido awards[].statusDetails",
    ]);
  });

  it("un hook que lanza no cambia el resultado; sin hook no pasa nada; map(parse) no confunde el índice con opciones", () => {
    const x = lic();
    x.Nuevo = 1;
    const sinRaw = (p: object) => JSON.stringify({ ...p, raw: null });
    const roto = () => {
      throw new Error("hook roto");
    };
    expect(sinRaw(parseLicitacion(x, { avisar: roto }))).toBe(sinRaw(parseLicitacion(x)));
    // TypeScript lo impide, pero desde JS `map` pasa el índice como segundo argumento.
    const comoJs = (f: Function) => f as (x: unknown, i: number) => unknown;
    expect(() => [x, x].map(comoJs(parseLicitacion))).not.toThrow();
    expect(() => [oc()].map(comoJs(parseOrdenCompra))).not.toThrow();
  });
});

describe("hallazgos del corpus real", () => {
  const muestra = (n: string) => json(`muestras/v1/${n}.json`).Listado[0];
  const hay = (n: string) => existsSync(new URL(`./fixtures/muestras/v1/${n}.json`, import.meta.url));

  it("el ítem adjudicado trae Adjudicacion.Cantidad (no CantidadAdjudicada): el total se calcula", () => {
    const x = clon(v1("licitacion-detalle.real")[0]!);
    x.Items.Listado[0].Adjudicacion = { RutProveedor: "76.000.000-0", NombreProveedor: "X SpA", Cantidad: 30, MontoUnitario: 1000 };
    expect(parseLicitacion(x).items[0]!.total?.valor).toBe(30_000);
  });

  it("Tipo manda sobre el sufijo; R1/R2 no son tipos", () => {
    expect(tipoDesdeCodigo("1469-227-R126")).toBeNull();
    expect(tipoDesdeCodigo("1523-53-R226")).toBeNull();
    expect(tipoDesdeCodigo("1509-5-LE26")).toBe("LE");
    expect(parseLicitacion({ CodigoExterno: "1469-227-R126", Tipo: "L1" }).tipoLicitacion).toBe("L1");
    expect(parseLicitacion({ CodigoExterno: "1469-227-R126" }).tipoLicitacion).toBeNull();
    if (hay("licitaciones/1469-227-R126")) expect(parseLicitacion(muestra("licitaciones/1469-227-R126")).tipoLicitacion).toBe("L1");
  });

  it("CodigoTipo 3 (privada), OC tipo 16/17 y estados del proveedor no avisan", () => {
    const x = clon(v1("licitacion-detalle.real")[0]!);
    x.CodigoTipo = 3;
    expect(avisos((avisar) => parseLicitacion(x, { avisar }))).toEqual([]);
    const o = clon(v1("oc-detalle.real")[0]!);
    for (const [codigo, tipo, prov] of [["16", "TD", 1], ["17", "CT", 7]] as const) {
      Object.assign(o, { CodigoTipo: codigo, Tipo: null, CodigoEstadoProveedor: prov });
      expect(avisos((avisar) => expect(parseOrdenCompra(o, { avisar }).tipoOrden).toBe(tipo))).toEqual([]);
    }
  });

  it("fechas de relleno 1900 quedan en null", () => {
    expect(normalizarFecha("1900-01-11T00:00:00")).toBeNull();
    const x = clon(v1("licitacion-detalle.real")[0]!);
    x.Fechas.FechaPublicacion = "1900-01-02T00:00:00";
    expect(parseLicitacion(x).fechas.publicacion).toBeNull();
  });

  it("códigos fuera de tabla (Modalidad 0 y 11, Contrato 9) avisan y no lanzan", () => {
    const x = clon(v1("licitacion-detalle.real")[0]!);
    Object.assign(x, { Modalidad: 11, Contrato: "9", TipoPago: "-1" });
    expect(avisos((avisar) => parseLicitacion(x, { avisar }))).toEqual(["valor_desconocido Listado[].Contrato", "valor_desconocido Listado[].Modalidad"]);
  });

  it("región con blancos, en mayúsculas o vacía", () => {
    expect(regionCodigo(" REGION METROPOLITANA")).toBe(13);
    expect(regionCodigo("Región del Biobío ")).toBe(8);
    expect(regionCodigo("")).toBeNull();
    expect(regionCodigo("  ")).toBeNull();
  });

  it("procesoOrigen: código COT sin \"ID:\" y Trato Directo FTD en el nombre", () => {
    const origen = (Nombre: string) => parseOrdenCompra({ Codigo: "1-1-AG26", Nombre, CodigoLicitacion: "" }).procesoOrigen;
    expect(origen("CAJAS MEGA BOX 1002584-93-COT26")).toBe("1002584-93-COT26");
    expect(origen("Orden de Compra generada por Trato Directo ID 1016414-13-FTD26")).toBe("1016414-13-FTD26");
    expect(origen("SONDA FOLEY ID:\t1002772-2689-COT26 (AG,TRANSVERSAL)")).toBe("1002772-2689-COT26");
    expect(origen("REPUESTO PARA ELECTROCARDIOGRAFO")).toBeNull();
  });
});
