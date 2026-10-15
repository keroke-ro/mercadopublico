# MCP

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md) · [Resiliencia](resiliencia.md) · [Testing](testing.md)

`mercadopublico mcp` es un servidor [MCP](https://modelcontextprotocol.io) para que un agente (Claude, Codex, Cursor, ChatGPT) busque en Mercado Público, traiga el detalle de un proceso y analice a la competencia. Usa el mismo cliente que la CLI: cola serial, cuota en disco, conversión de montos. No agrega dependencias.

Reglas de diseño:

- **Un solo cliente, una cola serial.** Nunca hay dos consultas en vuelo, aunque el agente llame a dos herramientas a la vez (la API responde 10500 si pasa).
- **Todo resultado trae `costo`:** `{ consultas, restanteHoy, topeAgente: { limite, usadas } }`. El agente ve cuánto gastó, cuánto le queda al ticket y cuánto le queda de su tope.
- **Tope diario del agente: `MP_MCP_TOPE`** (1000 por defecto). Al llegar, las herramientas que consultan la API se niegan. El conteo vive en memoria del proceso del servidor: **se reinicia al reiniciarlo**. La cuota real del ticket (10.000) sí queda en disco y se comparte con la CLI.
- **Los datos personales de funcionarios siempre van ocultos y `raw` nunca se manda.** No hay opción para cambiarlo.
- **Resultados compactos con URL pública para citar:** `https://www.mercadopublico.cl/...` para licitaciones y órdenes de compra. La URL pública de una Compra Ágil no está confirmada, así que `url` es `null`.

## Instalar

Necesitas Node 20 o superior y un ticket ([chilecompra.cl/api](https://www.chilecompra.cl/api/)). Todos los clientes de abajo lanzan `npx -y mercadopublico mcp` por stdio.

### Claude Code

```sh
claude mcp add mercadopublico -e MP_TICKET=tu-ticket -- npx -y mercadopublico mcp
```

### OpenAI Codex

```sh
codex mcp add mercadopublico --env MP_TICKET=tu-ticket -- npx -y mercadopublico mcp
```

O a mano, en `~/.codex/config.toml`:

```toml
[mcp_servers.mercadopublico]
command = "npx"
args = ["-y", "mercadopublico", "mcp"]
env = { MP_TICKET = "tu-ticket" }
```

Codex corta cada herramienta a los 60 s (`tool_timeout_sec`). Déjalo así: lo largo (`sync`, `ocds_importar`) corre como trabajo en segundo plano y responde al tiro.

### Cursor

En `~/.cursor/mcp.json` (global) o `.cursor/mcp.json` (un proyecto):

```json
{
  "mcpServers": {
    "mercadopublico": {
      "command": "npx",
      "args": ["-y", "mercadopublico", "mcp"],
      "env": { "MP_TICKET": "tu-ticket" }
    }
  }
}
```

### Claude Desktop

La forma fácil es la extensión `mercadopublico.mcpb`, que se adjunta a cada [release en GitHub](https://github.com/keroke-ro/mercadopublico/releases). Haz doble clic en el archivo, Claude Desktop pide el ticket (y, si quieres, la ruta del store y el tope) y lo guarda él. No necesitas tener Node instalado.

A mano, en `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows: `%APPDATA%\Claude\`), con el mismo bloque `mcpServers` de Cursor. Reinicia Claude Desktop después.

> Las rutas de Cursor y Claude Desktop son las habituales, pero no las verifiqué contra la versión de cada cliente: si no calzan, mira en sus ajustes la sección de servidores MCP.

## Herramientas

| Herramienta | Qué hace | Consultas | Store | Escribe |
|---|---|---|---|---|
| `search` | Busca por palabras en licitaciones activas, Compra Ágil y el store | 0 a 2 | opcional | no |
| `fetch` | Detalle de un proceso por su código | 1 (2 si cambia de familia) | no | no |
| `listar` | Procesos de un día, o de un organismo o proveedor | 1 | no | no |
| `organismos` | Código de un organismo comprador por nombre | 1 la primera vez (24 h en caché) | no | no |
| `proveedor` | Código de empresa de un proveedor por RUT | 1 | no | no |
| `cuota` | Consultas usadas hoy y gasto del agente | 0 | no | no |
| `sync` | Baja datos de la API al store, en segundo plano | las del trabajo, hasta `maxConsultas` | sí | sí |
| `ocds_importar` | Trae historial OCDS filtrado al store, en segundo plano | 0 | sí | sí |
| `trabajo_estado` | Avance del último trabajo | 0 | sí | no |
| `trabajo_cancelar` | Detiene el trabajo en curso, guardando lo hecho | 0 | sí | no (detiene el trabajo) |
| `radar` | Qué postular primero, a qué precio y qué viene | 0 | sí | no |
| `competidores` | Quién gana, cuánto y con qué concentración (HHI) | 0 | sí | no |
| `proximas_compras` | Compras que un organismo repite y cuándo vuelve la próxima | 0 | sí | no |
| `precios` | Rango de precios ganadores y precio sugerido | 0 | sí | no |

Las que piden store existen en `mercadopublico mcp` (stdio y `--http`) y se ocultan si el servidor se arma sin store (ver [Workers](#cloudflare-workers)).

### Búsqueda y detalle

- **`search`** busca en licitaciones activas (por nombre, caché de 10 min), Compra Ágil (nombre y descripción) y todo lo que haya en el store. Se exigen todas las palabras; no importan tildes ni mayúsculas. Con `region` se omiten las licitaciones v1, porque la API no filtra por región: queda Compra Ágil y el store. Las órdenes de compra solo se buscan por texto si están en el store; si no, usa `listar`. Ordena primero lo abierto por cierre más próximo, y después lo cerrado del más reciente al más viejo.
- **`fetch`** detecta la familia por el código: `1509-5-L114` es licitación, `2097-241-SE26` orden de compra, `1057539-228-COT26` Compra Ágil. Si el código no existe en su familia, prueba en la otra (por eso a veces cuesta 2). Devuelve un resumen legible en `text` y el proceso completo en `metadata`. `search` y `fetch` tienen la forma `{ id, title, url }` que pide el deep research de ChatGPT.

### Trabajos en segundo plano

`sync` y `ocds_importar` responden al tiro con el estado `planificando` y siguen solos. Hay **un trabajo a la vez**: pedir otro mientras corre es un error. El agente consulta con `trabajo_estado` y puede detenerlo con `trabajo_cancelar`; lo ya guardado queda en el store.

- **`sync`** exige `desde` y `maxConsultas`. Antes de lanzar, calcula sin gastar cuánto cuestan solo los listados (un día por fuente de v1, más 1 de Compra Ágil) y se niega si no caben en lo permitido: `maxConsultas`, lo que queda del tope del agente o lo que queda del ticket. La planificación completa ocurre dentro del trabajo y cuenta para `maxConsultas`. Si el plan no cabe, termina `detenido` sin ejecutar nada. Repetirlo con el mismo `desde` retoma donde quedó. Para rangos grandes, usa [`npx mercadopublico sync`](sync.md) en una terminal con `MP_STORE` apuntando al mismo store (ver [Store y variables de entorno](#store-y-variables-de-entorno)).
- **`ocds_importar`** lee el archivo OCDS de un año (unos 186 MB, en streaming) y guarda en el store lo que pasa tus filtros. Exige al menos uno de `q`, `comprador` o `rubro`. `max` va de 1 a 20.000 (5.000 por defecto). Cuesta 0 consultas y no cuenta para el tope. No pisa lo que el store ya tiene de la API, que es más fresco. Ver [OCDS](ocds.md).

### Análisis

Trabajan sobre el store, sin gastar consultas.

- **`competidores`** mezcla OCDS (solo se ve a quien ganó) y Compra Ágil (también los que cotizaron). Los proveedores que parecen persona natural (RUT bajo 50 millones) salen ocultos, salvo el `rut` que pidas; la `lectura` y el `porque` de `radar` los nombran "un proveedor persona natural", nunca por nombre ni RUT.
- **`precios`** usa solo Compra Ágil, y OCDS no la trae: hay que traerla con `sync` y `fuentes: ["compra_agil"]`. Con menos de 10 precios devuelve `insuficiente` y una `pista`.
- **`proximas_compras`** y el filtro `organismos` de `competidores` necesitan el código de organismo, que OCDS no trae: solo cuenta lo traído con `sync`.
- **`radar`** recibe el `perfil` como objeto (no una ruta), con la forma de un `Perfil` ([Radar](radar.md), ejemplo en [`examples/perfil.json`](https://github.com/keroke-ro/mercadopublico/blob/main/examples/perfil.json)). Opcionalmente `decisiones` y `max`.

## Prompts

El servidor ofrece tres prompts:

| Prompt | Para qué |
|---|---|
| `radar-diario` | La agenda de hoy: qué postular primero, a qué precio y qué compras vienen. Argumento: `perfil` (ruta o JSON). Solo con store. |
| `analizar-licitacion` | Resumen, requisitos, fechas, monto, criterios, riesgos y preguntas abiertas de un proceso. Argumento: `codigo`. |
| `estudiar-competencia` | Quién gana, a qué precios y qué organismos compran en un rubro o con un organismo. Argumentos: `rubro` y `organismo` (al menos uno). |

Solo los clientes de Claude (Claude Code, Claude Desktop, claude.ai) los muestran. Codex y ChatGPT los ignoran. En Claude Code: `/mcp__mercadopublico__analizar-licitacion`.

## Store y variables de entorno

Con `sync`, `ocds_importar` y las herramientas de análisis, el servidor lee y escribe un store local en un archivo JSON, con un lock (`<archivo>.lock`) para que dos procesos no lo escriban a la vez. Por defecto es `~/.mercadopublico/mp.json`, junto a la cuota (`cuota.json`). No depende del directorio de trabajo del cliente, que en Claude Desktop es impredecible.

La CLI (`sync`, `radar`) respeta `MP_STORE`, pero sin ella usa `./mp.json`, que no es este archivo. Para llenar desde una terminal el store que lee el servidor, pasa la misma ruta: `MP_STORE=~/.mercadopublico/mp.json npx mercadopublico sync --desde AAAA-MM-DD`. Los mensajes del servidor (store vacío, `sync` que no cabe) traen ese comando con la ruta real y mencionan primero la herramienta `sync`. Las lecturas del store van de a una (y mientras corre un trabajo leen por su mismo handle), así que varias llamadas en paralelo no se estorban; si el archivo lo tiene otro proceso, la herramienta responde un error corto (`No se pudo abrir el store local`), sin rutas ni datos del lock.

| Variable | Por defecto | |
|---|---|---|
| `MP_TICKET` | (obligatoria) | Ticket de la API |
| `MP_STORE` | `~/.mercadopublico/mp.json` | Archivo del store (la CLI `sync` y `radar` también lo leen; sin él usan `./mp.json`) |
| `MP_MCP_TOPE` | `1000` | Consultas diarias máximas del agente; entero positivo |
| `MERCADOPUBLICO_HOME` | `~/.mercadopublico` | Carpeta de `cuota.json` y del store por defecto |
| `MP_MCP_CLAVE` | (ninguna) | Clave de acceso de `--http` (ver [más abajo](#remoto-y-autohospedado)) |

Una variable vacía cuenta como no definida (Claude Desktop manda `""` por las opciones que dejas en blanco).

## Remoto y autohospedado

claude.ai (web y móvil) y ChatGPT no lanzan procesos en tu máquina: solo llaman, desde su nube, a una URL HTTPS pública. `localhost` no sirve, y no puedes mandar headers propios. Por eso hay que desplegar el servidor tú, con tu ticket, y protegerlo con una clave en la URL.

```sh
MP_TICKET=tu-ticket MP_MCP_CLAVE=$(openssl rand -hex 24) npx mercadopublico mcp --http --puerto 8787
```

Escucha en `127.0.0.1:8787` (`--host` lo cambia). Ponlo detrás de HTTPS (Fly, Render, un VPS con Caddy o nginx). La URL a entregarle al cliente es:

```
https://<host>/mcp/<clave>
```

- **La clave en la URL es un secreto.** Quien la tenga consulta con tu ticket y, con el store, puede lanzar `sync`. Para rotarla, cambia `MP_MCP_CLAVE` y reinicia.
- `MP_MCP_CLAVE` debe tener al menos 16 caracteres, si no el servidor no arranca (error de uso, código 2); `openssl rand -hex 24` da una buena.
- Sin `MP_MCP_CLAVE` el servidor no arranca. `--sin-clave` solo vale con `--host 127.0.0.1`, `localhost` o `::1`.
- Alternativa con header, para clientes que lo permiten: `Authorization: Bearer <clave>`.

```sh
codex mcp add mercadopublico --url https://<host>/mcp --bearer-token-env-var MP_MCP_CLAVE
claude mcp add --transport http mercadopublico https://<host>/mcp --header "Authorization: Bearer <clave>"
```

Para probar sin desplegar, un túnel a tu máquina:

```sh
cloudflared tunnel --url http://localhost:8787
```

Te da una URL `https://….trycloudflare.com`; úsala como `<host>`.

### Conectar el cliente

- **claude.ai:** Settings → Connectors → Add custom connector. Pega la URL con la clave y no configures autenticación.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode, y crea la app con la URL, sin autenticación. El deep research funciona con `search` y `fetch`. ChatGPT pide confirmación en las herramientas que no son de solo lectura (`sync`, `ocds_importar`, `trabajo_cancelar`).

> Estos dos pasos están armados siguiendo la documentación oficial de cada cliente, no los probé en una cuenta real. Los menús cambian seguido: revisa los actuales.

### Cloudflare Workers

El núcleo no importa nada de `node:`, así que corre en un Worker, Deno o Bun con el subpath `mercadopublico/mcp`:

```ts
import { MercadoPublico } from "mercadopublico";
import { crearServidorMcp, manejadorHttp } from "mercadopublico/mcp";

let manejar: ((req: Request) => Promise<Response>) | undefined;
export default {
  fetch: (req: Request, env: { MP_TICKET: string; MP_MCP_CLAVE: string }) =>
    (manejar ??= manejadorHttp(crearServidorMcp({ mp: new MercadoPublico({ ticket: env.MP_TICKET }) }), { clave: env.MP_MCP_CLAVE }))(req),
};
```

Límites: sin `abrirStore` no hay store, así que desaparecen `sync`, `ocds_importar`, `trabajo_*`, `radar`, `competidores`, `proximas_compras` y `precios` (y el prompt `radar-diario`). Quedan `search`, `fetch`, `listar`, `organismos`, `proveedor` y `cuota`. La cuota se cuenta en memoria por isolate, así que puede contar de menos; el 429 de la API sigue siendo el límite real. Si necesitas el store, usa la CLI con `--http`.

## Protocolo

Soporta MCP 2025-03-26, 2025-06-18, 2025-11-25 y 2026-07-28: responde `initialize` a los clientes de siempre y `server/discover` a los de la spec nueva (sin sesión). Transportes: stdio (un JSON-RPC por línea) y Streamable HTTP en su forma más simple: solo `POST`, un mensaje por pedido (sin batch), siempre respuesta `application/json`. No hay SSE ni `Mcp-Session-Id`. Un `GET` da 405 y un `Origin` presente da 403.

## Límites

- Las herramientas que consultan la API van de a una y a ~1 consulta por segundo. Un `search` o `fetch` tarda segundos; un `sync` de un día, minutos.
- El tope del agente (`MP_MCP_TOPE`) cuenta lo que gastó este servidor, no lo que gastaste tú con la CLI. El ticket sí es uno solo.
- El store es un archivo JSON que se reescribe por lotes. Aguanta decenas de miles de procesos; para más, usa el store de Postgres desde código ([Sync](sync.md)).
- Un trabajo en segundo plano vive en la memoria del servidor. Si lo reinicias, se pierde el estado (lo ya guardado sigue en el store y un nuevo `sync` retoma). Al cerrarse la entrada (stdio) o con Ctrl-C/SIGTERM (`--http`), el servidor aborta el trabajo en curso y suelta el lock del store antes de salir.
- Todas las herramientas informan `costo`, también cuando fallan (en `structuredContent.costo` y al final del texto del error). `maxConsultas` y el `costo` de cada llamada siguen contando si el día cambia (medianoche de Santiago) a mitad de camino; lo gastado antes de medianoche dentro de esa misma llamada o paso no se suma.
- `--http` rechaza con 413 los cuerpos de más de 1 MB.

## Problemas frecuentes

| Síntoma | Causa y salida |
|---|---|
| `Falta el ticket: usa --ticket o la variable de entorno MP_TICKET` | El cliente no pasó `MP_TICKET`. Agrégalo en `env` o en la configuración de la extensión. |
| `No se pudo abrir el store local` | Un `npx mercadopublico sync` (u otro servidor MCP) tiene el store (`<archivo>.lock`). Espera a que termine, o usa otro `MP_STORE`. Si no hay nada corriendo, borra el `.lock` junto al archivo. |
| `Se alcanzó el tope diario del agente` | Llegó a `MP_MCP_TOPE`. Súbelo y reinicia el servidor, o sigue desde la terminal con `npx mercadopublico …`. Reiniciar también lo pone en cero. |
| `Ya hay un trabajo en curso` | Consulta `trabajo_estado`, o detenlo con `trabajo_cancelar`. |
| `el store está vacío` | Trae datos antes con las herramientas `ocds_importar` (licitaciones y órdenes de compra) o `sync` (Compra Ágil y lo reciente), o desde una terminal con `MP_STORE=<misma ruta> npx mercadopublico sync --desde AAAA-MM-DD`. |
| `MP_MCP_CLAVE debe tener al menos 16 caracteres` | Con `--http`, la clave es muy corta. Genera una con `openssl rand -hex 24`. |
| 401 por HTTP | La clave de la URL o el Bearer no calzan con `MP_MCP_CLAVE`. |
