import type { AlEvento } from "./eventos.js";
import { diaSantiago } from "./fecha.js";
import type { EstadoCuota } from "./http.js";
import type { Proceso } from "./modelo.js";

/** Dónde deja `sync` los procesos. Implementa esto para usar otra base (Postgres viene en v1.x). */
export interface Store {
  obtener(codigo: string): Promise<Proceso | undefined>;
  guardar(procesos: Proceso[]): Promise<void>;
  /** Marca de avance de cada fuente (último día recorrido, último cambio visto). */
  cursor(clave: string): Promise<string | undefined>;
  fijarCursor(clave: string, valor: string): Promise<void>;
  todos(): AsyncIterable<Proceso>;
  /**
   * Opcional: `guardar` + `fijarCursor` en una sola escritura (transacción). Sin esto, sync llama a los dos en ese
   * orden; con esto, un corte nunca deja el cursor adelante de los datos y se ahorra una escritura por lote.
   */
  guardarConCursor?(procesos: Proceso[], clave: string, valor: string): Promise<void>;
  /** Opcional: libera lo que tenga tomado (el lock de `storeArchivo`). Después no se puede escribir. */
  cerrar?(): Promise<void>;
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
 * Un lock de otra máquina (o sin pid) sin señales de vida por más de esto se considera abandonado. Mientras el dueño
 * vive, lo renueva cada minuto. En la misma máquina manda el pid: un proceso vivo pero suspendido no lo pierde.
 */
const VENCE_LOCK_MS = 10 * 60_000;

type Fs = typeof import("node:fs/promises");

/**
 * Store en un archivo JSON. Se lee entero al abrir y se reescribe (atómico: tmp + fsync + rename) en cada lote.
 * Toma `<ruta>.lock` (pid, host y hora; nunca el ticket) para que dos procesos no escriban el mismo archivo: si otro
 * lo tiene, falla con un mensaje claro. El lock se libera con `cerrar()` o queda abandonado si el proceso muere.
 * Antes de cada rename revisa que el lock siga siendo suyo: si se lo quitaron, falla sin pisar el store del otro.
 * Si el JSON está dañado, lo mueve a `<ruta>.corrupto-<fecha>` y falla: nunca parte de cero en silencio.
 * ponytail: sirve hasta unas decenas de miles de procesos; más allá, usar un Store con base de datos.
 * Solo Node/Bun/Deno: importa node:fs al abrir.
 */
export async function storeArchivo(ruta: string): Promise<Store> {
  const fs = await import("node:fs/promises");
  const { hostname } = await import("node:os");
  const lock = `${ruta}.lock`;
  const yo = await tomarLock(fs, ruta, lock, hostname());
  const tmp = `${ruta}.${process.pid}.tmp`; // por proceso: otro que escriba la misma ruta no comparte el temporal
  const latido = setInterval(() => {
    const t = new Date();
    fs.utimes(lock, t, t).catch(() => {});
  }, 60_000);
  (latido as { unref?: () => void }).unref?.();
  const soltar = async () => {
    clearInterval(latido);
    if ((await fs.readFile(lock, "utf8").catch(() => "")) === yo) await fs.rm(lock, { force: true });
  };

  let d: Datos;
  try {
    d = await leer(fs, ruta);
  } catch (e) {
    await soltar();
    throw e;
  }

  let cerrado = false;
  let cola: Promise<void> = Promise.resolve();
  // Serializadas: dos escrituras a la vez se pisarían el .tmp.
  const escribir = () =>
    (cola = cola
      .catch(() => {})
      .then(async () => {
        if (cerrado) throw new Error(`El store ${ruta} ya se cerró`);
        const h = await fs.open(tmp, "w");
        try {
          await h.writeFile(JSON.stringify(d));
          await h.sync();
        } finally {
          await h.close();
        }
        // ponytail: queda una ventana de ms entre revisar y renombrar; cerrarla del todo pide un lock del sistema (flock).
        const dueño = await fs.readFile(lock, "utf8").catch(() => "");
        if (dueño !== yo) {
          await fs.rm(tmp, { force: true });
          throw new Error(`Se perdió el lock de ${ruta} (${lock}: ${dueño || "no existe"}); no se escribe para no pisar el store de otro proceso. Vuelve a abrirlo.`);
        }
        await fs.rename(tmp, ruta);
      }));

  return new (class extends StoreMemoria {
    override async guardar(procesos: Proceso[]) {
      await super.guardar(procesos);
      if (procesos.length) await escribir();
    }
    override async fijarCursor(clave: string, valor: string) {
      await super.fijarCursor(clave, valor);
      await escribir();
    }
    async guardarConCursor(procesos: Proceso[], clave: string, valor: string) {
      await super.guardar(procesos);
      await super.fijarCursor(clave, valor);
      await escribir();
    }
    async cerrar() {
      if (cerrado) return;
      await cola.catch(() => {});
      cerrado = true;
      await soltar();
    }
  })(d);
}

async function tomarLock(fs: Fs, ruta: string, lock: string, host: string): Promise<string> {
  const yo = JSON.stringify({ pid: process.pid, host, desde: new Date().toISOString() });
  for (let intento = 0; ; intento++) {
    try {
      await fs.writeFile(lock, yo, { flag: "wx" });
      return yo;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const otro = await fs.readFile(lock, "utf8").catch(() => "");
    const mtime = (await fs.stat(lock).catch(() => undefined))?.mtimeMs ?? 0;
    if (intento > 0 || !abandonado(otro, mtime, host)) {
      throw new Error(`${ruta} está en uso por otro proceso (${lock}: ${otro || "sin datos"}). Si no hay otro sync corriendo, borra ${lock}.`);
    }
    // ponytail: si dos procesos ven el mismo lock abandonado a la vez, ambos pueden robarlo; la ventana es de ms.
    await fs.rm(lock, { force: true });
  }
}

/** ¿El dueño del lock murió (mismo host: por pid, aunque lleve rato sin renovarlo) o dejó de renovarlo (otro host o sin pid)? */
function abandonado(contenido: string, mtimeMs: number, host: string): boolean {
  const l = ((): { pid?: unknown; host?: unknown } | null => {
    try {
      return JSON.parse(contenido);
    } catch {
      return null;
    }
  })();
  if (l?.host === host && Number.isInteger(l.pid)) {
    try {
      process.kill(l.pid as number, 0); // no mata: solo pregunta si existe
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH"; // EPERM: existe, de otro usuario
    }
  }
  return Date.now() - mtimeMs > VENCE_LOCK_MS;
}

async function leer(fs: Fs, ruta: string): Promise<Datos> {
  let texto: string;
  try {
    texto = await fs.readFile(ruta, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { procesos: {}, cursores: {} };
    throw e;
  }
  try {
    const d = JSON.parse(texto) as Datos;
    const objeto = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
    if (objeto(d) && objeto(d.procesos) && objeto(d.cursores)) return d;
  } catch {}
  const aparte = `${ruta}.corrupto-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.rename(ruta, aparte);
  throw new Error(`${ruta} está dañado (no es un store válido); se movió a ${aparte} para no perderlo. Revísalo, o vuelve a sincronizar desde cero.`);
}

export interface CuotaArchivo {
  /** Lo que decía el archivo al abrirlo; pásalo como `cuota` al cliente. `undefined` si no existía o estaba dañado. */
  estado: EstadoCuota | undefined;
  /** Pásalo como `alEvento` (o llámalo desde el tuyo): guarda tras cada consulta, así un crash no pierde la cuenta. */
  alEvento: AlEvento;
  /** Espera a que termine la última escritura. Llámalo antes de salir. */
  guardar(): Promise<void>;
}

/**
 * Cuota del día compartida en un archivo JSON `{ dia, usadas }`, como la de la CLI. Tras cada consulta suma lo gastado
 * a lo que diga el archivo en ese momento (no lo que decía al abrirlo), así dos procesos con el mismo ticket no se
 * pisan la cuenta. Escritura atómica (tmp + rename). Si no se puede escribir, no falla: reintenta en la siguiente.
 * ponytail: sin lock; dos procesos que escriben en el mismo milisegundo pueden perder lo de uno. Lock con `wx` si importa.
 * Solo Node/Bun/Deno: importa node:fs al abrir.
 *
 * ```ts
 * const archivo = await cuotaArchivo("cuota.json");
 * const mp = new MercadoPublico({ ticket, cuota: archivo.estado, alEvento: archivo.alEvento });
 * try { … } finally { await archivo.guardar(); }
 * ```
 */
export async function cuotaArchivo(ruta: string): Promise<CuotaArchivo> {
  const fs = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const leer = async (): Promise<EstadoCuota | undefined> => {
    try {
      const c = JSON.parse(await fs.readFile(ruta, "utf8")) as EstadoCuota;
      return typeof c.dia === "string" && Number.isInteger(c.usadas) ? { dia: c.dia, usadas: c.usadas } : undefined;
    } catch {
      return undefined;
    }
  };
  let sinGuardar = 0;
  let cola = Promise.resolve();
  const escribir = async () => {
    const n = sinGuardar;
    if (n === 0) return;
    sinGuardar = 0;
    try {
      const dia = diaSantiago();
      const ahora = await leer();
      await fs.mkdir(dirname(ruta), { recursive: true });
      const tmp = `${ruta}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ dia, usadas: (ahora?.dia === dia ? ahora.usadas : 0) + n }));
      await fs.rename(tmp, ruta);
    } catch {
      sinGuardar += n; // queda para la próxima
    }
  };
  return {
    estado: await leer(),
    alEvento: (e) => {
      if (e.tipo !== "consulta") return;
      sinGuardar++;
      cola = cola.then(escribir);
    },
    guardar: () => (cola = cola.then(escribir)),
  };
}
