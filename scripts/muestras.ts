// Corpus de muestras reales anonimizadas (test/fixtures/muestras): listados de días pasados → códigos elegidos para
// cubrir tipos, estados y monedas → detalles. Autocontenido (solo fetch), como scripts/contrato.ts:
//   node --experimental-strip-types scripts/muestras.ts
// Las respuestas crudas (con datos personales) se guardan FUERA del repo, en $MUESTRAS_CACHE (por defecto
// <tmpdir>/mercadopublico-muestras), para regenerar el corpus sin gastar cuota. Ahí también puede ir `ocultar.txt`:
// un texto literal por línea que se reemplaza por "[oculto]" (nombres sueltos que las reglas no detectan).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const V1 = "https://api.mercadopublico.cl/servicios/v1/publico";
const V2 = "https://api2.mercadopublico.cl/v2";
const PAUSA_MS = 2000;
const TOPE = 120; // consultas HTTP en total, sumando todas las corridas (se lleva en el caché)
const N_LIC = 28;
const N_OC = 18;
const EXTRA_MONEDA = 10;

const CACHE = process.env.MUESTRAS_CACHE ?? join(tmpdir(), "mercadopublico-muestras");
const SALIDA = new URL("../test/fixtures/muestras/", import.meta.url);
mkdirSync(CACHE, { recursive: true });

const archivoCuenta = join(CACHE, "consultas.json");
let consultas: number = existsSync(archivoCuenta) ? JSON.parse(readFileSync(archivoCuenta, "utf8")) : 0;
let nuevas = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ultima = 0;

type Resp = { status: number; cuerpo: any };

/** GET con caché en disco. El ticket nunca entra a la clave del caché ni a los mensajes. */
async function pedir(api: "v1" | "v2", ruta: string, ticket: string, intentos = 3): Promise<Resp> {
  const clave = join(CACHE, `${api}_${ruta.replace(/[^\w.-]+/g, "_")}.json`);
  if (existsSync(clave)) return JSON.parse(readFileSync(clave, "utf8"));
  let r: Resp = { status: 0, cuerpo: null };
  for (let i = 0; i < intentos; i++) {
    if (consultas >= TOPE) return { status: 0, cuerpo: { error: `tope de ${TOPE} consultas alcanzado` } }; // sin caché
    const espera = ultima + PAUSA_MS * (i + 1) - Date.now();
    if (espera > 0) await dormir(espera);
    consultas++;
    nuevas++;
    writeFileSync(archivoCuenta, String(consultas));
    ultima = Date.now();
    const url = api === "v1" ? `${V1}/${ruta}${ruta.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}` : `${V2}/${ruta}`;
    try {
      const res = await fetch(url, { headers: api === "v2" ? { ticket, accept: "application/json" } : { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      const texto = await res.text();
      let cuerpo: any;
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        cuerpo = { noJson: texto.slice(0, 200) };
      }
      r = { status: res.status, cuerpo };
    } catch (e) {
      r = { status: 0, cuerpo: { error: (e as Error).name } };
    }
    const ok = r.status === 200 && (api === "v1" ? "Listado" in r.cuerpo : r.cuerpo?.success === "OK");
    if (ok) break;
    console.error(`  ${api} ${ruta.split("?")[0]} intento ${i + 1}: HTTP ${r.status} ${JSON.stringify(r.cuerpo?.Mensaje ?? r.cuerpo?.errors ?? r.cuerpo?.mensaje ?? "").slice(0, 160)}`);
    const reintentable = r.status === 429 || r.status === 0 || String(r.cuerpo?.Codigo ?? "").startsWith("105");
    if (!reintentable) break;
  }
  // Se cachea también el fallo final: volver a correr no reintenta (borrar el archivo para eso).
  writeFileSync(clave, JSON.stringify(r));
  return r;
}

// ---------- anonimización (mismas reglas que scripts/contrato.ts, más texto libre y proveedores persona natural) ----------

const PERSONALES = new Set(["RutUsuario", "CodigoUsuario", "NombreUsuario", "CargoUsuario", "NombreResponsablePago", "EmailResponsablePago", "NombreResponsableContrato", "EmailResponsableContrato", "FonoResponsableContrato", "NombreContacto", "CargoContacto", "FonoContacto", "MailContacto", "contactPoint", "rut_proveedor", "razon_social"]);
const CORREO = /[\w.+-]+\s?@\s?[\w-]+(\.[\w-]+)+/g; // a veces con espacio: "CASILLA X @DOMINIO.COM"
// Más estricto que src/personales.ts: el lookbehind va antes del +56 (si no, "+569 9558 1570" se escapa) y no corta
// tokens alfanuméricos (el qs de UrlActa).
const FONO = /(?<![\w/+=-])(\+?56[\s-]?)?[29](?:[\s-]?\d){8}(?![\w-])/g;
// Números tras "fono", "teléfono", "cel.", "anexo"… aunque no tengan 9 dígitos (fijos antiguos, anexos).
const FONO_ROTULO = /\b(fonos?|tel[eé]fonos?|tel[fs]?\.?|cel(?:ular)?\.?|m[oó]vil|whats?app|anexos?)(\s*[:.\-]?\s*)\+?\(?\d[\d\s().-]{3,}\d/gi;
// Nombres tras rótulos de contacto: "CONTACTO: Juan Pérez", "Sra. María", "a cargo de don Luis…". Tapa hasta 4 palabras capitalizadas.
const PALABRA = "[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü'.]+";
const ci = (s: string) => s.replace(/\p{Ll}/gu, (c) => `[${c}${c.toUpperCase()}]`);
const ROTULOS = ["contacto", "contactar con", "contactar a", "contactarse con", "consultas con", "consultas a", "sr.", "sra.", "srta.", "sr", "sra", "srta", "señor", "señora", "don", "doña", "coordinar retiro", "coordinar con", "pac.", "paciente", "encargado", "encargada", "a cargo de", "referente técnico", "referente tecnico", "referente", "coordinador", "coordinadora", "solicitante", "nombre", "funcionario", "funcionaria", "jefe", "jefa", "director", "directora"];
const NOMBRE_ROTULO = new RegExp(
  `(?<![\\p{L}])(${ROTULOS.map((r) => ci(r).replace(/\./g, "\\.").replace(/ /g, "\\s+")).join("|")})(?!\\p{L})(\\s*[:\\-]?\\s*)((?:${PALABRA})(?:\\s+(?:de\\s+(?:la\\s+|los\\s+)?)?${PALABRA}){0,3})`,
  "gu",
);
// "CONTACTO BODEGA: Juan Pérez", "Contacto técnico - María Soto": nombre tras el rótulo del contacto.
const CONTACTO_DOS_PUNTOS = new RegExp(`(${ci("contacto")}[^:\\n]{0,40}[:\\-]\\s*)((?:${PALABRA})(?:\\s+${PALABRA}){1,3})`, "gu");
// Firmas en mayúscula con inicial: "LUIS ARAYA C.".
const FIRMA = /(?<![\p{L}])[A-ZÁÉÍÓÚÑ]{3,} [A-ZÁÉÍÓÚÑ]{3,} [A-ZÁÉÍÓÚÑ]\.(?=\s|$)/gu;
// Si la "persona" empieza con una de estas palabras no es un nombre y no se tapa.
const NO_NOMBRE = /^(BODEGA|UNIDAD|DEPARTAMENTO|DEPTO|SECCI[OÓ]N|OFICINA|ADQUISICIONES|ABASTECIMIENTO|COMPRAS|FINANZAS|SERVICIO|HOSPITAL|MUNICIPALIDAD|DIRECCI[OÓ]N|SUBDIRECCI[OÓ]N|ADMINISTRACI[OÓ]N|PROVEEDOR|T[EÉ]CNICO|ADMINISTRATIVO|REGIONAL|NACIONAL|GENERAL|EJECUTIVO|ALCALDE|DEL|DE|LA|EL|LOS|LAS|CON|PARA|POR|EN|Y|SU|SUS|AL)\b/i;

const extra = existsSync(join(CACHE, "ocultar.txt"))
  ? readFileSync(join(CACHE, "ocultar.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length)
  : [];

function taparTexto(s: string): string {
  for (const e of extra) s = s.split(e).join("[oculto]");
  return s
    .replace(CORREO, "[oculto]")
    .replace(FONO, "[oculto]")
    .replace(FONO_ROTULO, (_m, rot: string, sep: string) => `${rot}${sep}[oculto]`)
    .replace(FIRMA, "[oculto]")
    .replace(CONTACTO_DOS_PUNTOS, (m, rot: string, nombre: string) => (NO_NOMBRE.test(nombre) ? m : `${rot}[oculto]`))
    .replace(NOMBRE_ROTULO, (m, rot: string, sep: string, nombre: string) => (NO_NOMBRE.test(nombre) ? m : `${rot}${sep}[oculto]`));
}

/** RUT de persona natural: bajo 50.000.000 (las empresas parten en 50 millones o más). */
function rutPersona(x: unknown): boolean {
  const n = Number(String(x ?? "").replace(/[.\s]/g, "").split("-")[0]);
  return Number.isFinite(n) && n > 0 && n < 50_000_000;
}

function anonimizar(x: unknown, padre?: Record<string, unknown>): unknown {
  if (typeof x === "string") return taparTexto(x);
  if (Array.isArray(x)) return x.slice(0, 20).map((v) => anonimizar(v));
  if (x === null || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  // Proveedor persona natural (OC Proveedor, adjudicación de ítem): se tapan nombre, RUT y dirección.
  const persona = rutPersona(o.RutSucursal ?? o.RutProveedor);
  const deProveedor = new Set(["Nombre", "NombreSucursal", "RutSucursal", "RutProveedor", "NombreProveedor", "Direccion", "Codigo", "CodigoSucursal"]);
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, (PERSONALES.has(k) || (persona && deProveedor.has(k))) && v !== null && v !== "" ? "[oculto]" : anonimizar(v, o)]),
  );
}

// ---------- selección ----------

const tipoDe = (codigo: string) => /^\d+-\d+-([A-Z]+\d?)\d{2}$/.exec(codigo)?.[1] ?? "?";

/** Diasde semana hacia atrás desde hace `desde` días (hora de Santiago), uno sí y uno no. */
function dias(n: number, desde = 2): string[] {
  const out: string[] = [];
  for (let d = desde; out.length < n && d < 30; d++) {
    const f = new Date(Date.now() - d * 864e5);
    const [a, m, dd] = f.toLocaleDateString("en-CA", { timeZone: "America/Santiago" }).split("-");
    const sem = new Date(`${a}-${m}-${dd}T12:00:00Z`).getUTCDay();
    if (sem === 0 || sem === 6) continue;
    out.push(`${dd}${m}${a}`);
    d++; // uno sí, uno no
  }
  return out;
}

type Cand = { codigo: string; tipo: string; estado: string };

/** Greedy: cada elección maximiza cobertura nueva (tipo y estado valen más que la combinación). */
function elegir(cands: Cand[], n: number, ya: Set<string>): Cand[] {
  const tipos = new Set<string>(), estados = new Set<string>(), combos = new Set<string>();
  const out: Cand[] = [];
  const resto = cands.filter((c) => !ya.has(c.codigo));
  while (out.length < n && resto.length) {
    let mejor = 0, puntaje = -1;
    resto.forEach((c, i) => {
      const p = (tipos.has(c.tipo) ? 0 : 3) + (estados.has(c.estado) ? 0 : 3) + (combos.has(`${c.tipo}|${c.estado}`) ? 0 : 1);
      if (p > puntaje) [mejor, puntaje] = [i, p];
    });
    const c = resto.splice(mejor, 1)[0]!;
    tipos.add(c.tipo), estados.add(c.estado), combos.add(`${c.tipo}|${c.estado}`);
    out.push(c);
  }
  return out;
}

// ---------- main ----------

try {
  process.loadEnvFile();
} catch {}
const ticket = process.env.MP_TICKET;
if (!ticket) {
  console.error("Falta MP_TICKET");
  process.exit(2);
}
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
const marca = `grabado de la API real el ${hoy}`;

function guardar(rel: string, cuerpo: unknown) {
  const url = new URL(rel, SALIDA);
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, `${JSON.stringify({ _fixture: marca, ...(anonimizar(cuerpo) as object) }, null, 2)}\n`);
}

const indice: Record<string, unknown>[] = [];
const notas: string[] = [];

// --solo-v2: no vuelve a pedir la v1 y suma las muestras de Compra Ágil al índice que ya existe.
const SOLO_V2 = process.argv.includes("--solo-v2");
let base = 0;
if (SOLO_V2) {
  const previo = JSON.parse(readFileSync(new URL("indice.json", SALIDA), "utf8"));
  indice.push(...previo.muestras.filter((m: any) => !String(m.archivo).startsWith("v2/")));
  notas.push(...previo.notas.filter((n: string) => !n.startsWith("v2")));
  base = previo.consultas; // solo para el índice: el tope cuenta lo de este caché
} else {
// Licitaciones
const lics = new Map<string, Cand>();
for (const f of dias(5)) {
  const r = await pedir("v1", `licitaciones.json?fecha=${f}`, ticket);
  for (const x of r.cuerpo?.Listado ?? []) lics.set(x.CodigoExterno, { codigo: x.CodigoExterno, tipo: tipoDe(x.CodigoExterno), estado: String(x.CodigoEstado) });
  console.error(`licitaciones ${f}: ${r.cuerpo?.Listado?.length ?? `HTTP ${r.status}`}`);
}
// Revocadas y suspendidas casi no aparecen en un día cualquiera: se piden por estado.
for (const e of ["revocada", "suspendida", "desierta"]) {
  const r = await pedir("v1", `licitaciones.json?fecha=${dias(1, 3)[0]}&estado=${e}`, ticket);
  for (const x of r.cuerpo?.Listado ?? []) if (!lics.has(x.CodigoExterno)) lics.set(x.CodigoExterno, { codigo: x.CodigoExterno, tipo: tipoDe(x.CodigoExterno), estado: String(x.CodigoEstado) });
  console.error(`licitaciones estado=${e}: ${r.cuerpo?.Listado?.length ?? `HTTP ${r.status}`}`);
}
const resumenLista = (m: Map<string, Cand>) => {
  const t: Record<string, number> = {}, e: Record<string, number> = {};
  for (const c of m.values()) (t[c.tipo] = (t[c.tipo] ?? 0) + 1), (e[c.estado] = (e[c.estado] ?? 0) + 1);
  return { tipos: t, estados: e };
};
console.error("listado licitaciones:", JSON.stringify(resumenLista(lics)));

const detalleLic = async (c: Cand) => {
  const r = await pedir("v1", `licitaciones.json?codigo=${encodeURIComponent(c.codigo)}`, ticket);
  const l = r.cuerpo?.Listado?.[0];
  if (!l) return notas.push(`licitación ${c.codigo}: sin detalle (HTTP ${r.status} ${String(r.cuerpo?.Mensaje ?? "").replace(/\s+/g, " ")})`), null;
  guardar(`v1/licitaciones/${c.codigo}.json`, r.cuerpo);
  const items = l.Items?.Listado ?? [];
  indice.push({
    archivo: `v1/licitaciones/${c.codigo}.json`,
    tipo: l.Tipo ?? c.tipo,
    estado: `${l.CodigoEstado} ${l.Estado}`,
    moneda: l.Moneda,
    items: l.Items?.Cantidad ?? items.length,
    adjudicada: !!l.Adjudicacion,
    itemsAdjudicados: items.filter((i: any) => i.Adjudicacion).length,
  });
  return l;
};
const elegidas = new Set<string>();
for (const c of elegir([...lics.values()], N_LIC, elegidas)) elegidas.add(c.codigo), await detalleLic(c);
// Monedas distintas de CLP: más probables en LP/LQ/LR/O1 (montos en UF).
const monedas = () => new Set(indice.filter((i) => String(i.archivo).includes("/licitaciones/")).map((i) => i.moneda));
const grandes = [...lics.values()].filter((c) => !elegidas.has(c.codigo) && /^(LR|LQ|LP|O1|I2|H2)$/.test(c.tipo));
for (let i = 0, n = 0; i < grandes.length && n < EXTRA_MONEDA && !(monedas().has("CLF") && monedas().has("UTM")); i++, n++) {
  elegidas.add(grandes[i]!.codigo);
  await detalleLic(grandes[i]!);
}

// Tipos raros (≤ 10 en los listados): hasta 2 de cada uno, máximo 8 consultas.
const porTipo = resumenLista(lics).tipos;
let raros = 0;
for (const t of Object.keys(porTipo).filter((t) => porTipo[t]! <= 10)) {
  const faltan = Math.max(0, 2 - [...elegidas].filter((e) => tipoDe(e) === t).length);
  for (const c of [...lics.values()].filter((c) => c.tipo === t && !elegidas.has(c.codigo)).slice(0, faltan)) {
    if (raros++ >= 8) break;
    elegidas.add(c.codigo);
    await detalleLic(c);
  }
}

// Órdenes de compra
const ocs = new Map<string, Cand>();
for (const f of dias(3, 3)) {
  const r = await pedir("v1", `ordenesdecompra.json?fecha=${f}`, ticket);
  for (const x of r.cuerpo?.Listado ?? []) ocs.set(x.Codigo, { codigo: x.Codigo, tipo: tipoDe(x.Codigo), estado: String(x.CodigoEstado) });
  console.error(`ordenes ${f}: ${r.cuerpo?.Listado?.length ?? `HTTP ${r.status}`}`);
}
console.error("listado ordenes:", JSON.stringify(resumenLista(ocs)));
for (const c of elegir([...ocs.values()], N_OC, new Set())) {
  const r = await pedir("v1", `ordenesdecompra.json?codigo=${encodeURIComponent(c.codigo)}`, ticket);
  const o = r.cuerpo?.Listado?.[0];
  if (!o) {
    notas.push(`OC ${c.codigo}: sin detalle (HTTP ${r.status})`);
    continue;
  }
  guardar(`v1/ordenes/${c.codigo}.json`, r.cuerpo);
  indice.push({ archivo: `v1/ordenes/${c.codigo}.json`, tipo: `${o.CodigoTipo} ${o.Tipo}`, estado: `${o.CodigoEstado} ${o.Estado}`, moneda: o.TipoMoneda, items: o.Items?.Cantidad ?? o.Items?.Listado?.length ?? 0, adjudicada: null });
}

}

// Compra Ágil v2: sin filtros el listado responde 500, así que se pide un listado por estado (últimos 30 días)
// y el detalle de los primeros de cada uno: los estados con proveedor elegido traen cotizaciones.
const desde = `${new Date(Date.now() - 30 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Santiago" })}T00:00:00Z`; // hora de pared, como la lee la API
// `estado=proveedor_seleccionado` devuelve 0 resultados aunque existan (2026-10-14) y `oc_emitida` da 400:
// las muestras con cotizaciones salen de códigos conocidos.
const POR_ESTADO: Record<string, number> = { publicada: 1, cerrada: 2, desierta: 1, cancelada: 1 };
const CON_COTIZACIONES = ["1057539-228-COT26"];
for (const [estado, n] of [...Object.entries(POR_ESTADO), ["", 0] as const]) {
  const lista = estado ? await pedir("v2", `compra-agil?estado=${estado}&publicado_desde=${desde}&numero_pagina=1&tamano_pagina=10`, ticket, 2) : { status: 200, cuerpo: { success: "OK", payload: { items: CON_COTIZACIONES.map((codigo) => ({ codigo })) } } };
  if (lista.cuerpo?.success !== "OK") {
    notas.push(`v2 listado ${estado}: HTTP ${lista.status} ${JSON.stringify(lista.cuerpo?.errors ?? lista.cuerpo).slice(0, 200)}`);
    continue;
  }
  const elegidos: any[] = (lista.cuerpo.payload?.items ?? []).slice(0, n || undefined);
  for (const it of elegidos) {
    const r = await pedir("v2", `compra-agil/${encodeURIComponent(it.codigo)}`, ticket, 2);
    if (r.cuerpo?.success !== "OK") {
      notas.push(`v2 ${it.codigo}: HTTP ${r.status} ${JSON.stringify(r.cuerpo?.errors ?? r.cuerpo).slice(0, 160)}`);
      continue;
    }
    const p = r.cuerpo.payload;
    guardar(`v2/${it.codigo}.json`, r.cuerpo);
    indice.push({ archivo: `v2/${it.codigo}.json`, tipo: "COT", estado: p?.estado?.codigo, moneda: p?.presupuesto?.moneda, items: p?.productos_solicitados?.length ?? 0, adjudicada: (p?.proveedores_cotizando?.length ?? 0) > 0 });
  }
}

const cobertura = (pref: string) => {
  const de = (k: string) => [...new Set(indice.filter((i) => String(i.archivo).startsWith(pref)).map((i) => String(i[k])))].sort();
  return { tipos: de("tipo"), estados: de("estado"), monedas: de("moneda") };
};
writeFileSync(new URL("indice.json", SALIDA), `${JSON.stringify({ _fixture: marca, consultas: base + consultas, cobertura: { licitaciones: cobertura("v1/licitaciones"), ordenes: cobertura("v1/ordenes"), compraAgil: cobertura("v2") }, muestras: indice.sort((a, b) => String(a.archivo).localeCompare(String(b.archivo))), notas }, null, 2)}\n`);

// Misma cuenta diaria que la CLI y scripts/contrato.ts.
try {
  const ruta = join(process.env.MERCADOPUBLICO_HOME ?? join(homedir(), ".mercadopublico"), "cuota.json");
  const previa = existsSync(ruta) ? (JSON.parse(readFileSync(ruta, "utf8")) as { dia?: string; usadas?: number }) : {};
  mkdirSync(join(ruta, ".."), { recursive: true });
  writeFileSync(ruta, JSON.stringify({ dia: hoy, usadas: (previa.dia === hoy ? (previa.usadas ?? 0) : 0) + nuevas }));
} catch {}
console.error(`${indice.length} muestras, ${nuevas} consultas nuevas (${consultas} en total). Notas: ${notas.join(" | ") || "ninguna"}`);
