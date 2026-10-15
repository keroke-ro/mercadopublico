# mercadopublico

## 0.3.0

### Minor Changes

- 411e2d1: `npx mercadopublico` (o `mercadopublico init`) abre un instalador en la terminal: elige qué instalar (ticket, MCP en Claude Code, Codex, Cursor y Claude Desktop, perfil del radar con un primer sync, SDK en el proyecto) y lo deja configurado. El ticket, el store y el perfil quedan en `~/.mercadopublico/config.json` y la CLI y el MCP los usan cuando no hay `MP_TICKET`, `MP_STORE` ni `--perfil`. `radar` del MCP ya no exige `perfil` si hay uno guardado.

### Patch Changes

- Los tests ya no dejan carpetas temporales: todas van a una carpeta por corrida que se borra al final (antes se acumulaban miles de `mp-reanudar-*`). `npm run paquete` y `npm run smoke` también borran las suyas.

## 0.2.0

### Minor Changes

- 363ab21: - Un 504 (corte del gateway por una consulta demasiado cara) se reintenta una sola vez y no abre el circuito: antes gastaba 5 consultas y unos 2,5 minutos, y bloqueaba la fuente completa por 60 s. El mensaje sugiere acotar con región o fechas.
  - `cuotaArchivo(ruta)`: cuota del día en un archivo, guardada tras cada consulta y compartida entre procesos, así un script que se cae no pierde la cuenta. La CLI ahora la usa.
  - Radar: cuando el organismo no publica el monto (`VisibilidadMonto: 0`), el factor y el `porque` de `decidir` lo dicen en vez de "Monto desconocido".
- 3e3e381: Servidor MCP: `mercadopublico mcp` (stdio) y `mercadopublico mcp --http` (Streamable HTTP, para claude.ai y ChatGPT detrás de HTTPS con `MP_MCP_CLAVE`). Es dual-era (MCP 2025-03-26 a 2026-07-28), no agrega dependencias y sale también como subpath `mercadopublico/mcp` (`crearServidorMcp`, `manejadorHttp`, sin imports de `node:`, para Workers, Deno y Bun), como extensión `.mcpb` para Claude Desktop y en el MCP Registry.
  
  Herramientas: `search` y `fetch` (con la forma que pide el deep research de ChatGPT), `listar`, `organismos`, `proveedor`, `cuota`, y con store local `sync` y `ocds_importar` como trabajos en segundo plano (`trabajo_estado`, `trabajo_cancelar`; uno a la vez, `sync` exige `maxConsultas`), `radar`, `competidores`, `proximas_compras` y `precios`. Más tres prompts: `radar-diario`, `analizar-licitacion` y `estudiar-competencia`.
  
  Cada resultado trae `costo` (consultas gastadas, restante del ticket y tope del agente, `MP_MCP_TOPE`, 1000 por defecto), todo pasa por una sola cola serial, los datos personales van siempre ocultos y `raw` nunca se manda. El store por defecto es `~/.mercadopublico/mp.json` (`MP_STORE`, `MERCADOPUBLICO_HOME`). Guía en `docs/mcp.md`.
  
  También nuevo en la API: `codigos.familiaDesdeCodigo` (licitación, orden de compra o Compra Ágil a partir del código), `codigos.urlPublica` (ficha pública en mercadopublico.cl, para citar) y, en `mercadopublico/radar`, `resumenRadar` y `pesos`, que antes vivían dentro de la CLI.
  
  La CLI `sync` y `radar` respetan `MP_STORE` cuando no hay `--store` (sin ella, `./mp.json`). `radar` y `competidores` nombran a una persona natural (RUT bajo 50 millones) como "un proveedor persona natural" en sus textos.

### Patch Changes

- 18418a8: Compra Ágil (v2) ajustada a la API real, verificada el 2026-10-14:
  
  - Las fechas de la v2 se leen como hora de Santiago aunque traigan `Z` (antes quedaban 3 o 4 horas corridas), y las que llegan como `"AAAA-MM-DD HH:mm"` ya no quedan en `null`. Los filtros de fecha se mandan en el mismo reloj.
  - `ordenCompra` sale del `id_orden_compra` que llega en la raíz del detalle, y `cotizaciones[].seleccionada` lee `proveedor_seleccionado: 0|1`.
  - `compraAgil.listar` y `pagina` exigen al menos un filtro (sin ninguno, la API responde 500) y ya no aceptan `estado: "oc_emitida"`, porque la API lo rechaza. La CLI `compra-agil` sin filtros lista lo publicado hoy.
  - Sin avisos falsos por los campos que manda la API real.

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
