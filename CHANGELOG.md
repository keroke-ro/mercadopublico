# mercadopublico

## 0.1.0

### Minor Changes

- 1b30195: Primera versión pública (0.1).
  
  - **Cliente tipado** para la API v1 (licitaciones, órdenes de compra, `BuscarProveedor` y `BuscarComprador`) y la v2 de Compra Ágil (listado paginado y detalle), con errores tipados (`MercadoPublicoError`) y validación de entradas antes de gastar consultas.
  - **Un solo modelo, `Proceso`,** para v1, v2 y OCDS:
    - fechas ISO con offset de Santiago;
    - montos `{ valor, moneda, clp, fechaValor, fuente }` convertidos con el valor del día del documento: mindicador.cl, luego el Banco Central y al final la paridad mensual de ChileCompra.
  - **Resiliencia:**
    - cola serial con ritmo adaptativo ante el 10500;
    - reintentos con presupuesto;
    - circuit breaker por fuente (`mp.salud()`);
    - cancelación con `AbortSignal`;
    - eventos de observabilidad (`alEvento`);
    - cuota diaria en `mp.cuota`.
  - **`mp.sync.planificar` y `mp.sync.ejecutar`:**
    - sincronización incremental con costo estimado antes de empezar;
    - cursores que nunca adelantan a los datos y pendientes con tope;
    - stores en memoria y en archivo, con lock y escritura atómica.
  - **Avisos cuando la API cambia de forma** (campo nuevo o faltante, tipo distinto, valor desconocido).
  - **Lector OCDS en streaming** (`leerOcds`) para el histórico de datos abiertos.
  - **Tablas de códigos** con las contradicciones de la documentación oficial corregidas.
  - **Datos personales de funcionarios** marcados en `personales`. `ocultarPersonales` los tapa, junto con correos y teléfonos en texto libre.
  - **CLI `mercadopublico`** con salida JSON, CSV y tabla, `sync`, `radar` y `ocds`. Oculta datos personales por defecto.
  - **`mercadopublico/radar`:** `decidir`, `priorizar`, `precioSugerido`, `rangoDePrecio`, `proximasCompras`, `competidores` y `calibrar`, con fórmulas explícitas.
