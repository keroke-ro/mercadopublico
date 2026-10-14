# CLI

[Inicio](index.md) · [Guía](guia.md) · [Modelo](modelo.md) · [Sync](sync.md) · [OCDS](ocds.md) · [Radar](radar.md) · [Contrato](contrato.md)

```sh
npx mercadopublico --ayuda
```

```
Uso: mercadopublico <comando> [opciones]

Comandos:
  licitacion <codigo>                 Detalle de una licitación
  licitaciones                        Activas, o filtradas con --dia --estado --organismo --proveedor
  oc <codigo>                         Detalle de una orden de compra
  ordenes                             Del día, o filtradas con --dia --estado --organismo --proveedor
  compra-agil [<codigo>]              Detalle, o listado con --region 13,5 --estado publicada --q texto --desde ISO --max N (100)
  proveedor <rut>                     Código de empresa de un proveedor
  compradores                         Todos los organismos compradores
  ocds <archivo|url|año> [--max N]    Lee OCDS (.jsonl o .jsonl.gz); no pide ticket
  sync --desde AAAA-MM-DD             Actualiza un store local [--hasta] [--fuentes licitaciones,ordenes,compra_agil] [--store ./mp.json] [--plan]
  cuota                               Consultas usadas hoy desde esta máquina

Opciones:
  --formato json|csv|tabla            Por defecto tabla en terminal y json si no
  --ticket T                          Por defecto la variable MP_TICKET
  --incluir-personales                No ocultar datos personales de funcionarios
  --sin-conversion                    No convertir montos a pesos
  -h, --ayuda
```

## Ejemplos

```sh
export MP_TICKET=...

# Detalle (1 consulta)
npx mercadopublico licitacion 1509-5-L114
npx mercadopublico oc 2097-241-SE14 --formato json

# Listados (1 consulta)
npx mercadopublico licitaciones                                  # activas hoy
npx mercadopublico licitaciones --dia 2026-10-01 --estado adjudicada --formato csv > adjudicadas.csv
npx mercadopublico ordenes --organismo 7248 --dia 2026-10-01
npx mercadopublico ordenes                                       # todas las de hoy

# Compra Ágil (1 consulta por página de hasta 50)
npx mercadopublico compra-agil --region 13,5 --estado publicada --q papel --max 50
npx mercadopublico compra-agil 1057539-228-COT26

# Empresas
npx mercadopublico proveedor 76.123.456-7
npx mercadopublico compradores --formato csv > compradores.csv

# OCDS, sin ticket: un año del espejo de Open Contracting, una URL o un archivo local
npx mercadopublico ocds 2026 --max 10
npx mercadopublico ocds ./2026.jsonl.gz --max 1000 --formato csv

# Sync a un archivo JSON
npx mercadopublico sync --desde 2026-10-01 --plan                # muestra el plan (gasta los listados)
npx mercadopublico sync --desde 2026-10-01 --fuentes compra_agil --store ./ca.json

npx mercadopublico cuota
```

## Detalles

- **Datos personales:** se ocultan en toda salida que sea un proceso, salvo `--incluir-personales`.
- **Formato:** tabla si la salida es una terminal y JSON si no (por ejemplo, con `| jq`). La tabla y el CSV de procesos muestran tipo, código, nombre, estado, organismo, región, publicación, cierre y monto.
- **Fechas:** `--dia`, `--desde` y `--hasta` van en `AAAA-MM-DD`. En `compra-agil`, `--desde` es la fecha de publicación y acepta ISO. `--organismo` y `--proveedor` sin `--dia` usan hoy.
- **Cuota:** la CLI guarda las consultas del día en `~/.mercadopublico/cuota.json` (o en `$MERCADOPUBLICO_HOME`) y la retoma en la siguiente llamada. `cuota` la muestra sin gastar nada. Si corres dos CLI a la vez, la cuenta del último que termina pisa a la del otro.
- **sync:** imprime el plan y el avance en stderr y el resultado en stdout. Con `--plan` solo planifica, pero eso ya gasta los listados (ver [Sync](sync.md#lo-que-cuesta)).
- **Salida:** código 0 si todo bien, 1 si falló la API o la cuota, 2 si el comando está mal escrito. `DEBUG=1` muestra el stack.
