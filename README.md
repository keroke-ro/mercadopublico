![mercadopublico: la API de Mercado Público, bien usada. SDK en TypeScript por KeroKero.](https://unpkg.com/mercadopublico/docs/assets/readme/portada.png)

[![ci](https://img.shields.io/github/actions/workflow/status/keroke-ro/mercadopublico/ci.yml?branch=main&label=ci&style=flat-square&labelColor=171A17)](https://github.com/keroke-ro/mercadopublico/actions/workflows/ci.yml)
[![contrato](https://img.shields.io/github/actions/workflow/status/keroke-ro/mercadopublico/contrato.yml?branch=main&label=contrato&style=flat-square&labelColor=171A17)](https://github.com/keroke-ro/mercadopublico/actions/workflows/contrato.yml)
[![npm](https://img.shields.io/npm/v/mercadopublico?color=2F6A3B&style=flat-square&labelColor=171A17)](https://www.npmjs.com/package/mercadopublico)
[![dependencias](https://img.shields.io/badge/dependencias_en_runtime-0-2F6A3B?style=flat-square&labelColor=171A17)](package.json)
[![licencia](https://img.shields.io/badge/licencia-PolyForm_Noncommercial-2F6A3B?style=flat-square&labelColor=171A17)](LICENSE)

SDK en TypeScript para la [API de Mercado Público](https://www.chilecompra.cl/api/) de ChileCompra. Junta la API v1 (licitaciones, órdenes de compra y empresas), la v2 de Compra Ágil y las descargas OCDS en un solo modelo, `Proceso`, para que tu código no dependa de cuál de las tres trajo el dato. Se hace cargo de lo que cuesta usar bien la API: manda las consultas de a una para no gatillar el error 10500, reintenta solo cuando sirve, lleva la cuenta de las 10.000 consultas diarias del ticket, convierte los montos a pesos con el valor del día del documento y oculta los datos personales de funcionarios en la CLI. No tiene dependencias en runtime.

![Las tres APIs (v1, Compra Ágil y OCDS) se traducen a un solo tipo, Proceso: con tipo y origen, montos en pesos al valor del día, fechas ISO con offset de Santiago, datos de funcionarios aparte y lo desconocido en raw.](https://unpkg.com/mercadopublico/docs/assets/readme/modelo.png)

> No oficial: no está afiliado a la Dirección ChileCompra.

## Instalación

```sh
npm install mercadopublico
```

Requiere Node 20 o superior (usa `fetch` nativo). Se publica como ESM y CJS. Necesitas un ticket de la API: se pide con Clave Única en [chilecompra.cl/api](https://www.chilecompra.cl/api/) y llega por correo.

## En 30 segundos

```ts
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });

const activas = await mp.licitaciones.activas(); // 1 consulta
console.log(activas.length, "licitaciones publicadas hoy");

const lic = await mp.licitaciones.porCodigo("1509-5-L114"); // 1 consulta; null si no existe
if (lic) {
  console.log(lic.estado, lic.fechas.cierre); // "publicada" "2026-10-20T15:00:00-03:00"
  console.log(lic.monto); // { valor: 1200, moneda: "CLF", clp: 47_000_000, fechaValor: "2026-10-01", fuente: "mindicador.cl" }
}

// Compra Ágil: pagina sola, 1 consulta por página de 50
for await (const ca of mp.compraAgil.listar({ region: [13], estado: ["publicada"], q: "papel" })) {
  console.log(ca.codigo, ca.nombre, ca.monto?.clp);
}

console.log(mp.cuota.toJSON()); // { dia, usadas, limite: 10000, restante, reinicia }
```

## Cuota

El ticket da 10.000 consultas por día calendario. Si mandas dos a la vez, la API responde 10500; si se te acaban, 429. El SDK:

- **Pone todas las consultas en una cola serial.** Nunca hay dos en vuelo, aunque llames en paralelo.
- **Reintenta solo lo que tiene arreglo:** 10500, 5xx y cortes de red, con backoff exponencial y jitter (4 reintentos, base 1 s). Nunca reintenta un ticket inválido, un 404, parámetros malos ni un 429.
- **Lleva la cuenta en `mp.cuota`** (`usadas`, `restante`, `limite`, `reinicia`). Cada intento cuenta, también los reintentos. La API no informa cuánto queda, así que es la cuenta de este proceso: si quieres que sobreviva entre ejecuciones, guarda `mp.cuota.toJSON()` y pásalo como `cuota` al crear el cliente. La CLI ya lo hace.
- **Falla antes de gastar** con `cuota_insuficiente` si una operación no cabe en lo que queda del día.
- **Planifica los sync.** `mp.sync.planificar()` dice cuántas consultas va a costar y si alcanzan hoy, antes de pedir un solo detalle:

```ts
const plan = await mp.sync.planificar({ desde: "2026-10-01", store });
plan.consultas; // 1240
plan.cabeHoy; // true
await mp.sync.ejecutar(plan);
```

Detalle en [docs/sync.md](docs/sync.md).

## Resiliencia

La API falla seguido: rechaza con 10500 incluso consultas seriales (3 de cada 11 con 1 s de pausa) y a veces se cae entera. El SDK alarga la pausa sola ante cada 10500, pone un tope a los reintentos, deja de consultar una fuente caída por 60 s (circuit breaker) y acepta un `signal` en cada método. Un sync cortado en cualquier punto se reanuda sin huecos.

```ts
const mp = new MercadoPublico({
  ticket: process.env.MP_TICKET!,
  alEvento: (e) => console.error(JSON.stringify(e)), // consultas, reintentos, circuito, cuota, avisos de cambios en la API
});
mp.salud(); // { v1: { estado: "cerrado", fallas: 0, intervaloMs: 1000 }, v2: { … }, … }
```

![Cada falla y su respuesta: 10500, ritmo adaptativo; 5xx, timeout o red, reintentos con backoff y jitter; 5 caídas seguidas, circuito abierto 60 s; sync cortado, reanuda sin huecos; la API cambia, parsea igual y avisa; conversor caído, pasa al siguiente.](https://unpkg.com/mercadopublico/docs/assets/readme/resiliencia.png)

Qué pasa en cada falla, en [docs/resiliencia.md](docs/resiliencia.md).

## Datos personales

La v1 trae nombre, RUT, correo y teléfono de funcionarios (`RutUsuario`, `NombreUsuario`, `EmailResponsablePago`, `FonoResponsableContrato`, etc.). El SDK los separa en `proceso.personales`, y:

- **La CLI los oculta por defecto.** Para verlos: `--incluir-personales`.
- **En código los recibes tal como vienen.** Antes de exportar o publicar, pasa cada proceso por `ocultarPersonales`, que deja `personales` en `null` y tapa esos campos dentro de `raw`:

```ts
import { ocultarPersonales } from "mercadopublico";

const publicable = procesos.map(ocultarPersonales);
```

No se tapan el RUT ni la razón social de los proveedores: son datos de empresas, salvo cuando el proveedor es persona natural, y la API no lo indica. La Ley 21.719 de protección de datos personales empieza a regir en diciembre de 2026; si vas a publicar o cruzar estos datos, confirma el alcance con un abogado.

## Radar

`mercadopublico/radar` responde lo que se pregunta cada mañana un equipo que le vende al Estado: qué postular primero, a qué precio, contra quién compite y qué viene. Son fórmulas a la vista, sin machine learning: cada número trae su porqué en texto, y tu criterio (pesos, rubros, costos, vetos) entra en un `Perfil`.

![El puntaje es una suma ponderada de seis factores. decidir lo pasa por reglas duras, umbrales (0,7 postular, 0,4 revisar), capacidad y orden por cierre.](https://unpkg.com/mercadopublico/docs/assets/readme/radar.png)

```sh
npx mercadopublico radar --perfil perfil.json --decisiones decisiones.json
```

Detalle en [docs/radar.md](docs/radar.md).

## CLI

```sh
export MP_TICKET=...
npx mercadopublico licitacion 1509-5-L114
npx mercadopublico licitaciones --dia 2026-10-01 --estado adjudicada --formato csv > adjudicadas.csv
npx mercadopublico compra-agil --region 13 --estado publicada --q papel --max 50
npx mercadopublico ocds 2026 --max 10           # no pide ticket
npx mercadopublico sync --desde 2026-10-01 --plan
npx mercadopublico cuota
```

Salida en tabla si es una terminal y JSON si no; `--formato json|csv|tabla` para elegir. Referencia completa en [docs/cli.md](docs/cli.md).

## MCP

`npx mercadopublico mcp` levanta un servidor MCP por stdio para que un agente (Claude, Cursor, etc.) consulte la API. Tiene herramientas para licitaciones, órdenes de compra, Compra Ágil, proveedores, compradores, cuota y radar, y usa la misma cola, cuota en disco y conversión de montos que la CLI. Los datos personales se ocultan siempre, `raw` no se manda y las listas se recortan a `max` (50 por defecto). Por ejemplo, en Claude Code:

```sh
claude mcp add mercadopublico -e MP_TICKET=tu-ticket -- npx -y mercadopublico mcp
```

## Documentación

- [Guía](docs/guia.md): cliente, licitaciones, órdenes de compra, empresas, Compra Ágil y errores.
- [Modelo](docs/modelo.md): `Proceso`, `Monto`, fechas y conversores.
- [Sync](docs/sync.md): plan, costo en consultas, cursores y stores.
- [CLI](docs/cli.md)
- [OCDS](docs/ocds.md): el histórico de datos abiertos, en streaming.
- [Radar](docs/radar.md): `mercadopublico/radar` y `mercadopublico radar`: qué postular primero, a qué precio, contra quién y qué viene.
- [Resiliencia](docs/resiliencia.md): qué hace el SDK cuando la API falla, eventos y `mp.salud()`.
- [Testing](docs/testing.md): qué se prueba, dónde corre y cuántas consultas reales gasta.
- [Contrato nocturno](docs/contrato.md)
- [Notas de la API](docs/api-notes.md): lo que dice cada fuente oficial y dónde se contradicen.

## Calidad

Cada PR corre, en Node 20, 22 y 24, typecheck, tests unitarios, propiedades con fast-check, un corpus de 59 respuestas reales anonimizadas con snapshots y pruebas de caos contra un servidor local; además, cobertura con umbrales y el paquete tal como se publica, importado desde Node, Bun, Deno y un entorno tipo edge. Cada semana corren la prueba de mutación y un smoke contra la API real; cada noche, el [contrato](docs/contrato.md). Detalle en [docs/testing.md](docs/testing.md).

## Estado

Versión 0.x: la API pública todavía puede cambiar entre versiones menores (ver [CONTRIBUTING.md](CONTRIBUTING.md#versiones)).

Probado con un ticket real desde el 2026-10-13: la v1 tiene fixtures grabados de la API (`test/fixtures/v1/*.real.json`) y un corpus de respuestas reales anonimizadas (ver [docs/testing.md](docs/testing.md#corpus-real-y-snapshots)). Los fixtures de la v2 y de OCDS siguen reconstruidos desde la documentación oficial y llevan la marca `"_fixture": "reconstruido…"`. Estas dudas siguen abiertas (detalle en [docs/api-notes.md](docs/api-notes.md)):

- En qué zona horaria se reinicia la cuota (el SDK supone medianoche de Santiago) y si v1 y v2 comparten contador.
- Si el servidor acepta la grafía correcta de dos filtros de estado de OC que la documentación escribe con errata (`recepcionaceptadacialmente`, `recepecionconformeincompleta`). El SDK manda la de la documentación.
- Detalles de forma: si `Publico` en las rutas de Empresas distingue mayúsculas, si el filtro `region` de la v2 va separado por comas o repetido, y con qué status HTTP llega el error 10300.
- Si las fechas OCDS con sufijo `Z` son UTC reales o la hora de Santiago etiquetada como UTC. El SDK las lee como hora de Santiago.
- En Compra Ágil, `codigo_orden_compra` viene en `null` aunque la OC exista (el SDK usa `id_orden_compra`), y `seleccion.proveedor_seleccionado` está documentado pero no confirmado.
- mindicador.cl no respondía al investigar; si falla, el conversor usa los valores diarios del Banco Central (sus páginas "Ver serie", no una API) y, si eso también falla, el promedio mensual oficial de ChileCompra.

## Fuente de los datos

Los datos vienen de la Dirección ChileCompra (api.mercadopublico.cl). Si publicas datos obtenidos con esta librería, cita a ChileCompra como fuente.

Esta librería no está afiliada a la Dirección ChileCompra ni cuenta con su respaldo.

## Licencia

[PolyForm Noncommercial 1.0.0](LICENSE): libre para uso no comercial (personal, investigación, educación, organizaciones sin fines de lucro e instituciones públicas). Para uso comercial, escríbenos a [KeroKero](https://kerokero.cl).

Required Notice: Copyright KeroKero (https://kerokero.cl)

---

<img src="https://unpkg.com/mercadopublico/docs/assets/readme/kerokero.svg" width="18" height="18" alt=""> Hecho por [KeroKero](https://kerokero.cl): sistemas de decisión para tu operación.
