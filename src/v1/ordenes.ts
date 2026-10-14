import { MercadoPublicoError } from "../errores.js";
import { ddmmaaaa } from "../fecha.js";
import type { Transporte } from "../http.js";
import type { Enriquecer, OrdenCompra } from "../modelo.js";
import { ESTADO_FILTRO_OC, type EstadoFiltroOC } from "./codigos.js";
import { parseOrdenCompra } from "./parse.js";

// [W] usa "ordenesdecompra.json"; el PDF de OC escribe "OrdenCompra.json". Se usa el de la web.
const RUTA = "ordenesdecompra.json";

type Respuesta = { Listado?: unknown };

/**
 * Órdenes de compra de la API v1. Cada método gasta 1 consulta.
 * Los listados traen solo código, nombre y estado; el detalle requiere `porCodigo` (1 consulta por OC).
 */
export class OrdenesCompra {
  constructor(
    private readonly t: Transporte,
    private readonly enriquecer: Enriquecer = async (p) => p,
  ) {}

  async porCodigo(codigo: string): Promise<OrdenCompra | null> {
    // Sin código la API devuelve el listado del día y se tomaría un proceso cualquiera como "detalle".
    if (!codigo?.trim()) throw new MercadoPublicoError("parametros", "Falta el código");
    const p = (await this.listar({ codigo: codigo.trim() }))[0];
    return p ? this.enriquecer(p) : null;
  }

  /** Enviadas el día `dia` ("AAAA-MM-DD"), opcionalmente filtradas por estado. */
  delDia(dia: string, { estado }: { estado?: EstadoFiltroOC } = {}): Promise<OrdenCompra[]> {
    return this.listar({ fecha: ddmmaaaa(dia), estado: estado && ESTADO_FILTRO_OC[estado] });
  }

  /** Sin `dia`, el día actual ("todos" = todos los estados de hoy). */
  porEstado(estado: EstadoFiltroOC, { dia }: { dia?: string } = {}): Promise<OrdenCompra[]> {
    return this.listar({ estado: ESTADO_FILTRO_OC[estado], fecha: dia && ddmmaaaa(dia) });
  }

  porOrganismo(codigoOrganismo: string, { dia }: { dia: string }): Promise<OrdenCompra[]> {
    return this.listar({ fecha: ddmmaaaa(dia), CodigoOrganismo: codigoOrganismo });
  }

  porProveedor(codigoProveedor: string, { dia }: { dia: string }): Promise<OrdenCompra[]> {
    return this.listar({ fecha: ddmmaaaa(dia), CodigoProveedor: codigoProveedor });
  }

  private async listar(params: Record<string, string | undefined>): Promise<OrdenCompra[]> {
    const r = await this.t.v1<Respuesta | null>(RUTA, params);
    return Array.isArray(r?.Listado) ? r.Listado.map(parseOrdenCompra) : [];
  }
}
