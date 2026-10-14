import type { Transporte } from "../http.js";
import { str } from "../util.js";

// [W] escribe estas rutas con "Publico" en mayúscula y no se sabe si el server distingue: se sube un nivel
// desde la base ("…/v1/publico") para respetarla tal cual.
const RUTA = "../Publico/Empresas";

export interface Empresa {
  codigo: string;
  nombre: string;
}

type Respuesta = { listaEmpresas?: unknown; Listado?: unknown };

/** "70017820K", "70.017.820-k" → "70.017.820-k", el formato que exige BuscarProveedor. */
export function formatearRut(rut: string): string {
  const t = rut.replace(/[^0-9kK]/g, "").toLowerCase();
  return `${t.slice(0, -1).replace(/\B(?=(\d{3})+$)/g, ".")}-${t.slice(-1)}`;
}

export class Empresas {
  constructor(private readonly t: Transporte) {}

  /** Código de empresa del proveedor en Mercado Público; null si el RUT no está registrado. 1 consulta. */
  async buscarProveedor(rut: string): Promise<{ codigoEmpresa: string; nombre: string } | null> {
    const e = (await this.listar("BuscarProveedor", { rutempresaproveedor: formatearRut(rut) }))[0];
    return e ? { codigoEmpresa: e.codigo, nombre: e.nombre } : null;
  }

  /** Todos los organismos compradores. 1 consulta. */
  buscarComprador(): Promise<Empresa[]> {
    return this.listar("BuscarComprador");
  }

  private async listar(ruta: string, params: Record<string, string> = {}): Promise<Empresa[]> {
    const r = await this.t.v1<Respuesta | null>(`${RUTA}/${ruta}`, params);
    // La lista se llama "listaEmpresas" según terceros; se acepta "Listado" por si acaso.
    const l = r?.listaEmpresas ?? r?.Listado;
    return (Array.isArray(l) ? l : []).flatMap((x: Record<string, unknown> | null) => {
      const codigo = str(x?.CodigoEmpresa);
      return codigo === null ? [] : [{ codigo, nombre: str(x?.NombreEmpresa) ?? "" }];
    });
  }
}
