// La CLI compilada de punta a punta contra el servidor de caos: códigos de salida, stderr de una línea, Ctrl-C, lock
// del store entre procesos y cuenta de cuota compartida. Compila src/cli.ts a una carpeta temporal (no toca dist/).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TICKET, levantar, vigilarRechazos, type Servidor } from "./servidor.js";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const PRECARGA = pathToFileURL(fileURLToPath(new URL("./redirigir.mjs", import.meta.url))).href;
let srv: Servidor;
let cli: string;
const sueltos = vigilarRechazos();
const dirs: string[] = [];
const temporal = (prefijo: string) => dirs[dirs.push(mkdtempSync(join(tmpdir(), prefijo))) - 1]!;

beforeAll(async () => {
  srv = await levantar();
  const dir = temporal("mp-caos-cli-");
  execFileSync(join(RAIZ, "node_modules/.bin/tsup"), ["src/cli.ts", "--format", "esm", "--target", "node20", "--out-dir", dir, "--no-config", "--silent"], { cwd: RAIZ });
  cli = join(dir, "cli.js");
}, 30_000);
afterEach(() => srv.reiniciar());
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await srv.cerrar();
  expect(sueltos).toEqual([]);
});

const casa = () => temporal("mp-caos-home-");

/** `node cli.js` con HOME y cwd propios (sin el .env del repo), el ticket falso y las esperas 50 veces más cortas. */
function lanzar(args: string[], home: string) {
  const hijo = spawn(process.execPath, ["--import", PRECARGA, cli, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, MERCADOPUBLICO_HOME: home, MP_TICKET: TICKET, CAOS_URL: srv.url, CAOS_ACELERAR: "50" },
  });
  let out = "";
  let err = "";
  hijo.stdout.on("data", (d) => (out += d));
  hijo.stderr.on("data", (d) => (err += d));
  const fin = new Promise<{ codigo: number | null; out: string; err: string; t: number }>((ok) =>
    hijo.on("close", (codigo) => ok({ codigo, out, err, t: performance.now() })),
  );
  return { hijo, fin };
}
const correr = (args: string[], home = casa()) => lanzar(args, home).fin;
const cuota = (home: string) => JSON.parse(readFileSync(join(home, "cuota.json"), "utf8")).usadas as number;
const SYNC = ["sync", "--desde", "2026-10-01", "--hasta", "2026-10-01", "--fuentes", "licitaciones", "--store", "mp.json", "--sin-conversion"];

// Cada test lanza varios node: con la máquina cargada, los 5 s por defecto no alcanzan.
describe("caos:lento — CLI de punta a punta", { timeout: 30_000 }, () => {
  it("códigos de salida, stderr de una línea y nunca el ticket; la cuota suma las ejecuciones", async () => {
    const home = casa();
    const ok = await correr(["licitacion", "1000-1-LE26", "--sin-conversion"], home);
    expect(ok).toMatchObject({ codigo: 0, err: "" });
    expect(JSON.parse(ok.out).codigo).toBe("1000-1-LE26");

    srv.fallar("lic", { cuerpo: { Codigo: 203, Mensaje: "Ticket no válido." } });
    const ticket = await correr(["licitaciones", "--dia", "2026-10-01"], home);
    expect(ticket).toMatchObject({ codigo: 1, out: "", err: "mercadopublico: Ticket no válido.\n" });

    srv.fallar("oc", { cuerpo: "<html>Sitio en mantención</html>", headers: { "content-type": "text/html" } });
    const html = await correr(["oc", "2000-1-SE26"], home);
    expect(html.codigo).toBe(1);

    srv.fallar("lic", { cuerpo: "<html>Sitio en mantención</html>", headers: { "content-type": "text/html" } });
    const html2 = await correr(["licitacion", "1000-1-LE26"], home);
    expect(html.err).toBe("mercadopublico: La API respondió algo que no es JSON\n");
    expect(html2).toMatchObject({ codigo: 1, err: "mercadopublico: La API respondió algo que no es JSON\n" });

    const uso = await correr(["licitaciones", "--dia", "ayer"], home);
    expect(uso).toMatchObject({ codigo: 2, err: "mercadopublico: --dia debe ser AAAA-MM-DD (ver --ayuda)\n" });

    for (const r of [ok, ticket, html, html2, uso]) expect(r.out + r.err).not.toContain(TICKET);
    expect(cuota(home)).toBe(srv.llegadas.length);
    expect(readFileSync(join(home, "cuota.json"), "utf8")).not.toContain(TICKET);
  });

  it("Ctrl-C con un detalle en vuelo: guarda lo hecho, suelta el lock, guarda la cuota y sale con 130", async () => {
    const home = casa();
    srv.fallar("lic", undefined, undefined, { colgar: true }); // listado, 1000-1, y 1000-2 se cuelga
    const { hijo, fin } = lanzar(SYNC, home);
    const l = await srv.llegada("lic", 3);
    const t0 = performance.now();
    hijo.kill("SIGINT");
    const r = await fin;
    expect(r.t - t0).toBeLessThan(5000); // sin Ctrl-C seguiría colgado; con carga, 1 s no alcanza
    expect(r.codigo).toBe(130);
    expect(JSON.parse(r.out)).toMatchObject({ detenido: "cancelado", nuevos: 1, consultas: 3 });
    expect(r.err).toContain("Cancelando: se guarda lo hecho");
    expect(r.err).not.toContain(TICKET);
    expect(Object.keys(JSON.parse(readFileSync(join(home, "mp.json"), "utf8")).procesos)).toEqual(["1000-1-LE26"]);
    expect(existsSync(join(home, "mp.json.lock"))).toBe(false);
    expect(cuota(home)).toBe(3);
    await srv.cerrada(l);
  });

  it("Ctrl-C mientras planifica: también sale con 130 (no 1) y suelta el lock", async () => {
    const home = casa();
    srv.fallar("lic", { colgar: true });
    const { hijo, fin } = lanzar(SYNC, home);
    await srv.llegada("lic");
    hijo.kill("SIGINT");
    const r = await fin;
    expect(r.codigo).toBe(130);
    expect(r.err.trim().split("\n").at(-1)).toBe("mercadopublico: Consulta cancelada");
    expect(existsSync(join(home, "mp.json.lock"))).toBe(false);
    expect(cuota(home)).toBe(1);
  });

  it("dos sync sobre el mismo store: el segundo falla con el mensaje del lock; la cuota cuenta lo de cada proceso", async () => {
    const home = casa();
    srv.fallar("lic", undefined, { colgar: true });
    const a = lanzar(SYNC, home);
    await srv.llegada("lic", 2);

    const b = await correr(SYNC, home);
    expect(b.codigo).toBe(1);
    expect(b.err).toMatch(/^mercadopublico: mp\.json está en uso por otro proceso \(mp\.json\.lock: .*"pid":\d+.*\)\. Si no hay otro sync corriendo, borra mp\.json\.lock\.\n$/);
    expect(b.err).not.toContain(TICKET);
    expect(srv.de("lic")).toHaveLength(2); // el segundo no alcanzó a consultar

    const c = await correr(["licitaciones", "--dia", "2026-10-02", "--sin-conversion"], home);
    expect(c.codigo).toBe(0);
    expect(cuota(home)).toBe(2); // el listado ya terminado del primer sync (se guarda tras cada consulta) + la otra CLI

    a.hijo.kill("SIGINT");
    expect((await a.fin).codigo).toBe(130);
    expect(cuota(home)).toBe(3); // 1 de la otra CLI + listado y detalle del primer sync
    expect(srv.llegadas).toHaveLength(3);
  });

  it("kill -9 a mitad del sync: el lock queda huérfano, el siguiente sync lo toma (dueño muerto) y termina", async () => {
    const home = casa();
    srv.fallar("lic", undefined, undefined, { colgar: true });
    const a = lanzar(SYNC, home);
    await srv.llegada("lic", 3);
    // La cuota de las 2 consultas terminadas se escribe en paralelo con la 3.ª: esperar a que esté en disco antes de matar.
    while (!(existsSync(join(home, "cuota.json")) && cuota(home) >= 2)) await new Promise((r) => setTimeout(r, 5));
    a.hijo.kill("SIGKILL");
    await a.fin;
    expect(existsSync(join(home, "mp.json.lock"))).toBe(true);
    const b = await correr(SYNC, home);
    expect(b.codigo).toBe(0);
    expect(JSON.parse(b.out)).toMatchObject({ nuevos: 3, errores: [] }); // el lote a medias no se había guardado
    expect(existsSync(join(home, "mp.json.lock"))).toBe(false);
    // La cuota se guarda tras cada consulta: del proceso matado quedan las 2 terminadas (la 3.ª estaba en vuelo).
    expect(cuota(home)).toBeGreaterThanOrEqual(4 + 2);
    expect(cuota(home)).toBeLessThanOrEqual(4 + 3);
  });

  it("ocds: líneas malas avisadas en stderr; conexión cortada a mitad entrega lo leído, sale con 1 y una línea", async () => {
    const bien = await correr(["ocds", srv.urlOcds, "--max", "1000"]);
    expect(bien).toMatchObject({ codigo: 0, err: "2 líneas no se pudieron leer\n" });
    expect(JSON.parse(bien.out)).toHaveLength(60);

    srv.fallar("ocds", { cortarEn: 1500 });
    const cortada = await correr(["ocds", srv.urlOcds, "--max", "1000"]);
    expect(cortada.codigo).toBe(1);
    expect(cortada.err).toMatch(/^(\d+ líneas no se pudieron leer\n)?mercadopublico: La lectura OCDS se cortó después de \d+ procesos[^\n]+\n$/);
    const leidos = JSON.parse(cortada.out) as unknown[];
    expect(leidos.length).toBeLessThan(60); // con carga puede ser 0: ver docs/ocds.md (lo que alcanzó a procesarse)
  });
});
