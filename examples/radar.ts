// Radar de ejemplo: Compra Ágil publicadas en una región → cola priorizada y rango de precio.
// Uso: MP_TICKET=... npx tsx examples/radar.ts   (gasta 1 consulta por página + 1 por detalle)
import { MercadoPublico, type CompraAgil } from "../src/index.js";
import { priorizar, rangoDePrecio, type Perfil } from "../src/radar/index.js";

const ticket = process.env.MP_TICKET;
if (!ticket) throw new Error("Falta MP_TICKET");
const mp = new MercadoPublico({ ticket });

// Un perfil inventado. El de un cliente real nunca va al repo.
const perfil: Perfil = {
  pesos: { rubro: 3, region: 1, monto: 2, diasAlCierre: 2, competencia: 1 },
  rubros: ["44"], // UNSPSC 44: equipos y suministros de oficina
  regiones: [13],
  montoMin: 200_000,
  montoMax: 5_000_000,
};

// Solo la primera página (1 consulta) y el detalle de unas pocas, que es el que trae ítems y cotizaciones.
const { items } = await mp.compraAgil.pagina({ region: [13], estado: ["publicada"], q: "papel" }, 1);
const detalles: CompraAgil[] = [];
for (const ca of items.slice(0, 5)) {
  const d = await mp.compraAgil.detalle(ca.codigo);
  if (d) detalles.push(d);
}

for (const o of priorizar(detalles, perfil)) {
  console.log(`\n${o.puntaje.toFixed(2)}  ${o.proceso.codigo}  ${o.proceso.nombre}`);
  for (const f of o.factores) console.log(`  ${f.nombre.padEnd(12)} ${f.valor.toFixed(2)} × ${f.peso.toFixed(2)}  ${f.razon}`);
}

// Precios de lo que ya cerró: cotizaciones de compras con proveedor elegido.
const cerradas: CompraAgil[] = [];
const pasadas = await mp.compraAgil.pagina({ region: [13], estado: ["proveedor_seleccionado", "oc_emitida"], q: "papel" }, 1);
for (const ca of pasadas.items.slice(0, 10)) {
  const d = await mp.compraAgil.detalle(ca.codigo);
  if (d) cerradas.push(d);
}
const codigo = cerradas.flatMap((c) => c.items).find((i) => i.codigoProducto !== null)?.codigoProducto;
if (codigo) {
  const r = rangoDePrecio(codigo, cerradas, { minimo: 5 });
  console.log(`\nPrecio unitario de ${codigo}:`, "insuficiente" in r ? `${r.motivo} (n = ${r.n})` : `p25 ${r.p25} · p50 ${r.p50} · p75 ${r.p75} CLP por ${r.unidad} (n = ${r.n})`);
  for (const s of r.supuestos) console.log(`  - ${s}`);
}
console.log("\nCuota:", mp.cuota.toJSON());
