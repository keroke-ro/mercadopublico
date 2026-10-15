---
"mercadopublico": minor
---

`npx mercadopublico` (o `mercadopublico init`) abre un instalador en la terminal: elige qué instalar (ticket, MCP en Claude Code, Codex, Cursor y Claude Desktop, perfil del radar con un primer sync, SDK en el proyecto) y lo deja configurado. El ticket, el store y el perfil quedan en `~/.mercadopublico/config.json` y la CLI y el MCP los usan cuando no hay `MP_TICKET`, `MP_STORE` ni `--perfil`. `radar` del MCP ya no exige `perfil` si hay uno guardado.
