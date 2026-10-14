import { MercadoPublicoError } from "../errores.js";
import { desdeHoraSantiago } from "../fecha.js";
import type { Transporte } from "../http.js";
import type { CompraAgil, Enriquecer } from "../modelo.js";
import { num } from "../util.js";
import { parseCompraAgil, type EstadoCompraAgil } from "./parse.js";

export interface FiltrosCompraAgil {
  estado?: EstadoCompraAgil[];
  /** Códigos de región, 1 a 16. */
  region?: number[];
  /** Date o ISO. Sin offset se entiende como hora de Santiago. */
  publicadoDesde?: Date | string;
  publicadoHasta?: Date | string;
  /** Excluyente con `ttlCambioMs`. */
  cambioDesde?: Date | string;
  cambioHasta?: Date | string;
  /** Cambios de los últimos N ms. Excluyente con `cambioDesde`/`cambioHasta`. */
  ttlCambioMs?: number;
  /** Palabras clave en nombre y descripción. Excluyente con `id`. */
  q?: string;
  /** Código exacto. Excluyente con `q`. */
  id?: string;
  ordenarPor?: "FechaUltimaModificacion" | "FechaPublicacion";
  /** 10 a 50 (la API real rechaza menos de 10, aunque la guía no lo dice). Por defecto 50 (menos consultas). */
  tamanoPagina?: number;
  /**
   * RUT de la institución (`institucion.rut`). La API no tiene este filtro: se aplica aquí,
   * después de bajar cada página, así que NO ahorra consultas. Combínalo con `region`.
   */
  rutOrganismo?: string;
}

export interface PaginaCompraAgil {
  items: CompraAgil[];
  pagina: number;
  /** Lo que cuesta el listado completo en consultas. */
  totalPaginas: number;
  totalResultados: number;
}

const fallo = (m: string) => new MercadoPublicoError("parametros", m);
const rut = (x: string | null) => x?.replace(/[.\s]/g, "").toUpperCase();

function iso(x: Date | string | undefined, campo: string): string | undefined {
  if (x === undefined) return undefined;
  try {
    return (typeof x === "string" ? desdeHoraSantiago(x) : x).toISOString(); // RangeError si es inválida
  } catch {
    throw fallo(`${campo}: fecha inválida (${String(x)})`);
  }
}

/** Valida en local las combinaciones que la API rechaza, para no gastar una consulta en un 400. */
function params(f: FiltrosCompraAgil, numero: number) {
  if (f.id && f.q) throw fallo("`id` y `q` son excluyentes");
  if (f.ttlCambioMs !== undefined && (f.cambioDesde !== undefined || f.cambioHasta !== undefined))
    throw fallo("`ttlCambioMs` y `cambioDesde`/`cambioHasta` son excluyentes");
  const tamano = f.tamanoPagina ?? 50;
  if (!Number.isInteger(tamano) || tamano < 10 || tamano > 50) throw fallo("`tamanoPagina` va de 10 a 50");
  if (f.region?.some((r) => !Number.isInteger(r) || r < 1 || r > 16)) throw fallo("`region` va de 1 a 16");
  return {
    estado: f.estado,
    region: f.region,
    publicado_desde: iso(f.publicadoDesde, "publicadoDesde"),
    publicado_hasta: iso(f.publicadoHasta, "publicadoHasta"),
    cambio_desde: iso(f.cambioDesde, "cambioDesde"),
    cambio_hasta: iso(f.cambioHasta, "cambioHasta"),
    ttl_cambio_ms: f.ttlCambioMs,
    q: f.q,
    id: f.id,
    ordenar_por: f.ordenarPor,
    tamano_pagina: tamano,
    numero_pagina: numero,
  };
}

export class CompraAgilApi {
  constructor(
    private readonly t: Transporte,
    private readonly enriquecer: Enriquecer = async (p) => p,
  ) {}

  /** Una página. Cuesta 1 consulta. */
  async pagina(filtros: FiltrosCompraAgil, numero: number): Promise<PaginaCompraAgil> {
    const p = (await this.t.v2("compra-agil", params(filtros, numero))) as { items?: unknown; paginacion?: Record<string, unknown> } | null;
    const pag = p?.paginacion ?? {};
    let items = (Array.isArray(p?.items) ? p.items : []).map((x) => parseCompraAgil(x, { detalle: false }));
    const buscado = rut(filtros.rutOrganismo ?? null);
    if (buscado) items = items.filter((ca) => rut(ca.comprador?.rutUnidad ?? null) === buscado);
    return {
      items,
      pagina: num(pag.numero_pagina) ?? numero,
      totalPaginas: num(pag.total_paginas) ?? 0,
      totalResultados: num(pag.total_resultados) ?? 0,
    };
  }

  /** Recorre todas las páginas; cuesta `totalPaginas` consultas. */
  async *listar(filtros: FiltrosCompraAgil = {}): AsyncGenerator<CompraAgil, void, undefined> {
    for (let n = 1; ; n++) {
      const p = await this.pagina(filtros, n);
      yield* p.items;
      if (n >= p.totalPaginas) return;
    }
  }

  /** Detalle; null si no existe (igual que `porCodigo` en la v1). */
  async detalle(codigo: string): Promise<CompraAgil | null> {
    if (!codigo?.trim()) throw fallo("Falta el código de la Compra Ágil");
    const p = await this.t.v2(`compra-agil/${encodeURIComponent(codigo.trim())}`).catch((e: unknown) => {
      if (e instanceof MercadoPublicoError && e.tipo === "no_encontrado") return null;
      throw e;
    });
    if (p === null) return null;
    if (!p || typeof p !== "object") throw new MercadoPublicoError("respuesta_invalida", `La API no devolvió el detalle de ${codigo}`);
    return this.enriquecer(parseCompraAgil(p, { detalle: true }));
  }
}
