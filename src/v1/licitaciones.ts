import { MercadoPublicoError } from "../errores.js";
import { ddmmaaaa } from "../fecha.js";
import type { Transporte } from "../http.js";
import type { Enriquecer, Licitacion } from "../modelo.js";
import type { EstadoFiltroLicitacion } from "./codigos.js";
import { parseLicitacion } from "./parse.js";

type Respuesta = { Listado?: unknown };

/**
 * Licitaciones de la API v1. Cada método gasta 1 consulta.
 * Los listados (por día, estado, organismo o proveedor) traen solo código, nombre, estado y cierre:
 * el resto queda en null y el detalle completo requiere `porCodigo` (1 consulta por licitación).
 */
export class Licitaciones {
  constructor(
    private readonly t: Transporte,
    private readonly enriquecer: Enriquecer = async (p) => p,
  ) {}

  /** Detalle completo; null si no existe. */
  async porCodigo(codigo: string): Promise<Licitacion | null> {
    // Sin código la API devuelve el listado del día y se tomaría un proceso cualquiera como "detalle".
    if (!codigo?.trim()) throw new MercadoPublicoError("parametros", "Falta el código");
    const p = (await this.listar({ codigo: codigo.trim() }))[0];
    return p ? this.enriquecer(p) : null;
  }

  /** Publicadas el día `dia` ("AAAA-MM-DD"), opcionalmente filtradas por estado. */
  delDia(dia: string, { estado }: { estado?: EstadoFiltroLicitacion } = {}): Promise<Licitacion[]> {
    return this.listar({ fecha: ddmmaaaa(dia), estado });
  }

  /** Publicadas al día de hoy. */
  activas(): Promise<Licitacion[]> {
    return this.listar({ estado: "activas" });
  }

  porEstado(estado: EstadoFiltroLicitacion, { dia }: { dia?: string } = {}): Promise<Licitacion[]> {
    return this.listar({ estado, fecha: dia && ddmmaaaa(dia) });
  }

  porOrganismo(codigoOrganismo: string, { dia }: { dia: string }): Promise<Licitacion[]> {
    return this.listar({ fecha: ddmmaaaa(dia), CodigoOrganismo: codigoOrganismo });
  }

  porProveedor(codigoProveedor: string, { dia }: { dia: string }): Promise<Licitacion[]> {
    return this.listar({ fecha: ddmmaaaa(dia), CodigoProveedor: codigoProveedor });
  }

  private async listar(params: Record<string, string | undefined>): Promise<Licitacion[]> {
    const r = await this.t.v1<Respuesta | null>("licitaciones.json", params);
    return Array.isArray(r?.Listado) ? r.Listado.map(parseLicitacion) : [];
  }
}
