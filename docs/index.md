# mercadopublico

SDK en TypeScript para la [API de Mercado Público](https://www.chilecompra.cl/api/) de ChileCompra. Licitaciones, órdenes de compra y Compra Ágil en un solo modelo, con control de cuota, montos en pesos al día del documento y datos personales ocultos por defecto. Sin dependencias en runtime.

```sh
npm install mercadopublico
```

```ts
import { MercadoPublico } from "mercadopublico";

const mp = new MercadoPublico({ ticket: process.env.MP_TICKET! });
const activas = await mp.licitaciones.activas(); // 1 consulta
```

## Páginas

- [Guía](guia.md): cliente, licitaciones, órdenes de compra, empresas, Compra Ágil y errores.
- [Modelo](modelo.md): `Proceso`, `Monto`, fechas y conversores.
- [Sync](sync.md): plan, costo en consultas, cursores y stores.
- [CLI](cli.md): `npx mercadopublico …`
- [OCDS](ocds.md): el histórico de datos abiertos, en streaming.
- [Radar](radar.md): priorizar oportunidades y rangos de precio.
- [Contrato nocturno](contrato.md): cómo se vigila que la API no cambie.
- [Notas de la API](api-notes.md): lo que dice cada fuente oficial y dónde se contradicen.

Código en [github.com/keroke-ro/mercadopublico](https://github.com/keroke-ro/mercadopublico). No oficial: no está afiliado a la Dirección ChileCompra. Si publicas datos obtenidos con esta librería, cita a ChileCompra como fuente.
