---
"mercadopublico": minor
---

Servidor MCP: `mercadopublico mcp` (stdio) y `mercadopublico mcp --http` (Streamable HTTP, para claude.ai y ChatGPT detrás de HTTPS con `MP_MCP_CLAVE`). Es dual-era (MCP 2025-03-26 a 2026-07-28), no agrega dependencias y sale también como subpath `mercadopublico/mcp` (`crearServidorMcp`, `manejadorHttp`, sin imports de `node:`, para Workers, Deno y Bun), como extensión `.mcpb` para Claude Desktop y en el MCP Registry.

Herramientas: `search` y `fetch` (con la forma que pide el deep research de ChatGPT), `listar`, `organismos`, `proveedor`, `cuota`, y con store local `sync` y `ocds_importar` como trabajos en segundo plano (`trabajo_estado`, `trabajo_cancelar`; uno a la vez, `sync` exige `maxConsultas`), `radar`, `competidores`, `proximas_compras` y `precios`. Más tres prompts: `radar-diario`, `analizar-licitacion` y `estudiar-competencia`.

Cada resultado trae `costo` (consultas gastadas, restante del ticket y tope del agente, `MP_MCP_TOPE`, 1000 por defecto), todo pasa por una sola cola serial, los datos personales van siempre ocultos y `raw` nunca se manda. El store por defecto es `~/.mercadopublico/mp.json` (`MP_STORE`, `MERCADOPUBLICO_HOME`). Guía en `docs/mcp.md`.

También nuevo en la API: `codigos.familiaDesdeCodigo` (licitación, orden de compra o Compra Ágil a partir del código), `codigos.urlPublica` (ficha pública en mercadopublico.cl, para citar) y, en `mercadopublico/radar`, `resumenRadar` y `pesos`, que antes vivían dentro de la CLI.

La CLI `sync` y `radar` respetan `MP_STORE` cuando no hay `--store` (sin ella, `./mp.json`). `radar` y `competidores` nombran a una persona natural (RUT bajo 50 millones) como "un proveedor persona natural" en sus textos.
