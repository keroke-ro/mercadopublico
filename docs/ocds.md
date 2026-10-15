# OCDS

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [CLI](cli.md) · [MCP](mcp.md) · [Radar](radar.md) · [Contrato](contrato.md) · [Resiliencia](resiliencia.md) · [Testing](testing.md)

ChileCompra publica el histórico de licitaciones y órdenes de compra en formato [OCDS](https://standard.open-contracting.org/). El espejo de Open Contracting Partnership lo entrega como `.jsonl.gz`, una compiled release por línea: 2026 pesa unos 186 MB y el archivo completo unos 2,5 GB. `leerOcds` lo lee en streaming y entrega `Proceso`, el mismo modelo de la API. No pide ticket ni gasta cuota.

```ts
import { leerOcds, urlOcds } from "mercadopublico";

let n = 0;
for await (const p of leerOcds(urlOcds(2026))) {
  if (p.tipo === "licitacion" && p.estado === "adjudicada") n++;
}
console.log(n, "licitaciones adjudicadas en 2026");
```

## Fuentes

```ts
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { desdeOcds, leerOcds, urlOcds } from "mercadopublico";

urlOcds(2026); // "https://data.open-contracting.org/en/publication/144/download?name=2026.jsonl.gz"
urlOcds("full"); // todo el histórico

// Una URL, una Response o un ReadableStream. El gzip se detecta por los bytes, no por el nombre.
const local = Readable.toWeb(createReadStream("./2026.jsonl.gz")) as ReadableStream<Uint8Array>;
for await (const p of leerOcds(local, { alError: (linea, error, numero) => console.warn("línea", numero, error) })) {
  // …
}

// Un JSON ya parseado: compiled release, record package o release package
// (por ejemplo, cada {codigo}.json de los 7z mensuales del publisher).
const procesos = desdeOcds(JSON.parse(texto));
```

`leerOcds` acepta `{ fetch, signal, alError }`. Una línea que no se puede leer se salta y se avisa en `alError`; no corta la lectura.

Si la descarga se corta a mitad (conexión caída, gzip truncado), `leerOcds` entrega lo que alcanzó a procesarse, en orden, y después lanza el error de la descarga. Lo que ya había llegado pero no se alcanzó a procesar se pierde, así que puede no entregar nada antes del error.

## Lo que hay que saber

- **Solo licitaciones y OC.** Compra Ágil no se publica en OCDS. Una release es OC si el código termina en TD (trato directo) o CM (convenio marco), o si el award dice "Orden de Compra".
- **Montos sin convertir.** Los CLP traen `clp`; para UF, UTM, USD y EUR llama `convertirMontos(p, conversorPorDefecto)`.
- **Comprador:** `codigoOrganismo` queda en `null` porque OCDS no lo trae; `codigoUnidad` es el número de `CL-MP-n`.
- **Datos personales:** `parties[].contactPoint` y los nombres de persona natural que aparecen en `suppliers[].name` ("EMPRESA | Nombre Apellido") van a `personales`. `ocultarPersonales` tapa en `raw` el `contactPoint` y cada ruta anotada en `personales` (los `name` y el RUT de persona natural en `parties`, `tenderers` y `suppliers`). Se considera persona natural un RUT bajo 50 millones o un nombre "EMPRESA | Persona" con partes distintas; sin RUT, un "JUAN PEREZ | JUAN PEREZ" se escapa.
- **El espejo se actualiza cada unos 6 meses.** Para lo reciente usa la API o `sync`.

## Fechas

Las fechas OCDS de ChileCompra traen sufijo `Z`, pero no está claro si son UTC reales o la hora de Santiago etiquetada como UTC. El SDK las lee como hora de Santiago (descarta la `Z`), porque la base de ChileCompra guarda hora local sin huso y así el día queda tal como se publicó. Si fueran UTC reales, las horas quedarían corridas en 3 o 4 horas y algunos procesos cambiarían de día. Si se confirma lo contrario, se cambia en un solo lugar de `src/ocds.ts`.
