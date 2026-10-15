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
npx mercadopublico
```

Abre un instalador en la terminal. Eliges qué quieres y lo deja configurado:

- **Tu ticket:** lo prueba con una consulta y lo guarda en `~/.mercadopublico/config.json` (solo tu usuario puede leerlo), así la CLI y el MCP ya no piden `MP_TICKET`.
- **MCP:** lo agrega a Claude Code, Codex, Cursor o Claude Desktop, los que encuentre instalados.
- **Radar:** arma tu perfil (rubros, regiones y montos) y baja los últimos días para tu primera agenda.
- **SDK:** lo instala en el proyecto con tu gestor de paquetes (npm, pnpm, yarn o bun).

Lo puedes volver a correr cuando quieras con `npx mercadopublico init`. Si solo quieres la librería:

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

## MCP: úsalo desde Claude, ChatGPT, Codex o Cursor

`mercadopublico mcp` conecta tu asistente de IA con Mercado Público. Le preguntas en español y él busca, lee las fichas y analiza:

- «¿Qué licitaciones de computadores cierran esta semana?»
- «Analiza la licitación 1509-5-L114: requisitos, plazos y riesgos.»
- «¿Quién le gana a quién en Compra Ágil de artículos de aseo en la Región Metropolitana?»

**Lo más rápido:** corre `npx mercadopublico` en la terminal, elige «MCP para mis agentes» y listo. Si prefieres hacerlo a mano, son dos pasos.

**1. Consigue tu ticket.** Se pide gratis con Clave Única en [chilecompra.cl/api](https://www.chilecompra.cl/api/) y llega por correo. Tiene la forma `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. En los ejemplos de abajo, reemplaza `TU-TICKET` por el tuyo.

**2. Agrégalo a tu asistente.** Elige el tuyo:

<details>
<summary><b>Claude Desktop</b> (la app de Claude para Mac o Windows, sin programar)</summary>

1. Descarga [**mercadopublico.mcpb**](https://github.com/keroke-ro/mercadopublico/releases/latest/download/mercadopublico.mcpb) (del [último release](https://github.com/keroke-ro/mercadopublico/releases/latest)).
2. Ábrelo con doble clic: Claude Desktop muestra la extensión y te pide el ticket.
3. Pega tu ticket y confirma la instalación.

No necesitas instalar nada más. Para probar, abre un chat nuevo y pregunta: «¿Qué licitaciones de papel hay abiertas?».

</details>

<details>
<summary><b>Claude Code</b></summary>

Necesitas [Node 20](https://nodejs.org) o superior.

```sh
claude mcp add mercadopublico -e MP_TICKET=TU-TICKET -- npx -y mercadopublico mcp
```

Revisa que quedó conectado con `claude mcp list`, o con `/mcp` dentro de Claude Code.

</details>

<details>
<summary><b>Codex</b> (OpenAI: CLI, extensión del editor y app)</summary>

Necesitas [Node 20](https://nodejs.org) o superior.

```sh
codex mcp add mercadopublico --env MP_TICKET=TU-TICKET -- npx -y mercadopublico mcp
```

O agrega esto a `~/.codex/config.toml`:

```toml
[mcp_servers.mercadopublico]
command = "npx"
args = ["-y", "mercadopublico", "mcp"]
env = { MP_TICKET = "TU-TICKET" }
```

</details>

<details>
<summary><b>Cursor</b> (y otros editores que leen <code>mcpServers</code>)</summary>

Necesitas [Node 20](https://nodejs.org) o superior. En `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mercadopublico": {
      "command": "npx",
      "args": ["-y", "mercadopublico", "mcp"],
      "env": { "MP_TICKET": "TU-TICKET" }
    }
  }
}
```

El mismo bloque sirve para Claude Desktop sin la extensión, en `claude_desktop_config.json` (en Claude Desktop: Settings → Developer → Edit Config; reinícialo después).

</details>

<details>
<summary><b>ChatGPT y claude.ai</b> (web y celular)</summary>

Estos dos solo se conectan a servidores en internet, así que necesitas levantar uno. Requiere algo de terminal:

```sh
export MP_TICKET=TU-TICKET
export MP_MCP_CLAVE=$(openssl rand -hex 24)   # tu clave secreta; guárdala
npx mercadopublico mcp --http --puerto 8787
```

Publícalo con HTTPS, por ejemplo con `cloudflared tunnel --url http://localhost:8787`, y agrega como conector la URL `https://<tu-dominio>/mcp/<MP_MCP_CLAVE>`:

- **claude.ai:** Settings → Connectors → Add custom connector.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → activa Developer mode y crea el conector, sin autenticación (la clave ya va en la URL).

La URL con la clave es una contraseña: no la compartas. Para un servidor permanente (Cloudflare Workers, un VPS), mira [docs/mcp.md](docs/mcp.md#remoto-y-autohospedado).

</details>

**Qué cuidar.** Cada respuesta dice cuántas consultas gastó, y el asistente tiene un tope de 1.000 al día (de las 10.000 del ticket) para que no se coma tu cuota; cámbialo con `MP_MCP_TOPE`. Los datos personales de funcionarios siempre van ocultos. Lo que tarda (bajar días completos con `sync` o el historial con `ocds_importar`) corre en segundo plano, y el asistente te va contando cómo avanza.

Todas las herramientas, los prompts y las variables de entorno en [docs/mcp.md](docs/mcp.md).

## Documentación

- [Guía](docs/guia.md): cliente, licitaciones, órdenes de compra, empresas, Compra Ágil y errores.
- [Modelo](docs/modelo.md): `Proceso`, `Monto`, fechas y conversores.
- [Sync](docs/sync.md): plan, costo en consultas, cursores y stores.
- [CLI](docs/cli.md)
- [MCP](docs/mcp.md): el servidor para agentes: herramientas, instalación por cliente y modo remoto.
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
