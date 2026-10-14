# Cómo contribuir

## Setup

Node 20 o superior (22.6+ para los scripts de contrato).

```sh
git clone https://github.com/keroke-ro/mercadopublico.git
cd mercadopublico
npm ci
npm test            # vitest, con fixtures; no llama a la API
npm run typecheck
npm run build       # dist/ con tsup (ESM, CJS y tipos)
```

Para probar contra la API real necesitas tu propio ticket en `MP_TICKET`. Ver [docs/contrato.md](docs/contrato.md).

## Cambios

Todo PR que cambie lo que se publica lleva un changeset:

```sh
npx changeset
```

Elige el tipo de versión (ver [Versiones](#versiones)) y escribe en una o dos líneas qué cambia para quien usa la librería. El CI corre typecheck, tests y build en Node 20, 22 y 24.

## Reglas

- **Cero dependencias en runtime.** Solo `fetch`, `Intl`, `DecompressionStream` y lo que traiga la plataforma. Las devDependencies se discuten caso a caso.
- **Parsers tolerantes.** Un parser nunca lanza por un campo raro: lo que no entiende queda en `null` y en `raw`. La API cambia sin avisar.
- **Las correcciones a la documentación oficial van en `src/v1/codigos.ts`**, con un comentario que diga qué fuente dice qué, y un test en `test/codigos.test.ts`. En ningún otro lugar.
- **Nunca hagas commit de datos personales ni de tickets.** Los fixtures grabados se revisan a mano antes de subirlos (ver [docs/contrato.md](docs/contrato.md#grabar-fixtures-reales)).
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
