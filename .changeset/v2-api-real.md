---
"mercadopublico": patch
---

Compra Ágil (v2) ajustada a la API real, verificada el 2026-10-14:

- Las fechas de la v2 se leen como hora de Santiago aunque traigan `Z` (antes quedaban 3 o 4 horas corridas), y las que llegan como `"AAAA-MM-DD HH:mm"` ya no quedan en `null`. Los filtros de fecha se mandan en el mismo reloj.
- `ordenCompra` sale del `id_orden_compra` que llega en la raíz del detalle, y `cotizaciones[].seleccionada` lee `proveedor_seleccionado: 0|1`.
- `compraAgil.listar` y `pagina` exigen al menos un filtro (sin ninguno, la API responde 500) y ya no aceptan `estado: "oc_emitida"`, porque la API lo rechaza. La CLI `compra-agil` sin filtros lista lo publicado hoy.
- Sin avisos falsos por los campos que manda la API real.
