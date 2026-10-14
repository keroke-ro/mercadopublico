# Testing

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md) · [Resiliencia](resiliencia.md)

Casi todo se prueba sin llamar a la API: con fixtures, un `fetch` falso y un reloj inyectado. Solo tres cosas gastan consultas reales: el contrato nocturno, el smoke semanal y la grabación del corpus. Las tres comparten la cuota diaria de 10.000 del ticket con todo lo demás que hagas con él.

## Qué corre dónde

| Qué | Comando | Local | CI en cada PR | Programado | Consultas reales |
|---|---|---|---|---|---|
| Unitarios, propiedades, corpus, caos y superficie pública | `npm test` | sí | job `test`, Node 20, 22 y 24 | — | 0 |
| Typecheck | `npm run typecheck` | sí | job `test` | — | 0 |
| Tests de tipos | `npm run test:tipos` | sí | job `calidad` | — | 0 |
| Cobertura con umbrales | `npm run cobertura` | sí | job `calidad` | — | 0 |
| Paquete | `npm run paquete` | sí | jobs `calidad` (Node) y `runtimes` (Bun y Deno) | — | 0 |
| Mutación | `npm run mutacion` | lento, opcional | — | lunes 07:00 UTC (`mutacion.yml`) | 0 |
| Contrato | `npm run contrato` | con tu ticket | — | todas las noches, 06:00 UTC (`contrato.yml`) | 13; peor caso 39, tope 50 |
| Smoke | `npm run build && npm run smoke` | con tu ticket | — | miércoles 12:00 UTC (`smoke.yml`) | 30 o menos |
| Corpus real | `node --experimental-strip-types scripts/muestras.ts` | a mano | — | — | 120 o menos, sumando todas las corridas |
| Fixtures del contrato | `npm run fixtures:grabar` | a mano | — | — | igual que el contrato |

El CI corre en cada PR y en cada push a `main`. Los jobs programados también se lanzan a mano desde la pestaña Actions. Sin el secreto `MP_TICKET`, el contrato y el smoke terminan en verde sin hacer nada.

Los scripts con `--experimental-strip-types` piden Node 22.6 o superior.

## Unitarios

`test/*.test.ts`. `Transporte` acepta `fetch`, `ahora` y `dormir` inyectables, así que el backoff, el ritmo, el circuito y el cambio de día de la cuota se prueban sin esperar ni un milisegundo real. Fixtures en `test/fixtures/{v1,v2,ocds}`: los `.real.json` son respuestas reales anonimizadas y el resto está reconstruido desde la documentación oficial.

`test/sync-reanudar.test.ts` corta el sync en cada escritura posible del store, antes y después del rename, y comprueba que reanudar deja el store igual que una corrida sin cortes.

## Propiedades

`test/propiedades`, con [fast-check](https://fast-check.dev/):

- **Parsers:** con JSON arbitrario y con fixtures mutados, nunca lanzan y siempre devuelven un `Proceso` bien formado.
- **Fechas:** cada hora de 2025 a 2027 va y vuelve entre hora de Santiago e instante, cambios de horario incluidos.
- **Datos personales:** el texto libre pierde los correos y teléfonos, y nada más (RUT, fechas y códigos quedan intactos). `ocultarPersonales` no deja rastros.
- **Números y montos**, y **radar** (puntajes acotados, orden estable).

```sh
npx vitest run test/propiedades
```

Si una propiedad falla, fast-check imprime el contraejemplo mínimo junto con `seed` y `path`. Para reproducirlo, pásalos a `fc.assert(…, { seed, path })`.

## Corpus real y snapshots

`test/fixtures/muestras` tiene 59 respuestas reales anonimizadas (41 licitaciones y 18 órdenes de compra, grabadas el 2026-10-13 con 85 consultas), elegidas para cubrir tipos, estados y monedas. `indice.json` resume la cobertura y las notas de la grabación. Las 4 muestras de Compra Ágil (`v2/`) se agregaron el 2026-10-14 con `--solo-v2`. Los detalles `cerrada` dieron 504, y `estado=proveedor_seleccionado` no devuelve nada, así que la muestra con cotizaciones sale de un código conocido.

`test/muestras.test.ts` pasa cada muestra por el parser público y exige que no lance, que el código calce, que el estado sea conocido (o la glosa que mandó la API), que las fechas tengan offset, que los montos sean finitos y que cada ruta de `personales` exista en `raw`. El resultado, sin `raw`, queda en `test/__snapshots__/muestras/<codigo>.json`: cualquier cambio de un parser aparece como diff en el PR.

Si cambiaste un parser a propósito:

```sh
npx vitest run test/muestras.test.ts -u
git diff test/__snapshots__/muestras   # revisa que el cambio sea el que querías
```

### Agrandar el corpus

```sh
export MUESTRAS_CACHE="$HOME/mp-muestras-crudas"   # fuera del repo
MP_TICKET=... node --experimental-strip-types scripts/muestras.ts
npx vitest run test/muestras.test.ts -u
rm -rf "$MUESTRAS_CACHE"
```

- Lista días hábiles recientes, elige códigos que sumen tipos, estados y monedas nuevos, y pide su detalle. Escribe las muestras elegidas y reescribe `indice.json`; no borra las que ya estaban.
- **Presupuesto:** 120 consultas como máximo, sumando todas las corridas. La cuenta vive en `$MUESTRAS_CACHE/consultas.json`. Va de a una, con 2 s de pausa y hasta 3 intentos. Lo que gasta se suma a `~/.mercadopublico/cuota.json`, igual que la CLI.
- **`--solo-v2`:** no vuelve a pedir la v1. Pide un listado de Compra Ágil por estado y algunos detalles (unas 10 consultas), y suma las muestras al `indice.json` que ya existe.
- **Caché:** cada respuesta cruda se guarda en `$MUESTRAS_CACHE` (por defecto `mercadopublico-muestras` dentro de `os.tmpdir()`), así que volver a correrlo no gasta cuota. Un fallo también queda en caché: borra ese archivo para reintentarlo.
- **Borra el caché al terminar.** Tiene las respuestas sin anonimizar, con nombres, RUT, correos y teléfonos de funcionarios. Ojo: borrarlo también reinicia la cuenta del tope.

### Reglas para anonimizar

Antes de escribir cada muestra, `scripts/muestras.ts`:

- Reemplaza por `"[oculto]"` los campos de funcionarios, por nombre de clave: `RutUsuario`, `CodigoUsuario`, `NombreUsuario`, `CargoUsuario`, `NombreResponsablePago`, `EmailResponsablePago`, `NombreResponsableContrato`, `EmailResponsableContrato`, `FonoResponsableContrato`, `NombreContacto`, `CargoContacto`, `FonoContacto`, `MailContacto` y `contactPoint`. En la v2, también `rut_proveedor` y `razon_social`.
- Tapa nombre, RUT, dirección y códigos de un proveedor persona natural (RUT bajo 50.000.000).
- En todo texto libre tapa:
  - correos, también con un espacio antes de la `@`;
  - teléfonos chilenos de 9 dígitos, con o sin +56, y cualquier número después de "fono", "tel.", "cel.", "anexo" o "whatsapp";
  - nombres después de rótulos como "contacto", "Sr.", "Sra.", "don", "encargado", "a cargo de" o "referente" (hasta 4 palabras con mayúscula, salvo que la primera sea BODEGA, UNIDAD, DEPARTAMENTO y similares);
  - firmas en mayúscula con inicial ("LUIS ARAYA C.").
- Reemplaza cada línea de `$MUESTRAS_CACHE/ocultar.txt`, un texto literal por línea, para los nombres sueltos que las reglas no detectan.
- Corta cada arreglo a 20 elementos y marca el archivo con `"_fixture": "grabado de la API real el AAAA-MM-DD"`.

Las reglas no son perfectas. Revisa a mano lo que cambió antes de hacer commit; por ejemplo, `git diff test/fixtures/muestras | grep -n '@'`. Nunca hagas commit de una respuesta cruda.

## Caos

`test/caos` levanta un servidor HTTP local de verdad (en `127.0.0.1`, sockets y reloj reales) que hace de v1, v2, conversores de montos y OCDS, y apunta el cliente a él. El servidor inyecta las fallas que se ven en la API real: tormentas de 10500, 5xx, HTML de mantención, respuestas lentas, cuerpos cortados a la mitad. Los tests comprueban que el SDK termine con el `tipo` de error correcto, que nunca haya dos consultas en vuelo, que la cuota cuente lo que de verdad salió, que cancelar no deje timers ni listeners colgando y que un sync con `storeArchivo` cortado a mitad de camino se reanude sin huecos. No sale a internet.

```sh
npx vitest run test/caos
```

Va fuera de la prueba de mutación porque es lento.

## Tipos y superficie pública

- `npm run test:tipos` corre `test/**/*.test-d.ts` con `expectTypeOf`. Falla si cambia la forma pública de los tipos: el estrechamiento de `Proceso` por `tipo`, lo que devuelve cada método, la unión de `TipoError`…
- `test/paquete/superficie.test.ts` fija los nombres que exportan `mercadopublico` y `mercadopublico/radar`. Agregar o quitar un export obliga a tocar esa lista en el mismo PR (ver [CONTRIBUTING](https://github.com/keroke-ro/mercadopublico/blob/main/CONTRIBUTING.md)).

## Paquete

`npm run paquete` (`scripts/paquete.mjs`) revisa el paquete tal como llega a npm: build, `publint --strict`, `attw --pack` y `npm pack`. Después instala el tarball en un proyecto temporal y comprueba:

- que ESM y CJS (`mercadopublico` y `mercadopublico/radar`) exporten lo mismo;
- que el bin responda a `--ayuda` y `cuota`;
- que Bun y Deno, si están en el PATH, importen lo mismo;
- que funcione en un entorno tipo edge: `node:vm` sin `process`, `Buffer` ni `require`, solo APIs web.

En el CI, `calidad` lo corre con Node y `runtimes` con Bun y con Deno.

## Cobertura

`npm run cobertura` mide `src/**` con v8 y falla bajo estos umbrales:

| statements | branches | functions | lines |
|---|---|---|---|
| 85 | 80 | 85 | 88 |

Son lo medido el 2026-10-13 (88,5 / 83,6 / 88,3 / 91,5) menos unos 3 puntos. Si la cobertura sube, sube los umbrales en `vitest.config.ts`.

## Mutación

`npm run mutacion` corre [Stryker](https://stryker-mutator.io/) sobre lo que más cuesta si falla en silencio: `src/http.ts`, `src/sync.ts`, `src/personales.ts`, `src/monto.ts`, `src/fecha.ts` y `src/util.ts`. Un mutante que sobrevive es un cambio al código que ningún test nota.

| Puntaje | |
|---|---|
| 80 o más | bien |
| 60 a 80 | aceptable |
| bajo 60 | bajo |
| bajo 50 | el job falla (`break` en `stryker.config.json`) |

El reporte queda en `reports/mutation/index.html` (y `mutation.json`); en el workflow, como artefacto `mutacion`. Los tests escritos para matar mutantes que sobrevivieron van en `test/mutacion/`. Con `concurrency: 4` tarda bastante: córrelo en local solo si tocaste esos archivos.

## Contrato nocturno

Compara la forma de las respuestas reales con los fixtures y abre un issue si algo cambió. Detalle en [Contrato](contrato.md).

## Smoke semanal

`scripts/smoke.ts` usa el paquete ya construido (`dist/`) de punta a punta contra la API real:

1. Licitaciones activas y 2 detalles.
2. Órdenes de compra de ayer y 1 detalle.
3. Página 1 de Compra Ágil.
4. Sync de las OC del último domingo, sin detalle, a un `storeArchivo` temporal.
5. `conversorPorDefecto` con UF y dólar de un día hábil.

Crea el cliente con `limiteDiario: 30`, así que no puede pasar de 30 consultas. Imprime un resumen en markdown y sale con 1 solo ante una falla real. La v2 caída, la red, los reintentos agotados, `circuito_abierto` o `cuota_agotada` quedan como "degradado".

```sh
npm run build
MP_TICKET=... npm run smoke
```
