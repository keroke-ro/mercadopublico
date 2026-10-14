# Contrato nocturno

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md)

La API de Mercado Público cambia sin avisar. Todas las noches, el workflow [`contrato`](https://github.com/keroke-ro/mercadopublico/actions/workflows/contrato.yml) llama a la API real con pocas consultas y compara la forma de las respuestas con los fixtures de `test/fixtures`. Si algo cambió, abre un issue y el badge del README se pone rojo.

## Qué revisa

Corre a las 06:00 UTC (3 de la mañana en Chile en horario de verano, 2 en invierno) y también a mano desde la pestaña Actions (`workflow_dispatch`).

| Caso | Consultas |
|---|---|
| v1 licitaciones activas | 1 |
| v1 detalle de 3 licitaciones | 3 |
| v1 órdenes de compra de ayer | 1 |
| v1 detalle de 3 OC | 3 |
| v1 BuscarComprador | 1 |
| v2 listado de Compra Ágil | 1 |
| v2 detalle de 3 Compra Ágil | 3 |

Son 13 consultas, de a una y con 2 segundos de pausa entre ellas. Con un máximo de 2 reintentos por consulta, el peor caso son 39, bajo el tope de 50 que nos pusimos.

Compara rutas y tipos JSON, no valores:

- **agregado:** un campo que no está en el fixture.
- **eliminado:** un campo del fixture que no llegó, solo si su objeto padre sí llegó.
- **tipo cambiado:** por ejemplo, de `number` a `string`. `null` es compatible con cualquier tipo.

Si hay diferencias o un caso falla, el job comenta en el issue abierto con la etiqueta `contrato` o crea uno nuevo, y termina en rojo. El reporte también queda en el resumen de la ejecución.

## Configurar el ticket

El workflow lee el ticket del secreto `MP_TICKET`. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**, nombre `MP_TICKET`. O con la CLI de GitHub:

```sh
gh secret set MP_TICKET --repo keroke-ro/mercadopublico
```

Sin el secreto, el job deja un aviso y termina en verde sin revisar nada. Ojo: el badge se ve verde igual.

El ticket es personal y comparte cuota con todo lo que hagas con él ese día. Por eso el job gasta 50 consultas o menos.

## Correrlo en local

Necesita Node 22.6 o superior (usa `--experimental-strip-types`):

```sh
MP_TICKET=... npm run contrato
```

Imprime el reporte en markdown y sale con 1 si hay diferencias.

## Grabar fixtures reales

Hasta ahora los fixtures están reconstruidos desde la documentación oficial (llevan `"_fixture": "reconstruido…"`). Para grabarlos con respuestas reales:

```sh
MP_TICKET=... npm run fixtures:grabar
```

- Por cada caso guarda la primera respuesta en `test/fixtures/<caso>.real.json`, con `"_fixture": "grabado de la API real el AAAA-MM-DD"`.
- Desde ahí, el contrato compara contra el `.real.json` cuando existe. Los tests unitarios siguen usando los reconstruidos.
- **Anonimización:** los campos de funcionarios (`RutUsuario`, `NombreUsuario`, `EmailResponsablePago`, `FonoContacto`, `contactPoint`…) se reemplazan por `"[oculto]"` y cada arreglo se corta a 3 elementos.
- **Revisa a mano antes de hacer commit.** No se tapan el RUT ni la razón social de los proveedores (en Compra Ágil, `rut_proveedor` y `razon_social`), que pueden ser de una persona natural. Nunca hagas commit del ticket.
