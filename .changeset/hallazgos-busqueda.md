---
"mercadopublico": minor
---

- Un 504 (corte del gateway por una consulta demasiado cara) se reintenta una sola vez y no abre el circuito: antes gastaba 5 consultas y unos 2,5 minutos, y bloqueaba la fuente completa por 60 s. El mensaje sugiere acotar con región o fechas.
- `cuotaArchivo(ruta)`: cuota del día en un archivo, guardada tras cada consulta y compartida entre procesos, así un script que se cae no pierde la cuenta. La CLI ahora la usa.
- Radar: cuando el organismo no publica el monto (`VisibilidadMonto: 0`), el factor y el `porque` de `decidir` lo dicen en vez de "Monto desconocido".
