// Transporte Streamable HTTP del MCP, sin imports `node:` (Workers, Deno, Bun y Node): `Request` → `Response`.
// Solo POST, un mensaje JSON-RPC por pedido y siempre `application/json`: sin SSE ni `Mcp-Session-Id`.
// Es subpath público (`mercadopublico/mcp`), por eso reexporta el núcleo.
import { VERSIONES } from "./mcp.js";
export { crearServidorMcp } from "./mcp.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
/** Métodos modernos cuyo `Mcp-Name` debe calzar con este campo del cuerpo. */
const CAMPO_NOMBRE: Record<string, string> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };

/** Compara sin cortar en la primera diferencia (no filtra el largo del prefijo común). */
function iguales(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) d |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return d === 0;
}

/** `=?base64?…?=` es la forma de mandar en un header valores no ASCII (spec 2026-07-28). */
function decodificar(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return v;
  }
}

export function manejadorHttp(
  servidor: { manejar(msg: unknown): Promise<object | null> },
  op: { clave?: string; origenes?: string[] } = {},
): (req: Request) => Promise<Response> {
  const { clave } = op;
  const origenes = op.origenes ?? [];
  const respuesta = (status: number, cuerpo?: object, extra?: Record<string, string>) =>
    new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), {
      status,
      headers: { ...(cuerpo !== undefined && { "content-type": "application/json" }), "cache-control": "no-store", ...extra },
    });
  const error = (status: number, code: number, message: string, id: unknown = null, data?: unknown, extra?: Record<string, string>) =>
    respuesta(status, { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } }, extra);

  function autorizado(req: Request): boolean {
    if (!clave) return true;
    const bearer = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
    let ruta = new URL(req.url).pathname.replace(/\/$/, "");
    try {
      ruta = decodeURIComponent(ruta);
    } catch {}
    const sufijo = `/mcp/${clave}`;
    // Las dos vías se calculan antes de decidir: no se corta en la primera.
    const porRuta = iguales(ruta.slice(-sufijo.length), sufijo);
    const porBearer = iguales(bearer?.[1] ?? "", clave);
    return porRuta || porBearer;
  }

  return async (req) => {
    if (req.method !== "POST") return error(405, -32600, "Solo POST", null, undefined, { allow: "POST" });
    const origen = req.headers.get("origin");
    if (origen !== null && !origenes.includes(origen)) return error(403, -32600, "Origin no permitido");
    if (!autorizado(req)) return error(401, -32600, "No autorizado", null, undefined, { "www-authenticate": "Bearer" });

    let msg: unknown;
    try {
      msg = JSON.parse(await req.text());
    } catch {
      return error(400, -32700, "JSON inválido");
    }
    if (Array.isArray(msg)) return error(400, -32600, "Un solo mensaje JSON-RPC por pedido (sin batch)");

    const m = msg as { id?: unknown; method?: unknown; params?: { _meta?: Record<string, unknown>; [k: string]: unknown } } | null;
    const id = m && typeof m === "object" && "id" in m ? m.id : null;
    const meta = m?.params && typeof m.params === "object" ? m.params._meta : undefined;
    const pedida = meta && typeof meta === "object" ? meta[META_VERSION] : undefined;
    const version = req.headers.get("mcp-protocol-version");

    if (pedida !== undefined) {
      // Moderno (2026-07-28): los headers espejan el cuerpo y deben calzar.
      const desajuste = (que: string) => error(400, -32020, `Header mismatch: ${que}`, id);
      if (version !== pedida) return desajuste(`MCP-Protocol-Version '${version ?? ""}' no calza con _meta`);
      if (VERSIONES.includes(version!)) {
        const metodo = req.headers.get("mcp-method");
        if (metodo !== m!.method) return desajuste(`Mcp-Method '${metodo ?? ""}' no calza con el cuerpo`);
        const campo = typeof m!.method === "string" ? CAMPO_NOMBRE[m!.method] : undefined;
        if (campo) {
          const nombre = req.headers.get("mcp-name");
          if (nombre === null || decodificar(nombre) !== m!.params![campo]) return desajuste("Mcp-Name no calza con el cuerpo");
        }
      }
    } else if (version !== null && !VERSIONES.includes(version)) {
      return error(400, -32022, "Versión de protocolo no soportada", id, { supported: VERSIONES, requested: version });
    }

    let r: object | null;
    try {
      r = await servidor.manejar(msg);
    } catch {
      return error(500, -32603, "Error interno", id);
    }
    if (r === null) return respuesta(202);
    // Solo estos errores de protocolo cambian el status; el resto (incluidos los de herramientas) va en 200.
    const code = (r as { error?: { code?: number } }).error?.code;
    // -32601 → 404 solo en modernos (lo manda la spec 2026-07-28); en legacy la 2025-11-25 no dice nada y 200 es lo esperable.
    const status = code === -32022 || code === -32020 || code === -32600 || code === -32700 ? 400 : code === -32601 && pedida !== undefined ? 404 : 200;
    return respuesta(status, r);
  };
}
