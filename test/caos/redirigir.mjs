// Precarga (`node --import`) para correr la CLI compilada contra el servidor de caos sin tocar la CLI:
// - fetch: las URLs reales de la API pasan a CAOS_URL.
// - CAOS_ACELERAR=n divide por n las esperas de setTimeout (pausa de 1 s entre consultas y backoff), para que una
//   prueba de punta a punta no tarde minutos. No toca AbortSignal.timeout ni setInterval.
const base = process.env.CAOS_URL;
const real = globalThis.fetch;
globalThis.fetch = (u, init) => {
  const s = (typeof u === "string" ? u : u instanceof URL ? u.href : u.url)
    .replace("https://api.mercadopublico.cl", base)
    .replace("https://api2.mercadopublico.cl", base)
    .replace("https://mindicador.cl/api", `${base}/mindicador`)
    .replace("https://transparenciachc.blob.core.windows.net/oc-da/ParidadMoneda.csv", `${base}/paridad.csv`);
  return real(s, init);
};
const n = Number(process.env.CAOS_ACELERAR ?? 1);
if (n > 1) {
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...a) => st(f, (ms ?? 0) / n, ...a);
}
