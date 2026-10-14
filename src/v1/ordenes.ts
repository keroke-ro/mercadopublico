import { exigirCodigo, exigirDia, exigirUno } from "../errores.js";
import { ddmmaaaa } from "../fecha.js";
import type { Cancelable, Transporte } from "../http.js";
import type { Enriquecer, OrdenCompra } from "../modelo.js";
import { ESTADO_FILTRO_OC, type EstadoFiltroOC } from "./codigos.js";
import { parseOrdenCompra } from "./parse.js";

// [W] usa "ordenesdecompra.json"; el PDF de OC escribe "OrdenCompra.json". Se usa el de la web.
const RUTA = "ordenesdecompra.json";

type Respuesta = { Listado?: unknown };

const fecha = (dia: string) => ddmmaaaa(exigirDia(dia));
const estadoApi = (e: EstadoFiltroOC | undefined) => e && ESTADO_FILTRO_OC[exigirUno(e, Object.keys(ESTADO_FILTRO_OC), "estado")];

/**
 * Órdenes de compra de la API v1. Cada método gasta 1 consulta; con parámetros inválidos falla sin gastar ninguna.
 * Los listados traen solo código, nombre y estado; el detalle requiere `porCodigo` (1 consulta por OC).
 */
export class OrdenesCompra {
  constructor(
    private readonly t: Transporte,
    private readonly enriquecer: Enriquecer = async (p) => p,
  ) {}

  async porCodigo(codigo: string, { signal }: Cancelable = {}): Promise<OrdenCompra | null> {
    // Sin código la API devuelve el listado del día y se tomaría un proceso cualquiera como "detalle".
    const p = (await this.listar({ codigo: exigirCodigo(codigo) }, signal))[0];
    return p ? this.enriquecer(p) : null;
  }

  /** Enviadas el día `dia` ("AAAA-MM-DD"), opcionalmente filtradas por estado. */
  async delDia(dia: string, { estado, signal }: { estado?: EstadoFiltroOC } & Cancelable = {}): Promise<OrdenCompra[]> {
    return this.listar({ fecha: fecha(dia), estado: estadoApi(estado) }, signal);
  }

  /** Sin `dia`, el día actual ("todos" = todos los estados de hoy). */
  async porEstado(estado: EstadoFiltroOC, { dia, signal }: { dia?: string } & Cancelable = {}): Promise<OrdenCompra[]> {
    return this.listar({ estado: estadoApi(estado), fecha: dia && fecha(dia) }, signal);
  }

  async porOrganismo(codigoOrganismo: string, { dia, signal }: { dia: string } & Cancelable): Promise<OrdenCompra[]> {
    return this.listar({ fecha: fecha(dia), CodigoOrganismo: exigirCodigo(codigoOrganismo, "código de organismo") }, signal);
  }

  async porProveedor(codigoProveedor: string, { dia, signal }: { dia: string } & Cancelable): Promise<OrdenCompra[]> {
    return this.listar({ fecha: fecha(dia), CodigoProveedor: exigirCodigo(codigoProveedor, "código de proveedor") }, signal);
  }

  private async listar(params: Record<string, string | undefined>, signal?: AbortSignal): Promise<OrdenCompra[]> {
    const r = await this.t.v1<Respuesta | null>(RUTA, params, { signal });
    return Array.isArray(r?.Listado) ? r.Listado.map((x) => parseOrdenCompra(x, { avisar: this.t.avisar })) : [];
  }
}
