# mercadopublico

SDK en TypeScript para la [API de Mercado Público](https://www.chilecompra.cl/api/) de ChileCompra.

> En construcción (v0.1). No oficial: no está afiliado a la Dirección ChileCompra.

## Objetivo

- Cliente tipado para licitaciones, órdenes de compra, empresas y Compra Ágil, con los códigos como enums y errores tipados.
- Control de cuota (10.000 consultas diarias por ticket), cola serial y reintentos solo cuando corresponde (10500, 429, 5xx).
- Normalización de montos (CLP, UF, UTM, USD) y fechas en America/Santiago.
- Lector del histórico OCDS de datos abiertos de ChileCompra.

## Fuente de los datos

Los datos vienen de la Dirección ChileCompra (api.mercadopublico.cl). Si publicas datos obtenidos con esta librería, cita a ChileCompra como fuente.

## Licencia

MIT © KeroKero
