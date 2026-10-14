# Resiliencia

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md) · [Testing](testing.md)

La API de Mercado Público falla seguido y de formas raras: rechaza con 10500 consultas que van de a una, se cae con 500 y a veces responde HTML. Esta página dice qué hace el SDK en cada caso y cómo te enteras desde tu código.

## Qué pasa cuando algo falla

| Falla | Qué hace el SDK | Qué ves |
|---|---|---|
| **10500** "peticiones simultáneas" (llega con HTTP 429, también con consultas seriales) | Reintenta con backoff y duplica la pausa entre consultas a esa API ([ritmo adaptativo](#ritmo-adaptativo-y-10500)) | Eventos `reintento` y `ritmo`. Si se acaban los reintentos, error `simultaneas` |
| **Cuota de la API agotada** (429 sin código 10500, o un mensaje de cuota o límite) | No reintenta | Error `cuota_agotada` |
| **Cuota local agotada** | No manda la consulta | Error `cuota_insuficiente`. Antes, eventos `cuota` al 80%, 95% y 100% |
| **Timeout** (`timeoutMs`, 30 s) o corte de red | Reintenta. Cuenta como caída para el circuito | Eventos `reintento`; al final, error `red` |
| **5xx** | Reintenta. Cuenta como caída | Error `servidor` |
| **504** (corte del gateway a ~30 s, típico de una consulta amplia) | Reintenta una sola vez. No cuenta para el circuito, para no bloquear consultas que sí responden | Error `servidor` con `status: 504` y un mensaje que sugiere acotar |
| **HTML de mantención** | Con status 5xx, igual que un 5xx. Con 200, no reintenta y cuenta como caída | Error `servidor` o `respuesta_invalida` |
| **v2 con `success: "ERROR"`** (falla interna, vista con HTTP 500) | Igual que un 5xx; el mensaje de la API queda en el error | Error `servidor` |
| **Error v1 con HTTP 200** (`{Codigo, Mensaje}`) | Lo clasifica por código y mensaje, no por status | `ticket_invalido`, `cuota_agotada` o `parametros` |
| **5 caídas seguidas** de una fuente | Abre el [circuito](#circuit-breaker) por 60 s: no consulta ni gasta cuota | Error `circuito_abierto`, evento `circuito` y `mp.salud()` |
| **Demasiados reintentos** (más del 30% de los últimos 100 intentos) | Entrega el error en vez de seguir reintentando | El error original (`simultaneas`, `servidor` o `red`) |
| **Cancelaste** (`signal`) | Corta la consulta en vuelo, la pausa y el backoff | Error `cancelada`. `sync.ejecutar` devuelve `detenido: "cancelado"` |
| **mindicador.cl, Banco Central o ChileCompra caídos** | Pasa al conversor siguiente; si ninguno responde, el monto queda sin convertir | `clp: null` y eventos `conversion` y `circuito` |
| **La API cambió de forma** (campo nuevo, faltante, con otro tipo o código desconocido) | Parsea igual: lo que no entiende queda en `null` y en `raw` | Evento `aviso` |

Cada intento cuenta en la cuota local, también los reintentos. La tabla completa de `tipo` está en la [Guía](guia.md#errores).

## Ritmo adaptativo y 10500

La API rechaza con 10500 aunque las consultas vayan estrictamente de a una. Medido el 2026-10-13 ([notas de la API](api-notes.md)):

| Pausa entre consultas | Rechazadas |
|---|---|
| sin pausa | 4 de 10 |
| 500 ms | 4 de 12 |
| 1 s | 3 de 11 |
| 2 s | 1 de 7 |

Por eso el SDK:

- **Manda todo por una cola serial.** Nunca hay dos consultas en vuelo, aunque llames en paralelo.
- **Deja `intervaloMs` (1000) entre el inicio de una consulta y el de la siguiente a la misma API.** v1 y v2 llevan cada una su ritmo.
- **Ajusta la pausa sola (AIMD).** Ante cada 10500, la pausa de esa API se multiplica por `factor` (2) hasta `maximoMs` (8000). Después de `exitos` (20) consultas seguidas sin 10500, baja `pasoMs` (250 ms) hasta volver a `intervaloMs`. Cada cambio emite un evento `ritmo` y la pausa actual sale en `mp.salud().v1.intervaloMs`.
- **Reintenta hasta `reintentos` (4) veces** con backoff exponencial y jitter: con `esperaBaseMs` de 1000, las esperas son de 1, 2, 4 y 8 s, cada una al azar entre la mitad y el total.

```ts
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({
  ticket: process.env.MP_TICKET!,
  intervaloMs: 2000, // más lento, menos 10500
  ritmo: { maximoMs: 15_000 },
});
```

Con `intervaloMs: 0` no hay pausa ni ritmo adaptativo. Los valores por defecto están exportados: `RITMO`, `CIRCUITO`, `PRESUPUESTO_REINTENTOS` y `UMBRALES_CUOTA`.

## Presupuesto de reintentos

Si la API empieza a rechazar casi todo, reintentar solo quema cuota. Los reintentos no pueden pasar del 30% de los últimos 100 intentos (`presupuestoReintentos`, por defecto `0.3`). Siempre caben `reintentos`, así que una consulta suelta puede usar los suyos. Sin presupuesto, el SDK entrega el error real sin esperar.

## Circuit breaker

Cada fuente tiene un circuito: `v1`, `v2` y los tres conversores de montos (`mindicador`, `bcentral`, `paridad`).

```
cerrado ── 5 caídas seguidas ──▶ abierto ── 60 s ──▶ semiabierto ── la sonda responde ──▶ cerrado
                                    ▲                    │
                                    └──── la sonda cae ──┘
```

- **Caída** es `servidor`, `red` o `respuesta_invalida`. Cualquier otra respuesta (un 10500, un 404, parámetros malos) prueba que el servicio contesta y reinicia la cuenta.
- **Abierto:** cada llamada falla al tiro con `circuito_abierto`, sin tocar la red ni la cuota. El mensaje dice cuándo se vuelve a probar.
- **Semiabierto:** la siguiente consulta pasa como sonda. Si responde, el circuito se cierra; si cae, se abre otros 60 s.
- Si el circuito se abre en medio de los reintentos de una consulta, no espera: entrega el error real.
- v1 y v2 van por separado: una v2 caída no frena la v1.

```ts
const mp = new MercadoPublico({
  ticket: process.env.MP_TICKET!,
  circuito: { umbral: 10, enfriamientoMs: 5 * 60_000 }, // solo v1 y v2
});
```

Los circuitos de los conversores usan siempre los valores de `CIRCUITO` (5 caídas, 60 s).

## Cancelar consultas

Todos los métodos que consultan la API aceptan `{ signal }`. También `sync.planificar`, `sync.ejecutar` y `leerOcds`.

```ts
import { MercadoPublico, MercadoPublicoError } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });

try {
  const lics = await mp.licitaciones.delDia("2026-10-01", { signal: AbortSignal.timeout(60_000) });
  console.log(lics.length);
} catch (e) {
  if (e instanceof MercadoPublicoError && e.tipo === "cancelada") console.log("Tardó más de un minuto");
  else throw e;
}
```

- Rechaza con `cancelada` apenas se dispara el signal: con la consulta en vuelo, en la pausa del ritmo, en el backoff o esperando turno en la cola.
- Una consulta que ya salió cuenta en la cuota. Las que esperaban turno no gastan nada.
- No corta la conversión de montos que viene después de un `porCodigo` (cada descarga del conversor tiene su propio timeout de 10 s).
- `sync.planificar` rechaza con `cancelada`. `sync.ejecutar` no rechaza: guarda lo hecho y devuelve `detenido: "cancelado"`.

## Sync

- **El cursor nunca queda adelante de los datos.** Cada lote (un día de v1 o una página de Compra Ágil) se guarda antes de mover su cursor, o junto con él si el store tiene `guardarConCursor`. Un corte en cualquier punto (proceso muerto, Ctrl-C, error) puede dejar datos de más, nunca un hueco.
- **Reanudar da lo mismo que no cortar.** Correr el sync de nuevo después de un corte deja el store igual que una corrida sin cortes (datos, cursores y pendientes), y lo ya guardado no se vuelve a pedir. Las excepciones: las páginas de Compra Ágil de la vuelta cortada se vuelven a listar, y un pendiente puede sumar intentos de más, porque una vuelta cortada también cuenta. `test/sync-reanudar.test.ts` corta en cada consulta y en cada escritura posible y lo comprueba.
- **Lo pasajero queda pendiente, sin frenar el cursor.** Un detalle que falla por 10500, 5xx, red o una respuesta inválida queda en `<fuente>:pendientes` (escrito antes que el cursor) y el cursor avanza. La vuelta siguiente lo reintenta primero, contado en el plan. Tras 5 vueltas con error se abandona y sale en `resultado.abandonados`. Así un proceso que falla siempre cuesta 1 consulta por vuelta, no re-listar todo. Lo permanente (`no_encontrado`, `parametros`) queda en `errores` y nada más. Detalle en [Sync](sync.md#pendientes).
- **Cortan el sync:** `cuota_agotada`, `cuota_insuficiente`, `ticket_invalido` y `circuito_abierto`, con ese error. `cancelada` también lo corta, pero devuelve `detenido: "cancelado"`. En todos los casos lo ya pedido queda guardado.
- **`storeArchivo` no se comparte.** Toma `<ruta>.lock` mientras está abierto, escribe de forma atómica (temporal propio del proceso, fsync y rename) y, si el JSON está dañado, lo mueve a `<ruta>.corrupto-<fecha>` y falla en vez de partir de cero. En la misma máquina, un lock de un proceso vivo nunca se roba, aunque lleve rato sin renovarse (suspendido); los 10 minutos sin renovar solo valen para otra máquina. Antes de cada rename revisa que el lock siga siendo suyo; si no, falla sin escribir. Detalle en [Sync](sync.md#stores).

## Montos: conversores que se degradan

La cadena por defecto es mindicador.cl → Banco Central → paridad mensual de ChileCompra. Detalle de cada uno en [Modelo](modelo.md#conversores).

- Cada fuente tiene su circuito. Una fuente caída se salta sin esperar el timeout.
- Una descarga fallida se recuerda 5 minutos: con el servicio caído no pagas un timeout por cada monto.
- Si ninguna responde, el monto queda con `clp`, `fechaValor` y `fuente` en `null`. Nunca lanza. Puedes convertir después con `convertirMontos`.
- Cada intento emite un evento `conversion` (`fuente`, `ok`, `moneda`, `dia`).

Solo la cadena que arma `MercadoPublico` informa a `alEvento` y a `mp.salud()`. `conversorPorDefecto` tiene sus propios circuitos y no emite eventos. Si pasas tu propio `conversor`, los circuitos de los conversores en `salud()` quedan siempre en `cerrado`.

## Avisos: cuando la API cambia

Los parsers comparan cada respuesta con la forma que conocen (sacada de las respuestas reales) y avisan lo que no calza, sin cambiar el resultado:

| `aviso` | Cuándo |
|---|---|
| `campo_nuevo` | Llegó un campo que el parser no conoce |
| `campo_faltante` | Falta o viene `null` un campo del que depende el modelo |
| `tipo_distinto` | Un campo llegó con otro tipo JSON (por ejemplo, `string` en vez de `number`) |
| `valor_desconocido` | Un código que no está en las tablas (estado, tipo, región, moneda…) |

Cada aviso trae `origen` (`v1`, `v2` u `ocds`), `ruta` (por ejemplo `Listado[].Comprador.RutUnidad`), y `codigo` y `detalle` si se saben. Sale una vez por `aviso` y `ruta` en cada proceso parseado.

Con el cliente, llegan a `alEvento` como `{ tipo: "aviso", aviso, origen, ruta, codigo?, detalle? }`. Si usas los parsers sueltos, pásales `avisar`: `parseLicitacion(raw, { avisar })`, `parseOrdenCompra(raw, { avisar })`, `parseCompraAgil(raw, { detalle, avisar })`, `leerOcds(fuente, { avisar })` y `desdeOcds(json, { avisar })`.

## Observar con `alEvento`

| `tipo` | Cuándo | Campos |
|---|---|---|
| `consulta` | Terminó una consulta a la API, bien o mal | `fuente`, `url` (nunca con el ticket), `status` (`null` si no hubo respuesta), `ms`, `intento` |
| `reintento` | Se va a reintentar | `fuente`, `motivo` (el `tipo` del error), `intento`, `esperaMs` |
| `ritmo` | Cambió la pausa entre consultas | `fuente`, `intervaloMs` |
| `circuito` | Un circuito cambió de estado | `fuente`, `estado`, `fallas` |
| `cuota` | La cuota local cruzó el 80%, el 95% o el 100% (una vez por día cada umbral) | `usadas`, `limite`, `restante` |
| `conversion` | Un conversor respondió o no | `fuente`, `ok`, `moneda`, `dia` |
| `aviso` | Un parser notó algo raro | `aviso`, `origen`, `ruta`, `codigo?`, `detalle?` |

El hook se llama en línea, en medio de la consulta: que sea rápido. Si lanza, el SDK se traga el error.

Como líneas JSON en stderr, sin el ruido de las consultas que salieron bien:

```ts
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({
  ticket: process.env.MP_TICKET!,
  alEvento: (e) => {
    if (e.tipo === "consulta" && e.status === 200) return;
    console.error(JSON.stringify({ ts: new Date().toISOString(), ...e }));
  },
});
```

Contando avisos para una métrica o un resumen al final:

```ts
import { MercadoPublico } from "mercadopublico";

const avisos = new Map<string, number>();
const mp = new MercadoPublico({
  ticket: process.env.MP_TICKET!,
  alEvento: (e) => {
    if (e.tipo !== "aviso") return;
    const clave = `${e.origen} ${e.aviso} ${e.ruta}`;
    avisos.set(clave, (avisos.get(clave) ?? 0) + 1);
  },
});

await mp.licitaciones.delDia("2026-10-01");
for (const [clave, n] of avisos) console.log(n, clave); // 12 v1 campo_nuevo Listado[].CodigoNuevo
```

## Salud: `mp.salud()`

Devuelve el estado de cada fuente sin gastar consultas:

```json
{
  "v1": { "estado": "cerrado", "fallas": 0, "intervaloMs": 1000 },
  "v2": { "estado": "abierto", "fallas": 5, "ultimaFalla": "2026-10-13T21:30:00-03:00", "intervaloMs": 1000 },
  "mindicador": { "estado": "cerrado", "fallas": 0 },
  "bcentral": { "estado": "cerrado", "fallas": 0 },
  "paridad": { "estado": "cerrado", "fallas": 0 }
}
```

`fallas` son las caídas seguidas, `ultimaFalla` va en hora de Santiago e `intervaloMs` (solo v1 y v2) es la pausa actual. Para un endpoint de salud:

```ts
import { createServer } from "node:http";
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });

createServer((req, res) => {
  if (req.url !== "/salud") return void res.writeHead(404).end();
  const fuentes = mp.salud();
  const caida = fuentes.v1.estado === "abierto" || fuentes.v2.estado === "abierto";
  res.writeHead(caida ? 503 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify({ fuentes, cuota: mp.cuota.toJSON() }));
}).listen(8080);
```
