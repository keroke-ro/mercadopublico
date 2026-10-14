// Sync contra el servidor de caos con storeArchivo real: cancelar, quedarse sin cuota y páginas de mantención a mitad
// de camino, y reanudar después.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { storeArchivo, type Store } from "../../src/index.js";
import { cliente, levantar, medir, sinTicket, vigilarRechazos, type Servidor } from "./servidor.js";

let srv: Servidor;
const sueltos = vigilarRechazos();
beforeAll(async () => void (srv = await levantar()));
afterEach(() => srv.reiniciar());
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await srv.cerrar();
  expect(sueltos).toEqual([]);
});

// Licitaciones del 1 al 3 de octubre: 3 listados (pedidos 1-3 a "lic") y 6 detalles (pedidos 4-9).
const OPCIONES = { desde: "2026-10-01", hasta: "2026-10-03", fuentes: ["licitaciones" as const] };
const TODAS = ["1000-1-LE26", "1000-2-LE26", "1000-3-LE26", "1000-4-LE26", "1000-5-LE26", "1000-6-LE26"];
const dirs: string[] = [];
const ruta = () => join(dirs[dirs.push(mkdtempSync(join(tmpdir(), "mp-caos-"))) - 1]!, "mp.json");

async function codigos(s: Store) {
  const r: string[] = [];
  for await (const p of s.todos()) r.push(p.codigo);
  return r.sort();
}

async function sincronizar(archivo: string, signal?: AbortSignal) {
  const store = await storeArchivo(archivo);
  const c = cliente(srv);
  try {
    const plan = await c.mp.sync.planificar({ ...OPCIONES, store });
    return { ...c, resultado: await c.mp.sync.ejecutar(plan, { signal }), guardados: await codigos(store), cursor: await store.cursor("licitaciones") };
  } finally {
    await store.cerrar?.();
  }
}

describe("sync con fallas reales", () => {
  it("cancelar con un detalle en vuelo: vuelve de inmediato con 'cancelado', guarda lo hecho, suelta el lock y reanuda", async () => {
    const archivo = ruta();
    srv.fallar("lic", undefined, undefined, undefined, undefined, undefined, { colgar: true });
    const ac = new AbortController();
    const p = sincronizar(archivo, ac.signal);
    const l = await srv.llegada("lic", 6);
    ac.abort();
    const { valor, ms } = await medir(p);
    expect(ms).toBeLessThan(1000); // la alternativa es colgarse; con carga, 100 ms no alcanza
    expect(valor?.resultado).toMatchObject({ detenido: "cancelado", nuevos: 2, consultas: 6 });
    expect(valor?.guardados).toEqual(TODAS.slice(0, 2));
    expect(valor?.cursor).toBeUndefined();
    await srv.cerrada(l);
    expect(existsSync(`${archivo}.lock`)).toBe(false);

    const otra = await sincronizar(archivo);
    expect(otra.resultado.detenido).toBeUndefined();
    expect(otra.guardados).toEqual(TODAS);
    expect(otra.cursor).toBe("2026-10-03");
  });

  it("cuota agotada a mitad: rechaza con cuota_agotada después de guardar lo pedido; el cursor no avanza", async () => {
    const archivo = ruta();
    srv.fallar("lic", undefined, undefined, undefined, undefined, { status: 429, cuerpo: { Codigo: 429, Mensaje: "Ha superado el límite diario de solicitudes" } });
    const e = await sincronizar(archivo).catch((x: unknown) => x);
    expect(e).toMatchObject({ tipo: "cuota_agotada" });
    const store = await storeArchivo(archivo);
    expect(await codigos(store)).toEqual(TODAS.slice(0, 1));
    expect(await store.cursor("licitaciones")).toBeUndefined();
    await store.cerrar?.();
    expect(sinTicket(e)).toBe(true);
  });

  it("página de mantención (200 HTML) en un detalle: queda en errores y pendiente; el cursor avanza y la próxima vuelta la trae", async () => {
    const archivo = ruta();
    srv.fallar("lic", undefined, undefined, undefined, undefined, { cuerpo: "<html>Sitio en mantención</html>", headers: { "content-type": "text/html" } });
    const a = await sincronizar(archivo);
    expect(a.resultado.errores).toEqual([{ codigo: "1000-2-LE26", error: "La API respondió algo que no es JSON" }]);
    expect(a.guardados).toEqual(TODAS.filter((c) => c !== "1000-2-LE26"));
    expect(a.cursor).toBe("2026-10-03"); // el detalle fallido queda pendiente, no frena el cursor

    const b = await sincronizar(archivo);
    expect(b.resultado.errores).toEqual([]);
    expect(b.guardados).toEqual(TODAS);
    expect(b.cursor).toBe("2026-10-03");
    expect(sinTicket(a.eventos, b.eventos)).toBe(true);
  });
});
