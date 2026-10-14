// Núcleo del servidor MCP, sin transporte ni imports `node:` (corre en Node y en runtimes edge): `manejar` recibe un
// mensaje JSON-RPC ya parseado y devuelve la respuesta. "Dual-era": atiende a clientes 2025-11-25 (con `initialize`)
// y a los stateless de 2026-07-28 (con `server/discover` y `_meta`). El bucle stdio vive en cli.ts.
import { MercadoPublicoError } from "./errores.js";
import { diaSantiago } from "./fecha.js";
import { ocultarPersonales, type MercadoPublico, type Proceso, type Store } from "./index.js";
import { resumenRadar, pesos, type Perfil } from "./radar/index.js";
import { ESTADOS_FILTRO_LICITACION, ESTADO_FILTRO_OC, REGION, familiaDesdeCodigo, urlPublica } from "./v1/codigos.js";
import type { EstadoCompraAgil } from "./v2/parse.js";

const VERSIONES = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const LEGADAS = VERSIONES.slice(1);
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_INFO = "io.modelcontextprotocol/serverInfo";
const TTL_LISTA_MS = 3_600_000;

const INSTRUCCIONES =
  "Mercado Público de Chile. Busca con `search` y después trae el detalle con `fetch`. Las órdenes de compra se ven con `listar` " +
  "o, si hay store local, con `search`. Cada herramienta informa en `costo` cuántas consultas a la API gastó: la API permite " +
  "10.000 al día y este servidor corta al llegar a su tope diario. Los datos personales de funcionarios vienen ocultos.";

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
  /** ponytail: caché por proceso, sin LRU; las claves son pocas (activas, compradores y los detalles pedidos). */
  cacheado<T>(clave: string, ttlMs: number, f: () => Promise<T>): Promise<T>;
  topeAgente(): { limite: number; usadas: number };
}

interface Herramienta {
  name: string;
  title: string;
  description: string;
  inputSchema: Objeto;
  outputSchema?: Objeto;
  annotations: { readOnlyHint: true; idempotentHint: true; openWorldHint: boolean };
  requiereStore?: true;
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

function regiones(a: Args): number[] | undefined {
  const v = a.region;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.length || v.some((r) => !Number.isInteger(r) || r < 1 || r > 16)) throw new ErrorUso("`region` es una lista de códigos del 1 al 16 (13 = Metropolitana)");
  return v as number[];
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

async function enStore<T>(c: Ctx, f: (s: Store) => Promise<T>): Promise<T> {
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
      const todos = await enStore(c, async (s) => {
        const r: Proceso[] = [];
        for await (const p of s.todos()) r.push(p);
        return r;
      });
      if (!todos.length) throw new ErrorUso("el store está vacío: corre `npx mercadopublico sync --desde AAAA-MM-DD`");
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
];

// --- servidor ---

export function crearServidorMcp(op: { mp: MercadoPublico; abrirStore?: () => Promise<Store>; tope?: number; version?: string }): { manejar(msg: unknown): Promise<object | null> } {
  const { mp, abrirStore } = op;
  const limite = op.tope ?? 1000;
  const info = { name: "mercadopublico", version: op.version ?? "0.1.0" };
  const herramientas = HERRAMIENTAS.filter((h) => !h.requiereStore || abrirStore);

  const cache = new Map<string, { vence: number; v: Promise<unknown> }>();
  const cacheado = <T>(clave: string, ttlMs: number, f: () => Promise<T>): Promise<T> => {
    const e = cache.get(clave);
    if (e && e.vence > Date.now()) return e.v as Promise<T>;
    const v = f();
    cache.set(clave, { vence: Date.now() + ttlMs, v });
    v.catch(() => cache.delete(clave));
    return v;
  };

  // ponytail: el gasto del agente vive en memoria y se reinicia con el servidor; el de la CLI no se descuenta aquí (la cuota
  // real del ticket sí es compartida vía cuotaArchivo).
  const gasto = { dia: diaSantiago(), usadas: 0 };
  const topeAgente = () => {
    const hoy = diaSantiago();
    if (gasto.dia !== hoy) Object.assign(gasto, { dia: hoy, usadas: 0 });
    return { limite, usadas: gasto.usadas };
  };
  const ctx: Ctx = { mp, abrirStore, cacheado, topeAgente };

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
    const abierta = h.annotations.openWorldHint;
    const antes = mp.cuota.usadas;
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
        topeAgente(); // pasa al día nuevo si hace falta
        gasto.usadas += consultas;
      }
    }
    const salida = { ...datos, costo: { consultas, restanteHoy: mp.cuota.restante, topeAgente: topeAgente() } };
    return { content: [{ type: "text", text: JSON.stringify(salida) }], structuredContent: salida };
  }

  async function responder(method: string, params: Objeto): Promise<Objeto> {
    switch (method) {
      case "initialize": {
        const pedida = params.protocolVersion;
        return { protocolVersion: LEGADAS.includes(pedida as string) ? pedida : LEGADAS[0], capabilities: { tools: {} }, serverInfo: info, instructions: INSTRUCCIONES };
      }
      case "server/discover":
        return { supportedVersions: VERSIONES, capabilities: { tools: {} }, instructions: INSTRUCCIONES, ttlMs: TTL_LISTA_MS, cacheScope: "private" };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: herramientas.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, ...(outputSchema && { outputSchema }), annotations })),
          ttlMs: TTL_LISTA_MS,
          cacheScope: "private",
        };
      case "tools/call": {
        const h = herramientas.find((x) => x.name === params.name);
        if (!h) throw new ErrorRpc(-32602, `Herramienta desconocida: ${String(params.name)}`);
        const args = params.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ErrorRpc(-32602, "`arguments` debe ser un objeto");
        return h.annotations.openWorldHint ? enCola(() => ejecutar(h, args as Args)) : ejecutar(h, args as Args);
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
