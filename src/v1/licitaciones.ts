import { exigirCodigo, exigirDia, exigirUno } from "../errores.js";
import { ddmmaaaa } from "../fecha.js";
import type { Cancelable, Transporte } from "../http.js";
import type { Enriquecer, Licitacion } from "../modelo.js";
import { ESTADOS_FILTRO_LICITACION, type EstadoFiltroLicitacion } from "./codigos.js";
import { parseLicitacion } from "./parse.js";

type Respuesta = { Listado?: unknown };

const fecha = (dia: string) => ddmmaaaa(exigirDia(dia));
const estadoValido = (e: EstadoFiltroLicitacion | undefined) => e && exigirUno(e, ESTADOS_FILTRO_LICITACION, "estado");

/**
 * Licitaciones de la API v1. Cada método gasta 1 consulta; con parámetros inválidos falla sin gastar ninguna.
 * Los listados (por día, estado, organismo o proveedor) traen solo código, nombre, estado y cierre:
 * el resto queda en null y el detalle completo requiere `porCodigo` (1 consulta por licitación).
 */
export class Licitaciones {
  constructor(
    private readonly t: Transporte,
    private readonly enriquecer: Enriquecer = async (p) => p,
  ) {}

  /** Detalle completo; null si no existe. */
  async porCodigo(codigo: string, { signal }: Cancelable = {}): Promise<Licitacion | null> {
    // Sin código la API devuelve el listado del día y se tomaría un proceso cualquiera como "detalle".
    const p = (await this.listar({ codigo: exigirCodigo(codigo) }, signal))[0];
    return p ? this.enriquecer(p) : null;
  }

  /** Publicadas el día `dia` ("AAAA-MM-DD"), opcionalmente filtradas por estado. */
  async delDia(dia: string, { estado, signal }: { estado?: EstadoFiltroLicitacion } & Cancelable = {}): Promise<Licitacion[]> {
    return this.listar({ fecha: fecha(dia), estado: estadoValido(estado) }, signal);
  }

  /** Publicadas al día de hoy. */
  async activas({ signal }: Cancelable = {}): Promise<Licitacion[]> {
    return this.listar({ estado: "activas" }, signal);
  }

  async porEstado(estado: EstadoFiltroLicitacion, { dia, signal }: { dia?: string } & Cancelable = {}): Promise<Licitacion[]> {
    return this.listar({ estado: estadoValido(estado), fecha: dia && fecha(dia) }, signal);
  }

  async porOrganismo(codigoOrganismo: string, { dia, signal }: { dia: string } & Cancelable): Promise<Licitacion[]> {
    return this.listar({ fecha: fecha(dia), CodigoOrganismo: exigirCodigo(codigoOrganismo, "código de organismo") }, signal);
  }

  async porProveedor(codigoProveedor: string, { dia, signal }: { dia: string } & Cancelable): Promise<Licitacion[]> {
    return this.listar({ fecha: fecha(dia), CodigoProveedor: exigirCodigo(codigoProveedor, "código de proveedor") }, signal);
  }

  private async listar(params: Record<string, string | undefined>, signal?: AbortSignal): Promise<Licitacion[]> {
    const r = await this.t.v1<Respuesta | null>("licitaciones.json", params, { signal });
    return Array.isArray(r?.Listado) ? r.Listado.map((x) => parseLicitacion(x, { avisar: this.t.avisar })) : [];
  }
}
