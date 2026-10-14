# Sync

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md) · [Resiliencia](resiliencia.md) · [Testing](testing.md)

`mp.sync` mantiene al día una base local de licitaciones, órdenes de compra y Compra Ágil sin reventar la cuota. Se hace en dos pasos: `planificar` dice cuánto va a costar y `ejecutar` lo hace.

```ts
import { MercadoPublico, storeArchivo } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });
const store = await storeArchivo("./mp.json"); // toma ./mp.json.lock hasta cerrar()

try {
  const plan = await mp.sync.planificar({ desde: "2026-10-01", store });
  console.log(plan.consultas, plan.margenReintentos, plan.cabeHoy);
  for (const d of plan.desglose) console.log(d.fuente, d.consultas, d.nota);

  if (plan.cabeHoy) {
    const r = await mp.sync.ejecutar(plan, {
      alAvanzar: ({ fuente, hechas, total }) => console.log(fuente, hechas, "/", total),
    });
    console.log(r); // { consultas, nuevos, actualizados, omitidos, errores, abandonados?, detenido? }
  }
} finally {
  await store.cerrar?.();
}
```

## Opciones

| Opción | Por defecto | |
|---|---|---|
| `desde` | (obligatoria) | Primer día, `"AAAA-MM-DD"`. Si el store ya tiene cursor para una fuente, se parte desde el cursor. |
| `hasta` | hoy en Santiago | Último día, incluido. |
| `fuentes` | las tres | `"licitaciones"`, `"ordenes"`, `"compra_agil"` |
| `detalle` | `true` | Pedir el detalle de cada proceso nuevo o cambiado (1 consulta c/u). Con `false` se guarda lo que trae el listado. |
| `refrescar` | `false` | Volver a pedir el detalle de licitaciones y OC guardadas que siguen abiertas: licitaciones con cierre pasado y OC creadas antes de hoy, dentro de los últimos 90 días. Normalmente no hace falta: el listado v1 de un día trae lo que tuvo movimiento ese día (una OC creada el 8 y aceptada el 12 aparece el 12), así que recorrer los días ya trae los cambios de estado. Úsalo si ves que algo se queda atrás. Requiere `detalle`. |
| `tasaRechazo` | `0.25` | Fracción de consultas que esperas que la API rechace con 10500 y haya que reintentar. Da `plan.margenReintentos`. `0` = sin margen. |
| `store` | (obligatorio) | Dónde se guarda. |
| `signal` | — | Solo en `planificar`. Al dispararse rechaza con `cancelada`; los listados ya pedidos quedan gastados y no se guarda nada. |

`ejecutar(plan, { store?, alAvanzar?, signal? })` también acepta un `signal`: al dispararse no rechaza, guarda lo pedido y devuelve con `detenido: "cancelado"`.

## Lo que cuesta

`planificar` ya gasta consultas: baja los listados, que `ejecutar` reutiliza sin volver a pedirlos. Si ni los listados caben en lo que queda del día, falla con `cuota_insuficiente` antes de pedir nada.

Con `Dₗ` y `Dₒ` = días por recorrer de licitaciones y de órdenes (desde el día siguiente al cursor, o `desde`, hasta `hasta`):

| | Consultas | Precisión |
|---|---|---|
| `planificar` gasta | `Dₗ + Dₒ + 1` (la página 1 de Compra Ágil) | exacto |
| licitaciones | `Dₗ + Nₗ + Fₗ + Eₗ` | exacto |
| órdenes | `Dₒ + Nₒ + Fₒ + Eₒ` | exacto |
| Compra Ágil | `max(1, P) + R + E꜀` | cota superior |

- `N` = procesos de los listados que hay que pedir: los que no están en el store, más los guardados que no están en un [estado final](#estados-finales). Sin detalle, `N` no se suma: se guarda el ítem del listado, y solo si es nuevo o cambió de estado.
- `F` = procesos abiertos que se refrescan (ver `refrescar`); no mueven el cursor.
- `E` = [pendientes](#pendientes) de vueltas anteriores, 1 consulta c/u. La nota del desglose dice cuántos. Sin detalle no se reintentan.
- `P` = páginas del listado de Compra Ágil y `R` = resultados totales. Es cota superior porque al ejecutar se saltan los que no cambiaron y los cerrados. Sin detalle, `R` no se suma.
- `plan.consultas` = suma de las fuentes, incluidas las que ya gastó `planificar` (`plan.gastadas`).
- `plan.margenReintentos` = `⌈(consultas − listadas) · t / (1 − t)⌉`, con `t` = `tasaRechazo`: las consultas extra que se esperan por reintentos de lo que falta. La API rechaza con 10500 entre 15% y 30% de las consultas aunque vayan de a una (medido el 2026-10-13); con el `0.25` por defecto, el margen es un tercio de lo que falta.
- `plan.cabeHoy` = `consultas − listadas + margenReintentos ≤ restante`, donde `listadas` son las consultas de listado previstas (sin contar reintentos). `ejecutar` vuelve a exigirlo y, si no cabe, falla con `cuota_insuficiente` antes de empezar.
- Con la pausa de 1 s, 10.000 consultas toman unas 3 horas; más si la API rechaza y el [ritmo](resiliencia.md#ritmo-adaptativo-y-10500) se alarga.

## Cursores

Cada fuente guarda en el store hasta dónde llegó, para que la siguiente vuelta empiece ahí:

- **Licitaciones y órdenes:** el último día recorrido completo (`"AAAA-MM-DD"`). Hoy nunca se marca, porque el día no ha terminado. Un detalle que falla no frena el cursor: si fue algo pasajero queda [pendiente](#pendientes); si fue algo permanente (`no_encontrado`, `parametros`), solo queda en `errores`. Un registro roto no congela el sync.
- **Compra Ágil:** la `fechas.ultimoCambio` más reciente vista. El listado se pide con `cambioDesde` = ese cursor y `cambioHasta` = el día después de `hasta`. El cursor recién avanza al terminar todas las páginas.

## Pendientes

Si el detalle de un proceso falla por algo pasajero (10500, 5xx, red o una respuesta inválida, como una página de mantención), el código queda pendiente y el cursor avanza igual. Así un proceso que falla siempre no obliga a re-listar todos los días desde ahí en cada vuelta.

- Se guardan en el store como un cursor más, `<fuente>:pendientes`, con JSON `{ "codigo": intentos }`.
- La vuelta siguiente los pide primero, antes de los días nuevos, y entran en el plan (`E` en [lo que cuesta](#lo-que-cuesta)).
- Si sale, se guarda y deja de estar pendiente. Si falla por algo permanente, se descarta y queda en `errores`.
- Si vuelve a fallar por algo pasajero, suma un intento por vuelta. Al quinto se abandona: sale de los pendientes y queda en `resultado.abandonados` y en `errores`. Para traerlo después, pídelo a mano con `porCodigo` o `compraAgil.detalle`.
- Un pendiente que además aparece en un día nuevo se pide en los dos lados.

## Estados finales

Un proceso guardado en un estado que ya no cambia no se vuelve a consultar: `adjudicada`, `desierta`, `revocada`, `cancelada`, `recepcion_conforme` y `oc_emitida`.

Quedan fuera a propósito: licitación `cerrada` o `suspendida` (aún se adjudica o revoca), OC `recepcion_parcial` o `recepcion_conforme_incompleta` (falta recepcionar) y Compra Ágil `proveedor_seleccionado` (la OC aparece después en el detalle). En Compra Ágil, además, se salta todo lo que no cambió su `fecha_ultimo_cambio`.

## Errores y cortes

- Un detalle que falla queda en `resultado.errores` (`{ codigo, error }`) y el sync sigue. Si fue algo pasajero, también queda [pendiente](#pendientes).
- `cuota_agotada`, `cuota_insuficiente`, `ticket_invalido` y `circuito_abierto` (la API viene cayéndose, ver [Resiliencia](resiliencia.md#circuit-breaker)) cortan el sync con ese error. Lo que ya se pidió queda guardado.
- Un error al pedir una página de Compra Ágil después de la primera también corta el sync con ese error.
- Si se dispara el `signal`, se detiene, guarda lo hecho y devuelve `resultado.detenido = "cancelado"`.
- Si la cuenta local llega a cero a mitad de camino, se detiene, guarda lo hecho y lo dice en `resultado.detenido`. Mañana sigue desde el cursor.
- En cualquier corte, el cursor nunca queda adelante de lo guardado: cada lote (un día o una página) se guarda antes de mover su cursor, o junto con él, y los pendientes nuevos se escriben antes que el cursor. Un pendiente solo sale de la lista después de guardar su detalle. Correr de nuevo deja el store igual que si no se hubiera cortado; lo único que puede cambiar son los intentos de un pendiente, porque una vuelta cortada también cuenta.

## Stores

```ts
import { storeArchivo, storeMemoria } from "mercadopublico";

const enMemoria = storeMemoria();
const enArchivo = await storeArchivo("./mp.json"); // solo Node, Bun o Deno

for await (const p of enArchivo.todos()) console.log(p.codigo, p.estado);
await enArchivo.cerrar?.(); // suelta el lock
```

`storeArchivo` lee el JSON entero al abrir y lo reescribe una vez por lote (un día o una página), datos y cursor juntos. Sirve hasta unas decenas de miles de procesos; más allá, usa una base de datos.

- **Escritura atómica:** escribe a `<ruta>.<pid>.tmp` (uno por proceso), hace fsync y lo renombra. Un corte deja el archivo anterior o el nuevo, nunca uno a medias.
- **Lock:** al abrir toma `<ruta>.lock` (pid, host y hora; nunca el ticket). Si otro proceso lo tiene, `storeArchivo` falla con un mensaje que lo dice. Mientras el dueño vive, renueva el lock cada minuto. Cuándo se da por abandonado y se toma solo:
  - **Misma máquina:** solo si su proceso ya no existe. Un proceso vivo nunca lo pierde, aunque lleve horas sin renovarlo (un notebook suspendido, un `SIGSTOP`).
  - **Otra máquina, o sin pid:** si no se renovó en 10 minutos.
  - Si estás seguro de que no hay otro sync corriendo, puedes borrar el `.lock` a mano.
- **Lock perdido:** antes de cada rename revisa que el `.lock` siga siendo suyo. Si no (lo borraron a mano o lo tomó otro), falla con un mensaje claro y no escribe: nunca pisa el store de otro proceso. Vuelve a abrirlo.
- **Ciérralo** con `await store.cerrar?.()` cuando termines, idealmente en un `finally`: suelta el lock. Después de cerrar ya no se puede escribir. Si no lo cierras y el proceso termina, el lock queda abandonado y la próxima apertura lo toma.
- **Archivo dañado:** si el JSON no es un store válido, lo mueve a `<ruta>.corrupto-<fecha>` y falla. Nunca parte de cero en silencio: revísalo o vuelve a sincronizar desde cero.

### Tu propio store

Implementa `Store`. `guardar` reemplaza por `codigo`. Las claves de cursor son los nombres de las fuentes y `<fuente>:pendientes` (un JSON que puede crecer: guárdalo como texto sin límite de largo). Dos métodos son opcionales:

- `guardarConCursor(procesos, clave, valor)`: guarda los procesos y mueve el cursor en una sola transacción. Sin él, sync llama a `guardar` y después a `fijarCursor`. Con él, un corte nunca deja el cursor adelante de los datos y te ahorras una escritura por lote.
- `cerrar()`: suelta lo que tengas tomado (conexiones, locks).

```ts
import type { Proceso, Store } from "mercadopublico";

// `db` es una conexión de Postgres (p. ej. un `Client` de `pg`). Con un `Pool`, la transacción
// necesita su propio cliente: `const c = await pool.connect()` y `c.release()` al final.
declare const db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export const storePostgres: Store = {
  async obtener(codigo) {
    const { rows } = await db.query("select datos from procesos where codigo = $1", [codigo]);
    return rows[0]?.datos as Proceso | undefined;
  },
  async guardar(procesos) {
    for (const p of procesos)
      await db.query("insert into procesos (codigo, datos) values ($1, $2) on conflict (codigo) do update set datos = $2", [p.codigo, p]);
  },
  async cursor(clave) {
    const { rows } = await db.query("select valor from cursores where clave = $1", [clave]);
    return rows[0]?.valor as string | undefined;
  },
  async fijarCursor(clave, valor) {
    await db.query("insert into cursores (clave, valor) values ($1, $2) on conflict (clave) do update set valor = $2", [clave, valor]);
  },
  async *todos() {
    const { rows } = await db.query("select datos from procesos");
    for (const r of rows) yield r.datos as Proceso;
  },
  async guardarConCursor(procesos, clave, valor) {
    await db.query("begin");
    try {
      await storePostgres.guardar(procesos);
      await storePostgres.fijarCursor(clave, valor);
      await db.query("commit");
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  },
};
```

Un store con Postgres incluido viene en v1.x.
