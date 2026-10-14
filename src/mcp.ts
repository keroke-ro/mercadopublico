// Núcleo del servidor MCP, sin transporte ni imports `node:` (corre en Node y en runtimes edge): `manejar` recibe un
// mensaje JSON-RPC ya parseado y devuelve la respuesta. "Dual-era": atiende a clientes 2025-11-25 (con `initialize`)
// y a los stateless de 2026-07-28 (con `server/discover` y `_meta`). El bucle stdio vive en cli.ts.
import { MercadoPublicoError } from "./errores.js";
import { diaSantiago, sumarDias } from "./fecha.js";
import { ocultarPersonales, type CompraAgil, type MercadoPublico, type Proceso, type Proveedor, type Store } from "./index.js";
import { MUESTRA_MINIMA, competidores, precioSugerido, proximasCompras, rangoDePrecio, resumenRadar, pesos, type Perfil } from "./radar/index.js";
import { leerOcds, urlOcds } from "./ocds.js";
import { PROMPTS, obtenerPrompt } from "./mcp-prompts.js";
import { OCULTO } from "./personales.js";
import { ESTADOS_FILTRO_LICITACION, ESTADO_FILTRO_OC, REGION, familiaDesdeCodigo, urlPublica } from "./v1/codigos.js";
import type { FuenteSync } from "./sync.js";
import type { EstadoCompraAgil } from "./v2/parse.js";

export const VERSIONES = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const LEGADAS = VERSIONES.slice(1);
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_INFO = "io.modelcontextprotocol/serverInfo";
const TTL_LISTA_MS = 3_600_000;
const CAPACIDADES = { tools: {}, prompts: {} };

const INSTRUCCIONES =
  "Mercado Público de Chile. Busca con `search` y después trae el detalle con `fetch`. Las órdenes de compra se ven con `listar` " +
  "o, si hay store local, con `search`. Cada herramienta informa en `costo` cuántas consultas a la API gastó: la API permite " +
  "10.000 al día y este servidor corta al llegar a su tope diario. Los datos personales de funcionarios vienen ocultos. " +
  "Con store local, `sync` baja datos en segundo plano (un solo trabajo a la vez): responde al tiro y avanza solo; consulta el avance con `trabajo_estado` y " +
  "no lo pidas de nuevo mientras corre. `trabajo_cancelar` lo detiene guardando lo hecho. " +
  "Para el historial (quién ganó, a qué precio, cada cuánto compra un organismo): `ocds_importar` trae al store licitaciones y órdenes de compra de un año desde OCDS, filtradas (0 consultas, mismo espacio de trabajo que `sync`), " +
  "y `competidores`, `proximas_compras` y `precios` lo analizan en local (0 consultas). Los precios salen de Compra Ágil, que solo llega con `sync`.";

type Args = Record<string, unknown>;
type Objeto = Record<string, unknown>;

class ErrorRpc extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}
/** Argumentos inválidos o algo que el agente puede corregir: vuelve como `isError`, no como error de protocolo. */
class ErrorUso extends Error {}

interface Ctx {
  mp: MercadoPublico;
  abrirStore?: () => Promise<Store>;
  fetch?: typeof fetch;
  /** ponytail: caché por proceso, sin LRU; las claves son pocas (activas, compradores y los detalles pedidos). */
  cacheado<T>(clave: string, ttlMs: number, f: () => Promise<T>): Promise<T>;
  topeAgente(): { limite: number; usadas: number };
  /** Último trabajo en segundo plano (en curso o ya terminado). */
  trabajo(): Trabajo | undefined;
  /** Handle del store que tiene tomado el trabajo en curso, si lo hay. */
  storeTrabajo(): Store | undefined;
  lanzar(t: Pick<Trabajo, "tipo" | "parametros" | "store">, correr: (t: Trabajo) => Promise<Salida>): Trabajo;
}

type EstadoTrabajo = "planificando" | "ejecutando" | "terminado" | "detenido" | "cancelado" | "error";
/**
 * Un solo espacio para trabajos en segundo plano (`sync` y `ocds_importar`). Vive en memoria del servidor.
 * `store` es el handle que el trabajo tiene tomado (y con él el lock) hasta que termina.
 */
interface Trabajo {
  tipo: string;
  estado: EstadoTrabajo;
  parametros: Objeto;
  plan?: Objeto;
  avance?: Objeto;
  resultado?: Objeto;
  mensaje?: string;
  inicio: string;
  fin?: string;
  abort: AbortController;
  store: Store;
  listo: Promise<void>;
}
/** Cómo terminó un trabajo. */
type Salida = Pick<Trabajo, "estado"> & Partial<Pick<Trabajo, "mensaje" | "resultado">>;

const enCurso = (t: Trabajo | undefined): t is Trabajo => t?.estado === "planificando" || t?.estado === "ejecutando";
const vista = ({ abort: _a, store: _s, listo: _l, ...t }: Trabajo) => t;

interface Herramienta {
  name: string;
  title: string;
  description: string;
  inputSchema: Objeto;
  outputSchema?: Objeto;
  annotations: { readOnlyHint: boolean; destructiveHint?: false; idempotentHint: true; openWorldHint: boolean };
  requiereStore?: true;
  /** Abierta al mundo pero sin gastar cuota (descarga de OCDS): ni cuenta para el tope del agente ni va en la cola de la API. */
  sinCuota?: true;
  ejecutar(a: Args, c: Ctx): Promise<Objeto>;
}

// --- argumentos ---

function texto(a: Args, k: string, obligatorio?: true): string;
function texto(a: Args, k: string): string | undefined;
function texto(a: Args, k: string, obligatorio = false) {
  const v = a[k];
  if (v === undefined || v === null || v === "") {
    if (obligatorio) throw new ErrorUso(`Falta \`${k}\``);
    return undefined;
  }
  if (typeof v !== "string") throw new ErrorUso(`\`${k}\` debe ser texto`);
  return v;
}

function entero(a: Args, k: string, defecto: number, tope: number): number {
  const v = a[k] ?? defecto;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > tope) throw new ErrorUso(`\`${k}\` debe ser un entero entre 1 y ${tope}`);
  return v;
}

function regiones(a: Args, k = "region"): number[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.length || v.some((r) => !Number.isInteger(r) || r < 1 || r > 16)) throw new ErrorUso(`\`${k}\` es una lista de códigos del 1 al 16 (13 = Metropolitana)`);
  return v as number[];
}

/** Rubros UNSPSC (2, 4, 6 u 8 dígitos); el formato lo valida el radar y su RangeError vuelve como error de uso. */
function rubros(a: Args): (string | number)[] | undefined {
  const v = a.rubros;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((r) => typeof r !== "string" && typeof r !== "number")) throw new ErrorUso("`rubros` es una lista de códigos UNSPSC (2, 4, 6 u 8 dígitos)");
  return v as (string | number)[];
}

/** Persona natural: RUT bajo 50 millones (el mismo criterio del parser OCDS). Sin RUT no se puede saber y se deja. */
function sinPersona(p: Proveedor): Proveedor {
  const n = parseInt((p.rut ?? "").replace(/[^0-9kK]/g, "").slice(0, -1), 10);
  return n > 0 && n < 50_000_000 ? { rut: OCULTO, nombre: OCULTO, codigo: p.codigo } : p;
}

/** Las funciones del radar lanzan RangeError con mensajes que el agente puede corregir. */
function delRadar<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw e instanceof RangeError ? new ErrorUso(e.message) : e;
  }
}

// --- búsqueda por palabras ---

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const palabras = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
const calza = (ps: string[], s: string | null) => {
  const n = norm(s ?? "");
  return ps.every((p) => n.includes(p));
};

const ESTADOS_LISTADO = [...new Set([...ESTADOS_FILTRO_LICITACION, ...Object.keys(ESTADO_FILTRO_OC)])];
const ETIQUETA = { licitacion: "Licitación", orden_compra: "Orden de compra", compra_agil: "Compra Ágil" } as const;
const FUENTES: string[] = ["licitaciones", "ordenes", "compra_agil"];
// ponytail: `max` protege a `storeArchivo`, que reescribe el JSON entero en cada lote y aguanta decenas de miles de procesos; más allá, el store de Postgres.
const MAX_OCDS_DEFECTO = 5000;
const MAX_OCDS = 20_000;
const LOTE_OCDS = 500;
const MS_ACTIVAS = 600_000;
const MS_COMPRADORES = 86_400_000;
const activas = (c: Ctx) => c.cacheado("activas", MS_ACTIVAS, () => c.mp.licitaciones.activas());

const fila = (p: Proceso, fuente: string) => ({
  id: p.codigo,
  title: p.nombre,
  url: urlPublica(p.tipo, p.codigo),
  tipo: p.tipo,
  estado: p.estado,
  organismo: p.comprador?.nombreOrganismo ?? null,
  region: p.comprador?.region ?? null,
  montoClp: p.monto?.clp ?? null,
  cierre: p.fechas.cierre,
  fuente,
});
type Fila = ReturnType<typeof fila>;

// Primero lo abierto, por cierre más próximo; después lo ya cerrado, del más reciente al más viejo; sin cierre al final.
function porCierre(a: Fila, b: Fila) {
  const ahora = Date.now();
  const clave = (f: Fila) => {
    const t = f.cierre ? Date.parse(f.cierre) : NaN;
    return Number.isNaN(t) ? [2, 0] : t >= ahora ? [0, t] : [1, -t];
  };
  const [x, y] = [clave(a), clave(b)];
  return x[0]! - y[0]! || x[1]! - y[1]!;
}

async function historial(c: Ctx): Promise<Proceso[]> {
  const todos = await enStore(c, async (s) => {
    const r: Proceso[] = [];
    for await (const p of s.todos()) r.push(p);
    return r;
  });
  if (!todos.length) throw new ErrorUso("el store está vacío: trae datos con `ocds_importar` (licitaciones y órdenes de compra) o corre `npx mercadopublico sync --desde AAAA-MM-DD` (Compra Ágil y lo reciente)");
  return todos;
}

async function enStore<T>(c: Ctx, f: (s: Store) => Promise<T>): Promise<T> {
  const t = c.storeTrabajo();
  if (t) return f(t); // el trabajo en curso tiene el lock: se lee por su handle y no se cierra
  const s = await c.abrirStore!();
  try {
    return await f(s);
  } finally {
    await s.cerrar?.();
  }
}

// --- resumen legible de un proceso ---

function resumen(p: Proceso): string {
  const c = p.comprador;
  const f = p.fechas;
  const dia = (s: string | null) => s?.slice(0, 16).replace("T", " ");
  const m = p.monto;
  const cotizaciones = p.tipo === "compra_agil" ? p.cotizaciones : [];
  const n = p.tipo === "compra_agil" ? cotizaciones.length || p.oferentes : p.oferentes;
  const sel = cotizaciones.find((x) => x.seleccionada)?.proveedor;
  const prov = p.tipo === "orden_compra" ? p.proveedor : sel;
  const l: (string | false | null | undefined)[] = [
    `${ETIQUETA[p.tipo]} ${p.codigo}: ${p.nombre}`,
    `Estado: ${p.estadoGlosa ?? p.estado}`,
    c && `Organismo: ${[c.nombreOrganismo, c.nombreUnidad].filter(Boolean).join(" · ")}${c.region ? ` · región ${REGION[c.region as keyof typeof REGION] ?? c.region}` : ""}`,
    f.publicacion && `Publicación: ${dia(f.publicacion)}`,
    f.cierre && `Cierre: ${dia(f.cierre)}`,
    f.adjudicacion && `Adjudicación: ${dia(f.adjudicacion)}`,
    m
      ? `Monto: ${m.valor} ${m.moneda}${m.moneda !== "CLP" && m.clp !== null ? ` (${pesos(m.clp)} CLP)` : ""}`
      : (p.raw as { VisibilidadMonto?: unknown } | null)?.VisibilidadMonto === 0 && "Monto: el organismo no lo publica",
    p.tipo === "orden_compra" && p.procesoOrigen && `Proceso de origen: ${p.procesoOrigen}`,
    prov && `Proveedor: ${[prov.nombre, prov.rut].filter(Boolean).join(" · ")}`,
    n !== null && `${p.tipo === "compra_agil" ? "Cotizaciones" : "Oferentes"}: ${n}`,
    p.descripcion && `Descripción: ${p.descripcion.slice(0, 600)}`,
  ];
  if (p.items.length) {
    l.push(`Ítems (${p.items.length}):`);
    for (const i of p.items.slice(0, 30)) l.push(`- ${i.nombre ?? i.descripcion ?? "ítem"}${i.cantidad !== null ? ` × ${i.cantidad}${i.unidad ? ` ${i.unidad}` : ""}` : ""}`);
    if (p.items.length > 30) l.push(`… y ${p.items.length - 30} más (ver metadata.items)`);
  }
  return l.filter((x): x is string => !!x).join("\n");
}

const MSG_NO_CODIGO = "no parece un código de Mercado Público (ej. 1509-5-L114, 2097-241-SE26, 1057539-228-COT26)";

// --- herramientas ---

const HERRAMIENTAS: Herramienta[] = [
  {
    name: "search",
    title: "Buscar procesos de compra",
    description:
      "Busca por palabras en licitaciones activas (nombre), Compra Ágil (nombre y descripción) y, si hay store local, en todo lo sincronizado (única forma de buscar órdenes de compra por texto). " +
      "Cuesta 0 a 2 consultas (licitaciones activas se cachean 10 min, Compra Ágil 1). Úsala primero para encontrar códigos y luego `fetch` para el detalle. " +
      "Las licitaciones v1 no se pueden filtrar por región: con `region` solo se busca en Compra Ágil y el store.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Palabras a buscar; se exigen todas, sin importar tildes ni mayúsculas" },
        tipo: { type: "string", enum: ["licitacion", "compra_agil", "orden_compra"], description: "Restringe la búsqueda a una familia; sin esto, todas" },
        region: { type: "array", items: { type: "integer", minimum: 1, maximum: 16 }, description: "Regiones (13 = Metropolitana); excluye las licitaciones v1" },
        estado: { type: "string", description: "Estado del proceso, p. ej. publicada (por defecto en Compra Ágil), cerrada, adjudicada" },
        max: { type: "integer", minimum: 1, maximum: 100, description: "Máximo de resultados (20 por defecto)" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              url: { type: ["string", "null"] },
              tipo: { type: "string" },
              estado: { type: "string" },
              organismo: { type: ["string", "null"] },
              region: { type: ["integer", "null"] },
              montoClp: { type: ["number", "null"] },
              cierre: { type: ["string", "null"] },
              fuente: { type: "string" },
            },
            required: ["id", "title", "url"],
          },
        },
        total: { type: "integer" },
        notas: { type: "array", items: { type: "string" } },
      },
      required: ["results"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ejecutar(a, c) {
      const query = texto(a, "query", true);
      const tipo = texto(a, "tipo");
      if (tipo && !(tipo in ETIQUETA)) throw new ErrorUso("`tipo` debe ser licitacion, compra_agil u orden_compra");
      const region = regiones(a);
      const estado = texto(a, "estado");
      const max = entero(a, "max", 20, 100);
      const ps = palabras(query);
      if (!ps.length) throw new ErrorUso("`query` necesita al menos una palabra de 2 letras o más");

      const notas: string[] = [];
      let fuentes = 0;
      let fallos = 0;
      let ultimo: unknown;
      const fuente = async (nombre: string, f: () => Promise<Fila[]>) => {
        fuentes++;
        try {
          return await f();
        } catch (e) {
          fallos++;
          ultimo = e;
          notas.push(`${nombre}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      };

      const api: Fila[] = [];
      if (!tipo || tipo === "licitacion") {
        if (region) notas.push("Las licitaciones v1 no se pueden filtrar por región: se omitieron; se buscó solo en Compra Ágil y el store.");
        else api.push(...(await fuente("licitaciones activas", async () => (await activas(c)).filter((p) => calza(ps, p.nombre) && (!estado || p.estado === estado)).map((p) => fila(p, "api_v1")))));
      }
      if (!tipo || tipo === "compra_agil") {
        api.push(
          ...(await fuente("Compra Ágil", async () => {
            const filtros = { q: query, region, estado: [(estado ?? "publicada") as Exclude<EstadoCompraAgil, "oc_emitida">], tamanoPagina: Math.min(50, Math.max(10, max)) };
            const pag = await c.mp.compraAgil.pagina(filtros, 1);
            if (pag.totalResultados > pag.items.length) notas.push(`Compra Ágil: ${pag.totalResultados} resultados en la API, solo se trajo la primera página (${pag.items.length}); afina la búsqueda.`);
            return pag.items.map((p) => fila(p, "api_v2"));
          })),
        );
      }
      const local: Fila[] = [];
      if (tipo === "orden_compra" && !c.abrirStore) notas.push("Las órdenes de compra solo se buscan en un store local (no hay uno configurado): usa `listar` con tipo ordenes para ver las de un día.");
      if (c.abrirStore) {
        local.push(
          ...(await fuente("store local", () =>
            enStore(c, async (s) => {
              const r: Fila[] = [];
              for await (const p of s.todos()) {
                if (tipo && p.tipo !== tipo) continue;
                if (estado && p.estado !== estado) continue;
                if (region && !region.includes(p.comprador?.region ?? -1)) continue;
                if (calza(ps, `${p.nombre} ${p.descripcion ?? ""}`)) r.push(fila(p, "store"));
              }
              return r;
            }),
          )),
        );
      }
      if (fuentes && fallos === fuentes) throw ultimo;

      const unicos = new Map<string, Fila>();
      for (const f of [...api, ...local]) if (!unicos.has(f.id)) unicos.set(f.id, f);
      const todas = [...unicos.values()].sort(porCierre);
      return { results: todas.slice(0, max), total: todas.length, notas };
    },
  },
  {
    name: "fetch",
    title: "Traer el detalle de un proceso",
    description:
      "Detalle de un proceso por su código (licitación, orden de compra o Compra Ágil; la familia se detecta del código). Devuelve un resumen legible en `text` y el proceso completo en `metadata`. " +
      "Cuesta 1 consulta, 2 si el código no existe en su familia y se prueba en la otra (10 min en caché). Úsala después de `search` o `listar`.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Código del proceso, p. ej. 1509-5-L114, 2097-241-SE26 o 1057539-228-COT26" } },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: ["string", "null"] }, metadata: { type: "object" } },
      required: ["id", "title", "text", "url"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ejecutar(a, c) {
      const id = texto(a, "id", true).trim();
      const familia = familiaDesdeCodigo(id);
      if (!familia) throw new ErrorUso(`"${id}" ${MSG_NO_CODIGO}`);
      return c.cacheado(`fetch:${id}`, MS_ACTIVAS, async () => {
        const buscar = {
          licitacion: () => c.mp.licitaciones.porCodigo(id),
          orden_compra: () => c.mp.ordenes.porCodigo(id),
          compra_agil: () => c.mp.compraAgil.detalle(id),
        };
        const orden = familia === "licitacion" ? (["licitacion", "orden_compra"] as const) : familia === "orden_compra" ? (["orden_compra", "licitacion"] as const) : (["compra_agil"] as const);
        let p: Proceso | null = null;
        for (const f of orden) if ((p = await buscar[f]())) break;
        if (!p) throw new ErrorUso(`No existe ningún proceso con código ${id}`);
        const limpio = ocultarPersonales(p);
        const { raw: _, ...metadata } = limpio;
        return { id: p.codigo, title: p.nombre, text: resumen(limpio), url: urlPublica(p.tipo, p.codigo), metadata };
      });
    },
  },
  {
    name: "listar",
    title: "Listar licitaciones u órdenes de compra de un día",
    description:
      "Listado de licitaciones u órdenes de compra: las de hoy, o las de un día filtradas por estado, organismo o proveedor. Es la forma de ver órdenes de compra sin store. " +
      "Cuesta 1 consulta (las licitaciones activas de hoy se cachean 10 min). El listado trae solo código, nombre, estado y cierre: usa `fetch` para el detalle.",
    inputSchema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["licitaciones", "ordenes"] },
        dia: { type: "string", description: "Día AAAA-MM-DD; por defecto hoy" },
        estado: { type: "string", enum: ESTADOS_LISTADO, description: "Licitaciones: " + ESTADOS_FILTRO_LICITACION.join(", ") + ". Órdenes: " + Object.keys(ESTADO_FILTRO_OC).join(", ") + ". No se combina con organismo ni proveedor" },
        organismo: { type: "string", description: "Código del organismo comprador (ver `organismos`)" },
        proveedor: { type: "string", description: "Código de empresa del proveedor (ver `proveedor`)" },
        max: { type: "integer", minimum: 1, maximum: 500, description: "Máximo de filas (50 por defecto)" },
      },
      required: ["tipo"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ejecutar(a, c) {
      const tipo = texto(a, "tipo", true);
      if (tipo !== "licitaciones" && tipo !== "ordenes") throw new ErrorUso("`tipo` debe ser licitaciones u ordenes");
      const dia = texto(a, "dia");
      const estado = texto(a, "estado");
      const organismo = texto(a, "organismo");
      const proveedor = texto(a, "proveedor");
      const max = entero(a, "max", 50, 500);
      if (estado && (organismo || proveedor)) throw new ErrorUso("`estado` no se combina con `organismo` ni `proveedor`");
      // Mismas reglas que los comandos `licitaciones` y `ordenes` de la CLI.
      const api = tipo === "licitaciones" ? c.mp.licitaciones : c.mp.ordenes;
      // El tipo de `estado` se valida dentro de la API (lista los válidos si no calza).
      const e = estado as never;
      let ps: Proceso[];
      if (organismo) ps = await api.porOrganismo(organismo, { dia: dia ?? diaSantiago() });
      else if (proveedor) ps = await api.porProveedor(proveedor, { dia: dia ?? diaSantiago() });
      else if (estado) ps = await api.porEstado(e, { dia });
      else if (dia) ps = await api.delDia(dia);
      else ps = tipo === "licitaciones" ? await activas(c) : await c.mp.ordenes.porEstado("todos");
      const resultados = ps.slice(0, max).map((p) => ({ codigo: p.codigo, nombre: p.nombre, estado: p.estado, cierre: p.fechas.cierre, url: urlPublica(p.tipo, p.codigo) }));
      return { resultados, total: ps.length, mostrados: resultados.length, truncado: ps.length > max };
    },
  },
  {
    name: "organismos",
    title: "Buscar organismos compradores",
    description: "Busca organismos compradores por nombre y devuelve su código (para `listar` con `organismo`). Cuesta 1 consulta la primera vez; la lista completa se cachea 24 h.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Palabras del nombre; sin esto, los primeros de la lista" },
        max: { type: "integer", minimum: 1, maximum: 500, description: "Máximo de filas (50 por defecto)" },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ejecutar(a, c) {
      const query = texto(a, "query");
      const max = entero(a, "max", 50, 500);
      const ps = query ? palabras(query) : [];
      if (query && !ps.length) throw new ErrorUso("`query` necesita al menos una palabra de 2 letras o más");
      const todos = (await c.cacheado("compradores", MS_COMPRADORES, () => c.mp.empresas.buscarComprador())).filter((e) => calza(ps, e.nombre));
      return { organismos: todos.slice(0, max).map((e) => ({ codigo: e.codigo, nombre: e.nombre })), total: todos.length, truncado: todos.length > max };
    },
  },
  {
    name: "proveedor",
    title: "Buscar un proveedor por RUT",
    description: "Código de empresa de un proveedor a partir de su RUT (para `listar` con `proveedor`). Cuesta 1 consulta.",
    inputSchema: { type: "object", properties: { rut: { type: "string", description: "RUT, con o sin puntos y guion" } }, required: ["rut"] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ejecutar(a, c) {
      const rut = texto(a, "rut", true);
      const e = await c.mp.empresas.buscarProveedor(rut);
      if (!e) throw new ErrorUso(`No hay un proveedor registrado con RUT ${rut}`);
      return { rut, codigo: e.codigo, nombre: e.nombre };
    },
  },
  {
    name: "cuota",
    title: "Ver la cuota de consultas",
    description: "Consultas usadas hoy de las 10.000 diarias del ticket, cuándo se reinicia y cuánto lleva gastado el agente de su tope diario. Cuesta 0 consultas.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ejecutar(_, c) {
      return { ...c.mp.cuota.toJSON(), topeAgente: c.topeAgente() };
    },
  },
  {
    name: "radar",
    title: "Radar de oportunidades",
    description:
      "Qué postular primero, a qué precio y qué viene, a partir del store local sincronizado (`npx mercadopublico sync`) y el perfil de la empresa. Cuesta 0 consultas. " +
      "`perfil` es un objeto con `pesos` y, opcionalmente, rubros, regiones, montoMin, montoMax, costos (ver docs/radar.md).",
    inputSchema: {
      type: "object",
      properties: {
        perfil: { type: "object", description: "Perfil de la empresa: { pesos: { rubro, region, monto, diasAlCierre, competencia, incumbente }, rubros?, regiones?, montoMin?, montoMax?, costos? }" },
        decisiones: { type: "array", items: { type: "object", properties: { codigo: { type: "string" }, decision: { type: "string", enum: ["postular", "descartar"] } } }, description: "Decisiones pasadas del equipo, para calibrar los pesos" },
        max: { type: "integer", minimum: 1, maximum: 100, description: "Máximo de oportunidades de la agenda (10 por defecto)" },
      },
      required: ["perfil"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    requiereStore: true,
    async ejecutar(a, c) {
      const perfil = a.perfil as Perfil | undefined;
      if (!perfil || typeof perfil !== "object" || Array.isArray(perfil) || !perfil.pesos || typeof perfil.pesos !== "object") throw new ErrorUso("`perfil` debe ser un objeto con `pesos`");
      if (a.decisiones !== undefined && !Array.isArray(a.decisiones)) throw new ErrorUso("`decisiones` debe ser una lista");
      const max = entero(a, "max", 10, 100);
      const todos = await historial(c);
      const r = resumenRadar(todos, perfil, { decisiones: a.decisiones as never });
      const agenda = r.decisiones.filter((d) => d.turno !== null);
      const conteo = {
        abiertas: r.decisiones.length,
        agenda: agenda.length,
        sinCupo: r.decisiones.filter((d) => d.turno === null && d.accion !== "descartar").length,
        descartadas: r.decisiones.filter((d) => d.accion === "descartar").length,
      };
      return { ...r, decisiones: agenda.slice(0, max), proximas: r.proximas.slice(0, max), conteo };
    },
  },
  {
    name: "competidores",
    title: "Quién gana en un rubro u organismo",
    description:
      "Quién gana, cuánto y con qué concentración (HHI), a partir del store local. Los datos vienen de OCDS (licitaciones y órdenes de compra, que se traen con `ocds_importar`; ahí solo se ve a quien ganó) y de Compra Ágil (solo si se trajo con `sync`; ahí se ven también los que cotizaron). " +
      "Cuesta 0 consultas. El filtro `organismos` usa el código de organismo, que OCDS no trae: solo calza procesos traídos con `sync`. Los proveedores que parecen persona natural (RUT bajo 50 millones) salen ocultos, salvo el del `rut` pedido.",
    inputSchema: {
      type: "object",
      properties: {
        rubros: { type: "array", items: { type: ["string", "integer"] }, description: "Códigos UNSPSC por prefijo (2, 4, 6 u 8 dígitos), p. ej. 4410" },
        organismos: { type: "array", items: { type: "string" }, description: "Códigos de organismo comprador (ver `organismos`); solo calza procesos traídos con `sync`" },
        regiones: { type: "array", items: { type: "integer", minimum: 1, maximum: 16 }, description: "Regiones (13 = Metropolitana)" },
        rut: { type: "string", description: "RUT de tu empresa, para marcarla en la lista (`eresTu`)" },
        max: { type: "integer", minimum: 1, maximum: 100, description: "Máximo de competidores (20 por defecto)" },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    requiereStore: true,
    async ejecutar(a, c) {
      const rut = texto(a, "rut");
      const organismos = a.organismos;
      if (organismos !== undefined && (!Array.isArray(organismos) || organismos.some((o) => typeof o !== "string"))) throw new ErrorUso("`organismos` es una lista de códigos de organismo");
      const max = entero(a, "max", 20, 100);
      const filtro = { rubros: rubros(a), organismos: organismos as string[] | undefined, regiones: regiones(a, "regiones"), rut };
      const todos = await historial(c);
      const r = delRadar(() => competidores(todos, filtro));
      return { ...r, competidores: r.competidores.slice(0, max).map((x) => ({ ...x, proveedor: x.eresTu ? x.proveedor : sinPersona(x.proveedor) })), totalCompetidores: r.competidores.length, truncado: r.competidores.length > max };
    },
  },
  {
    name: "proximas_compras",
    title: "Qué compras se repiten y cuándo vuelven",
    description:
      "Compras que un organismo repite en una familia UNSPSC y la ventana en que debería salir la próxima, a partir del historial del store local. Cuesta 0 consultas. " +
      "Necesita el código de organismo, que OCDS no trae: solo cuenta lo traído con `sync` (licitaciones, órdenes de compra y Compra Ágil); lo de `ocds_importar` no aparece aquí.",
    inputSchema: {
      type: "object",
      properties: {
        rubros: { type: "array", items: { type: ["string", "integer"] }, description: "Códigos UNSPSC por prefijo (2, 4, 6 u 8 dígitos)" },
        regiones: { type: "array", items: { type: "integer", minimum: 1, maximum: 16 }, description: "Regiones (13 = Metropolitana)" },
        max: { type: "integer", minimum: 1, maximum: 100, description: "Máximo de ventanas (20 por defecto)" },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    requiereStore: true,
    async ejecutar(a, c) {
      const reg = regiones(a, "regiones");
      const max = entero(a, "max", 20, 100);
      const todos = await historial(c);
      const todas = delRadar(() => proximasCompras(todos, { ahora: new Date(), rubros: rubros(a) })).filter((x) => !reg || reg.includes(x.region ?? -1));
      return { proximas: todas.slice(0, max), total: todas.length, truncado: todas.length > max };
    },
  },
  {
    name: "precios",
    title: "Rango de precios y precio sugerido",
    description:
      "Qué precio unitario ha ganado un producto (`codigoProducto` UNSPSC) en Compra Ágil: percentiles de lo adjudicado y, con `costo`, el precio que maximiza la ganancia esperada. Cuesta 0 consultas. " +
      "Usa solo las Compras Ágiles del store, que llegan únicamente con `sync` (fuentes [\"compra_agil\"]): OCDS no trae Compra Ágil, así que `ocds_importar` no alimenta esta herramienta. Con menos de 10 precios devuelve `insuficiente` y una `pista`.",
    inputSchema: {
      type: "object",
      properties: {
        codigoProducto: { type: "integer", minimum: 1, description: "Código UNSPSC del producto (8 dígitos), p. ej. 44121701" },
        costo: { type: "number", minimum: 0, description: "Tu costo por unidad en CLP: devuelve el precio sugerido en vez del rango" },
        unidad: { type: "string", description: "Unidad de medida; por defecto la más frecuente" },
      },
      required: ["codigoProducto"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    requiereStore: true,
    async ejecutar(a, c) {
      const codigo = a.codigoProducto;
      if (typeof codigo !== "number" || !Number.isInteger(codigo) || codigo < 1) throw new ErrorUso("`codigoProducto` debe ser un entero (código UNSPSC)");
      const unidad = texto(a, "unidad");
      if (a.costo !== undefined && (typeof a.costo !== "number" || !Number.isFinite(a.costo) || a.costo < 0)) throw new ErrorUso("`costo` debe ser un número ≥ 0");
      const compras = (await historial(c)).filter((p): p is CompraAgil => p.tipo === "compra_agil");
      const r = a.costo !== undefined ? precioSugerido(codigo, compras, { costo: a.costo, unidad }) : rangoDePrecio(codigo, compras, { soloSeleccionadas: true, unidad });
      if (!("insuficiente" in r)) {
        // Sin la curva (un punto por precio ganador distinto): `precio`, `ganadas` y `probabilidad` ya dicen lo que importa.
        // `costo` es el sobre de cada respuesta (consultas gastadas): el del usuario sale como `costoUnitario`.
        const { curva, costo, ...resto } = r as typeof r & { curva?: unknown[]; costo?: number };
        return { ...resto, ...(costo !== undefined && { costoUnitario: costo }), ...(curva && { puntosDeCurva: curva.length }), comprasAgiles: compras.length };
      }
      const pista = r.motivo === "muestra insuficiente"
        ? `Hay ${r.n} precios ganadores de este producto en ${compras.length} Compras Ágiles del store; se necesitan al menos ${MUESTRA_MINIMA}. Trae más con \`sync\` y fuentes ["compra_agil"] (OCDS no trae Compra Ágil), o prueba otra \`unidad\`.`
        : "Tu costo está sobre los precios que ganaron: con ese costo no hay un precio que gane con ganancia.";
      return { ...r, pista, comprasAgiles: compras.length };
    },
  },
  {
    name: "sync",
    title: "Sincronizar el store local (trabajo en segundo plano)",
    description:
      "Baja al store local lo ocurrido entre `desde` y `hasta` (licitaciones, órdenes de compra y Compra Ágil) para `search` y `radar`. Es un trabajo en segundo plano: responde al tiro con estado planificando " +
      "y sigue solo (la API va a ~1 consulta por segundo, un día de datos toma minutos). Consulta el avance con `trabajo_estado`; `trabajo_cancelar` lo detiene guardando lo hecho. " +
      "Gasta consultas de la cuota: `maxConsultas` es el máximo que se permite gastar (planificación incluida); si el listado o el plan lo pasan, se niega o se detiene sin ejecutar. " +
      "Solo un trabajo a la vez. Repetirlo con el mismo `desde` retoma desde donde quedó. Para rangos grandes usa `npx mercadopublico sync` en una terminal.",
    inputSchema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "Primer día, AAAA-MM-DD (si el store ya tiene avance de una fuente, se parte desde ahí)" },
        hasta: { type: "string", description: "Último día, AAAA-MM-DD; por defecto hoy" },
        fuentes: { type: "array", items: { type: "string", enum: FUENTES }, description: "Por defecto las tres" },
        maxConsultas: { type: "integer", minimum: 1, description: "Máximo de consultas a la API que este sync puede gastar; obligatorio" },
      },
      required: ["desde", "maxConsultas"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    requiereStore: true,
    async ejecutar(a, c) {
      const desde = diaArg(a, "desde", true);
      const hasta = diaArg(a, "hasta") ?? c.mp.cuota.toJSON().dia;
      if (desde > hasta) throw new ErrorUso("`desde` no puede ser posterior a `hasta`");
      if (a.maxConsultas === undefined) throw new ErrorUso("Falta `maxConsultas`");
      const maxConsultas = entero(a, "maxConsultas", 1, Number.MAX_SAFE_INTEGER);
      const f = a.fuentes ?? FUENTES;
      if (!Array.isArray(f) || !f.length || f.some((x) => !FUENTES.includes(x))) throw new ErrorUso(`\`fuentes\` es una lista con ${FUENTES.join(", ")}`);
      const fuentes = [...new Set(f as FuenteSync[])];
      libre(c);

      const store = await c.abrirStore!();
      let lanzado = false;
      try {
        // Lo que cuestan solo los listados, sin pedir nada: un día por fuente v1 desde su cursor, más 1 de Compra Ágil (como Sync.planificar).
        const dias: Record<string, number> = {};
        for (const x of fuentes) {
          if (x === "compra_agil") continue;
          const cur = await store.cursor(x);
          let n = 0;
          for (let d = cur && cur >= desde ? sumarDias(cur, 1) : desde; d <= hasta; d = sumarDias(d, 1)) n++;
          dias[x] = n;
        }
        const listado = Object.values(dias).reduce((s, n) => s + n, 0) + (fuentes.includes("compra_agil") ? 1 : 0);
        const tope = c.topeAgente();
        const permitido = Math.min(maxConsultas, tope.limite - tope.usadas, c.mp.cuota.restante);
        if (listado > permitido)
          throw new ErrorUso(
            `Solo listar ${desde} a ${hasta} cuesta ${listado} consultas (${dias.licitaciones ?? 0} días de licitaciones + ${dias.ordenes ?? 0} de órdenes + ${fuentes.includes("compra_agil") ? 1 : 0} de Compra Ágil) ` +
              `y hay ${permitido} disponibles (maxConsultas ${maxConsultas}, tope del agente ${tope.limite - tope.usadas}, ticket ${c.mp.cuota.restante}). ` +
              "Prueba un rango más corto o corre `npx mercadopublico sync` en una terminal.",
          );
        const t = c.lanzar({ tipo: "sync", parametros: { desde, hasta, fuentes, maxConsultas }, store }, (j) => correrSync(c, j, { desde, hasta, fuentes, maxConsultas }));
        lanzado = true;
        return { trabajo: vista(t) };
      } finally {
        if (!lanzado) await store.cerrar?.();
      }
    },
  },
  {
    name: "ocds_importar",
    title: "Importar historial OCDS al store (trabajo en segundo plano)",
    description:
      "Trae al store local licitaciones y órdenes de compra de un año desde los datos abiertos OCDS (data.open-contracting.org; el archivo anual pesa unos 186 MB y se lee en streaming), solo los que pasan tus filtros: " +
      "para `competidores` y `search`. Es un trabajo en segundo plano, del mismo espacio que `sync` (uno a la vez): responde al tiro y avanza solo; usa `trabajo_estado` y `trabajo_cancelar` (guarda lo aceptado). " +
      "Cuesta 0 consultas a la API y no cuenta para el tope del agente. Exige al menos uno de `q`, `comprador` o `rubro`. No pisa lo que el store ya tiene de la API (`sync`), que es más fresco. " +
      "OCDS no trae Compra Ágil (para `precios` usa `sync`) ni el código de organismo (`proximas_compras` y el filtro `organismos` no lo ven).",
    inputSchema: {
      type: "object",
      properties: {
        anio: { type: "integer", minimum: 2010, description: "Año del archivo OCDS, desde 2010 hasta el actual" },
        q: { type: "string", description: "Palabras del nombre o la descripción; se exigen todas" },
        comprador: { type: "string", description: "Palabras del nombre del organismo o la unidad compradora" },
        rubro: { type: "string", description: "Prefijo de código UNSPSC (solo dígitos), p. ej. 4410" },
        desde: { type: "string", description: "Publicación desde AAAA-MM-DD" },
        hasta: { type: "string", description: "Publicación hasta AAAA-MM-DD" },
        max: { type: "integer", minimum: 1, maximum: MAX_OCDS, description: `Máximo de procesos a guardar (${MAX_OCDS_DEFECTO} por defecto)` },
      },
      required: ["anio"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    requiereStore: true,
    sinCuota: true,
    async ejecutar(a, c) {
      const anio = a.anio;
      const actual = Number(c.mp.cuota.toJSON().dia.slice(0, 4));
      if (typeof anio !== "number" || !Number.isInteger(anio) || anio < 2010 || anio > actual) throw new ErrorUso(`\`anio\` debe ser un entero entre 2010 y ${actual}`);
      const q = texto(a, "q");
      const comprador = texto(a, "comprador");
      const rubro = texto(a, "rubro");
      if (!q && !comprador && !rubro) throw new ErrorUso("Falta al menos un filtro (`q`, `comprador` o `rubro`): el archivo del año pesa unos 186 MB y traerlo entero no cabe en el store");
      const p: ParamsOcds = { anio, q: q ? palabras(q) : undefined, comprador: comprador ? palabras(comprador) : undefined, rubro, desde: diaArg(a, "desde"), hasta: diaArg(a, "hasta"), max: entero(a, "max", MAX_OCDS_DEFECTO, MAX_OCDS) };
      if (q && !p.q!.length) throw new ErrorUso("`q` necesita al menos una palabra de 2 letras o más");
      if (comprador && !p.comprador!.length) throw new ErrorUso("`comprador` necesita al menos una palabra de 2 letras o más");
      if (rubro && !/^\d{1,8}$/.test(rubro)) throw new ErrorUso("`rubro` es un prefijo de código UNSPSC: solo dígitos (hasta 8)");
      if (p.desde && p.hasta && p.desde > p.hasta) throw new ErrorUso("`desde` no puede ser posterior a `hasta`");
      libre(c);

      const store = await c.abrirStore!();
      let lanzado = false;
      try {
        const parametros = Object.fromEntries(Object.entries({ anio, q, comprador, rubro, desde: p.desde, hasta: p.hasta, max: p.max }).filter(([, v]) => v !== undefined));
        const t = c.lanzar({ tipo: "ocds", parametros, store }, (j) => correrOcds(c, j, p));
        lanzado = true;
        return { trabajo: vista(t) };
      } finally {
        if (!lanzado) await store.cerrar?.();
      }
    },
  },
  {
    name: "trabajo_estado",
    title: "Ver el trabajo en segundo plano",
    description: "Estado del último trabajo en segundo plano (`sync` u `ocds_importar`): plan, avance (`sync`: fuente, hechas/total; `ocds_importar`: leidos, aceptados, guardados…), resultado o motivo por el que se detuvo. `trabajo` es null si no ha habido ninguno. Cuesta 0 consultas.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    requiereStore: true,
    async ejecutar(_, c) {
      const t = c.trabajo();
      return { trabajo: t ? vista(t) : null };
    },
  },
  {
    name: "trabajo_cancelar",
    title: "Cancelar el trabajo en segundo plano",
    description: "Detiene el trabajo en curso: lo ya pedido queda guardado en el store, el lock se libera y el estado pasa a cancelado (un `sync` posterior retoma). Cuesta 0 consultas.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    requiereStore: true,
    async ejecutar(_, c) {
      const t = c.trabajo();
      if (!enCurso(t)) throw new ErrorUso("No hay ningún trabajo en curso");
      t.abort.abort();
      // Corta la consulta en vuelo; si algo se cuelga, no se espera más de 5 s y queda cancelándose (ver `trabajo_estado`).
      let fin: ReturnType<typeof setTimeout>;
      await Promise.race([t.listo, new Promise((r) => (fin = setTimeout(r, 5000)))]);
      clearTimeout(fin!);
      return { trabajo: vista(t) };
    },
  },
];

// --- trabajos ---

/** Un solo trabajo a la vez, de cualquier tipo. */
function libre(c: Ctx) {
  const actual = c.trabajo();
  if (enCurso(actual)) throw new ErrorUso(`Ya hay un trabajo en curso (${actual.tipo}, ${actual.estado}). Consulta \`trabajo_estado\` o detenlo con \`trabajo_cancelar\`.`);
}

function diaArg(a: Args, k: string, obligatorio?: true): string;
function diaArg(a: Args, k: string): string | undefined;
function diaArg(a: Args, k: string, obligatorio = false) {
  const v = obligatorio ? texto(a, k, true) : texto(a, k);
  if (v === undefined) return v;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && (() => { try { return sumarDias(v, 0) === v; } catch { return false; } })();
  if (!ok) throw new ErrorUso(`\`${k}\` debe ser un día AAAA-MM-DD válido`);
  return v;
}

/** El cuerpo del trabajo `sync`: planifica, revisa que el plan quepa y ejecuta. Nunca corre dentro de `enCola`. */
async function correrSync(c: Ctx, j: Trabajo, p: { desde: string; hasta: string; fuentes: FuenteSync[]; maxConsultas: number }): Promise<Salida> {
  const { mp } = c;
  const inicio = mp.cuota.usadas;
  const gastadas = () => Math.max(0, mp.cuota.usadas - inicio);
  const topes = () => {
    const t = c.topeAgente();
    return { maxConsultas: p.maxConsultas - gastadas(), agente: t.limite - t.usadas, ticket: mp.cuota.restante };
  };
  const { signal } = j.abort;

  const plan = await mp.sync.planificar({ desde: p.desde, hasta: p.hasta, fuentes: p.fuentes, store: j.store, signal });
  const { consultas, gastadas: delPlan, margenReintentos, cabeHoy, desglose } = plan;
  j.plan = { consultas, gastadas: delPlan, margenReintentos, cabeHoy, desglose };
  const falta = consultas - delPlan + (margenReintentos ?? 0);
  const t = topes();
  if (falta > Math.min(...Object.values(t)))
    return {
      estado: "detenido",
      mensaje:
        `El plan necesita unas ${falta} consultas más (incluye ${margenReintentos ?? 0} de margen para reintentos) y quedan ${t.maxConsultas} de maxConsultas, ${t.agente} del tope del agente y ${t.ticket} del ticket. ` +
        "No se ejecutó nada. Acorta el rango, sube maxConsultas o corre `npx mercadopublico sync` en una terminal.",
    };

  let razon: string | undefined;
  j.estado = "ejecutando";
  const r = await mp.sync.ejecutar(plan, {
    signal,
    alAvanzar(a) {
      j.avance = a;
      const tope = topes();
      razon ??= tope.agente <= 0 ? `se alcanzó el tope diario del agente (${c.topeAgente().limite} consultas)` : tope.maxConsultas <= 0 ? `se alcanzó maxConsultas (${p.maxConsultas})` : undefined;
      if (razon) j.abort.abort();
    },
  });
  const { errores, abandonados, ...resto } = r;
  // Sin lo voluminoso: los primeros errores bastan, el total dice cuántos son.
  const resultado = { ...resto, errores: errores.slice(0, 20), totalErrores: errores.length, ...(abandonados && { abandonados: abandonados.slice(0, 20) }) };
  if (razon) return { estado: "detenido", resultado, mensaje: `Detenido: ${razon}. Lo hecho quedó guardado; un nuevo \`sync\` retoma.` };
  if (r.detenido === "cancelado") return { estado: "cancelado", resultado, mensaje: "Cancelado; lo hecho quedó guardado." };
  if (r.detenido) return { estado: "detenido", resultado, mensaje: r.detenido };
  return { estado: "terminado", resultado };
}


interface ParamsOcds {
  anio: number;
  q?: string[];
  comprador?: string[];
  rubro?: string;
  desde?: string;
  hasta?: string;
  max: number;
}

/** El cuerpo del trabajo `ocds_importar`: lee el archivo del año en streaming y guarda en lotes lo que pasa todos los filtros. */
async function correrOcds(c: Ctx, j: Trabajo, p: ParamsOcds): Promise<Salida> {
  const { signal } = j.abort;
  const avance = { leidos: 0, aceptados: 0, guardados: 0, omitidos: 0, lineasMalas: 0 };
  j.avance = avance;
  j.estado = "ejecutando";
  const pasa = (x: Proceso) => {
    const dia = (x.fechas.publicacion ?? x.fechas.creacion)?.slice(0, 10);
    return (
      (!p.q || calza(p.q, `${x.nombre} ${x.descripcion ?? ""}`)) &&
      (!p.comprador || calza(p.comprador, `${x.comprador?.nombreOrganismo ?? ""} ${x.comprador?.nombreUnidad ?? ""}`)) &&
      (!p.rubro || x.items.some((i) => i.codigoProducto !== null && String(i.codigoProducto).startsWith(p.rubro!))) &&
      (!(p.desde || p.hasta) || (!!dia && (!p.desde || dia >= p.desde) && (!p.hasta || dia <= p.hasta)))
    );
  };
  let lote: Proceso[] = [];
  const volcar = async () => {
    const nuevos: Proceso[] = [];
    for (const x of lote) {
      const previo = await j.store.obtener(x.codigo);
      if (previo && previo.origen !== "ocds") avance.omitidos++; // lo de la API es más rico y más fresco
      else nuevos.push(x);
    }
    if (nuevos.length) await j.store.guardar(nuevos);
    avance.guardados += nuevos.length;
    lote = [];
  };

  let fallo: unknown;
  let cortado = false;
  try {
    for await (const x of leerOcds(urlOcds(p.anio), { fetch: c.fetch, signal, alError: () => avance.lineasMalas++ })) {
      if (signal.aborted) break;
      avance.leidos++;
      if (!pasa(x)) continue;
      avance.aceptados++;
      lote.push(x);
      if (lote.length >= LOTE_OCDS) await volcar();
      if (avance.aceptados >= p.max) {
        cortado = true;
        break;
      }
    }
  } catch (e) {
    fallo = e;
  }
  await volcar().catch((e) => (fallo ??= e)); // también al cancelar o fallar: lo aceptado queda guardado
  const resultado = { ...avance };
  if (signal.aborted) return { estado: "cancelado", resultado, mensaje: "Cancelado; lo aceptado quedó guardado." };
  if (fallo) return { estado: "error", resultado, mensaje: `${fallo instanceof Error ? fallo.message : String(fallo)}. Lo aceptado hasta ahí quedó guardado.` };
  if (cortado) return { estado: "terminado", resultado, mensaje: `Se detuvo al llegar a max (${p.max}): puede haber más procesos que calzan; sube max (hasta ${MAX_OCDS}) o afina los filtros.` };
  return { estado: "terminado", resultado };
}


// --- servidor ---

export function crearServidorMcp(op: { mp: MercadoPublico; abrirStore?: () => Promise<Store>; fetch?: typeof fetch; tope?: number; version?: string }): { manejar(msg: unknown): Promise<object | null> } {
  const { mp, abrirStore } = op;
  const limite = op.tope ?? 1000;
  const info = { name: "mercadopublico", version: op.version ?? "0.1.0" };
  const herramientas = HERRAMIENTAS.filter((h) => !h.requiereStore || abrirStore);
  // radar-diario usa `radar`, que necesita store.
  const prompts = PROMPTS.filter((p) => p.name !== "radar-diario" || abrirStore);

  const cache = new Map<string, { vence: number; v: Promise<unknown> }>();
  const cacheado = <T>(clave: string, ttlMs: number, f: () => Promise<T>): Promise<T> => {
    const e = cache.get(clave);
    if (e && e.vence > Date.now()) return e.v as Promise<T>;
    const v = f();
    cache.set(clave, { vence: Date.now() + ttlMs, v });
    v.catch(() => cache.delete(clave));
    return v;
  };

  // El gasto del agente es todo lo que este servidor consultó hoy (herramientas y trabajo en segundo plano): el delta global de
  // `mp.cuota.usadas` desde que arrancó, que se reinicia con el día. ponytail: vive en memoria y se reinicia con el servidor; lo
  // de la CLI no se descuenta aquí (la cuota real del ticket sí es compartida vía cuotaArchivo).
  const gasto = { dia: mp.cuota.toJSON().dia, base: mp.cuota.usadas };
  const topeAgente = () => {
    const hoy = mp.cuota.toJSON().dia;
    if (gasto.dia !== hoy) Object.assign(gasto, { dia: hoy, base: 0 });
    return { limite, usadas: Math.max(0, mp.cuota.usadas - gasto.base) };
  };

  let trabajo: Trabajo | undefined;
  const lanzar: Ctx["lanzar"] = (t, correr) => {
    const j: Trabajo = { ...t, estado: "planificando", inicio: new Date().toISOString(), abort: new AbortController(), listo: undefined! };
    trabajo = j;
    // Con un timer, el que lo pidió responde antes de que el trabajo gaste su primera consulta (su `costo` no se la lleva).
    j.listo = new Promise<void>((fin) =>
      setTimeout(async () => {
        const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
        let s: Salida;
        try {
          s = await correr(j);
        } catch (e) {
          s = e instanceof MercadoPublicoError && e.tipo === "cancelada" ? { estado: "cancelado", mensaje: "Cancelado; lo hecho quedó guardado." } : { estado: "error", mensaje: msg(e) };
        }
        // Primero se suelta el lock y recién después se publica el estado final.
        await j.store.cerrar?.().catch((e) => (s = { ...s, mensaje: [s.mensaje, `no se pudo cerrar el store: ${msg(e)}`].filter(Boolean).join(" · ") }));
        Object.assign(j, s, { fin: new Date().toISOString() });
        fin();
      }, 0),
    );
    return j;
  };
  const ctx: Ctx = { mp, abrirStore, fetch: op.fetch, cacheado, topeAgente, trabajo: () => trabajo, storeTrabajo: () => (enCurso(trabajo) ? trabajo.store : undefined), lanzar };

  // Las herramientas que consultan la API van de a una: así el delta de `mp.cuota.usadas` es de esa llamada y no de otra.
  let cola: Promise<unknown> = Promise.resolve();
  const enCola = <T>(f: () => Promise<T>): Promise<T> => {
    const r = cola.then(f);
    cola = r.catch(() => {});
    return r;
  };

  const completo = (r: Objeto) => ({ resultType: "complete", ...r, _meta: { [META_INFO]: info } });
  const fallo = (m: string) => ({ content: [{ type: "text", text: m }], isError: true });

  async function ejecutar(h: Herramienta, args: Args) {
    const abierta = h.annotations.openWorldHint && !h.sinCuota;
    const antes = mp.cuota.usadas;
    const conTrabajo = enCurso(trabajo) && trabajo.tipo === "sync"; // sus consultas se mezclan con las de esta llamada en el delta
    let datos: Objeto;
    let consultas = 0;
    try {
      if (abierta && topeAgente().usadas >= limite)
        throw new ErrorUso(`Se alcanzó el tope diario del agente (${limite} consultas a la API). Para seguir, corre \`npx mercadopublico …\` en una terminal o sube MP_MCP_TOPE y reinicia el servidor.`);
      datos = await h.ejecutar(args, ctx);
    } catch (e) {
      if (e instanceof ErrorUso || e instanceof MercadoPublicoError) return fallo(e.message);
      throw e;
    } finally {
      // La cuota cuenta cada intento, también los que fallan. Si cambia el día a mitad de camino el delta puede salir negativo.
      if (abierta) {
        consultas = Math.max(0, mp.cuota.usadas - antes);
      }
    }
    const salida = { ...datos, costo: { consultas, restanteHoy: mp.cuota.restante, topeAgente: topeAgente(), ...(conTrabajo && abierta && { nota: "incluye consultas del trabajo en curso" }) } };
    return { content: [{ type: "text", text: JSON.stringify(salida) }], structuredContent: salida };
  }

  async function responder(method: string, params: Objeto): Promise<Objeto> {
    switch (method) {
      case "initialize": {
        const pedida = params.protocolVersion;
        return { protocolVersion: LEGADAS.includes(pedida as string) ? pedida : LEGADAS[0], capabilities: CAPACIDADES, serverInfo: info, instructions: INSTRUCCIONES };
      }
      case "server/discover":
        return { supportedVersions: VERSIONES, capabilities: CAPACIDADES, instructions: INSTRUCCIONES, ttlMs: TTL_LISTA_MS, cacheScope: "private" };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: herramientas.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, ...(outputSchema && { outputSchema }), annotations })),
          ttlMs: TTL_LISTA_MS,
          cacheScope: "private",
        };
      case "prompts/list":
        return { prompts: prompts.map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a })), ttlMs: TTL_LISTA_MS, cacheScope: "private" };
      case "prompts/get": {
        const a = params.arguments ?? {};
        if (typeof a !== "object" || a === null || Array.isArray(a)) throw new ErrorRpc(-32602, "`arguments` debe ser un objeto");
        if (!prompts.some((x) => x.name === params.name)) throw new ErrorRpc(-32602, `Prompt desconocido: ${String(params.name)}`);
        try {
          return obtenerPrompt(params.name as string, a as Args);
        } catch (e) {
          throw new ErrorRpc(-32602, (e as Error).message);
        }
      }
      case "tools/call": {
        const h = herramientas.find((x) => x.name === params.name);
        if (!h) throw new ErrorRpc(-32602, `Herramienta desconocida: ${String(params.name)}`);
        const args = params.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ErrorRpc(-32602, "`arguments` debe ser un objeto");
        return h.annotations.openWorldHint && !h.sinCuota ? enCola(() => ejecutar(h, args as Args)) : ejecutar(h, args as Args);
      }
      default:
        throw new ErrorRpc(-32601, `Método no soportado: ${method}`);
    }
  }

  return {
    async manejar(msg) {
      const m = msg as { id?: string | number | null; method?: unknown; params?: unknown } | null;
      if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.method !== "string")
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Mensaje JSON-RPC inválido" } };
      if (m.id === undefined) return null; // notificaciones: initialized, cancelled
      const id = m.id;
      const error = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } });
      try {
        const params = m.params ?? {};
        if (typeof params !== "object" || params === null || Array.isArray(params)) throw new ErrorRpc(-32602, "`params` debe ser un objeto");
        const meta = (params as Objeto)._meta as Objeto | undefined;
        const pedida = meta?.[META_VERSION];
        if (pedida !== undefined && !VERSIONES.includes(pedida as string)) throw new ErrorRpc(-32022, "Versión de protocolo no soportada", { supported: VERSIONES, requested: pedida });
        return { jsonrpc: "2.0", id, result: completo(await responder(m.method, params as Objeto)) };
      } catch (e) {
        return e instanceof ErrorRpc ? error(e.code, e.message, e.data) : error(-32603, e instanceof Error ? e.message : String(e));
      }
    },
  };
}
