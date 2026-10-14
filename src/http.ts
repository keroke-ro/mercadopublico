import { MercadoPublicoError, type TipoError } from "./errores.js";
import { emitir, type AlEvento, type Aviso, type EstadoCircuito, type Fuente } from "./eventos.js";
import { diaSantiago, isoSantiago, proximaMedianoche } from "./fecha.js";

export const BASE_V1 = "https://api.mercadopublico.cl/servicios/v1/publico";

/** Fracciones de la cuota diaria que disparan un evento `cuota` (una vez por día cada una). */
export const UMBRALES_CUOTA = [0.8, 0.95, 1] as const;

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
  /** Umbrales ya avisados hoy. */
  private avisados = new Set<number>();

  constructor(
    readonly limite = 10_000,
    estado?: EstadoCuota,
    private readonly ahora: () => Date = () => new Date(),
    private readonly alEvento?: AlEvento,
  ) {
    // Copia: el estado que pasa el usuario (p. ej. leído de un archivo) no se toca.
    this.estado = estado ? { ...estado } : { dia: diaSantiago(this.ahora()), usadas: 0 };
  }

  private hoy(): EstadoCuota {
    const dia = diaSantiago(this.ahora());
    if (this.estado.dia !== dia) {
      this.estado = { dia, usadas: 0 };
      this.avisados.clear();
    }
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
    const usadas = (this.hoy().usadas += n);
    for (const u of UMBRALES_CUOTA) {
      if (usadas < u * this.limite || this.avisados.has(u)) continue;
      this.avisados.add(u);
      emitir(this.alEvento, { tipo: "cuota", usadas, limite: this.limite, restante: this.restante });
    }
  }

  /** La API dijo que la cuota se acabó: la cuenta local pasa a agotada para no seguir consultando hoy. */
  agotar(): void {
    const falta = this.restante;
    if (falta > 0) this.registrar(falta);
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

/** Ritmo adaptativo (AIMD): ante un 10500 la pausa se multiplica; tras varios éxitos seguidos baja de a poco hasta `intervaloMs`. */
export const RITMO = {
  factor: 2,
  maximoMs: 8000,
  /** Éxitos seguidos para bajar un paso. */
  exitos: 20,
  pasoMs: 250,
};

/** Circuit breaker: tras `umbral` caídas seguidas (servidor, red, respuesta inválida) la fuente se da por caída `enfriamientoMs`. */
export const CIRCUITO = { umbral: 5, enfriamientoMs: 60_000 };

/** Los reintentos no pueden pasar de esta fracción de los últimos `ventana` intentos (más `reintentos`, para arrancar). */
export const PRESUPUESTO_REINTENTOS = { fraccion: 0.3, ventana: 100 };

/** Errores que indican que el servicio está caído, no que el pedido estaba mal. */
const CAIDAS: ReadonlySet<TipoError> = new Set(["servidor", "red", "respuesta_invalida"]);

export interface Salud {
  estado: EstadoCircuito;
  fallas: number;
  /** ISO con offset de Santiago. */
  ultimaFalla?: string;
  /** Pausa actual entre consultas (solo v1 y v2). */
  intervaloMs?: number;
}

/** cerrado → abierto tras `umbral` caídas seguidas → semiabierto pasado el enfriamiento, que deja pasar una sola sonda. */
export class Circuito {
  estado: EstadoCircuito = "cerrado";
  fallas = 0;
  ultimaFalla?: string;
  private hasta = 0;

  constructor(
    readonly fuente: Fuente,
    private readonly o: { umbral?: number; enfriamientoMs?: number; ahora?: () => Date; alEvento?: AlEvento } = {},
  ) {}

  private ahora = () => (this.o.ahora?.() ?? new Date()).getTime();

  private cambiar(estado: EstadoCircuito): void {
    if (this.estado === estado) return;
    this.estado = estado;
    emitir(this.o.alEvento, { tipo: "circuito", fuente: this.fuente, estado, fallas: this.fallas });
  }

  /** Lanza "circuito_abierto" si la fuente está caída; en semiabierto la primera llamada pasa como sonda. */
  exigir(): void {
    if (this.estado === "abierto" && this.ahora() >= this.hasta) return this.cambiar("semiabierto");
    if (this.estado === "cerrado") return;
    const cuando = this.estado === "semiabierto" ? "hay una sonda en curso" : `se vuelve a probar después de ${isoSantiago(new Date(this.hasta))}`;
    throw new MercadoPublicoError("circuito_abierto", `${this.fuente} viene fallando (${this.fallas} seguidas); ${cuando}`);
  }

  exito(): void {
    this.fallas = 0;
    this.cambiar("cerrado");
  }

  falla(): void {
    this.fallas++;
    this.ultimaFalla = isoSantiago(new Date(this.ahora()));
    if (this.estado === "semiabierto" || this.fallas >= (this.o.umbral ?? CIRCUITO.umbral)) {
      this.hasta = this.ahora() + (this.o.enfriamientoMs ?? CIRCUITO.enfriamientoMs);
      this.cambiar("abierto");
    }
  }

  /** Anota el resultado de un intento. Un error que no es caída (parámetros, 404, 10500…) prueba que el servicio responde. */
  anotar(e?: unknown): void {
    if (!(e instanceof MercadoPublicoError)) return e === undefined ? this.exito() : this.soltar();
    if (CAIDAS.has(e.tipo)) this.falla();
    else if (e.tipo === "cancelada" || e.tipo === "circuito_abierto") this.soltar();
    else this.exito();
  }

  /** La sonda no llegó a decidir (cancelada): la próxima llamada vuelve a ser sonda. */
  private soltar(): void {
    if (this.estado === "semiabierto") {
      this.estado = "abierto";
      this.hasta = 0;
    }
  }

  salud(): Salud {
    return { estado: this.estado, fallas: this.fallas, ...(this.ultimaFalla && { ultimaFalla: this.ultimaFalla }) };
  }
}

export interface Cancelable {
  /** Cancela la consulta en vuelo, la pausa y el backoff; rechaza con tipo "cancelada". */
  signal?: AbortSignal;
}

const cancelada = (s: AbortSignal) => new MercadoPublicoError("cancelada", "Consulta cancelada", { cause: s.reason });

/** `p`, o "cancelada" apenas `signal` aborte. */
export function cancelable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return (p.catch(() => {}), Promise.reject(cancelada(signal)));
  return new Promise<T>((ok, mal) => {
    const fin = () => mal(cancelada(signal));
    signal.addEventListener("abort", fin, { once: true });
    p.then(ok, mal).finally(() => signal.removeEventListener("abort", fin));
  });
}

/** Une señales; `soltar` quita los listeners del respaldo (sin AbortSignal.any) para no acumularlos en una señal larga. */
function unirSeñales(s: AbortSignal[]): { signal: AbortSignal; soltar: () => void } {
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(s), soltar: () => {} };
  const c = new AbortController();
  const quitar: (() => void)[] = [];
  for (const x of s) {
    if (x.aborted) c.abort(x.reason);
    else {
      const f = () => c.abort(x.reason);
      x.addEventListener("abort", f, { once: true });
      quitar.push(() => x.removeEventListener("abort", f));
    }
  }
  return { signal: c.signal, soltar: () => quitar.forEach((q) => q()) };
}

const dormirReal = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal?.aborted) return r(); // ya cancelada: no dejar un timer vivo
    const fin = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", fin);
      r();
    };
    const t = setTimeout(fin, ms);
    signal?.addEventListener("abort", fin, { once: true });
  });

export interface OpcionesTransporte {
  ticket: string;
  fetch?: typeof fetch;
  /** Reintentos ante 10500, 5xx o corte de red. Por defecto 4. */
  reintentos?: number;
  /** Base del backoff exponencial, en ms. Por defecto 1000. */
  esperaBaseMs?: number;
  /** Timeout por consulta, en ms. Por defecto 30000. */
  timeoutMs?: number;
  /**
   * Mínimo entre el inicio de una consulta y la siguiente a la misma API, en ms. Por defecto 1000; 0 desactiva el ritmo.
   * La API responde 10500 ("peticiones simultáneas", con HTTP 429) también a consultas seriales, de forma intermitente.
   * Medido el 2026-10-13: sin pausa fallan 4 de 10, con 1 s 3 de 11 y con 2 s 1 de 7. Por eso la pausa sube sola ante
   * cada 10500 (ver RITMO) y los reintentos cubren el resto, pero cada uno se cuenta en la cuota.
   */
  intervaloMs?: number;
  /** Ajustes del ritmo adaptativo. Por defecto RITMO. */
  ritmo?: Partial<typeof RITMO>;
  /** Ajustes del circuit breaker de v1 y v2. Por defecto CIRCUITO. */
  circuito?: Partial<typeof CIRCUITO>;
  /** Fracción máxima de reintentos sobre los últimos 100 intentos. Por defecto 0.3. */
  presupuestoReintentos?: number;
  limiteDiario?: number;
  /** Estado de cuota guardado de una ejecución anterior del mismo día. */
  cuota?: EstadoCuota;
  baseV1?: string;
  baseV2?: string;
  /** Recibe lo que el SDK observa de sí mismo: consultas, reintentos, ritmo, circuito, cuota, conversiones y avisos. */
  alEvento?: AlEvento;
  /** Inyectables para tests. */
  ahora?: () => Date;
  dormir?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type Params = Record<string, string | number | boolean | undefined | null | readonly (string | number)[]>;
type Api = "v1" | "v2";

/** Cola serial + ritmo + circuito + reintentos + cuota. Todas las consultas a la API pasan por aquí, de a una. */
export class Transporte {
  readonly cuota: Cuota;
  readonly alEvento?: AlEvento;
  /** Para los parsers: convierte cada `Aviso` en un evento. */
  private avisados = new Set<string>();
  /**
   * Un aviso por (origen, tipo, ruta) por cliente: un campo nuevo en la API no puede generar un evento por proceso.
   * ponytail: por vida del cliente; si hace falta volver a verlos, crear otro cliente.
   */
  readonly avisar = ({ tipo, ...a }: Aviso): void => {
    const k = `${a.origen}|${tipo}|${a.ruta}`;
    if (this.avisados.has(k)) return;
    this.avisados.add(k);
    emitir(this.alEvento, { tipo: "aviso", aviso: tipo, ...a });
  };
  /** Uno por fuente. Los de los conversores los usa la cadena por defecto de `MercadoPublico`. */
  readonly circuitos: Record<Fuente, Circuito>;
  private cola: Promise<unknown> = Promise.resolve();
  private readonly ritmo: Record<Api, { intervaloMs: number; exitos: number; ultima: number }>;
  /** true = reintento, de los últimos PRESUPUESTO_REINTENTOS.ventana intentos. */
  private ventana: boolean[] = [];
  private readonly o: Required<Omit<OpcionesTransporte, "cuota" | "limiteDiario" | "alEvento" | "ritmo" | "circuito">> & { ritmo: typeof RITMO };

  constructor(opciones: OpcionesTransporte) {
    if (!opciones.ticket) throw new MercadoPublicoError("ticket_invalido", "Falta el ticket de la API de Mercado Público");
    this.o = {
      ticket: opciones.ticket,
      fetch: opciones.fetch ?? ((...a) => globalThis.fetch(...a)),
      reintentos: opciones.reintentos ?? 4,
      esperaBaseMs: opciones.esperaBaseMs ?? 1000,
      timeoutMs: opciones.timeoutMs ?? 30_000,
      intervaloMs: opciones.intervaloMs ?? 1000,
      ritmo: { ...RITMO, ...opciones.ritmo },
      presupuestoReintentos: opciones.presupuestoReintentos ?? PRESUPUESTO_REINTENTOS.fraccion,
      baseV1: opciones.baseV1 ?? BASE_V1,
      baseV2: opciones.baseV2 ?? BASE_V2,
      ahora: opciones.ahora ?? (() => new Date()),
      dormir: opciones.dormir ?? dormirReal,
    };
    this.alEvento = opciones.alEvento;
    this.cuota = new Cuota(opciones.limiteDiario, opciones.cuota, this.o.ahora, this.alEvento);
    const base = { ahora: this.o.ahora, alEvento: this.alEvento };
    const c = (f: Fuente, extra = {}) => new Circuito(f, { ...base, ...extra });
    this.circuitos = {
      v1: c("v1", opciones.circuito),
      v2: c("v2", opciones.circuito),
      mindicador: c("mindicador"),
      bcentral: c("bcentral"),
      paridad: c("paridad"),
    };
    const r = () => ({ intervaloMs: this.o.intervaloMs, exitos: 0, ultima: -Infinity });
    this.ritmo = { v1: r(), v2: r() };
  }

  /** GET a la API v1. El ticket va en la query. Devuelve el JSON tal cual. */
  v1<T = unknown>(ruta: string, params: Params = {}, { signal }: Cancelable = {}): Promise<T> {
    const url = armarUrl(this.o.baseV1, ruta, { ...params, ticket: this.o.ticket });
    const visible = armarUrl(this.o.baseV1, ruta, params);
    return this.enCola(() => this.consultar(url, visible, {}, "v1", signal), signal) as Promise<T>;
  }

  /** GET a la API v2 (Compra Ágil). El ticket va en un header. Devuelve `payload`. */
  v2<T = unknown>(ruta: string, params: Params = {}, { signal }: Cancelable = {}): Promise<T> {
    const url = armarUrl(this.o.baseV2, ruta, params);
    return this.enCola(() => this.consultar(url, url, { [HEADER_TICKET_V2]: this.o.ticket }, "v2", signal), signal) as Promise<T>;
  }

  /** Estado de cada fuente: circuito, caídas seguidas, última caída y, en v1/v2, la pausa actual. */
  salud(): Record<Fuente, Salud> {
    const s = Object.fromEntries(Object.entries(this.circuitos).map(([f, c]) => [f, c.salud()])) as Record<Fuente, Salud>;
    s.v1.intervaloMs = this.ritmo.v1.intervaloMs;
    s.v2.intervaloMs = this.ritmo.v2.intervaloMs;
    return s;
  }

  private enCola<T>(tarea: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Si se cancela mientras espera turno, la tarea igual corre cuando le toque, pero solo para ver el signal y salir.
    const p = this.cola.then(tarea);
    this.cola = p.catch(() => {});
    return cancelable(p, signal);
  }

  private async consultar(url: string, visible: string, headers: Record<string, string>, api: Api, signal?: AbortSignal): Promise<unknown> {
    const circuito = this.circuitos[api];
    for (let intento = 1; ; intento++) {
      if (signal?.aborted) throw cancelada(signal);
      // La cuota primero: si fallara después de pasar el circuito a semiabierto, la sonda quedaría tomada para siempre.
      if (this.cuota.restante <= 0) this.cuota.exigir(1, "la consulta");
      circuito.exigir();
      this.anotarIntento(intento > 1);
      try {
        const r = await this.unaVez(url, visible, headers, api, intento, signal);
        circuito.anotar();
        this.ajustarRitmo(api, true);
        return r;
      } catch (e) {
        circuito.anotar(e);
        if (e instanceof MercadoPublicoError && e.tipo === "simultaneas") this.ajustarRitmo(api, false);
        if (e instanceof MercadoPublicoError && e.tipo === "cuota_agotada") this.cuota.agotar();
        if (!(e instanceof MercadoPublicoError) || !e.reintentable || intento > this.o.reintentos) throw e;
        // Con el circuito recién abierto o sin presupuesto, se entrega el error real en vez de esperar para nada.
        if (circuito.estado === "abierto" || !this.hayPresupuesto()) throw e;
        // Backoff exponencial con jitter: entre la mitad y el total de base·2^(intento-1).
        const base = this.o.esperaBaseMs * 2 ** (intento - 1);
        const esperaMs = Math.round(base / 2 + Math.random() * (base / 2));
        emitir(this.alEvento, { tipo: "reintento", fuente: api, motivo: e.tipo, intento: intento + 1, esperaMs });
        await cancelable(this.o.dormir(esperaMs, signal), signal);
      }
    }
  }

  private anotarIntento(reintento: boolean): void {
    this.ventana.push(reintento);
    if (this.ventana.length > PRESUPUESTO_REINTENTOS.ventana) this.ventana.shift();
  }

  /** ¿Cabe un reintento más? Siempre caben `reintentos` en la ventana, para que una sola consulta pueda usarlos. */
  private hayPresupuesto(): boolean {
    const usados = this.ventana.filter(Boolean).length;
    return usados < Math.max(this.o.reintentos, this.o.presupuestoReintentos * this.ventana.length);
  }

  private ajustarRitmo(api: Api, ok: boolean): void {
    const r = this.ritmo[api];
    const { factor, maximoMs, exitos, pasoMs } = this.o.ritmo;
    const antes = r.intervaloMs;
    if (!ok) {
      r.exitos = 0;
      r.intervaloMs = Math.min(Math.max(maximoMs, this.o.intervaloMs), r.intervaloMs * factor);
    } else if (++r.exitos >= exitos && r.intervaloMs > this.o.intervaloMs) {
      r.exitos = 0;
      r.intervaloMs = Math.max(this.o.intervaloMs, r.intervaloMs - pasoMs);
    }
    if (r.intervaloMs !== antes) emitir(this.alEvento, { tipo: "ritmo", fuente: api, intervaloMs: r.intervaloMs });
  }

  private async unaVez(url: string, visible: string, headers: Record<string, string>, api: Api, intento: number, signal?: AbortSignal): Promise<unknown> {
    const r = this.ritmo[api];
    const espera = r.ultima + r.intervaloMs - this.o.ahora().getTime();
    if (espera > 0) await cancelable(this.o.dormir(espera, signal), signal);
    if (signal?.aborted) throw cancelada(signal);
    const t0 = this.o.ahora().getTime();
    r.ultima = t0;
    this.cuota.registrar();
    let status: number | null = null;
    const host = new URL(url).host;
    let soltar = () => {};
    try {
      let res: Response;
      const senal = unirSeñales(signal ? [signal, AbortSignal.timeout(this.o.timeoutMs)] : [AbortSignal.timeout(this.o.timeoutMs)]);
      soltar = senal.soltar;
      try {
        res = await cancelable(this.o.fetch(url, { headers: { accept: "application/json", ...headers }, signal: senal.signal }), signal);
      } catch (e) {
        if (signal?.aborted) throw cancelada(signal);
        throw new MercadoPublicoError("red", `No se pudo conectar con ${host}`, { cause: this.sinTicket(e) });
      }
      status = res.status;
      let texto: string;
      try {
        texto = await cancelable(res.text(), signal);
      } catch (e) {
        if (signal?.aborted) throw cancelada(signal);
        throw new MercadoPublicoError("red", `Se cortó la respuesta de ${host}`, { cause: this.sinTicket(e) });
      }
      let cuerpo: unknown;
      try {
        cuerpo = texto ? JSON.parse(texto) : undefined;
      } catch {
        if (res.ok) throw new MercadoPublicoError("respuesta_invalida", "La API respondió algo que no es JSON", { status: res.status });
      }
      const error = clasificar(res.status, cuerpo, api);
      if (error) throw error;
      return api === "v2" ? (cuerpo as { payload?: unknown }).payload : cuerpo;
    } finally {
      soltar();
      emitir(this.alEvento, { tipo: "consulta", fuente: api, url: visible, status, ms: this.o.ahora().getTime() - t0, intento });
    }
  }

  /**
   * Copia del error de red sin el ticket: Bun guarda la URL completa en `path` y Deno la pone en el mensaje, y la v1
   * lleva el ticket en la URL. Se conserva nombre, mensaje y `code` (también el de `cause`), que es lo útil para depurar.
   */
  private sinTicket(e: unknown): Error {
    const tapar = (t: unknown) => String(t ?? "").replaceAll(this.o.ticket, "***");
    const x = (e ?? {}) as { name?: string; message?: string; code?: string; cause?: { code?: string } };
    const limpio = new Error(tapar(x.message ?? e), x.cause?.code ? { cause: { code: x.cause.code } } : undefined) as Error & { code?: string };
    limpio.name = x.name ?? "Error";
    if (x.code) limpio.code = tapar(x.code);
    return limpio;
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

const TICKET_INVALIDO = /ticket.*(no es v[aá]lido|no v[aá]lido|inv[aá]lido|no existe)/;
const CUOTA_AGOTADA = /cuota|l[ií]mite (diario|de (solicitudes|peticiones|consultas))/;

/**
 * Error de cualquiera de los dos formatos: v1 {Codigo, Mensaje} o v2 {success:"NOK", errors:[{codigo, mensaje}]}.
 * Decide primero por código y status; el texto del mensaje es el último recurso porque la v1 no documenta sus códigos.
 */
function clasificar(status: number, cuerpo: unknown, api: "v1" | "v2"): MercadoPublicoError | undefined {
  const c = cuerpo && typeof cuerpo === "object" && !Array.isArray(cuerpo) ? (cuerpo as Record<string, unknown>) : undefined;
  let codigo: number | string | undefined;
  let mensaje: string | undefined;
  if (api === "v1" && c && "Codigo" in c && !("Listado" in c)) {
    codigo = c.Codigo as number | string;
    mensaje = String(c.Mensaje ?? "");
  } else if (api === "v2" && c && c.success !== "OK" && c.success !== true && c.errors) {
    // success llega como "NOK" (error del pedido) o "ERROR" (falla interna, visto con HTTP 500).
    const errs = (Array.isArray(c.errors) ? c.errors : [c.errors]) as ({ codigo?: string; mensaje?: string } | string | null)[];
    codigo = typeof errs[0] === "object" ? errs[0]?.codigo : undefined;
    mensaje = errs.map((e) => (typeof e === "object" && e ? (e.mensaje ?? JSON.stringify(e)) : String(e))).join("; ");
  } else if (api === "v2" && c && status >= 400 && typeof c.mensaje === "string") {
    // Error de la v2 sin sobre: {"codigo":"ERROR_INTERNO","mensaje":"…"}.
    codigo = c.codigo as string | undefined;
    mensaje = c.mensaje;
  }
  if (status < 400 && mensaje === undefined) {
    return c ? undefined : new MercadoPublicoError("respuesta_invalida", "La API respondió un JSON inesperado", { status });
  }

  const texto = (mensaje ?? "").toLowerCase();
  let tipo: TipoError;
  const codigoHttp5xx = Number(codigo) >= 500 && Number(codigo) < 600;
  if (Number(codigo) === 10500 || /simult[aá]ne/.test(texto)) tipo = "simultaneas";
  // Cuota agotada solo si el mensaje lo dice, o si la v2 lo informa con su código 429 documentado.
  else if (CUOTA_AGOTADA.test(texto) && (status === 429 || codigo !== undefined)) tipo = "cuota_agotada";
  else if (api === "v2" && (status === 429 || Number(codigo) === 429)) tipo = "cuota_agotada";
  // Un 429 de la v1 sin mensaje de cuota (cuerpo vacío, HTML de un proxy, 10500 cortado) es freno por ritmo: se reintenta.
  else if (api === "v1" && status === 429) tipo = "simultaneas";
  else if (status === 401 || status === 403) tipo = "ticket_invalido";
  else if (api === "v1" && codigo !== undefined && TICKET_INVALIDO.test(texto)) tipo = "ticket_invalido";
  // En la v1 el status HTTP no es confiable: un Codigo propio (10300…) es error del pedido aunque venga con 500.
  // Un Codigo que es un 5xx HTTP, en cambio, es falla del servidor.
  else if (api === "v1" && codigo !== undefined && !codigoHttp5xx) tipo = "parametros";
  else if (status === 404) tipo = "no_encontrado";
  else if (status >= 500 || codigoHttp5xx) tipo = "servidor";
  else if (mensaje !== undefined || status === 400 || status === 422) tipo = "parametros";
  else tipo = "respuesta_invalida";

  return new MercadoPublicoError(tipo, mensaje || `HTTP ${status}`, { status, codigo });
}
