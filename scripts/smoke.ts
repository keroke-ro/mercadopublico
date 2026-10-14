// Smoke semanal contra la API real usando el paquete YA CONSTRUIDO (dist/), de punta a punta:
//   npm run build && MP_TICKET=… node --experimental-strip-types scripts/smoke.ts
// Presupuesto: ≤ 30 consultas (limiteDiario las corta). Imprime un resumen markdown. Sale con 1 solo si algo
// se rompió de verdad; la v2 caída, la red o los reintentos agotados quedan como "degradado".
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRESUPUESTO = 30;

// Import computado: el tipo viene de src (typecheck sin build), el código de dist.
type Sdk = typeof import("../src/index.js");
const sdk: Sdk = await import(new URL("../dist/index.js", import.meta.url).href);
const { MercadoPublico, MercadoPublicoError, conversorPorDefecto, diaSantiago, storeArchivo } = sdk;

try {
  process.loadEnvFile(); // .env local; en CI viene del secreto
} catch {}
const ticket = process.env.MP_TICKET;
if (!ticket) {
  console.log("Sin MP_TICKET: se salta el smoke.");
  process.exit(0);
}

type Estado = "ok" | "aviso" | "degradado" | "falla";
const filas: { paso: string; estado: Estado; nota: string; consultas: number }[] = [];
const mp = new MercadoPublico({ ticket, limiteDiario: PRESUPUESTO });

/** Errores que no son culpa del SDK: la API o la red fallando, o la cuota gastada por otro lado. */
const degradacion = (e: unknown) =>
  e instanceof MercadoPublicoError && (e.reintentable || ["circuito_abierto", "cuota_agotada"].includes(e.tipo));

async function paso(nombre: string, f: () => Promise<string | { aviso: string }>) {
  const antes = mp.cuota.usadas;
  let estado: Estado = "ok";
  let nota: string;
  try {
    const r = await f();
    if (typeof r === "string") nota = r;
    else ((estado = "aviso"), (nota = r.aviso));
  } catch (e) {
    estado = degradacion(e) ? "degradado" : "falla";
    nota = e instanceof MercadoPublicoError ? `${e.tipo}: ${e.message}` : String((e as Error)?.stack ?? e);
  }
  filas.push({ paso: nombre, estado, nota: nota.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|"), consultas: mp.cuota.usadas - antes });
}

function afirmar(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

const DIA = 86_400_000;
const hoy = new Date();
const ayer = diaSantiago(new Date(hoy.getTime() - DIA));
// Último domingo (ayer o antes): pocas OC, sync barato.
const domingo = diaSantiago(new Date(hoy.getTime() - (((hoy.getUTCDay() + 6) % 7) + 1) * DIA));
// Un día hábil de la semana pasada (el dólar no se publica en fin de semana).
let t = hoy.getTime() - 7 * DIA;
while ([0, 6].includes(new Date(t).getUTCDay())) t -= DIA;
const habil = diaSantiago(new Date(t));

await paso("v1 licitaciones activas + 2 detalles", async () => {
  const activas = await mp.licitaciones.activas();
  afirmar(activas.length > 0, "el listado de activas vino vacío");
  for (const l of activas.slice(0, 2)) {
    const d = await mp.licitaciones.porCodigo(l.codigo);
    afirmar(d?.tipo === "licitacion" && d.codigo === l.codigo, `detalle de ${l.codigo} vacío o distinto`);
    afirmar(d.nombre && d.fechas, `detalle de ${l.codigo} sin nombre o fechas`);
  }
  return `${activas.length} activas`;
});

await paso(`v1 órdenes de ${ayer} + 1 detalle`, async () => {
  const ocs = await mp.ordenes.delDia(ayer);
  if (!ocs.length) return { aviso: "el listado de ayer vino vacío" };
  const d = await mp.ordenes.porCodigo(ocs[0]!.codigo);
  afirmar(d?.tipo === "orden_compra" && d.codigo === ocs[0]!.codigo, `detalle de ${ocs[0]!.codigo} vacío o distinto`);
  return `${ocs.length} OC; ${d.codigo} ${d.estado}${d.monto ? `, ${d.monto.moneda} ${d.monto.valor}` : ""}`;
});

await paso("v2 Compra Ágil página 1", async () => {
  const p = await mp.compraAgil.pagina({}, 1);
  afirmar(p.items.length > 0 && p.items.every((c) => c.tipo === "compra_agil"), "página 1 vacía o con otro tipo");
  return `${p.totalResultados} resultados en ${p.totalPaginas} páginas`;
});

await paso(`sync de órdenes del ${domingo} (sin detalle) a storeArchivo`, async () => {
  const store = await storeArchivo(join(mkdtempSync(join(tmpdir(), "mp-smoke-")), "store.json"));
  const plan = await mp.sync.planificar({ desde: domingo, hasta: domingo, fuentes: ["ordenes"], detalle: false, store });
  const r = await mp.sync.ejecutar(plan);
  let guardados = 0;
  for await (const _ of store.todos()) guardados++;
  afirmar(guardados === r.nuevos + r.actualizados, `guardó ${guardados} pero informó ${r.nuevos + r.actualizados}`);
  afirmar((await store.cursor("ordenes")) === domingo, "el cursor no avanzó");
  if (r.errores.length) return { aviso: `${r.errores.length} errores: ${r.errores[0]!.error}` };
  return `${r.nuevos} nuevos, ${r.consultas} consultas`;
});

await paso(`conversorPorDefecto UF y USD del ${habil}`, async () => {
  const notas: string[] = [];
  for (const m of ["CLF", "USD"] as const) {
    const p = await conversorPorDefecto(m, habil);
    afirmar(p && p.valor > 0, `sin paridad ${m}`);
    afirmar(m !== "CLF" || (p.valor > 20_000 && p.valor < 100_000), `UF fuera de rango: ${p.valor}`);
    notas.push(`${m} ${p.valor} (${p.fuente}, ${p.fechaValor})`);
  }
  return notas.join("; ");
});

const usadas = mp.cuota.usadas;
const fallas = filas.filter((f) => f.estado === "falla").length;
console.log(
  [
    "# Smoke semanal de mercadopublico",
    "",
    `Fecha: ${new Date().toISOString()} · ${usadas}/${PRESUPUESTO} consultas`,
    "",
    "| Paso | Estado | Consultas | Nota |",
    "| --- | --- | --- | --- |",
    ...filas.map((f) => `| ${f.paso} | ${f.estado} | ${f.consultas} | ${f.nota} |`),
    "",
    fallas ? `**${fallas} paso(s) con falla.**` : "Sin fallas.",
  ].join("\n"),
);
process.exitCode = fallas ? 1 : 0;
