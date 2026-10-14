# PRD: `mercadopublico`, SDK TypeScript para Mercado Público

KeroKero · Pony · 14-oct-2026 · Estado: borrador para que Damián decida
Repo: github.com/keroke-ro/mercadopublico (privado) · npm: `mercadopublico` (reservado)

## 1. Problema

Más de 850 organismos del Estado compran en Mercado Público y le compran a más de 118.000 proveedores, de los que el 91% son mypes (según el diccionario oficial de ChileCompra). La API es gratis, pero cuesta usarla bien:

- **Hay tres APIs distintas:**
  - v1 de licitaciones y órdenes de compra: el ticket va en la URL, las fechas en `ddmmaaaa` y los campos en PascalCase.
  - v2 de Compra Ágil: el ticket va en un header, la respuesta viene en `{success, payload, errors}`, los campos en snake_case y es paginada.
  - Las descargas OCDS: archivos `.jsonl.gz` de hasta 2,9 GB.

  Las tres describen el mismo mundo con modelos distintos.
- **El ticket es uno por persona**, con 10.000 consultas por día calendario. Si se agota, la API responde 429. Si se le mandan consultas simultáneas, responde 10500. Además vigila por IP.
- **La documentación se contradice entre sí y con lo que entrega la API.** Ejemplos verificados en los PDF oficiales:
  - `Obras` vale 0 o 2, no 0 o 1.
  - El PDF lista los tipos LQ, LR, H2 e I2, que la página web no menciona.
  - En Compra Ágil, `codigo_orden_compra` viene en `null` aunque la orden se haya emitido.
- **Los montos vienen en CLP, CLF (UF), UTM, USD o EUR.** Para comparar dos licitaciones hay que convertir con el valor de la fecha correspondiente.

Hoy cada equipo que quiere vigilar licitaciones vuelve a escribir lo mismo: el cliente HTTP, la cola, los reintentos, el parser y la conversión de monedas.

## 2. Lo que ya existe (verificado el 13 y 14 de octubre de 2026)

| Librería | Qué hace bien | Qué le falta |
|---|---|---|
| chile-public-market-sdk (Python, PyPI 1.0.1, 13 estrellas) | Tipado con pydantic, versión síncrona y asíncrona, v1 y Compra Ágil, tests de contrato | No reintenta ni controla la cuota: su README dice "inject your own HTTPX client". Tampoco trae OCDS, normalización de montos ni sincronización incremental. |
| chilecompra-sdk, apimercadopublico, mercado-publico-api-v2-wrapper (npm) | Cubren endpoints básicos | De 0 a 4 estrellas, sin tests y con unas 20 a 60 descargas al mes. |
| mercadopublico-parser (TS) | Zod, CLI, clasificación | No está en npm y declara 0 tests. |
| 3 servidores MCP | Les dan la API a los agentes | Son capas delgadas, sin cuota ni modelo propio. |

En TypeScript no hay nada serio, y en ningún lenguaje hay algo que vaya más allá de envolver la API.

## 3. Propuestas diferenciadoras

1. **Un solo modelo para las tres fuentes.** Licitación, orden de compra y Compra Ágil se vuelven `Proceso`, un tipo con discriminante (`tipo: "licitacion" | "orden_compra" | "compra_agil"`). Da lo mismo si los datos vienen de la v1, de la v2 o de OCDS: el código del usuario no cambia. Esto es lo que nos protege cuando llegue la API nueva de ChileCompra (licitación 869591-10-LP26), porque se cambia el transporte y no el modelo.
2. **Uso consciente de la cuota.**
   - El SDK lleva la cuenta del día y la expone (`client.cuota.restante`).
   - Antes de una operación grande avisa cuánto va a gastar. Por ejemplo, "este sync gasta unas 1.240 consultas", y si no alcanza falla antes de empezar, no a mitad de camino.
   - Las consultas pasan por una cola serial, para que nunca se crucen y disparen el 10500.
   - Los reintentos usan backoff exponencial con jitter, y solo ante 10500, 5xx o un corte de red. Nunca reintenta ante ticket inválido, 404 o un 429 por cuota agotada.
3. **Sincronización incremental como primitiva.** Una llamada `sync({desde, store})` mantiene al día una base local:
   - Para la v2 usa `cambio_desde` y `fecha_ultimo_cambio`.
   - Para la v1 recorre día por día.
   - Un proceso cerrado no se vuelve a consultar, gracias a una caché por estado.
   - El `store` se puede cambiar: memoria y archivo en la v1, Postgres después.
4. **Normalización honesta.**
   - Cada monto se guarda como `{valor, moneda, clp, fechaValor, fuente}`. La conversión de UF y UTM se hace con el valor del día del documento, no con el de hoy.
   - Cada fecha se guarda como ISO con offset de America/Santiago.
   - Los códigos se convierten en enums con su glosa, y los errores de la documentación quedan corregidos en un solo lugar, con un test que lo prueba.
5. **Datos personales protegidos por defecto.** La v1 trae nombre, RUT, correo y teléfono de funcionarios: `RutUsuario`, `NombreUsuario`, `EmailResponsablePago`, `FonoResponsableContrato`, entre otros.
   - El SDK los marca como datos personales y la CLI y las exportaciones los ocultan salvo que se pida lo contrario (`--incluir-personales`).
   - La Ley 21.719 de datos personales empieza a regir en diciembre de 2026. Hay que confirmar la fecha y el alcance con un abogado.
   - Nadie más resuelve esto, y es un argumento de confianza para clientes grandes.
6. **Contrato vigilado todas las noches.** Un job de CI llama a la API real con pocas consultas, compara los resultados con los fixtures y abre un issue si cambia algo (un campo nuevo, un tipo distinto, uno que desaparece). En el README va un badge "compatible con la API al día X". Esto convierte el mantenimiento en algo visible y medible.
7. **Una capa de decisión (lo que hace KeroKero).** Va en `mercadopublico/radar` y son ejemplos abiertos con datos públicos:
   - `priorizar(procesos, perfil)`: devuelve una cola de oportunidades ordenada, con la razón de cada lugar. El orden sale de una suma ponderada y explícita:

     `puntaje = Σ wᵢ · fᵢ`

     Los factores fᵢ ∈ [0, 1] son el calce de rubro (UNSPSC), la región, el monto dentro del rango de la empresa, los días al cierre y la competencia esperada. Los pesos wᵢ los define el usuario, y no hay caja negra.
   - `rangoDePrecio(codigoProducto)`: usa las cotizaciones que trae el detalle de Compra Ágil (`productos_cotizados[].precio_unitario`) y entrega los percentiles p25, p50 y p75 junto con n. Si n es menor que 10, dice "muestra insuficiente" en vez de inventar un rango. Supuestos: los precios son netos y del mismo producto y unidad, y la muestra solo incluye a quienes cotizaron. Para estimar cuánto suele ganar se usan solo las cotizaciones seleccionadas.

   El criterio de cada cliente nunca va al repo. Esto es la vitrina y no el producto.
8. **Cero dependencias en runtime.** Usa `fetch` nativo, funciona en Node 20+, Bun, Deno y edge, y se publica como ESM y CJS. Trade-off: escribimos nuestros parsers en vez de usar zod. Ganamos peso y control, y a cambio perdemos validación declarativa. Los parsers son tolerantes: si llega un campo desconocido lo guardan en `raw` en vez de romper, porque esta API cambia sin avisar.

## 4. Alcance

**v1.0 incluye:**
- API v1 completa:
  - Licitaciones por código, fecha, estado, organismo y proveedor.
  - Órdenes de compra con los mismos filtros.
  - `BuscarProveedor` y `BuscarComprador`.
- API v2 de Compra Ágil: listado paginado con todos los filtros, más el detalle.
- Lector OCDS en streaming (`.jsonl.gz`) que entrega `Proceso`.
- Cuota, cola, reintentos, caché y `sync`.
- Normalización de montos y fechas, y datos personales ocultos.
- CLI (`npx mercadopublico …`) con salida JSON, CSV y tabla.
- Ejemplos de `radar`.
- Documentación en un sitio estático y una página en kerokero.cl.

**Fuera de alcance:**
- SDK en Python (para eso existe el de ezer-mackenzie; si hace falta, le contribuimos).
- Scraping del sitio web de Mercado Público. Solo usamos la API oficial y OCDS.
- Un espejo público o hosting de datos.
- Descargar adjuntos.
- Recomendaciones con machine learning.

**Después (v1.x):** un servidor MCP sobre el SDK, que serían unas 200 líneas reutilizando el SDK, y un `store` para Postgres.

## 5. API propuesta (borrador)

```ts
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });

const activas = await mp.licitaciones.activas();           // 1 consulta
const lic = await mp.licitaciones.porCodigo("1509-5-L114");
lic.montoEstimado; // { valor: 1200, moneda: "CLF", clp: 47_000_000, fechaValor: "2026-10-01", fuente: "..." }

for await (const ca of mp.compraAgil.listar({ region: [13], estado: ["publicada"] })) { /* pagina sola */ }

const plan = await mp.sync.planificar({ desde: "2026-10-01" }); // { consultas: 1240, cabeHoy: true }
await mp.sync.ejecutar(plan, { store });

mp.cuota; // { usadas: 1302, limite: 10000, reinicia: "2026-10-15T00:00:00-03:00" }
```

## 6. Estimación

Supuesto: un desarrollador senior a tiempo completo, con Pony revisando el diseño, la matemática y el código. Son semanas de desarrollo y no incluyen las esperas por ChileCompra.

| Hito | Contenido | Semanas |
|---|---|---|
| M0 Validación | Ticket, grabar fixtures reales (v1, v2 y OCDS), confirmar en qué zona horaria se reinicia la cuota, consultar a ChileCompra sobre la librería, armar el esqueleto (TS, tsup, vitest, CI, changesets) | 1 |
| M1 Cliente (v0.1) | v1 y v2 tipados, errores tipados, enums corregidos, tests con fixtures. **Aquí se hace público el repo.** | 2,5 |
| M2 Resiliencia (v0.2) | Cuota, cola, reintentos, caché, `sync` con planificación, CLI, contrato nocturno | 1,5 |
| M3 Datos (v0.3) | Modelo `Proceso`, lector OCDS en streaming, normalización de montos y fechas, datos personales ocultos | 2,5 |
| M4 Decisión (v1.0) | `radar` (priorización y rango de precios), documentación, página en kerokero.cl | 2 |
| **Total** | | **≈ 9,5 semanas (≈ 380 h)** |

- Con dedicación de medio tiempo son unos 4 a 5 meses de calendario.
- Margen de riesgo de +30%, porque la API está poco documentada y se descubren cosas al grabar fixtures.
- Rango realista: entre 9,5 y 12,5 semanas.
- Mantenimiento después de la v1.0: unas 2 horas a la semana, más un pico de 1 a 2 semanas cuando ChileCompra saque su API nueva.

## 7. Métricas de éxito (refutables)

Las mediremos a 6 meses de la v1.0. Son metas modestas, y si no se cumplen hay que revisar si conviene seguir:

- Al menos 150 descargas semanales en npm y 50 estrellas en GitHub.
- Al menos 3 contribuidores externos con un PR mergeado.
- Al menos 2 conversaciones comerciales de KeroKero que lleguen por el SDK. Hay que preguntar "¿cómo nos conociste?" en el diagnóstico.
- Si la API cambia, el contrato nocturno lo detecta en menos de 24 horas.

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| La API nueva de ChileCompra deja obsoleta la v1 | Modelo `Proceso` separado del transporte, con un adaptador por versión |
| Los términos no permiten publicar una librería | Consultar en M0, antes de hacer público el repo |
| El ticket de CI es personal (el de Damián) y se gasta cuota | Guardarlo como secreto de GitHub y limitar el job nocturno a 50 consultas o menos. Más adelante, pedir un ticket institucional (la doc v2 dice que existen límites mayores) |
| Bloqueos por IP desde GitHub Actions | Pocas consultas y serializadas. Si bloquean, correr el job desde un runner propio |
| Datos personales de funcionarios | Ocultos por defecto y revisión con abogado |
| Repo abandonado que daña la marca | Un responsable con nombre, el badge de contrato y una política escrita de versiones |

## 9. Decisiones pendientes (Damián)

1. ¿Quién es el responsable del mantenimiento y quién lo implementa? (Propongo a Lautaro como responsable y a un dev fullstack para implementar.)
2. ¿Dedicación completa o a medio tiempo? Eso define si son 2,5 o 5 meses.
3. ¿`radar` queda abierto en el repo? Mi voto es sí, pero solo con datos públicos.
4. ¿Pedimos un ticket institucional de KeroKero a ChileCompra?

Fuentes: Diccionario de datos de Licitaciones y de OC (chilecompra.cl/wp-content/uploads/2026/03/), Guía API Compra Ágil v2 v3.0 (mayo 2026, chilecompra.cl/wp-content/uploads/2026/05/), https://www.chilecompra.cl/api/, data.open-contracting.org/en/publication/144, y los README de los repos citados.
