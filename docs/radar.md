# Radar

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Contrato](contrato.md)

`mercadopublico/radar` es una capa de decisión de ejemplo sobre datos públicos: ordena oportunidades y lee rangos de precio con fórmulas explícitas, sin caja negra ni machine learning. Es una vitrina, no un producto: el criterio de cada empresa (sus pesos, rubros y márgenes) se pasa desde afuera y nunca va en este repo. Todo es determinista: mismas entradas, mismo resultado.

```ts
import { MercadoPublico } from "mercadopublico";
import { priorizar, rangoDePrecio, type Perfil } from "mercadopublico/radar";
```

Ejemplo completo en [`examples/radar.ts`](https://github.com/keroke-ro/mercadopublico/blob/main/examples/radar.ts).

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

Cada constante es un default exportado en `AJUSTES` (`neutro`, `creditoRubro`, `decadasMonto`, `diasMinimos`, `oferentesReferencia`, `estadosAbiertos`) y el perfil puede sobrescribirlo con un campo del mismo nombre:

```ts
const urgente: Perfil = { ...perfil, diasMinimos: 5, estadosAbiertos: ["publicada"] };
```

Lanza `RangeError` si un peso es negativo o no es finito, si todos son 0, si un rubro no tiene 2, 4, 6 u 8 dígitos o si `montoMin > montoMax`.

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
