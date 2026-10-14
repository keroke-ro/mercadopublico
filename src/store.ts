import type { Proceso } from "./modelo.js";

/** Dónde deja `sync` los procesos. Implementa esto para usar otra base (Postgres viene en v1.x). */
export interface Store {
  obtener(codigo: string): Promise<Proceso | undefined>;
  guardar(procesos: Proceso[]): Promise<void>;
  /** Marca de avance de cada fuente (último día recorrido, último cambio visto). */
  cursor(clave: string): Promise<string | undefined>;
  fijarCursor(clave: string, valor: string): Promise<void>;
  todos(): AsyncIterable<Proceso>;
}

interface Datos {
  procesos: Record<string, Proceso>;
  cursores: Record<string, string>;
}

class StoreMemoria implements Store {
  constructor(protected d: Datos = { procesos: {}, cursores: {} }) {}
  async obtener(codigo: string) {
    return this.d.procesos[codigo];
  }
  async guardar(procesos: Proceso[]) {
    for (const p of procesos) this.d.procesos[p.codigo] = p;
  }
  async cursor(clave: string) {
    return this.d.cursores[clave];
  }
  async fijarCursor(clave: string, valor: string) {
    this.d.cursores[clave] = valor;
  }
  async *todos() {
    yield* Object.values(this.d.procesos);
  }
}

export function storeMemoria(): Store {
  return new StoreMemoria();
}

/**
 * Store en un archivo JSON. Se lee entero al abrir y se reescribe (atómico: tmp + rename) en cada guardado.
 * ponytail: sirve hasta unas decenas de miles de procesos; más allá, usar un Store con base de datos.
 * Solo Node/Bun/Deno: importa node:fs al abrir.
 */
export async function storeArchivo(ruta: string): Promise<Store> {
  const fs = await import("node:fs/promises");
  let d: Datos = { procesos: {}, cursores: {} };
  try {
    d = JSON.parse(await fs.readFile(ruta, "utf8")) as Datos;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const escribir = async () => {
    await fs.writeFile(`${ruta}.tmp`, JSON.stringify(d));
    await fs.rename(`${ruta}.tmp`, ruta);
  };
  return new (class extends StoreMemoria {
    override async guardar(procesos: Proceso[]) {
      await super.guardar(procesos);
      await escribir();
    }
    override async fijarCursor(clave: string, valor: string) {
      await super.fijarCursor(clave, valor);
      await escribir();
    }
  })(d);
}
