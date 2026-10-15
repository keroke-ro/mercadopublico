// `npx mercadopublico` (o `mercadopublico init`) en una terminal: elige qué instalar y lo deja configurado.
// Ticket en ~/.mercadopublico/config.json, el MCP en los agentes que encuentre, el perfil del radar con un primer sync
// y el SDK en el proyecto. Las funciones puras van exportadas para los tests; lo interactivo no se testea.
import * as p from "@clack/prompts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MercadoPublico, MercadoPublicoError, cuotaArchivo, storeArchivo, type Proceso } from "./index.js";
import { resumenRadar, type Perfil } from "./radar/index.js";
import { diaSantiago, sumarDias } from "./fecha.js";
import { REGION } from "./v1/codigos.js";

export interface Config {
  ticket?: string;
  store?: string;
  perfil?: string;
}

export const rutaConfig = (home: string) => join(home, "config.json");

export async function leerConfig(home: string): Promise<Config> {
  try {
    return JSON.parse(await readFile(rutaConfig(home), "utf8")) as Config;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${rutaConfig(home)} no es JSON válido: arréglalo o bórralo y corre \`npx mercadopublico init\``);
  }
}

/** Solo lo puede leer el dueño: lleva el ticket. */
async function guardarConfig(home: string, c: Config) {
  await mkdir(home, { recursive: true });
  await writeFile(rutaConfig(home), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await chmod(rutaConfig(home), 0o600);
}

export type Cliente = "claude-code" | "codex" | "cursor" | "claude-desktop";

/** Dónde guardan su configuración MCP los clientes que se configuran editando JSON. */
export function rutasClientes(plataforma: NodeJS.Platform, home: string, env: Record<string, string | undefined>) {
  const desktop =
    plataforma === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : plataforma === "win32"
        ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude")
        : join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude");
  return { cursor: join(home, ".cursor", "mcp.json"), "claude-desktop": join(desktop, "claude_desktop_config.json") };
}

export interface EntradaMcp {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Cómo lanzar el servidor desde una app de escritorio. En macOS y Linux las apps abiertas desde el Dock no heredan el
 * PATH de la terminal (nvm, Homebrew): se usa el npx que está junto a este node y se le pasa ese directorio en PATH.
 */
export function entradaMcp(plataforma: NodeJS.Platform, execPath: string, existe: (f: string) => boolean = existsSync): EntradaMcp {
  const args = ["-y", "mercadopublico", "mcp"];
  const bin = dirname(execPath);
  if (plataforma === "win32" || !existe(join(bin, "npx"))) return { command: "npx", args };
  return { command: join(bin, "npx"), args, env: { PATH: [...new Set([bin, "/usr/local/bin", "/usr/bin", "/bin"])].join(":") } };
}

/** El JSON de configuración con `mcpServers.mercadopublico` agregado o reemplazado; lo demás queda igual. */
export function conServidor(texto: string | null, entrada: EntradaMcp): string {
  let c: Record<string, unknown> = {};
  if (texto?.trim()) {
    c = JSON.parse(texto) as Record<string, unknown>;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("no es un objeto JSON");
  }
  const servidores = c.mcpServers && typeof c.mcpServers === "object" ? (c.mcpServers as Record<string, unknown>) : {};
  return `${JSON.stringify({ ...c, mcpServers: { ...servidores, mercadopublico: entrada } }, null, 2)}\n`;
}

/** Montos como los escribe la gente: "200.000", "5 millones", "$1.500.000", "2M". */
export function monto(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/\$/g, "");
  if (!t) return undefined;
  const millones = /(millones|millón|millon|mm|m)$/.test(t);
  const n = Number(t.replace(/(millones|millón|millon|mm|m)$/, "").trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(millones ? n * 1_000_000 : n) : NaN;
}

export function rubros(s: string): string[] {
  return s.split(/[\s,;]+/).filter(Boolean);
}

export interface RespuestasPerfil {
  rubros: string[];
  regiones: number[];
  montoMin?: number;
  montoMax?: number;
  rut?: string;
  capacidad: number;
}

/** Los pesos de examples/perfil.json: rubro primero, después monto y plazo. Se ajustan después con `calibrar`. */
export function perfilDesde(r: RespuestasPerfil): Perfil {
  return {
    pesos: { rubro: 3, region: r.regiones.length ? 1 : 0, monto: r.montoMin !== undefined || r.montoMax !== undefined ? 2 : 0, diasAlCierre: 2, competencia: 1, incumbente: 2 },
    rubros: r.rubros,
    ...(r.regiones.length && { regiones: r.regiones }),
    ...(r.montoMin !== undefined && { montoMin: r.montoMin }),
    ...(r.montoMax !== undefined && { montoMax: r.montoMax }),
    ...(r.rut && { rut: r.rut }),
    capacidad: r.capacidad,
  };
}

// --- presentación ---

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const pinta = (n: string) => (s: string) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const negrita = pinta("1");
const tenue = pinta("2");
const verde = pinta("32");
const cian = pinta("36");
const haceDias = (n: number) => sumarDias(diaSantiago(), -n);

/** La ruta como la escribirías tú: ~/.mercadopublico/… */
export const corta = (ruta: string, home = homedir()) => (ruta.startsWith(`${home}/`) || ruta.startsWith(`${home}\\`) ? `~${ruta.slice(home.length)}` : ruta);
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Una rana que salta hasta el título y un brillo que lo recorre. Sin TTY, NO_COLOR o en CI: estático. */
async function portada(version: string) {
  const titulo = " mercadopublico ";
  const sub = `instalador · v${version} · por KeroKero`;
  if (!color || p.isCI()) return void process.stdout.write(`\n  ${negrita(titulo)}\n  ${sub}\n\n`);
  const ancho = 24;
  const rana = ["  @..@  ", " (----) ", "( >__< )", "^^ ~~ ^^"];
  const salto = [2, 1, 0, 1, 2]; // líneas vacías sobre la rana: 2 = en el suelo
  const out = process.stdout;
  out.write("\x1b[?25l\n");
  try {
    for (let x = 0; x <= ancho; x += 2) {
      const alto = salto[(x / 2) % salto.length]!;
      const lineas = [...Array(alto).fill(""), ...rana, ...Array(2 - alto).fill("")].slice(0, 6);
      out.write(lineas.map((l) => `\x1b[2K${" ".repeat(x)}${verde(l)}`).join("\n"));
      await espera(45);
      out.write(`\x1b[${lineas.length - 1}A\r`);
    }
    out.write("\x1b[0J");
    // Brillo: un degradé de verdes que pasa por el título una vez.
    const tonos = [22, 28, 34, 40, 46, 82, 118, 157, 194, 231];
    for (let i = -tonos.length; i <= titulo.length + tonos.length; i++) {
      const s = [...titulo].map((ch, j) => {
        const d = Math.abs(j - i);
        return `\x1b[1;38;5;${d < tonos.length ? tonos[tonos.length - 1 - d] : 34}m${ch}`;
      });
      out.write(`\r  ${verde("(·>·)")} \x1b[42m${s.join("")}\x1b[0m`);
      await espera(28);
    }
    out.write("\n\n  ");
    for (const ch of sub) (out.write(tenue(ch)), await espera(8));
    out.write("\n\n");
  } finally {
    out.write("\x1b[?25h");
  }
}

class Cancelado extends Error {}
function r<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) throw new Cancelado();
  return v as Exclude<T, symbol>;
}

function correr(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; salida: string }> {
  return new Promise((ok) =>
    execFile(cmd, args, { cwd, shell: process.platform === "win32", timeout: 180_000 }, (e, out, err) => ok({ ok: !e, salida: `${out}${err}`.trim() })),
  );
}

const tieneComando = async (cmd: string) => (await correr(cmd, ["--version"])).ok;

/** Devuelve si había un archivo antes (y quedó su respaldo en .bak). */
async function escribirConRespaldo(ruta: string, f: (antes: string | null) => string): Promise<boolean> {
  const antes = existsSync(ruta) ? await readFile(ruta, "utf8") : null;
  const nuevo = f(antes);
  await mkdir(dirname(ruta), { recursive: true });
  if (antes !== null) await copyFile(ruta, `${ruta}.bak`);
  await writeFile(ruta, nuevo);
  return antes !== null;
}

// --- pasos ---

interface Estado {
  home: string;
  config: Config;
  mcp: boolean;
  hechos: string[];
  siguientes: string[];
}

async function pasoTicket(e: Estado, env: Record<string, string | undefined>) {
  const actual = e.config.ticket || env.MP_TICKET;
  if (actual) {
    const usar = r(await p.confirm({ message: `Encontré un ticket (${tenue(`…${actual.slice(-4)}`)}). ¿Lo uso?`, initialValue: true }));
    if (usar) {
      if (!e.config.ticket) (e.config.ticket = actual), e.hechos.push(`Ticket guardado en ${corta(rutaConfig(e.home))}`);
      return;
    }
  } else p.note(`Se pide gratis con Clave Única en ${cian("https://www.chilecompra.cl/api/")}\ny llega por correo. Sin ticket igual puedes instalar todo y agregarlo después.`, "Tu ticket de la API");

  for (;;) {
    const t = r(
      await p.password({
        message: "Pega tu ticket (o déjalo vacío para seguir sin él)",
        mask: "•",
        validate: (v) => (!v || /^[\dA-F]{8}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{12}$/i.test(v.trim()) ? undefined : "Tiene la forma XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"),
      }),
    ).trim();
    if (!t) return void e.siguientes.push(`Cuando tengas el ticket: ${cian("npx mercadopublico init")}`);
    const s = p.spinner();
    s.start("Probando el ticket con la API (1 consulta)");
    try {
      const cuota = await cuotaArchivo(join(e.home, "cuota.json"));
      try {
        await new MercadoPublico({ ticket: t, alEvento: cuota.alEvento, cuota: cuota.estado, reintentos: 1 }).licitaciones.porCodigo("1509-5-L114");
      } finally {
        await cuota.guardar();
      }
      s.stop(verde("Ticket válido"));
    } catch (err) {
      if (err instanceof MercadoPublicoError && err.tipo === "ticket_invalido") {
        s.error("La API dice que ese ticket no es válido");
        continue;
      }
      s.error(`No pude probarlo (${(err as Error).message}); lo guardo igual`);
    }
    e.config.ticket = t;
    e.hechos.push(`Ticket guardado en ${corta(rutaConfig(e.home))} ${tenue("(solo tu usuario puede leerlo)")}`);
    return;
  }
}

const NOMBRES: Record<Cliente, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "claude-desktop": "Claude Desktop" };

async function pasoMcp(e: Estado, env: Record<string, string | undefined>) {
  const s = p.spinner();
  s.start("Buscando agentes en este equipo");
  const rutas = rutasClientes(process.platform, homedir(), env);
  const hay: Record<Cliente, boolean> = {
    "claude-code": await tieneComando("claude"),
    codex: await tieneComando("codex"),
    cursor: existsSync(dirname(rutas.cursor)),
    "claude-desktop": existsSync(dirname(rutas["claude-desktop"])),
  };
  const encontrados = (Object.keys(hay) as Cliente[]).filter((c) => hay[c]);
  s.stop(encontrados.length ? `Encontré ${encontrados.map((c) => NOMBRES[c]).join(", ")}` : "No encontré agentes instalados");

  const elegidos = r(
    await p.multiselect<Cliente>({
      message: "¿En cuáles lo configuro?",
      options: (Object.keys(NOMBRES) as Cliente[]).map((c) => ({ value: c, label: NOMBRES[c], hint: hay[c] ? "instalado" : "no lo encontré" })),
      initialValues: encontrados,
      required: false,
    }),
  );
  if (!elegidos.length) return;

  const entrada = entradaMcp(process.platform, process.execPath);
  const npx = ["npx", "-y", "mercadopublico", "mcp"];
  for (const c of elegidos) {
    const s = p.spinner();
    s.start(`Configurando ${NOMBRES[c]}`);
    try {
      let respaldo = false;
      if (c === "claude-code" || c === "codex") {
        const cmd = c === "claude-code" ? "claude" : "codex";
        const alcance = c === "claude-code" ? ["--scope", "user"] : [];
        // `add` falla si ya existe: se quita primero (sin importar si estaba).
        await correr(cmd, ["mcp", "remove", ...alcance, "mercadopublico"]);
        const res = await correr(cmd, ["mcp", "add", ...alcance, "mercadopublico", "--", ...npx]);
        if (!res.ok) throw new Error(res.salida.split("\n").pop() || `${cmd} mcp add falló`);
      } else respaldo = await escribirConRespaldo(rutas[c], (antes) => conServidor(antes, entrada));
      s.stop(`${NOMBRES[c]} ${verde("listo")}`);
      e.mcp = true;
      e.hechos.push(`MCP en ${NOMBRES[c]}${c === "cursor" || c === "claude-desktop" ? tenue(` (${corta(rutas[c])}${respaldo ? ", respaldo en .bak" : ""})`) : ""}`);
      if (c === "claude-desktop") e.siguientes.push("Cierra y vuelve a abrir Claude Desktop para que cargue el MCP");
    } catch (err) {
      s.error(`${NOMBRES[c]}: ${(err as Error).message}`);
      e.siguientes.push(`Configura ${NOMBRES[c]} a mano: ${cian("https://github.com/keroke-ro/mercadopublico/blob/main/docs/mcp.md")}`);
    }
  }
}

async function pasoRadar(e: Estado) {
  p.log.step(negrita("Radar: ¿qué le vendes al Estado?"));
  const rutaPerfil = join(e.home, "perfil.json");
  if (existsSync(rutaPerfil) && !r(await p.confirm({ message: `Ya tienes un perfil en ${corta(rutaPerfil)}. ¿Lo reemplazo?`, initialValue: false }))) {
    e.config.perfil = rutaPerfil;
  } else {
    const rs = rubros(
      r(
        await p.text({
          message: "Rubros (códigos UNSPSC, los mismos de los ítems en las fichas), separados por coma",
          placeholder: "4213 (guantes médicos), 4323 (software), 8111 (servicios TI)",
          validate: (v) => (!v?.trim() ? "Pon al menos uno" : rubros(v).every((x) => /^(\d{2}|\d{4}|\d{6}|\d{8})$/.test(x)) ? undefined : "Códigos de 2, 4, 6 u 8 dígitos"),
        }),
      ),
    );
    const regiones = r(
      await p.multiselect<number>({
        message: "¿En qué regiones? (ninguna = todo Chile)",
        options: Object.entries(REGION).map(([k, v]) => ({ value: Number(k), label: v })),
        required: false,
      }),
    );
    const validaMonto = (v: string | undefined) => (Number.isNaN(monto(v ?? "")) ? "Un monto en pesos, como 200.000 o 5 millones" : undefined);
    const min = monto(r(await p.text({ message: "Monto mínimo que te interesa (CLP, vacío = sin mínimo)", placeholder: "200.000", validate: validaMonto })) ?? "");
    const max = monto(r(await p.text({ message: "Monto máximo que alcanzas a atender (vacío = sin máximo)", placeholder: "5 millones", validate: validaMonto })) ?? "");
    const rut = r(
      await p.text({
        message: "RUT de tu empresa (opcional, para no contarte como tu competencia)",
        placeholder: "76.123.456-7",
        validate: (v) => (!v?.trim() || /^\d{1,3}(\.?\d{3}){0,2}-?[\dkK]$/.test(v.trim()) ? undefined : "RUT inválido"),
      }),
    )?.trim();
    const capacidad = Number(
      r(await p.text({ message: "¿Cuántas ofertas alcanza a preparar tu equipo por vez?", initialValue: "5", validate: (v) => (/^[1-9]\d*$/.test(v?.trim() ?? "") ? undefined : "Un entero positivo") })),
    );
    const perfil = perfilDesde({ rubros: rs, regiones, montoMin: min, montoMax: max, rut: rut || undefined, capacidad });
    await mkdir(e.home, { recursive: true });
    await writeFile(rutaPerfil, `${JSON.stringify(perfil, null, 2)}\n`);
    e.config.perfil = rutaPerfil;
    e.hechos.push(`Perfil del radar en ${corta(rutaPerfil)} ${tenue("(edítalo cuando quieras: docs/radar.md)")}`);
  }
  e.config.store ??= join(e.home, "mp.json");

  const sync = cian(`npx mercadopublico sync --desde ${haceDias(7)}`);
  if (!e.config.ticket) return void e.siguientes.push(`Con el ticket, llena el store para el radar: ${sync}`);
  const dias = r(
    await p.select<number>({
      message: "¿Bajo datos para que el radar tenga con qué trabajar?",
      options: [
        { value: 7, label: "Últimos 7 días", hint: "unos minutos" },
        { value: 30, label: "Últimos 30 días", hint: "más historial, más rato" },
        { value: 0, label: "Ahora no" },
      ],
      initialValue: 7,
    }),
  );
  if (!dias) return void e.siguientes.push(`Llena el store para el radar: ${sync}`);
  await sincronizar(e, dias);
}

async function sincronizar(e: Estado, dias: number) {
  const cuota = await cuotaArchivo(join(e.home, "cuota.json"));
  const mp = new MercadoPublico({ ticket: e.config.ticket!, alEvento: cuota.alEvento, cuota: cuota.estado });
  const store = await storeArchivo(e.config.store!);
  const ac = new AbortController();
  const parar = () => ac.abort();
  process.once("SIGINT", parar);
  try {
    const desde = haceDias(dias);
    const s = p.spinner();
    s.start("Calculando cuántas consultas cuesta");
    const plan = await mp.sync.planificar({ desde, store, signal: ac.signal });
    s.stop(`Cuesta ~${plan.consultas} consultas (quedan ${plan.restante} de 10.000 hoy)`);
    if (!r(await p.confirm({ message: "¿Le doy?", initialValue: plan.consultas <= plan.restante / 2 }))) return;
    const barra = p.progress({ style: "heavy", max: Math.max(1, plan.consultas) });
    barra.start("Bajando datos de Mercado Público");
    const hechas = new Map<string, number>();
    const resultado = await mp.sync.ejecutar(plan, {
      signal: ac.signal,
      alAvanzar: ({ fuente, hechas: n, total }) => {
        barra.advance(n - (hechas.get(fuente) ?? 0), `${fuente.replace("_", " ")} ${n}/${total}`);
        hechas.set(fuente, n);
      },
    });
    barra.stop(resultado.detenido === "cancelado" ? "Cancelado: quedó guardado lo que alcanzó a bajar" : verde("Datos al día"));
    e.hechos.push(`Store con ${dias} días de datos en ${corta(e.config.store!)}`);

    const todos: Proceso[] = [];
    for await (const x of store.todos()) todos.push(x);
    const perfil = JSON.parse(await readFile(e.config.perfil!, "utf8")) as Perfil;
    const agenda = resumenRadar(todos, perfil).decisiones.filter((d) => d.turno !== null);
    if (agenda.length)
      p.note(
        agenda.slice(0, 3).map((d, i) => `${negrita(String(i + 1))}  ${d.accion.toUpperCase()}  ${cian(d.codigo)}  ${d.nombre}`.slice(0, 110)).join("\n"),
        `Tu radar ya ve ${agenda.length} para postular`,
      );
    else p.log.info("Todavía nada abierto calza con tu perfil. Mañana hay más: el sync es incremental.");
  } finally {
    process.off("SIGINT", parar);
    await store.cerrar?.();
    await cuota.guardar();
  }
}

async function pasoSdk(e: Estado, cwd: string) {
  const pm = existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(cwd, "yarn.lock")) ? "yarn" : existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb")) ? "bun" : "npm";
  const s = p.spinner();
  s.start(`Instalando con ${pm}`);
  const res = await correr(pm, [pm === "npm" ? "install" : "add", "mercadopublico"], cwd);
  if (!res.ok) {
    s.error(`${pm} falló`);
    p.log.error(res.salida.split("\n").slice(-8).join("\n"));
    return;
  }
  s.stop(`mercadopublico ${verde("instalado")} en el proyecto`);
  e.hechos.push(`SDK instalado con ${pm}`);

  const env = join(cwd, ".env");
  const conTicket = existsSync(env) && /^MP_TICKET=/m.test(await readFile(env, "utf8"));
  if (e.config.ticket && !conTicket && r(await p.confirm({ message: "¿Agrego MP_TICKET al .env del proyecto?", initialValue: true }))) {
    await appendFile(env, `${existsSync(env) && !(await readFile(env, "utf8")).endsWith("\n") ? "\n" : ""}MP_TICKET=${e.config.ticket}\n`);
    const gi = join(cwd, ".gitignore");
    if (existsSync(gi) && !/^\.env$/m.test(await readFile(gi, "utf8"))) await appendFile(gi, "\n.env\n");
    e.hechos.push(`MP_TICKET en .env${existsSync(gi) ? " (y .env en .gitignore)" : ""}`);
  }
  p.note(
    [
      `import { MercadoPublico } from "mercadopublico";`,
      ``,
      `const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });`,
      `const activas = await mp.licitaciones.activas();`,
      `console.log(activas.length, "licitaciones abiertas hoy");`,
    ].join("\n"),
    "Para empezar",
  );
}

type Pieza = "ticket" | "mcp" | "radar" | "sdk";

/** El instalador interactivo. Devuelve el código de salida. */
export async function instalar(op: { home: string; env: Record<string, string | undefined>; version: string; cwd?: string }): Promise<number> {
  const cwd = op.cwd ?? process.cwd();
  const e: Estado = { home: op.home, config: await leerConfig(op.home), mcp: false, hechos: [], siguientes: [] };
  await portada(op.version);
  p.intro(negrita(" Vamos a dejar todo listo "));
  try {
    const hayProyecto = existsSync(join(cwd, "package.json"));
    const piezas = r(
      await p.multiselect<Pieza>({
        message: "¿Qué quieres instalar?",
        options: [
          { value: "ticket", label: "Mi ticket de la API", hint: "lo prueba y lo guarda para la CLI y el MCP" },
          { value: "mcp", label: "MCP para mis agentes", hint: "Claude, Codex, Cursor" },
          { value: "radar", label: "Radar de oportunidades", hint: "tu perfil y un primer sync" },
          ...(hayProyecto ? [{ value: "sdk" as const, label: "SDK en este proyecto", hint: "npm i mercadopublico" }] : []),
        ],
        initialValues: ["ticket", "mcp", ...(hayProyecto ? (["sdk"] as const) : [])],
        required: true,
      }),
    );
    if (piezas.includes("ticket")) await pasoTicket(e, op.env);
    if (piezas.includes("mcp")) await pasoMcp(e, op.env);
    if (piezas.includes("radar")) await pasoRadar(e);
    // Antes del SDK: si el sync o un cliente fallan a mitad, lo elegido igual queda guardado.
    if (e.config.ticket || e.config.perfil || e.config.store) await guardarConfig(e.home, e.config);
    if (piezas.includes("sdk")) await pasoSdk(e, cwd);
  } catch (err) {
    if (err instanceof Cancelado) {
      if (e.config.ticket || e.config.perfil) await guardarConfig(e.home, e.config);
      p.cancel("Cancelado. Lo que ya quedó hecho, quedó hecho.");
      return 130;
    }
    throw err;
  }

  // Las apps de escritorio no ven MP_TICKET de la terminal: el MCP lo lee de config.json.
  if (e.mcp && !e.config.ticket) e.siguientes.unshift(`El MCP necesita tu ticket: ${cian("npx mercadopublico init")} y elige "Mi ticket"`);
  if (e.hechos.length) p.note(e.hechos.map((h) => `${verde("✓")} ${h}`).join("\n"), "Listo");
  const pruebas = [
    ...(e.mcp ? [`${tenue("Pregúntale a tu agente:")} «busca licitaciones de guantes que cierren esta semana»`] : []),
    ...(e.config.perfil ? [`${tenue("Tu radar:")} ${cian("npx mercadopublico radar")}  ${tenue("o pídeselo a tu agente")}`] : []),
    `${tenue("En la terminal:")} ${cian("npx mercadopublico licitaciones")}`,
  ];
  p.note([...e.siguientes.map((x) => `→ ${x}`), ...pruebas].join("\n"), "Ahora");
  p.outro(`${verde("(·>·)")} kero kero`);
  return 0;
}
