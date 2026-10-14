# Radar

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Contrato](contrato.md) · [Resiliencia](resiliencia.md) · [Testing](testing.md)

`mercadopublico/radar` es la capa de decisión de KeroKero sobre los datos públicos de Mercado Público. Responde lo que se pregunta cada mañana un equipo que le vende al Estado:

| Pregunta | Función |
|---|---|
| ¿Qué postulo primero? | [`decidir`](#decidirprocesos-perfil-opciones) (y [`priorizar`](#priorizarprocesos-perfil-opciones), el puntaje que usa) |
| ¿A qué precio? | [`precioSugerido`](#preciosugeridocodigoproducto-compras-opciones) y [`rangoDePrecio`](#rangodepreciocodigoproducto-compras-opciones) |
| ¿Contra quién compito? | [`competidores`](#competidoreshistorial-filtro) y el factor `incumbente` |
| ¿Qué viene? | [`proximasCompras`](#proximascomprashistorial-opciones) |
| ¿El criterio escrito calza con lo que de verdad decidimos? | [`calibrar`](#calibrarprocesos-perfil-decisiones-opciones) |

Todo con fórmulas explícitas, sin caja negra ni machine learning: cada número trae su porqué en texto. El criterio de tu empresa (pesos, rubros, costos, vetos) se pasa desde afuera en un `Perfil` y nunca va en este repo. Todo es determinista: mismas entradas (y mismo `ahora`), mismo resultado. Son funciones puras sobre `Proceso[]`: les da lo mismo si los procesos vienen de la API, de un store o de OCDS.

```ts
import { MercadoPublico } from "mercadopublico";
import { decidir, precioSugerido, proximasCompras, calibrar, competidores, type Perfil } from "mercadopublico/radar";
```

## En la terminal

Sincroniza un store y pásale un perfil. `radar` no pide ticket ni gasta consultas: todo lo abierto del store se decide y todo lo cerrado es historial (competidores, precios, compras que se repiten).

```sh
npx mercadopublico sync --desde 2026-07-01 --fuentes compra_agil,ordenes
npx mercadopublico radar --perfil perfil.json
```

```
Radar · 2026-10-13 · 37 abiertas entre 4210 procesos de ./mp.json

5 valen la pena. En este orden:

  1  POSTULA  0.86  1057539-228-COT26  Guantes de nitrilo talla M
     Hospital del Salvador · región 13 · $3.200.000 · cierra 2026-10-15 15:00
     · El ítem 42132203 está dentro del rubro 4213 (familia).
     · Comercial Uno se llevó 1 de 6 adjudicaciones previas de estas familias en este organismo. Tú, 3.
     Cotiza: $4.180 por caja: con ese precio habrías ganado 7 de 12 compras parecidas, margen 16 %
  …

Fuera de la vista: 8 sin capacidad, 24 descartadas. Todo, con su porqué, en --formato json o csv.

Lo que viene:
  2026-11-03 … 2026-11-17  Hospital X compró de la familia 4213 5 veces, cada ~91 días (entre 85 y 99); la última, el 2026-08-04.
```

(Datos de ejemplo.) Un perfil completo está en [`examples/perfil.json`](https://github.com/keroke-ro/mercadopublico/blob/main/examples/perfil.json). Con `--decisiones decisiones.json` (un arreglo de `{ "codigo": "...", "decision": "postular" | "descartar" }`) agrega la [calibración](#calibrarprocesos-perfil-decisiones-opciones) al final. `--formato json` entrega todo sin `raw` ni datos personales; `--formato csv`, una fila por proceso.

Ejemplo en código en [`examples/radar.ts`](https://github.com/keroke-ro/mercadopublico/blob/main/examples/radar.ts).

## `priorizar(procesos, perfil, opciones?)`

```ts
const perfil: Perfil = {
  pesos: { rubro: 3, region: 1, monto: 2, diasAlCierre: 2, competencia: 1 },
  rubros: ["44"], // UNSPSC de 2, 4, 6 u 8 dígitos
  regiones: [13],
  montoMin: 200_000, // CLP
  montoMax: 5_000_000,
};

for (const o of priorizar(detalles, perfil)) {
  console.log(o.puntaje.toFixed(2), o.proceso.codigo);
  for (const f of o.factores) console.log(" ", f.nombre, f.valor, "×", f.peso, f.razon);
}
```

Devuelve `Oportunidad[]` (`{ proceso, puntaje, factores }`) ordenado por puntaje descendente; los empates mantienen el orden de entrada. Deja fuera lo que no está abierto (`estadosAbiertos`, por defecto `["publicada"]`) salvo `{ incluirCerrados: true }`. `{ ahora }` fija el reloj.

Pasa detalles, no listados: un listado no trae ítems, así que el rubro queda neutro.

### La fórmula

```
puntaje = Σ wᵢ · fᵢ        fᵢ ∈ [0, 1],  wᵢ = pesoᵢ / Σ pesos
```

Los pesos se normalizan para sumar 1, así que el puntaje queda en [0, 1]. Un peso que falta vale 0. Cada factor trae su `razon` en texto. Cuando falta el dato, o el perfil no define ese criterio, el factor vale `neutro` (0,5): ni suma ni resta.

| Factor | fᵢ |
|---|---|
| `rubro` | Máximo sobre ítems × rubros: 1 si el código UNSPSC del ítem empieza con el del rubro; si no, `creditoRubro[k]` = `[0, 0.25, 0.5, 0.75][k]`, con k = pares de dígitos iguales desde la izquierda (segmento, familia, clase). |
| `region` | 1 si la región del comprador está en `regiones`, 0 si no. |
| `monto` | 1 si `monto.clp` está en [`montoMin`, `montoMax`]. Fuera: `max(0, 1 − abs(log10(x / borde)) / decadasMonto)`, con `borde` el límite más cercano y `decadasMonto` = 1, es decir, llega a 0 a 10× del borde. |
| `diasAlCierre` | 0 si no está abierto o ya cerró; si no, `min(1, d / diasMinimos)`, con d = días al cierre y `diasMinimos` = 2. |
| `competencia` | `k / (k + n)`, con n = oferentes y `k` = `oferentesReferencia` = 3: 0 oferentes da 1 y 3 oferentes dan 0,5. En un proceso abierto, n son los que van, no los que habrá. |
| `incumbente` | Con `{ historial }`: `1 − cuota` del proveedor (que no seas tú, según `perfil.rut`) que más adjudicaciones se llevó en el mismo organismo y las mismas familias UNSPSC. Neutro sin historial o con menos de `victoriasMinimas` = 3 adjudicaciones previas. |

`{ historial }` son procesos pasados (OC, licitaciones adjudicadas, Compra Ágil con selección); puede ser el store entero, porque lo abierto no cuenta como historial.

Cada constante es un default exportado en `AJUSTES` (`neutro`, `creditoRubro`, `decadasMonto`, `diasMinimos`, `oferentesReferencia`, `victoriasMinimas`, `estadosAbiertos`, `umbralPostular`, `umbralRevisar`, `decisionesMinimas`, `mejoraMinima`, `comprasMinimas`, `irregularidadMaxima`) y el perfil puede sobrescribirlo con un campo del mismo nombre:

```ts
const urgente: Perfil = { ...perfil, diasMinimos: 5, estadosAbiertos: ["publicada"] };
```

Lanza `RangeError` si un peso es negativo o no es finito, si todos son 0, si un rubro no tiene 2, 4, 6 u 8 dígitos o si `montoMin > montoMax`.

## `decidir(procesos, perfil, opciones?)`

La lista corta: qué postular, qué revisar y qué descartar, cada uno con su porqué y en qué orden. Mismas opciones que `priorizar` (`ahora`, `historial`).

```ts
const perfil: Perfil = {
  pesos: { rubro: 3, region: 1, monto: 2, diasAlCierre: 2, competencia: 1, incumbente: 2 },
  rubros: ["4213"],
  regiones: [13],
  rut: "76.123.456-7",
  capacidad: 5, // ofertas que el equipo alcanza a preparar
  vetos: [{ factor: "diasAlCierre", minimo: 0.5 }], // menos de 1 día al cierre: ni mirarla
  excluir: ["arriendo", "instalación"],
};

for (const d of decidir(abiertas, perfil, { historial })) {
  console.log(d.turno ?? "-", d.accion, d.proceso.codigo);
  for (const p of d.porque) console.log("  ", p);
}
```

1. **Reglas duras.** Si el nombre, la descripción o un ítem menciona una palabra de `excluir` (sin tildes ni mayúsculas), o si un factor vale menos que el `minimo` de un veto, se descarta. Un veto funciona aunque el peso de ese factor sea 0.
2. **Puntaje.** Desde `umbralPostular` (0,7), postular; desde `umbralRevisar` (0,4), revisar; bajo eso, descartar.
3. **Agenda.** Las no descartadas entran por puntaje hasta llenar `capacidad` (sin `capacidad`, entran todas) y se ordenan por fecha de cierre: `turno` 1 es lo que cierra antes. Las que no caben traen `turno: null` y lo dicen en `porque`.

`porque`: para postular, los dos factores que más aportan; para revisar, el que más aporta y el que más resta ("Ojo: …"); para descartar, la regla dura o los dos que más restan. Devuelve `Decision[]` (`Oportunidad` + `accion`, `turno`, `porque`): primero la agenda, luego lo que no cupo y al final lo descartado. Lanza `RangeError` si los umbrales no cumplen `0 ≤ umbralRevisar ≤ umbralPostular ≤ 1`, si `capacidad` no es un entero ≥ 0 o si un veto no tiene un factor válido.

## `calibrar(procesos, perfil, decisiones, opciones?)`

Compara lo que el equipo postuló y descartó con el puntaje del radar, y propone pesos que calcen mejor. Propone; no cambia el perfil.

```ts
const c = calibrar(store, perfil, [
  { codigo: "1057539-228-COT26", decision: "postular" },
  { codigo: "2097-241-SE14", decision: "descartar" },
  // …
]);
if (!("insuficiente" in c)) {
  console.log(c.acuerdo, "→", c.acuerdoSugerido, c.pesosSugeridos);
  for (const x of c.cambios) console.log(x.razon); // "Sube competencia: en las que postulaste vale en promedio 0,9; en las que descartaste, 0,3."
}
```

- **Acuerdo** = AUC: fracción de pares (postulada, descartada) en que la postulada saca más puntaje; un empate cuenta 0,5. 1 es calce perfecto y 0,5 es lo mismo que al azar.
- **Búsqueda** por coordenadas, determinista: en cada paso prueba apagar, dividir por dos o duplicar cada peso (o encender uno apagado) y aplica el mejor cambio mientras mejore al menos `mejoraMinima` (0,02). Así no persigue ruido.
- `pesosSugeridos` vienen en la escala de tu perfil, listos para pegar; `cambios` trae cada peso normalizado antes y después, con la diferencia de promedios que lo justifica; `desacuerdos`, las decisiones que contradicen la acción que habría sugerido el radar.
- Con menos de `decisionesMinimas` (5) de cada tipo devuelve `{ insuficiente: true, motivo: "pocas decisiones" }`.
- Los factores se calculan con los datos de hoy, no con los del día en que se decidió: por ejemplo, los oferentes finales en vez de los que iban.

## `precioSugerido(codigoProducto, compras, opciones)`

El precio unitario que maximiza la ganancia esperada contra lo que ganó antes en Compra Ágil, dado tu costo.

```ts
const s = precioSugerido(42132203, comprasAgiles, { costo: 3500 });
if ("insuficiente" in s) console.log(s.motivo);
else console.log(s.precio, s.ganadas, "de", s.n, s.margen); // 4180 7 de 12 0,16
```

```
P(ganar | x) = precios ganadores ≥ x / n
sugerido     = argmax  P(ganar | x) · (x − costo)   sobre los precios ganadores observados
```

La curva solo cambia en los precios observados, así que basta probarlos; empate: el más barato, que gana más seguido. `curva` trae todos los puntos (`precio`, `ganadas`, `probabilidad`, `ganancia`) para graficarla. Usa la misma muestra que `rangoDePrecio` con `soloSeleccionadas` (mismo producto, misma unidad, precios netos en CLP) y el mismo `minimo`. Devuelve `insuficiente` con `"muestra insuficiente"` o con `"costo sobre los precios ganadores"` si no hay precio que deje ganancia. Supone que se gana con el precio más bajo; en Compra Ágil también pesan plazo y calidad, y la respuesta lo repite en `supuestos`.

## `competidores(historial, filtro?)`

Quién gana, cuánto y qué tan concentrado está el mercado. `filtro`: `rubros`, `organismos` (códigos), `regiones` y `rut` (para marcarte con `eresTu`).

```ts
const m = competidores(store, { rubros: ["4213"], regiones: [13], rut: "76.123.456-7" });
console.log(m.lectura, m.hhi); // "Concentrado: …" 3400
for (const c of m.competidores.slice(0, 5)) console.log(c.proveedor.nombre, c.victorias, c.tasa, c.montoGanado);
```

- Compra Ágil: participa quien cotizó y gana la cotización seleccionada. Licitaciones y OC: solo se ve a quien ganó, así que ahí participar es ganar y la `tasa` sale 1.
- Una OC que viene de un proceso que también está en los datos se anota en ese proceso, no dos veces. Lo abierto no cuenta.
- `hhi` (Herfindahl–Hirschman) = Σ (cuota de victorias × 100)², de 0 a 10.000: bajo 1.500 competido, sobre 2.500 concentrado.
- Los proveedores se identifican por RUT normalizado (solo dígitos y K); sin RUT, por código o nombre.

## `proximasCompras(historial, opciones?)`

Compras que se repiten, para preparar la oferta antes de que se publique.

```ts
for (const x of proximasCompras(store, { rubros: ["4213"] })) console.log(x.desde, x.hasta, x.razon);
// 2026-11-03 2026-11-17 Hospital X compró de la familia 4213 5 veces, cada ~91 días (entre 85 y 99); la última, el 2026-08-04.
```

Por organismo y familia UNSPSC (4 dígitos), junta los días distintos en que se publicó algo (`fechas.publicacion`, o `creacion` si falta). Con al menos `comprasMinimas` (3) días y una regularidad de `(intervalo máximo − mínimo) ≤ irregularidadMaxima × mediana`, la próxima debería salir entre `última + intervalo mínimo` y `última + intervalo máximo`. Solo devuelve las ventanas que todavía no terminan, ordenadas por inicio. Una OC que viene de otro proceso de los datos no se cuenta aparte. Para tener historial sin gastar cuota, usa [OCDS](ocds.md).

## `rangoDePrecio(codigoProducto, compras, opciones?)`

p25, p50 y p75 del precio unitario en CLP que se cotizó para un producto en el detalle de Compra Ágil (`productos_cotizados[].precio_unitario`).

```ts
const r = rangoDePrecio(44121618, detallesCompraAgil, { soloSeleccionadas: true });
if ("insuficiente" in r) console.log(r.motivo, r.n); // "muestra insuficiente"
else console.log(r.p25, r.p50, r.p75, r.unidad, r.n);
for (const s of r.supuestos) console.log("-", s);
```

| Opción | Por defecto | |
|---|---|---|
| `soloSeleccionadas` | `false` | Solo cotizaciones seleccionadas: estima cuánto suele ganar, no cuánto se cotiza. |
| `unidad` | la más frecuente | Unidad de `productos_solicitados` con la que comparar. |
| `minimo` | `10` (`MUESTRA_MINIMA`) | Con menos precios no inventa un rango: devuelve `{ insuficiente: true, motivo: "muestra insuficiente", n }`. |

Percentiles por interpolación lineal (Hyndman–Fan tipo 7, el de R y `PERCENTIL.INC` de Excel): con los precios ordenados, `h = (n − 1)·p` y `x⌊h⌋ + (h − ⌊h⌋)·(x⌊h⌋₊₁ − x⌊h⌋)`.

Supuestos, que la respuesta repite en `supuestos`:

- Los precios unitarios se toman como netos (sin IVA ni despacho).
- La muestra solo incluye a quienes cotizaron: no es el precio de mercado.
- Montos en CLP al día del documento; se omiten los que no se pudieron convertir.
- Mismo producto y misma unidad. La cotización no trae unidad, así que se usa la de `productos_solicitados` de la misma compra; si hay varias, se usa la más frecuente y se avisa.
- Cuando la API no informa qué cotización se seleccionó, solo se infiere si hubo una única cotización.
