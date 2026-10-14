// Servidor MCP por stdio (`mercadopublico mcp`): cada herramienta corre un comando de la CLI con --formato json,
// así hereda validación, cuota en disco, conversores y datos personales ocultos. Sin dependencias: JSON-RPC a mano.
import { createInterface } from "node:readline";
import type { IO } from "./cli.js";
import { ESTADOS_FILTRO_LICITACION, ESTADO_FILTRO_OC } from "./v1/codigos.js";

type Args = Record<string, unknown>;
type Main = (argv: string[], io: IO) => Promise<number>;

const texto = (description: string) => ({ type: "string", description });
const dia = texto("Día AAAA-MM-DD; por defecto hoy");
const max = { type: "integer", minimum: 1, description: "Máximo de resultados a devolver (50 por defecto)" };
const filtrosV1 = (estados: readonly string[]) => ({
  dia,
  estado: { type: "string", enum: estados, description: "No se combina con organismo ni proveedor" },
  organismo: texto("Código del organismo comprador (ver compradores)"),
  proveedor: texto("Código de empresa del proveedor (ver proveedor)"),
  max,
});

const HERRAMIENTAS: { name: string; description: string; comando: string; posicional?: string; properties: Args; required?: string[] }[] = [
  { name: "licitacion", comando: "licitacion", posicional: "codigo", description: "Detalle de una licitación por código (ej. 1509-5-L114). 1 consulta.", properties: { codigo: texto("Código de la licitación") }, required: ["codigo"] },
  { name: "licitaciones", comando: "licitaciones", description: "Licitaciones activas hoy, o las de un día filtradas por estado, organismo o proveedor. 1 consulta.", properties: filtrosV1(ESTADOS_FILTRO_LICITACION) },
  { name: "orden_compra", comando: "oc", posicional: "codigo", description: "Detalle de una orden de compra por código. 1 consulta.", properties: { codigo: texto("Código de la orden de compra") }, required: ["codigo"] },
  { name: "ordenes_compra", comando: "ordenes", description: "Órdenes de compra de hoy, o las de un día filtradas por estado, organismo o proveedor. 1 consulta.", properties: filtrosV1(Object.keys(ESTADO_FILTRO_OC)) },
  {
    name: "compra_agil",
    comando: "compra-agil",
    posicional: "codigo",
    description: "Detalle de una Compra Ágil por código, o listado filtrado (sin filtros: las publicadas hoy). 1 consulta por página de 50.",
    properties: {
      codigo: texto("Código de la Compra Ágil; si va, se ignoran los filtros"),
      region: { type: "array", items: { type: "integer", minimum: 1, maximum: 16 }, description: "Regiones (13 = Metropolitana)" },
      estado: { type: "array", items: { type: "string", enum: ["publicada", "cerrada", "desierta", "cancelada", "proveedor_seleccionado"] } },
      q: texto("Texto a buscar"),
      desde: texto("Publicadas desde esta fecha ISO"),
      max,
    },
  },
  { name: "proveedor", comando: "proveedor", posicional: "rut", description: "Código de empresa de un proveedor a partir de su RUT. 1 consulta.", properties: { rut: texto("RUT, con o sin puntos") }, required: ["rut"] },
  { name: "compradores", comando: "compradores", description: "Todos los organismos compradores con su código. 1 consulta.", properties: { max } },
  { name: "cuota", comando: "cuota", description: "Consultas usadas hoy de las 10.000 diarias del ticket. No gasta consultas.", properties: {} },
  {
    name: "radar",
    comando: "radar",
    description: "Qué postular primero, a qué precio y qué viene, desde un store local ya sincronizado (mercadopublico sync). No gasta consultas.",
    properties: { perfil: texto("Ruta al perfil.json"), store: texto("Ruta al store (./mp.json por defecto)"), decisiones: texto("Ruta a decisiones.json para calibrar") },
    required: ["perfil"],
  },
];

/** Traduce los argumentos de una herramienta a argv de la CLI. */
export function argv(nombre: string, a: Args): string[] {
  const h = HERRAMIENTAS.find((x) => x.name === nombre);
  if (!h) throw new Error(`Herramienta desconocida: ${nombre}`);
  const r = [h.comando];
  if (h.posicional && a[h.posicional] !== undefined) r.push(String(a[h.posicional]));
  for (const [k, v] of Object.entries(a)) {
    if (k === h.posicional || v === undefined || v === null || !(k in h.properties)) continue;
    if (k === "max" && h.comando !== "compra-agil") continue; // en el resto el recorte lo hace el servidor
    r.push(`--${k}`, Array.isArray(v) ? v.join(",") : String(v));
  }
  return [...r, "--formato", "json"];
}

/** Sin `raw` (enorme y redundante para un agente) y con las listas recortadas a `max`. */
export function resumir(salida: string, tope = 50): string {
  const datos = JSON.parse(salida) as unknown;
  const recorte = Array.isArray(datos) && datos.length > tope ? { total: datos.length, mostrados: tope, resultados: datos.slice(0, tope) } : datos;
  return JSON.stringify(recorte, (k, v) => (k === "raw" ? undefined : v));
}

async function llamar(main: Main, io: IO, nombre: string, a: Args) {
  let out = "";
  let err = "";
  const codigo = await main(argv(nombre, a), { stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (err += s) }, env: io.env, fetch: io.fetch });
  if (codigo !== 0) return { isError: true, content: [{ type: "text", text: err.trim() || `Falló con código ${codigo}` }] };
  return { content: [{ type: "text", text: resumir(out, typeof a.max === "number" ? a.max : 50) }] };
}

// ponytail: atiende un mensaje a la vez; eso serializa las consultas (evita el 10500), pero un ping espera a la herramienta en curso.
export async function servir(main: Main, io: IO, entrada: NodeJS.ReadableStream): Promise<number> {
  const enviar = (m: unknown) => io.stdout.write(`${JSON.stringify(m)}\n`);
  for await (const linea of createInterface({ input: entrada, crlfDelay: Infinity })) {
    if (!linea.trim()) continue;
    let m: { id?: string | number; method?: string; params?: Args };
    try {
      m = JSON.parse(linea);
    } catch {
      enviar({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
      continue;
    }
    if (m.id === undefined) continue; // notificaciones: initialized, cancelled
    const responder = (result: unknown) => enviar({ jsonrpc: "2.0", id: m.id, result });
    try {
      switch (m.method) {
        case "initialize":
          responder({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mercadopublico", version: "0.1.0" } });
          break;
        case "ping":
          responder({});
          break;
        case "tools/list":
          responder({ tools: HERRAMIENTAS.map(({ name, description, properties, required }) => ({ name, description, inputSchema: { type: "object", properties, required } })) });
          break;
        case "tools/call":
          responder(await llamar(main, io, String(m.params?.name), (m.params?.arguments ?? {}) as Args));
          break;
        default:
          enviar({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Método no soportado: ${m.method}` } });
      }
    } catch (e) {
      enviar({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
    }
  }
  return 0;
}
