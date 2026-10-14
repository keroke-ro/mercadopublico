# Guía

[Inicio](index.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md)

## Cliente

```ts
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });
```

| Opción | Por defecto | Para qué |
|---|---|---|
| `ticket` | (obligatorio) | Tu ticket de la API. Va en la URL en la v1 y en un header en la v2. |
| `conversor` | mindicador.cl y, si falla, la paridad mensual de ChileCompra | Cómo pasar UF, UTM, USD y EUR a pesos. `false` no convierte. Ver [Modelo](modelo.md#conversores). |
| `reintentos` | `4` | Reintentos ante 10500, 5xx o corte de red. |
| `esperaBaseMs` | `1000` | Base del backoff: cada espera es al azar entre la mitad y el total de `esperaBaseMs · 2^intento`. |
| `timeoutMs` | `30000` | Timeout por consulta. |
| `limiteDiario` | `10000` | Consultas por día del ticket. |
| `cuota` | — | `{ dia, usadas }` guardado de una ejecución anterior del mismo día. |
| `fetch` | `globalThis.fetch` | Para inyectar un `fetch` propio (proxy, tests). |

### La cuota entre ejecuciones

`mp.cuota` cuenta lo que gastó este proceso. Para que la cuenta sobreviva, guárdala y pásala de vuelta:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { MercadoPublico, type EstadoCuota } from "mercadopublico";

const guardada = JSON.parse(await readFile("cuota.json", "utf8").catch(() => "null")) as EstadoCuota | null;
const mp = new MercadoPublico({ ticket: process.env.MP_TICKET!, cuota: guardada ?? undefined });

// … tus consultas …

const { dia, usadas } = mp.cuota.toJSON();
await writeFile("cuota.json", JSON.stringify({ dia, usadas }));
```

Si `dia` ya no es hoy en Santiago, la cuenta parte de cero sola.

## Licitaciones

Cada método gasta 1 consulta. Los listados traen solo código, nombre, estado y cierre; el resto queda en `null` hasta que pidas el detalle.

```ts
const lic = await mp.licitaciones.porCodigo("1509-5-L114"); // Licitacion | null, con montos convertidos
const hoy = await mp.licitaciones.activas(); // publicadas hoy
const delDia = await mp.licitaciones.delDia("2026-10-01");
const adjudicadas = await mp.licitaciones.delDia("2026-10-01", { estado: "adjudicada" });
const desiertas = await mp.licitaciones.porEstado("desierta", { dia: "2026-10-01" }); // sin dia: hoy
const deUnOrganismo = await mp.licitaciones.porOrganismo("7248", { dia: "2026-10-01" });
const deUnProveedor = await mp.licitaciones.porProveedor("17793", { dia: "2026-10-01" });
```

Estados para filtrar: `publicada`, `cerrada`, `desierta`, `adjudicada`, `revocada`, `suspendida`, `todos`, `activas`.

## Órdenes de compra

Igual que licitaciones, sin `activas`. Cada método gasta 1 consulta.

```ts
const oc = await mp.ordenes.porCodigo("2097-241-SE14"); // OrdenCompra | null
const enviadas = await mp.ordenes.delDia("2026-10-01");
const todasDeHoy = await mp.ordenes.porEstado("todos");
const aceptadas = await mp.ordenes.porEstado("aceptada", { dia: "2026-10-01" });
```

Estados para filtrar: `enviada_proveedor`, `aceptada`, `cancelada`, `recepcion_conforme`, `pendiente_recepcion`, `recepcion_parcial`, `recepcion_conforme_incompleta`, `todos`. El SDK los traduce al valor que pide la API (dos de ellos con la errata de la documentación).

## Empresas

```ts
const prov = await mp.empresas.buscarProveedor("76.123.456-7"); // { codigo, nombre } | null
if (prov) await mp.ordenes.porProveedor(prov.codigo, { dia: "2026-10-01" });

const compradores = await mp.empresas.buscarComprador(); // { codigo, nombre }[], todos los organismos
```

`buscarProveedor` acepta el RUT con o sin puntos y guion; `formatearRut` lo deja como lo pide la API (`70.017.820-k`).

## Compra Ágil (v2)

```ts
// Una página: 1 consulta.
const p = await mp.compraAgil.pagina({ region: [13], estado: ["publicada"] }, 1);
p.items; p.totalPaginas; p.totalResultados;

// Todas las páginas: totalPaginas consultas.
for await (const ca of mp.compraAgil.listar({ q: "papel", publicadoDesde: "2026-10-01" })) {
  console.log(ca.codigo, ca.monto);
}

// Detalle con ítems y cotizaciones: 1 consulta.
const ca = await mp.compraAgil.detalle("1057539-228-COT26"); // null si no existe
ca?.cotizaciones; // [{ proveedor, monto, seleccionada, productos }]
ca?.ordenCompra; // código o id de la OC; ver nota abajo
```

Filtros (`FiltrosCompraAgil`): `estado`, `region` (1 a 16), `publicadoDesde`/`publicadoHasta`, `cambioDesde`/`cambioHasta` o `ttlCambioMs`, `q` o `id`, `ordenarPor`, `tamanoPagina` (1 a 50, por defecto 50) y `rutOrganismo`. Las fechas aceptan `Date` o ISO; sin offset se leen como hora de Santiago.

- Las combinaciones que la API rechaza (`q` con `id`, `ttlCambioMs` con `cambioDesde`) fallan en local con `parametros`, sin gastar consulta.
- `rutOrganismo` no existe en la API: se filtra después de bajar cada página y no ahorra consultas. Combínalo con `region`.
- `codigo_orden_compra` llega en `null` aunque la OC exista. `ordenCompra` usa `id_orden_compra` cuando falta el código.
- `detalle` devuelve `null` si el código no existe, igual que `porCodigo` en la v1.

## Códigos

Las tablas de la v1, con las contradicciones de la documentación ya resueltas (cada corrección tiene su test):

```ts
import { codigos } from "mercadopublico";

codigos.TIPO_LICITACION.LE; // "Licitación Pública igual o superior a 100 UTM e inferior a 1.000 UTM"
codigos.REGION[13]; // "Metropolitana"
codigos.glosa(codigos.MODALIDAD_PAGO, 6); // "Contra Entrega Conforme"
codigos.regionCodigo("Región Metropolitana de Santiago"); // 13
```

## Errores

Todo error de la API o de la cuota es un `MercadoPublicoError` con `tipo`, `status` (HTTP), `codigo` (el de la API, p. ej. 10500) y `reintentable`.

```ts
import { MercadoPublicoError } from "mercadopublico";

try {
  await mp.licitaciones.activas();
} catch (e) {
  if (e instanceof MercadoPublicoError && e.tipo === "cuota_agotada") {
    console.log("Sin cuota hasta", mp.cuota.reinicia);
  } else throw e;
}
```

| `tipo` | Cuándo | ¿Se reintenta? |
|---|---|---|
| `ticket_invalido` | Falta el ticket, 401, 403 o un mensaje que habla del ticket | No |
| `cuota_agotada` | 429 de la API o un mensaje de límite o cuota | No |
| `cuota_insuficiente` | El SDK se negó antes de gastar: la operación no cabe en lo que queda hoy | No |
| `simultaneas` | Código 10500: dos consultas a la vez | Sí |
| `no_encontrado` | 404 | No |
| `parametros` | 400 o 422, o filtros inválidos detectados en local | No |
| `servidor` | 5xx | Sí |
| `red` | Corte de red o timeout | Sí |
| `respuesta_invalida` | La API respondió algo que no es JSON o no se entiende | No |

Los reintentos usan backoff exponencial con jitter y cada intento cuenta en la cuota. Un error de la v1 se detecta por el cuerpo (`{Codigo, Mensaje}`) aunque llegue con HTTP 200.
