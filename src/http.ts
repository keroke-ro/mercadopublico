import { MercadoPublicoError, type TipoError } from "./errores.js";
import { diaSantiago, proximaMedianoche } from "./fecha.js";

export const BASE_V1 = "https://api.mercadopublico.cl/servicios/v1/publico";

export interface EstadoCuota {
  dia: string;
  usadas: number;
}

/**
 * Cuenta local de consultas del día (en Santiago). La API no expone cuánto queda,
 * así que esto es lo que el SDK gastó desde este proceso más el estado inicial que le pases.
 * ponytail: se supone que la cuota se reinicia a medianoche de Santiago; confirmar en M0.
 */
export class Cuota {
  private estado: EstadoCuota;

  constructor(
    readonly limite = 10_000,
    estado?: EstadoCuota,
    private readonly ahora: () => Date = () => new Date(),
  ) {
    this.estado = estado ?? { dia: diaSantiago(this.ahora()), usadas: 0 };
  }

  private hoy(): EstadoCuota {
    const dia = diaSantiago(this.ahora());
    if (this.estado.dia !== dia) this.estado = { dia, usadas: 0 };
    return this.estado;
  }

  get usadas(): number {
    return this.hoy().usadas;
  }
  get restante(): number {
    return Math.max(0, this.limite - this.usadas);
  }
  get reinicia(): string {
    return proximaMedianoche(this.ahora());
  }

  registrar(n = 1): void {
    this.hoy().usadas += n;
  }

  /** Falla antes de empezar si la operación no cabe en lo que queda del día. */
  exigir(consultas: number, que = "la operación"): void {
    if (consultas > this.restante) {
      throw new MercadoPublicoError(
        "cuota_insuficiente",
        `${que} necesita unas ${consultas} consultas y quedan ${this.restante} de ${this.limite} hasta ${this.reinicia}`,
      );
    }
  }

  toJSON() {
    return { dia: this.hoy().dia, usadas: this.usadas, limite: this.limite, restante: this.restante, reinicia: this.reinicia };
  }
}

export interface OpcionesTransporte {
  ticket: string;
  fetch?: typeof fetch;
  /** Reintentos ante 10500, 5xx o corte de red. Por defecto 4. */
  reintentos?: number;
  /** Base del backoff exponencial, en ms. Por defecto 1000. */
  esperaBaseMs?: number;
  /** Timeout por consulta, en ms. Por defecto 30000. */
  timeoutMs?: number;
  limiteDiario?: number;
  /** Estado de cuota guardado de una ejecución anterior del mismo día. */
  cuota?: EstadoCuota;
  baseV1?: string;
  baseV2?: string;
  /** Inyectables para tests. */
  ahora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
}

type Params = Record<string, string | number | boolean | undefined | null | readonly (string | number)[]>;

/** Cola serial + reintentos + cuota. Todas las consultas a la API pasan por aquí, de a una. */
export class Transporte {
  readonly cuota: Cuota;
  private cola: Promise<unknown> = Promise.resolve();
  private readonly o: Required<Omit<OpcionesTransporte, "cuota" | "limiteDiario">>;

  constructor(opciones: OpcionesTransporte) {
    if (!opciones.ticket) throw new MercadoPublicoError("ticket_invalido", "Falta el ticket de la API de Mercado Público");
    this.o = {
      ticket: opciones.ticket,
      fetch: opciones.fetch ?? ((...a) => globalThis.fetch(...a)),
      reintentos: opciones.reintentos ?? 4,
      esperaBaseMs: opciones.esperaBaseMs ?? 1000,
      timeoutMs: opciones.timeoutMs ?? 30_000,
      baseV1: opciones.baseV1 ?? BASE_V1,
      baseV2: opciones.baseV2 ?? BASE_V2,
      ahora: opciones.ahora ?? (() => new Date()),
      dormir: opciones.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
    this.cuota = new Cuota(opciones.limiteDiario, opciones.cuota, this.o.ahora);
  }

  /** GET a la API v1. El ticket va en la query. Devuelve el JSON tal cual. */
  v1<T = unknown>(ruta: string, params: Params = {}): Promise<T> {
    const url = armarUrl(this.o.baseV1, ruta, { ...params, ticket: this.o.ticket });
    return this.enCola(() => this.consultar(url, {}, "v1")) as Promise<T>;
  }

  /** GET a la API v2 (Compra Ágil). El ticket va en un header. Devuelve `payload`. */
  v2<T = unknown>(ruta: string, params: Params = {}): Promise<T> {
    const url = armarUrl(this.o.baseV2, ruta, params);
    return this.enCola(() => this.consultar(url, { [HEADER_TICKET_V2]: this.o.ticket }, "v2")) as Promise<T>;
  }

  private enCola<T>(tarea: () => Promise<T>): Promise<T> {
    const p = this.cola.then(tarea);
    this.cola = p.catch(() => {});
    return p;
  }

  private async consultar(url: string, headers: Record<string, string>, api: "v1" | "v2"): Promise<unknown> {
    for (let intento = 0; ; intento++) {
      if (this.cuota.restante <= 0) this.cuota.exigir(1, "la consulta");
      try {
        return await this.unaVez(url, headers, api);
      } catch (e) {
        const err = e instanceof MercadoPublicoError ? e : new MercadoPublicoError("red", "Error de red", { cause: e });
        if (!err.reintentable || intento >= this.o.reintentos) throw err;
        // Backoff exponencial con jitter: entre la mitad y el total de base·2^intento.
        const espera = this.o.esperaBaseMs * 2 ** intento;
        await this.o.dormir(espera / 2 + Math.random() * (espera / 2));
      }
    }
  }

  private async unaVez(url: string, headers: Record<string, string>, api: "v1" | "v2"): Promise<unknown> {
    let res: Response;
    this.cuota.registrar();
    try {
      res = await this.o.fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(this.o.timeoutMs) });
    } catch (e) {
      throw new MercadoPublicoError("red", `No se pudo conectar con ${new URL(url).host}`, { cause: e });
    }
    const texto = await res.text();
    let cuerpo: unknown;
    try {
      cuerpo = texto ? JSON.parse(texto) : undefined;
    } catch {
      if (res.ok) throw new MercadoPublicoError("respuesta_invalida", "La API respondió algo que no es JSON", { status: res.status });
    }
    const error = clasificar(res.status, cuerpo, api);
    if (error) throw error;
    return api === "v2" ? (cuerpo as { payload?: unknown }).payload : cuerpo;
  }
}

// Según la Guía API Compra Ágil v2 v3.0 (mayo 2026), ver docs/api-notes.md §3.
export const BASE_V2 = "https://api2.mercadopublico.cl/v2";
export const HEADER_TICKET_V2 = "ticket";

function armarUrl(base: string, ruta: string, params: Params): string {
  const url = new URL(`${base.replace(/\/$/, "")}/${ruta.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return url.toString();
}

/** Mensaje de error de cualquiera de los dos formatos: v1 {Codigo, Mensaje} o v2 {success:"NOK", errors:[{codigo, mensaje}]}. */
function clasificar(status: number, cuerpo: unknown, api: "v1" | "v2"): MercadoPublicoError | undefined {
  const c = (cuerpo ?? {}) as Record<string, unknown>;
  let codigo: number | string | undefined;
  let mensaje: string | undefined;
  if (api === "v1" && "Codigo" in c && !("Listado" in c)) {
    codigo = c.Codigo as number | string;
    mensaje = String(c.Mensaje ?? "");
  } else if (api === "v2" && (c.success === "NOK" || c.success === false)) {
    const errs = (Array.isArray(c.errors) ? c.errors : [c.errors]) as ({ codigo?: string; mensaje?: string } | string | null)[];
    codigo = typeof errs[0] === "object" ? errs[0]?.codigo : undefined;
    mensaje = errs.map((e) => (typeof e === "object" && e ? (e.mensaje ?? JSON.stringify(e)) : String(e))).join("; ");
  }
  if (status < 400 && mensaje === undefined) return undefined;

  const texto = `${mensaje ?? ""}`.toLowerCase();
  let tipo: TipoError;
  if (Number(codigo) === 10500 || texto.includes("simult")) tipo = "simultaneas";
  else if (status === 429 || Number(codigo) === 429 || texto.includes("cuota") || texto.includes("límite") || texto.includes("limite")) tipo = "cuota_agotada";
  else if (status === 401 || status === 403 || texto.includes("ticket")) tipo = "ticket_invalido";
  else if (status === 404) tipo = "no_encontrado";
  else if (status >= 500) tipo = "servidor";
  else if (status === 400 || status === 422 || mensaje !== undefined) tipo = "parametros";
  else tipo = "respuesta_invalida";

  return new MercadoPublicoError(tipo, mensaje || `HTTP ${status}`, { status, codigo });
}
