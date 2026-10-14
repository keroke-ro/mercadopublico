# Sync

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [CLI](cli.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md)

`mp.sync` mantiene al día una base local de licitaciones, órdenes de compra y Compra Ágil sin reventar la cuota. Se hace en dos pasos: `planificar` dice cuánto va a costar y `ejecutar` lo hace.

```ts
import { MercadoPublico, storeArchivo } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });
const store = await storeArchivo("./mp.json");

const plan = await mp.sync.planificar({ desde: "2026-10-01", store });
console.log(plan.consultas, plan.cabeHoy);
for (const d of plan.desglose) console.log(d.fuente, d.consultas, d.nota);

if (plan.cabeHoy) {
  const r = await mp.sync.ejecutar(plan, {
    alAvanzar: ({ fuente, hechas, total }) => console.log(fuente, hechas, "/", total),
  });
  console.log(r); // { consultas, nuevos, actualizados, omitidos, errores, detenido? }
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
| `store` | (obligatorio) | Dónde se guarda. |

## Lo que cuesta

`planificar` ya gasta consultas: baja los listados, que `ejecutar` reutiliza sin volver a pedirlos. Si ni los listados caben en lo que queda del día, falla con `cuota_insuficiente` antes de pedir nada.

Con `Dₗ` y `Dₒ` = días por recorrer de licitaciones y de órdenes (desde el día siguiente al cursor, o `desde`, hasta `hasta`):

| | Consultas | Precisión |
|---|---|---|
| `planificar` gasta | `Dₗ + Dₒ + 1` (la página 1 de Compra Ágil) | exacto |
| licitaciones | `Dₗ + Nₗ + Fₗ` | exacto |
| órdenes | `Dₒ + Nₒ + Fₒ` | exacto |
| Compra Ágil | `max(1, P) + R` | cota superior |

- `N` = procesos de los listados que hay que pedir: los que no están en el store, más los guardados que no están en un [estado final](#estados-finales). Sin detalle, `N` no se suma: se guarda el ítem del listado, y solo si es nuevo o cambió de estado.
- `F` = procesos abiertos que se refrescan (ver `refrescar`); no mueven el cursor.
- `P` = páginas del listado de Compra Ágil y `R` = resultados totales. Es cota superior porque al ejecutar se saltan los que no cambiaron y los cerrados. Sin detalle, `R` no se suma.
- `plan.consultas` = suma de las fuentes, incluidas las que ya gastó `planificar` (`plan.gastadas`).
- `plan.cabeHoy` = `consultas − listadas ≤ restante`, donde `listadas` son las consultas de listado previstas (sin contar reintentos). `ejecutar` vuelve a exigirlo y, si no cabe, falla con `cuota_insuficiente` antes de empezar.
- Los reintentos también gastan cuota y no están en el plan. En la práctica la API rechaza con 10500 entre 15% y 30% de las consultas aunque vayan de a una (medido el 2026-10-13), así que deja ese margen. Con la pausa de 1 s, 10.000 consultas toman unas 3 horas.

## Cursores

Cada fuente guarda en el store hasta dónde llegó, para que la siguiente vuelta empiece ahí:

- **Licitaciones y órdenes:** el último día recorrido completo (`"AAAA-MM-DD"`). Hoy nunca se marca, porque el día no ha terminado. Si el detalle de un proceso falla por algo pasajero (10500, 5xx, red), el cursor de esa fuente deja de avanzar para reintentarlo la próxima vez. Si falla por algo permanente (`no_encontrado`, `parametros`), queda en `errores` pero el cursor avanza: un registro roto no congela el sync.
- **Compra Ágil:** la `fechas.ultimoCambio` más reciente vista. El listado se pide con `cambioDesde` = ese cursor y `cambioHasta` = el día después de `hasta`. El cursor recién avanza al terminar todas las páginas sin errores pasajeros.

## Estados finales

Un proceso guardado en un estado que ya no cambia no se vuelve a consultar: `adjudicada`, `desierta`, `revocada`, `cancelada`, `recepcion_conforme` y `oc_emitida`.

Quedan fuera a propósito: licitación `cerrada` o `suspendida` (aún se adjudica o revoca), OC `recepcion_parcial` o `recepcion_conforme_incompleta` (falta recepcionar) y Compra Ágil `proveedor_seleccionado` (la OC aparece después en el detalle). En Compra Ágil, además, se salta todo lo que no cambió su `fecha_ultimo_cambio`.

## Errores y cortes

- Un detalle que falla queda en `resultado.errores` (`{ codigo, error }`) y el sync sigue.
- `cuota_agotada`, `cuota_insuficiente` y `ticket_invalido` cortan el sync con ese error. Lo que ya se pidió queda guardado.
- Si la cuenta local llega a cero a mitad de camino, se detiene, guarda lo hecho y lo dice en `resultado.detenido`. Mañana sigue desde el cursor.

## Stores

```ts
import { storeArchivo, storeMemoria } from "mercadopublico";

const enMemoria = storeMemoria();
const enArchivo = await storeArchivo("./mp.json"); // solo Node, Bun o Deno

for await (const p of enArchivo.todos()) console.log(p.codigo, p.estado);
```

`storeArchivo` lee el JSON entero al abrir y lo reescribe en cada guardado (escribe a un temporal y lo renombra). Sirve hasta unas decenas de miles de procesos; más allá, usa una base de datos.

### Tu propio store

Implementa `Store`. `guardar` reemplaza por `codigo`; las claves de cursor son los nombres de las fuentes.

```ts
import type { Proceso, Store } from "mercadopublico";

// `db` es tu cliente de Postgres (p. ej. un Pool de `pg`).
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
};
```

Un store con Postgres incluido viene en v1.x.
