// Sync incremental (PRD §3.3) con planificación de cuota (§3.2). Firmas estables: se pueden agregar campos, no quitar.
import { MercadoPublicoError } from "./errores.js";
import { sumarDias } from "./fecha.js";
import type { MercadoPublico } from "./index.js";
import type { Proceso } from "./modelo.js";
import type { Store } from "./store.js";

export type FuenteSync = "licitaciones" | "ordenes" | "compra_agil";

export interface OpcionesSync {
  /** Primer día a recorrer, "AAAA-MM-DD". Si el store ya tiene cursor para una fuente, se parte desde el cursor. */
  desde: string;
  /** Último día (incluido). Por defecto hoy en Santiago. */
  hasta?: string;
  /** Por defecto las tres. */
  fuentes?: FuenteSync[];
  /** Pedir el detalle de cada proceso nuevo o cambiado (1 consulta c/u). Por defecto true. */
  detalle?: boolean;
  /**
   * Volver a pedir el detalle de licitaciones y OC guardadas que siguen abiertas (1 consulta c/u), porque la v1 lista
   * cada día una sola vez. Por defecto true; requiere `detalle`. Ver REFRESCO_DIAS.
   */
  refrescar?: boolean;
  store: Store;
}

/** Un listado que ya bajó `planificar` y que `ejecutar` reutiliza sin volver a pedirlo. */
export interface ListadoSync {
  fuente: FuenteSync;
  /** v1: el día listado. v2: el `cambio_desde` usado. */
  desde: string;
  /** v1: el día completo. v2: solo la página 1. */
  items: Proceso[];
  /** Páginas del listado (v2); 1 en la v1. */
  paginas: number;
  /** v1: procesos guardados que se vuelven a pedir; no es un listado ni mueve el cursor. */
  refresco?: true;
}

export interface PlanSync {
  opciones: OpcionesSync;
  /** Consultas estimadas en total (incluye las que ya gastó planificar). */
  consultas: number;
  /** Consultas que ya gastó la planificación (listados que se reutilizan al ejecutar). */
  gastadas: number;
  desglose: { fuente: FuenteSync; consultas: number; nota: string }[];
  cabeHoy: boolean;
  restante: number;
  listados: ListadoSync[];
  /** Día (Santiago) en que se planificó: lo que se listó de ese día o después no estaba completo. */
  dia: string;
  /** `opciones.hasta` resuelto al planificar, para que ejecutar pida lo mismo aunque pase la medianoche. */
  hasta: string;
  /** Consultas de listado previstas (1 por día v1 y la página 1 de la v2), sin contar reintentos. */
  listadas: number;
}

export interface ResultadoSync {
  consultas: number;
  nuevos: number;
  actualizados: number;
  /** Procesos ya guardados que no se volvieron a consultar: en estado final o (v2) sin cambios desde la última vez. */
  omitidos: number;
  errores: { codigo: string; error: string }[];
  /** Si se detuvo antes de terminar porque se acabó la cuota local; lo hecho quedó guardado. */
  detenido?: string;
}

/**
 * Estados que ya no cambian, con los slugs de v1/codigos.ts y v2/parse.ts. Quedan fuera a propósito:
 * licitación cerrada/suspendida (aún se adjudica o revoca), OC recepcion_parcial/recepcion_conforme_incompleta
 * (puede faltar recepcionar), Compra Ágil proveedor_seleccionado (la v2 casi nunca pasa a oc_emitida, pero la OC
 * aparece después en el detalle) y cerrada.
 */
const FINALES: ReadonlySet<string> = new Set(["adjudicada", "desierta", "revocada", "cancelada", "recepcion_conforme", "oc_emitida"]);
const ABORTAN: ReadonlySet<string> = new Set(["cuota_agotada", "cuota_insuficiente", "ticket_invalido"]);

/** ¿Hay que pedir (o, sin detalle, volver a guardar) este proceso? */
function necesita(s: Proceso | undefined, item: Proceso, detalle: boolean): boolean {
  if (!s) return true;
  if (FINALES.has(s.estado)) return false;
  if (item.tipo === "compra_agil") return s.fechas.ultimoCambio !== item.fechas.ultimoCambio;
  return detalle || s.estado !== item.estado; // sin detalle, no se pisa lo guardado si nada cambió
}

/**
 * ponytail: el refresco v1 mira licitaciones con cierre y OC con creación en los últimos REFRESCO_DIAS días;
 * lo que siga abierto después de eso (OC que nunca se recepcionan, licitaciones olvidadas) ya no se re-pide.
 * Si hace falta, re-listar esos días con un `desde` viejo y sin cursor.
 */
const REFRESCO_DIAS = 90;

const filtrosCA = (cambioDesde: string, hasta: string) => ({ cambioDesde, cambioHasta: sumarDias(hasta, 1) });

export class Sync {
  constructor(private readonly mp: MercadoPublico) {}

  private hoy(): string {
    return this.mp.cuota.toJSON().dia; // respeta el reloj inyectado al cliente
  }

  async planificar(opciones: OpcionesSync): Promise<PlanSync> {
    const dia = this.hoy();
    const { store, desde, hasta = dia, fuentes = ["licitaciones", "ordenes", "compra_agil"], detalle = true, refrescar = true } = opciones;
    const cuota = this.mp.cuota;
    const antes = cuota.usadas;
    const dias = new Map<FuenteSync, string[]>();
    for (const f of fuentes) {
      if (f === "compra_agil") continue;
      const c = await store.cursor(f);
      const lista: string[] = [];
      for (let d = c && c >= desde ? sumarDias(c, 1) : desde; d <= hasta; d = sumarDias(d, 1)) lista.push(d);
      dias.set(f, lista);
    }
    // Los listados se gastan aquí mismo: si ni eso cabe, falla antes de pedir nada.
    const listadas = [...dias.values()].flat().length + (fuentes.includes("compra_agil") ? 1 : 0);
    cuota.exigir(listadas, "planificar el sync");

    const listados: ListadoSync[] = [];
    const desglose: PlanSync["desglose"] = [];
    for (const f of fuentes) {
      if (f === "compra_agil") {
        const cambioDesde = (await store.cursor(f)) ?? desde;
        const p = await this.mp.compraAgil.pagina(filtrosCA(cambioDesde, hasta), 1);
        listados.push({ fuente: f, desde: cambioDesde, items: p.items, paginas: p.totalPaginas });
        const det = detalle ? ` + hasta ${p.totalResultados} detalles (se saltan los sin cambios y los cerrados)` : "";
        desglose.push({ fuente: f, consultas: Math.max(1, p.totalPaginas) + (detalle ? p.totalResultados : 0), nota: `cota superior: ${p.totalPaginas} páginas${det}, cambios desde ${cambioDesde}` });
        continue;
      }
      let pedir = 0;
      let omitidos = 0;
      const ds = dias.get(f)!;
      const listados0 = new Set<string>();
      for (const d of ds) {
        const items: Proceso[] = await (f === "licitaciones" ? this.mp.licitaciones : this.mp.ordenes).delDia(d);
        listados.push({ fuente: f, desde: d, items, paginas: 1 });
        for (const it of items) (listados0.add(it.codigo), necesita(await store.obtener(it.codigo), it, detalle) ? pedir++ : omitidos++);
      }
      const abiertos: Proceso[] = [];
      if (detalle && refrescar) {
        const tipo = f === "licitaciones" ? "licitacion" : "orden_compra";
        for await (const s of store.todos()) {
          const ref = (s.tipo === "licitacion" ? s.fechas.cierre : (s.fechas.creacion ?? s.fechas.publicacion))?.slice(0, 10);
          if (s.tipo === tipo && !FINALES.has(s.estado) && !listados0.has(s.codigo) && ref && ref < dia && ref >= sumarDias(dia, -REFRESCO_DIAS)) abiertos.push(s);
        }
        if (abiertos.length) listados.push({ fuente: f, desde: dia, items: abiertos, paginas: 0, refresco: true });
      }
      const rango = ds.length ? `${ds[0]} a ${ds.at(-1)}` : "sin días nuevos";
      const que = f === "licitaciones" ? "cerradas" : "creadas";
      desglose.push({
        fuente: f,
        consultas: ds.length + (detalle ? pedir : 0) + abiertos.length,
        nota: `exacto: ${ds.length} días (${rango}) + ${detalle ? pedir : 0} detalles + ${abiertos.length} abiertas ${que} en los últimos ${REFRESCO_DIAS} días a refrescar; ${omitidos} ya guardados se omiten`,
      });
    }
    const consultas = desglose.reduce((a, d) => a + d.consultas, 0);
    const gastadas = cuota.usadas - antes;
    return { opciones, consultas, gastadas, desglose, cabeHoy: consultas - listadas <= cuota.restante, restante: cuota.restante, listados, dia, hasta, listadas };
  }

  async ejecutar(plan: PlanSync, o: { store?: Store; alAvanzar?: (p: { fuente: FuenteSync; hechas: number; total: number }) => void } = {}): Promise<ResultadoSync> {
    const store = o.store ?? plan.opciones.store;
    const { detalle = true } = plan.opciones;
    const cuota = this.mp.cuota;
    cuota.exigir(plan.consultas - plan.listadas, "el sync");
    const antes = cuota.usadas;
    const r: ResultadoSync = { consultas: 0, nuevos: 0, actualizados: 0, omitidos: 0, errores: [] };
    let reintentar = 0; // errores reintentables vistos
    const fin = () => ({ ...r, consultas: plan.gastadas + cuota.usadas - antes });
    const sinCuota = () => {
      if (cuota.restante >= 1) return false;
      r.detenido = `se acabó la cuota del día (se reinicia ${cuota.reinicia}); lo hecho quedó guardado`;
      return true;
    };

    let actual: FuenteSync | undefined;
    let base = 0;
    let inicio = 0;
    const avanzar = () =>
      o.alAvanzar?.({ fuente: actual!, hechas: base + cuota.usadas - inicio, total: plan.desglose.find((d) => d.fuente === actual)?.consultas ?? 0 });

    /** Procesa y guarda un lote (un día o una página). false = hay que parar. */
    const lote = async (items: Proceso[]): Promise<boolean> => {
      const listos: Proceso[] = [];
      try {
        for (const it of items) {
          const s = await store.obtener(it.codigo);
          if (!necesita(s, it, detalle)) {
            r.omitidos++;
            continue;
          }
          if (detalle && sinCuota()) return false;
          try {
            listos.push(detalle ? await this.detalle(actual!, it.codigo) : it);
            if (s) r.actualizados++;
            else r.nuevos++;
          } catch (e) {
            if (e instanceof MercadoPublicoError && ABORTAN.has(e.tipo)) throw e;
            if (e instanceof MercadoPublicoError && e.reintentable) reintentar++;
            r.errores.push({ codigo: it.codigo, error: e instanceof Error ? e.message : String(e) });
          }
          if (detalle) avanzar();
        }
        return true;
      } finally {
        await store.guardar(listos); // también si se aborta: lo pedido no se pierde
      }
    };

    // Un cursor solo avanza mientras todo lo anterior de su fuente salió sin errores reintentables (red, 5xx), para
    // reintentarlos la próxima vez. Los permanentes (no_encontrado, parametros…) se anotan y no lo frenan.
    const conErrores = new Set<FuenteSync>();
    for (const l of plan.listados) {
      if (l.fuente !== actual) {
        actual = l.fuente;
        base = plan.listados.filter((x) => x.fuente === actual && !x.refresco).length;
        inicio = cuota.usadas;
      }
      const e0 = reintentar;
      if (l.fuente !== "compra_agil") {
        if (!(await lote(l.items))) return fin();
        if (l.refresco) continue;
        if (reintentar > e0) conErrores.add(l.fuente);
        // El día en que se planificó no estaba completo: no se marca, la próxima vez se vuelve a listar.
        if (!conErrores.has(l.fuente) && l.desde < plan.dia) await store.fijarCursor(l.fuente, l.desde);
        avanzar();
        continue;
      }
      // ponytail: la v2 ordena por último cambio descendente, así que el cursor recién puede avanzar al terminar
      // todas las páginas. Si se corta, la próxima vez se re-listan las páginas, pero los detalles ya guardados se
      // saltan (mismo fecha_ultimo_cambio). Para reanudar sin re-listar haría falta un segundo cursor con cambio_hasta.
      let max = await store.cursor(l.fuente);
      for (let n = 1, items = l.items, total = l.paginas; ; ) {
        if (!(await lote(items))) return fin();
        for (const it of items) {
          const u = it.fechas.ultimoCambio;
          if (u && (!max || Date.parse(u) > Date.parse(max))) max = u;
        }
        if (++n > total) break;
        if (sinCuota()) return fin();
        ({ items, totalPaginas: total } = await this.mp.compraAgil.pagina(filtrosCA(l.desde, plan.hasta), n));
        avanzar();
      }
      if (reintentar === e0 && max) await store.fijarCursor(l.fuente, max);
      avanzar();
    }
    return fin();
  }

  private async detalle(f: FuenteSync, codigo: string): Promise<Proceso> {
    const p = f === "compra_agil" ? await this.mp.compraAgil.detalle(codigo) : await (f === "licitaciones" ? this.mp.licitaciones : this.mp.ordenes).porCodigo(codigo);
    if (!p) throw new MercadoPublicoError("no_encontrado", `${codigo} no tiene detalle`);
    return p;
  }
}
