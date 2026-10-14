# Cómo contribuir

## Setup

Node 20 o superior (22.6+ para los scripts que corren con `--experimental-strip-types`).

```sh
git clone https://github.com/keroke-ro/mercadopublico.git
cd mercadopublico
npm ci
npm test            # vitest, con fixtures; no llama a la API
npm run typecheck
npm run build       # dist/ con tsup (ESM, CJS y tipos)
```

| Script | Qué hace | ¿Llama a la API? |
|---|---|---|
| `npm test` | Unitarios, propiedades, corpus con snapshots, caos y superficie pública | No |
| `npm run test:tipos` | Tests de tipos (`test/**/*.test-d.ts`) | No |
| `npm run cobertura` | Tests con cobertura; falla bajo los umbrales de `vitest.config.ts` | No |
| `npm run paquete` | Build, publint, attw y el tarball importado desde Node ESM/CJS, el bin, Bun, Deno y un entorno edge | No |
| `npm run mutacion` | Stryker sobre http, sync, personales, monto, fecha y util. Lento | No |
| `npm run contrato` | Compara la forma de la API real con los fixtures | Sí, 13 a 39 |
| `npm run fixtures:grabar` | Graba los fixtures `.real.json` del contrato | Sí, igual |
| `npm run smoke` | El paquete construido contra la API real (antes, `npm run build`) | Sí, 30 o menos |
| `node --experimental-strip-types scripts/muestras.ts` | Agranda el corpus de muestras reales | Sí, 120 o menos en total |

Para lo que llama a la API necesitas tu propio ticket en `MP_TICKET` (o en un `.env`). Qué corre en cada PR y qué una vez por semana o por noche, en [docs/testing.md](docs/testing.md).

## Cambios

Todo PR que cambie lo que se publica lleva un changeset:

```sh
npx changeset
```

Elige el tipo de versión (ver [Versiones](#versiones)) y escribe en una o dos líneas qué cambia para quien usa la librería. El CI corre typecheck, tests y build en Node 20, 22 y 24, y además cobertura, tests de tipos y el paquete en Node, Bun y Deno.

- **Superficie pública:** si agregas, quitas o renombras un export de `mercadopublico` o `mercadopublico/radar`, actualiza la lista de `test/paquete/superficie.test.ts` en el mismo PR. Ese test existe para que ningún export cambie sin que alguien lo decida: quitar o renombrar uno rompe compatibilidad (ver [Versiones](#versiones)). Si cambia la forma de un tipo público, ajusta `test/tipos.test-d.ts`.
- **Snapshots del corpus:** si cambias un parser y cambia lo que sale de una muestra real, regenera con `npx vitest run test/muestras.test.ts -u` y revisa el diff de `test/__snapshots__/muestras` antes de subirlo. Un diff que no esperabas es un bug, no un snapshot viejo.

## Reglas

- **Cero dependencias en runtime.** Solo `fetch`, `Intl`, `DecompressionStream` y lo que traiga la plataforma. Las devDependencies se discuten caso a caso.
- **Parsers tolerantes.** Un parser nunca lanza por un campo raro: lo que no entiende queda en `null` y en `raw`. La API cambia sin avisar.
- **Las correcciones a la documentación oficial van en `src/v1/codigos.ts`**, con un comentario que diga qué fuente dice qué, y un test en `test/codigos.test.ts`. En ningún otro lugar.
- **Nunca hagas commit de datos personales ni de tickets.** Los fixtures grabados se revisan a mano antes de subirlos (ver [docs/contrato.md](docs/contrato.md#grabar-fixtures-reales)).
- **Nunca hagas commit de respuestas crudas de la API.** Todo lo que entra a `test/fixtures` pasa antes por la anonimización de `scripts/contrato.ts` (campos de funcionarios por nombre de clave, y correos y teléfonos en texto libre) o de `scripts/muestras.ts` (además, proveedores persona natural con RUT bajo 50 millones y nombres después de rótulos como "contacto" o "Sra."; reglas completas en [docs/testing.md](docs/testing.md#reglas-para-anonimizar)). Las reglas no atrapan todo: revisa el diff a mano y agrega a `ocultar.txt` lo que se escape. El caché crudo de `scripts/muestras.ts` (`$MUESTRAS_CACHE`) vive fuera del repo; bórralo al terminar.
- **Lo que no esté verificado contra la API real se marca como tal**, en el código y en [docs/api-notes.md](docs/api-notes.md).

## Versiones

Seguimos [semver](https://semver.org/lang/es/). Lo que más protegemos es el modelo `Proceso`: es lo que el código de quien usa la librería toca, venga el dato de v1, v2 u OCDS.

**Rompe compatibilidad (major):**

- Quitar, renombrar o cambiar el tipo o el significado de un campo de `Proceso`, `Monto`, `Comprador`, `Item`, `Cotizacion` u otro tipo exportado. Por ejemplo, que `monto` deje de ser el monto estimado de una licitación.
- Cambiar un slug de `estado` existente.
- Quitar un export o cambiar la firma de un método público.
- Cambiar la interfaz `Store` o lo que se guarda en un cursor.
- Quitar o renombrar un comando o una opción de la CLI.

**No rompe (minor o patch):**

- Agregar campos opcionales, exports, métodos, filtros o comandos (minor).
- Agregar códigos a las tablas de `codigos`: son abiertas y un código desconocido nunca es error (minor).
- Corregir una glosa o un parser para que coincida con la API real (patch).
- Cambios en `raw`: refleja la API tal cual y no tiene garantías.

Mientras estemos en 0.x, un cambio que rompe sube la versión menor (0.1 → 0.2) y el changeset lo dice en la primera línea. Desde la 1.0, semver estricto.

### Publicar el servidor MCP

`mercadopublico mcp` sale en npm, en el MCP Registry y como extensión de Claude Desktop (`mercadopublico.mcpb`). Al hacer la release:

1. Sube `version` en `server.json` (la de arriba y la de `packages[0]`) a la de `package.json`. Changesets solo toca `package.json`, así que es un paso manual. `npm run mcpb` falla si no coinciden.
2. Publica en npm (`npm run release`).
3. `npm run mcpb` y adjunta `mercadopublico.mcpb` al GitHub Release.
4. `mcp-publisher login github` y `mcp-publisher publish` desde la raíz. El registry exige que la versión ya esté en npm con el mismo `mcpName`.
