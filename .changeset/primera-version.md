---
"mercadopublico": minor
---

Primera versión pública (0.1):

- Cliente tipado para la API v1 (licitaciones, órdenes de compra, `BuscarProveedor` y `BuscarComprador`) y la v2 de Compra Ágil (listado paginado y detalle), con errores tipados (`MercadoPublicoError`).
- Un solo modelo, `Proceso`, para v1, v2 y OCDS, con fechas ISO con offset de Santiago y montos `{ valor, moneda, clp, fechaValor, fuente }` convertidos con el valor del día del documento.
- Cola serial, reintentos solo ante 10500, 5xx y cortes de red, y cuenta de la cuota diaria en `mp.cuota`.
- `mp.sync.planificar` y `mp.sync.ejecutar`: sincronización incremental con costo estimado antes de empezar, cursores y stores en memoria y en archivo.
- Lector OCDS en streaming (`leerOcds`) para el histórico de datos abiertos.
- Tablas de códigos con las contradicciones de la documentación oficial corregidas.
- Datos personales de funcionarios marcados en `personales` y `ocultarPersonales` para taparlos.
- CLI `mercadopublico` con salida JSON, CSV y tabla; oculta datos personales por defecto.
- `mercadopublico/radar`: `priorizar` y `rangoDePrecio`, de ejemplo y con fórmulas explícitas.
