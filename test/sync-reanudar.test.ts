// Cortar un sync en CUALQUIER punto y reanudarlo deja el store igual que un sync sin cortes, sin re-pedir sin fin.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MercadoPublico, storeArchivo, storeMemoria, type Store } from "../src/index.js";

/** Rompe el rename n° `en` del store en archivo: antes (no se escribió) o después (se escribió pero el proceso "muere"). */
const romper = vi.hoisted(() => ({ n: 0, en: 0, despues: false }));
vi.mock("node:fs/promises", async (original) => {
  const m = await original<typeof import("node:fs/promises")>();
  return {
    ...m,
    rename: async (a: string, b: string) => {
      if (++romper.n !== romper.en) return m.rename(a, b);
      if (romper.despues) await m.rename(a, b);
      throw new Error("corte simulado al escribir");
    },
  };
});

const HOY = "2026-06-20";
const OPCIONES = { desde: "2026-06-17", hasta: HOY } as const;

// Licitaciones y OC por día ("ddmmaaaa" → código → CodigoEstado del listado) y estado del detalle (sin entrada → 400).
const LIC: Record<string, Record<string, number>> = {
  "17062026": { L1: 5, L2: 6 },
  "18062026": { L3: 5, L1: 6, L404: 5 },
  "19062026": { L4: 8, L2: 8, L6: 5 },
  "20062026": { L5: 5 },
};
const LIC_DET: Record<string, number> = { L1: 8, L2: 6, L3: 5, L4: 8, L5: 5, L6: 7 };
const OC: Record<string, Record<string, number>> = {
  "17062026": { O1: 4, O2: 6 },
  "18062026": { O3: 4, O1: 6 },
  "19062026": { O2: 12, O4: 9 },
};
const OC_DET: Record<string, number> = { O1: 6, O2: 12, O3: 4, O4: 9 };
// Compra Ágil: código → [estado, fecha_ultimo_cambio]. La API ordena por último cambio descendente.
const CA: Record<string, [string, string]> = {
  C1: ["publicada", "2026-06-17T10:00:00Z"],
  C2: ["cerrada", "2026-06-17T15:00:00Z"],
  C3: ["oc_emitida", "2026-06-18T09:00:00Z"],
  C4: ["publicada", "2026-06-19T11:00:00Z"],
  C5: ["proveedor_seleccionado", "2026-06-19T20:00:00Z"],
};
const caItem = (codigo: string) => ({ codigo, nombre: codigo, estado: { codigo: CA[codigo]![0] }, fechas: { fecha_ultimo_cambio: CA[codigo]![1] } });

function servidor(u: URL): Response {
  const cod = /compra-agil\/(.+)$/.exec(u.pathname)?.[1];
  if (cod) return Response.json({ success: "OK", payload: caItem(decodeURIComponent(cod)) });
  if (u.pathname.endsWith("compra-agil")) {
    const desde = Date.parse(u.searchParams.get("cambio_desde")!);
    const todos = Object.keys(CA).filter((c) => Date.parse(CA[c]![1]) >= desde).sort((a, b) => Date.parse(CA[b]![1]) - Date.parse(CA[a]![1]));
    const n = Number(u.searchParams.get("numero_pagina"));
    const pagina = { numero_pagina: n, total_paginas: Math.ceil(todos.length / 2), total_resultados: todos.length };
    return Response.json({ success: "OK", payload: { items: todos.slice(2 * (n - 1), 2 * n).map(caItem), paginacion: pagina } });
  }
  const lic = u.pathname.endsWith("licitaciones.json");
  const campo = lic ? "CodigoExterno" : "Codigo";
  const codigo = u.searchParams.get("codigo");
  if (codigo) {
    const e = (lic ? LIC_DET : OC_DET)[codigo];
    if (e === undefined) return Response.json({ Codigo: 400, Mensaje: `sin detalle ${codigo}` }, { status: 400 });
    return Response.json({ Listado: [{ [campo]: codigo, Nombre: `detalle ${codigo}`, CodigoEstado: e }] });
  }
  const dia = (lic ? LIC : OC)[u.searchParams.get("fecha")!] ?? {};
  return Response.json({ Listado: Object.entries(dia).map(([c, e]) => ({ [campo]: c, Nombre: c, CodigoEstado: e })) });
}

type Corte = "fatal" | "cancelar";

/** Un "proceso": cliente nuevo; si `matarEn`, la consulta n° matarEn falla con ticket inválido o cancela el signal. */
async function correr(store: Store, matarEn?: number, corte: Corte = "fatal") {
  let n = 0;
  const ac = new AbortController();
  const mp = new MercadoPublico({
    ticket: "T",
    conversor: false,
    reintentos: 0,
    intervaloMs: 0,
    dormir: async () => {},
    ahora: () => new Date(`${HOY}T12:00:00-04:00`),
    fetch: async (url) => {
      if (++n === matarEn) {
        if (corte === "fatal") return Response.json({ Codigo: 401, Mensaje: "Ticket no válido." }, { status: 401 });
        ac.abort();
      }
      return servidor(new URL(String(url)));
    },
  });
  let terminado = false;
  try {
    const plan = await mp.sync.planificar({ ...OPCIONES, store, signal: ac.signal });
    const r = await mp.sync.ejecutar(plan, { signal: ac.signal });
    terminado = !r.detenido;
  } catch {
    // corte: lo que quedó guardado es lo que importa
  }
  return { consultas: n, terminado };
}

async function volcar(store: Store) {
  const procesos: Record<string, unknown> = {};
  for await (const p of store.todos()) procesos[p.codigo] = p;
  const cursores = Object.fromEntries(await Promise.all(["licitaciones", "ordenes", "compra_agil"].map(async (f) => [f, await store.cursor(f)])));
  return JSON.parse(JSON.stringify({ procesos, cursores })) as unknown;
}

type Abrir = () => Promise<{ store: Store; reabrir: () => Promise<Store> }>;
const memoria: Abrir = async () => {
  const store = storeMemoria();
  return { store, reabrir: async () => store };
};
const archivo: Abrir = async () => {
  const ruta = join(mkdtempSync(join(tmpdir(), "mp-reanudar-")), "mp.json");
  let store = await storeArchivo(ruta);
  return {
    store,
    // El proceso murió: se suelta el lock sin escribir nada más y se relee lo que quedó en disco.
    reabrir: async () => (await store.cerrar!(), (store = await storeArchivo(ruta))),
  };
};

async function referencia(abrir: Abrir) {
  const { store } = await abrir();
  romper.n = 0;
  const r = await correr(store);
  expect(r.terminado).toBe(true);
  return { esperado: await volcar(store), consultas: r.consultas, escrituras: romper.n };
}

/** Reanuda (plan nuevo + ejecutar) hasta terminar. Devuelve el store final y lo gastado al reanudar. */
async function reanudar(s: { reabrir: () => Promise<Store> }, maxIntentos = 5) {
  let gastadas = 0;
  for (let i = 0; i < maxIntentos; i++) {
    const store = await s.reabrir();
    const r = await correr(store);
    gastadas += r.consultas;
    if (r.terminado) return { store, gastadas, intentos: i + 1 };
  }
  throw new Error("no terminó al reanudar");
}

describe.each([
  ["memoria", memoria],
  ["archivo", archivo],
] as const)("reanudar con store en %s", (_, abrir) => {
  it.each(["fatal", "cancelar"] as const)("cortado (%s) en cada consulta k, reanudar da lo mismo que sin cortes", async (corte) => {
    const { esperado, consultas: N } = await referencia(abrir);
    expect(N).toBeGreaterThan(20);
    for (let k = 1; k <= N; k++) {
      const s = await abrir();
      const cortado = await correr(s.store, k, corte);
      expect(cortado).toMatchObject({ consultas: k, terminado: false });
      const { store, gastadas, intentos } = await reanudar(s);
      expect(intentos, `k=${k}`).toBe(1);
      expect(await volcar(store), `k=${k}`).toEqual(esperado);
      // Reanudar nunca cuesta más que un sync completo: lo ya guardado solo ahorra.
      expect(gastadas, `k=${k}`).toBeLessThanOrEqual(N);
      await store.cerrar?.();
    }
  });
});

describe("reanudar con store en archivo y cortes al escribir", () => {
  it("un corte antes o después de cada escritura, reanudar da lo mismo que sin cortes", async () => {
    const { esperado, consultas: N, escrituras } = await referencia(archivo);
    // Una escritura por lote (día o página) con datos o cursor: guardar + cursor van juntos.
    expect(escrituras).toBeLessThanOrEqual(4 + 3 + 3);
    for (const despues of [false, true]) {
      for (let j = 1; j <= escrituras; j++) {
        const s = await archivo();
        Object.assign(romper, { n: 0, en: j, despues });
        const cortado = await correr(s.store);
        romper.en = 0;
        expect(cortado.terminado, `j=${j}`).toBe(false);
        const { store, gastadas } = await reanudar(s);
        expect(await volcar(store), `j=${j} despues=${despues}`).toEqual(esperado);
        expect(gastadas).toBeLessThanOrEqual(N);
        await store.cerrar!();
      }
    }
  });

  it("muchos cortes seguidos al azar (consultas y escrituras) terminan igual y con gasto acotado", async () => {
    const { esperado, consultas: N, escrituras } = await referencia(archivo);
    let semilla = 42;
    const azar = (n: number) => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31), 1 + (semilla % n));
    for (let caso = 0; caso < 20; caso++) {
      const s = await archivo();
      let store = s.store;
      let gastadas = 0;
      let intentos = 0;
      for (let terminado = false; !terminado; intentos++) {
        expect(intentos).toBeLessThan(15);
        if (intentos) store = await s.reabrir();
        Object.assign(romper, { n: 0, en: azar(2) === 1 ? azar(escrituras + 2) : 0, despues: azar(2) === 1 });
        const r = await correr(store, intentos < 4 ? azar(N + 3) : undefined, azar(2) === 1 ? "fatal" : "cancelar");
        romper.en = 0;
        gastadas += r.consultas;
        terminado = r.terminado;
      }
      expect(await volcar(store), `caso ${caso}`).toEqual(esperado);
      expect(gastadas).toBeLessThanOrEqual(intentos * N);
      await store.cerrar!();
    }
  });
});
