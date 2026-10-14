# Modelo

[Inicio](index.md) · [Guía](guia.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md)

v1, v2 y OCDS se traducen a un solo tipo, `Proceso`. Tu código mira `tipo` y no le importa de qué API vino el dato (eso queda en `origen`).

```ts
import type { Proceso } from "mercadopublico";

function resumen(p: Proceso): string {
  switch (p.tipo) {
    case "licitacion":
      return `${p.codigo} ${p.tipoLicitacion ?? "?"} ${p.estado}, ${p.oferentes ?? "?"} oferentes`;
    case "orden_compra":
      return `${p.codigo} a ${p.proveedor?.nombre ?? "?"}, origen ${p.procesoOrigen ?? "directo"}`;
    case "compra_agil":
      return `${p.codigo} ${p.cotizaciones.length} cotizaciones, OC ${p.ordenCompra ?? "sin OC"}`;
  }
}
```

## Campos comunes

| Campo | Qué es |
|---|---|
| `tipo` | `"licitacion"`, `"orden_compra"` o `"compra_agil"` |
| `codigo`, `nombre`, `descripcion` | |
| `estado` | Slug en snake_case: `publicada`, `adjudicada`, `enviada_proveedor`, `proveedor_seleccionado`… Si el código no está en las tablas, el slug de la glosa que trajo la API, o `"desconocido"`. |
| `estadoGlosa` | Glosa oficial del estado |
| `comprador` | `{ codigoOrganismo, nombreOrganismo, rutUnidad, codigoUnidad, nombreUnidad, region, comuna }`; `region` es el código 1 a 16 |
| `fechas` | `{ creacion, publicacion, cierre, adjudicacion, ultimoCambio }`, ISO con offset de Santiago |
| `monto` | `Monto`: estimado (licitación), total (OC) o presupuesto (Compra Ágil) |
| `items` | `{ codigoProducto (UNSPSC), nombre, descripcion, cantidad, unidad, precioUnitario, total, proveedor }[]` |
| `oferentes` | Ofertas o cotizaciones recibidas, si se sabe |
| `personales` | Datos personales de funcionarios tal como vinieron, o `null`. Ver `ocultarPersonales`. |
| `origen` | `"v1"`, `"v2"` u `"ocds"` |
| `raw` | La respuesta original sin tocar, con los campos que el parser no conoce |

Propios de cada tipo:

- `Licitacion`: `tipoLicitacion` (L1, LE, LP, LQ, LR…) y `tipoLicitacionGlosa`.
- `OrdenCompra`: `tipoOrden`, `proveedor` y `procesoOrigen` (la licitación o Compra Ágil que la originó).
- `CompraAgil`: `ordenCompra` y `cotizaciones` (`{ proveedor, monto, seleccionada, productos }[]`).

Los parsers no lanzan: un campo vacío o con otro tipo queda en `null` y lo desconocido sigue en `raw`.

## De dónde sale cada campo

| | Licitación v1 | OC v1 | Compra Ágil v2 | OCDS |
|---|---|---|---|---|
| `monto` | `MontoEstimado` + `Moneda` | `Total` + `TipoMoneda` | `monto_disponible` o `presupuesto_estimado` | `tender.value`; en una OC, `awards[0].value.amountGross` |
| `fechas.publicacion` | `FechaPublicacion` | `FechaEnvio` | `fecha_publicacion` | `tender.tenderPeriod.startDate` |
| `fechas.cierre` | `FechaCierre` | — | `fecha_cierre` | `tender.tenderPeriod.endDate` |
| `fechas.ultimoCambio` | — | `FechaUltimaModificacion` | `fecha_ultimo_cambio` | `date` de la release |
| `oferentes` | `Adjudicacion.NumeroOferentes` | — | `resumen.total_ofertas_recibidas` | `tender.numberOfTenderers` |
| `items[].total` | `MontoUnitario × CantidadAdjudicada` (calculado) | `Total` del ítem | — | neto del award |
| `personales` | `RutUsuario`, `NombreUsuario`, `EmailResponsablePago`… | ídem | siempre `null` | `parties[].contactPoint`, nombres de persona en `suppliers[].name` |

- En OCDS, una release es OC si el código termina en TD o CM, o si el award dice "Orden de Compra". Compra Ágil no se publica en OCDS.
- En Compra Ágil, `cotizaciones[].monto` es `monto_total` (con impuesto y despacho); el neto queda en `raw`. `seleccionada` sale de `seleccion.proveedor_seleccionado` y, si no viene, solo se infiere cuando hubo una única cotización en una compra con proveedor elegido.

## Fechas

Todas en ISO 8601 con el offset de America/Santiago vigente en ese instante, con horario de verano incluido:

```ts
lic.fechas.cierre; // "2026-10-20T15:00:00-03:00"
lic.fechas.publicacion; // "2026-06-15T10:00:00-04:00"
```

La v1 entrega hora de Santiago sin offset y el SDK le pone el que corresponde. Las fechas OCDS traen `Z`, pero se leen como hora de Santiago (ver [OCDS](ocds.md#fechas)). Para tus propias fechas:

```ts
import { isoSantiago, diaSantiago, normalizarFecha } from "mercadopublico";

isoSantiago(new Date()); // "2026-10-13T21:30:00-03:00"
diaSantiago(); // "2026-10-13"
normalizarFecha("2026-10-01T15:00:00"); // "2026-10-01T15:00:00-03:00"
```

## Montos

```ts
interface Monto {
  valor: number; // en la moneda original
  moneda: "CLP" | "CLF" | "UTM" | "USD" | "EUR"; // CLF = UF
  clp: number | null; // en pesos al día fechaValor; null si no se pudo convertir
  fechaValor: string | null; // "AAAA-MM-DD" del valor de UF/UTM/dólar/euro usado
  fuente: string | null; // "mindicador.cl", "chilecompra:ParidadMoneda (mensual)", "identidad" para CLP
}
```

La conversión usa el valor del día del documento (publicación o, si no hay, creación), nunca el de hoy. Una licitación de 1.200 UF publicada el 1 de octubre se compara con su UF del 1 de octubre. Si no hay valor ese día, `fechaValor` dice cuál se usó (el dólar del viernes para un sábado, el primero del mes en la paridad mensual).

Qué se convierte solo:

- `porCodigo` de licitaciones y OC, y `compraAgil.detalle`: sí, con el conversor del cliente.
- Listados (`activas`, `delDia`, `compraAgil.listar`…) y `leerOcds`: no. Los montos en CLP ya traen `clp`; los demás quedan con `clp: null` hasta que llames `convertirMontos`.

## Conversores

Un `Conversor` es `(moneda, dia) => Promise<Paridad | null>`, con `Paridad = { valor, fechaValor, fuente }` (pesos por 1 unidad). No debe lanzar.

| Conversor | Qué hace |
|---|---|
| `conversorMindicador()` | Valores diarios de mindicador.cl, un request por moneda y año. Dólar y euro sin valor ese día: el último de los 7 días anteriores. UTM: el valor del mes. |
| `conversorParidadChileCompra()` | `ParidadMoneda.csv` oficial de ChileCompra: un promedio mensual, `fechaValor` es el día 1. El mes en curso no está hasta que termina. |
| `conversorEncadenado(a, b, …)` | El primero que responda. |
| `conversorPorDefecto` | `conversorEncadenado(conversorMindicador(), conversorParidadChileCompra())` |

```ts
import { MercadoPublico, convertirMontos, conversorEncadenado, conversorPorDefecto, type Conversor } from "mercadopublico";

// Tu propia tabla primero; si no tiene el día, los de siempre.
const ufPropia = new Map([["2026-10-01", 39_650.12]]);
const miConversor: Conversor = async (moneda, dia) => {
  const valor = moneda === "CLF" ? ufPropia.get(dia) : undefined;
  return valor ? { valor, fechaValor: dia, fuente: "mi tabla" } : null;
};

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET!, conversor: conversorEncadenado(miConversor, conversorPorDefecto) });

// O a mano, sobre procesos que no vienen convertidos:
const lista = await mp.licitaciones.activas();
const convertidas = await Promise.all(lista.map((p) => convertirMontos(p, conversorPorDefecto)));
```

Con `conversor: false` no se convierte nada y no se hace ningún request fuera de la API.
