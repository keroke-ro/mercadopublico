# Notas API Mercado Público / ChileCompra

Investigado el 2026-10-13 **sin ticket**: no se hizo ninguna llamada a v1 ni a v2. Todo JSON de v1/v2 que aparece aquí está reconstruido desde la documentación, salvo que se indique otra cosa.

## Fuentes (claves usadas en el texto)

| Clave | URL |
|---|---|
| [W] | https://www.chilecompra.cl/api/ (página oficial; ojo, `api.mercadopublico.cl/` y `/modules/{Licitacion,OrdenCompra,api,ejemplo_08}.aspx` hacen **302** hacia aquí; `ejemplo_09.aspx` y `tutorial.aspx` dan 404) |
| [PL] | https://www.chilecompra.cl/wp-content/uploads/2026/03/Documentacion-API-Mercado-Publico-Licitaciones.pdf (diccionario, 9 págs.; idéntico por md5 a `api.mercadopublico.cl/documentos/Documentación API Mercado Publico - Licitaciones.pdf`) |
| [PO] | https://www.chilecompra.cl/wp-content/uploads/2026/03/Documentacion-API-Mercado-Publico-oc.pdf (diccionario OC, 6 págs.) |
| [CA] | https://www.chilecompra.cl/wp-content/uploads/2026/05/Documentacion_API_Compra_Agil.pdf (Guía API Compra Ágil v2, **versión 3.0**, mayo 2026). `-2-1.pdf` y `-3-1.pdf` tienen el mismo texto; solo cambia la portada |
| [OCP] | https://data.open-contracting.org/en/publication/144 |
| [DA] | bundle JS de https://datos-abiertos.chilecompra.cl/descargas/procesos-ocds (es una SPA; las URLs se sacaron del JS) |
| [OCDS-7z] | muestra real `https://ocds-lic-files.da.mercadopublico.cl/2026/202601.7z` (descargada e inspeccionada) |
| [OCDS-gz] | muestra real de los primeros ~400 KB de `2026.jsonl.gz` de [OCP] |
| [PAR] | https://transparenciachc.blob.core.windows.net/oc-da/ParidadMoneda.csv |
| [3P] | fuentes de terceros, **no oficiales** (p. ej. https://github.com/gbaldessari/licitaciones-api) |

Marcas: **(V: clave)** = verificado en esa fuente. **(NV)** = no verificado. Los datos personales se marcan con 🔒.

---


> **Verificado con ticket real el 2026-10-13** (13 consultas; fixtures en `test/fixtures/v1/*.real.json`):
> - `licitaciones.json?estado=activas` y `ordenesdecompra.json?fecha=ddmmaaaa` responden con `Listado` de solo `CodigoExterno`/`Codigo`, `Nombre`, `CodigoEstado` (+ `FechaCierre` en licitaciones). `ordenesdecompra.json` es el nombre correcto.
> - `Publico/Empresas/BuscarComprador` responde `{Cantidad, FechaCreacion, listaEmpresas:[{CodigoEmpresa, NombreEmpresa}]}`.
> - Fechas de v1 sin offset (hora de Chile), a veces con milisegundos: `2026-10-06T17:51:21.567`.
> - El detalle de licitación trae `FechaCierre: null` en la raíz; la fecha real está en `Fechas.FechaCierre`. `TipoPago` y `SubContratacion` llegan como string.
> - En OC, `Items.Listado[].Total` llega en 0 aunque haya `PrecioNeto`; `Unidad` puede ser null; las OC de Compra Ágil (tipo AG) traen `CodigoLicitacion: ""` y el código `…-COT26` dentro de `Nombre`.
> - Las descripciones traen datos de contacto en texto libre (nombre, teléfono, correo de funcionarios).
> - v2 Compra Ágil respondió `500 {"codigo":"ERROR_INTERNO","mensaje":"Servicio no disponible…"}` esa noche: sin verificar aún.

## 1. API v1 (licitaciones, OC, empresas)

**Base:** `https://api.mercadopublico.cl/servicios/v1/publico/` (V: W). Los PDF usan `http://` (V: PL, PO).
**Formato:** se elige con la extensión `.json` | `.jsonp` (agrega `&callback=fn`) | `.xml` (V: W). Si no se indica, la respuesta es JSON (V: PL, PO).
**Método:** solo GET con query params (V: W). **Auth:** query param `ticket` (V: W).
**Fechas de entrada:** `fecha=ddmmaaaa`, p. ej. `12062026` (V: W).

### Endpoints y parámetros (nombres y mayúsculas exactos)

| Endpoint | Parámetros | Notas |
|---|---|---|
| `licitaciones.json` | `codigo`, `fecha`, `estado`, `CodigoOrganismo`, `CodigoProveedor`, `ticket` | Combinaciones documentadas: `codigo`; nada (todas las del día actual); `fecha`; `estado=activas`; `fecha+estado`; `fecha+CodigoProveedor`; `fecha+CodigoOrganismo` (V: W). Con `codigo` la fecha no importa y se devuelve el **detalle** (V: W) |
| `ordenesdecompra.json` | igual que licitaciones | "Todos los estados del día actual" = `?estado=todos` sin fecha (V: W). ⚠ [PO] escribe `OrdenCompra.json?codigo=`; la web usa `ordenesdecompra.json`. Usar el de la web (NV cuál acepta el server) |
| `Empresas/BuscarProveedor` | `rutempresaproveedor` (RUT **con puntos, guion y DV**, p. ej. `70.017.820-k`), `ticket` | Path con **`Publico`** en mayúscula: `/servicios/v1/Publico/Empresas/BuscarProveedor` (V: W). Devuelve CódigoEmpresa y NombreEmpresa (V: W) |
| `Empresas/BuscarComprador` | `ticket` | Lista **todos** los organismos con CódigoEmpresa/NombreEmpresa (V: W) |

Respuesta de los endpoints de Empresas: `{"Cantidad":n,"FechaCreacion":…,"listaEmpresas":[{"CodigoEmpresa":"…","NombreEmpresa":"…"}]}`. La lista se llama **`listaEmpresas`**, no `Listado` (NV; [3P]). No se sabe si los paths distinguen mayúsculas (NV), así que conviene usarlos tal cual.

**Valores de `estado`:**
- Licitaciones: `publicada`, `cerrada`, `desierta`, `adjudicada`, `revocada`, `suspendida`, `todos`, `activas` (V: W). `activas` = publicadas al día de la consulta. La web los muestra con mayúscula inicial, pero los ejemplos van en minúscula, así que hay que enviarlos en minúscula.
- OC: `enviadaproveedor`, `aceptada`, `cancelada`, `recepcionconforme`, `pendienterecepcion`, `recepcionaceptadacialmente` (sic), `recepecionconformeincompleta` (sic), `todos` (V: W). Las erratas están copiadas literal; no se sabe qué grafía acepta el server (NV). El estado "En proceso" (código 5) no tiene valor de parámetro.

### Envelope

```
{ Cantidad: int, FechaCreacion: datetime /*fecha de la consulta*/, Version: string, Listado: [...] }
```
(V: W, PL, PO). El formato serializado del datetime es NV; probablemente `"2026-06-12T15:00:00"` sin zona y en hora de Chile.

**Listado vs. detalle:** las búsquedas por fecha/estado/organismo/proveedor se hacen sobre lo publicado (licitaciones) o enviado (OC) **en el día**, y traen "información básica" (V: W).
- Ítem de lista de licitación, presumiblemente: `CodigoExterno`, `Nombre`, `CodigoEstado`, `FechaCierre` (son los campos 4–7 de [PL]) (NV).
- Ítem de lista de OC: `Codigo`, `Nombre`, `CodigoEstado` (NV).
- Para tener el detalle completo hay que pedir 1 request por `codigo`, lo que consume cuota.

### Campos del detalle de licitación (`Listado[]`), según (V: PL)

Equivalencias de tipo: nvarchar/varchar → `string`; int/entero/smallint/float → `number`; bit → `0|1`; DateTime → `string`. Todo puede ser `null` (NV).

| Campo | Tipo PDF | Nota |
|---|---|---|
| CodigoExterno | nvarchar100 | p. ej. `1509-5-L114` |
| Nombre | nvarchar255 | |
| CodigoEstado | int | tabla §2.1 |
| Estado | nvarchar510 | glosa del estado |
| FechaCierre | DateTime | |
| Descripcion | nvarchar max | |
| Comprador.{CodigoOrganismo, NombreOrganismo, RutUnidad, CodigoUnidad, NombreUnidad, DireccionUnidad, ComunaUnidad, RegionUnidad} | nvarchar | |
| Comprador.{RutUsuario🔒, CodigoUsuario🔒, NombreUsuario🔒, CargoUsuario🔒} | nvarchar/texto | funcionario responsable |
| DiasCierreLicitacion | entero | |
| Informada | bit | 1=sí |
| CodigoTipo | int | 1=Pública, 2=Privada |
| Tipo | nvarchar20 | tabla §2.2 |
| TipoConvocatoria | int | 1=Abierto, 0=Cerrada |
| Moneda | nvarchar100 | §2.3 |
| Etapas | int | 1 o 2 |
| EstadoEtapas | int | aperturas realizadas [1,2] |
| TomaRazon | int | 1=con toma de razón |
| EstadoPublicidadOfertas | smallint | 1=ofertas técnicas públicas |
| JustificacionPublicidad | nvarchar | |
| Contrato | int | PDF: 1=requiere suscripción, 2=se formaliza con OC (solo LE). ⚠ La web dice binario 1/0 con ejemplo `<Contrato>NO</Contrato>` |
| Obras | int | PDF: 0=No, 2=Sí. ⚠ La web dice 2=Sí, 1=No, con ejemplo `<Obras>0</Obras>` |
| CantidadReclamos | entero | reclamos recibidos por el organismo |
| Fechas.{FechaCreacion, FechaCierre, FechaInicio, FechaFinal, FechaPubRespuestas, FechaActoAperturaTecnica, FechaActoAperturaEconomica, FechaPublicacion, FechaAdjudicacion, FechaEstimadaAdjudicacion, FechaSoporteFisico, FechaTiempoEvaluacion, FechaEstimadaFirma, FechasUsuario, FechaVisitaTerreno, FechaEntregaAntecedentes} | DateTime | FechaInicio/FechaFinal = foro. `FechasUsuario` "indica si el usuario definió fechas adicionales" y aun así está tipado DateTime ⚠ |
| UnidadTiempoEvaluacion | int | §2.6 |
| DireccionVisita, DireccionEntrega | varchar500 | |
| Estimacion | (sin tipo) | §2.4 |
| FuenteFinanciamiento | int | (NV: podría ser texto) |
| VisibilidadMonto | bit | |
| MontoEstimado | float | |
| UnidadTiempo | int | unidad de `TiempoDuracionContrato` |
| Modalidad | int | §2.5 |
| TipoPago | int | sin tabla |
| NombreResponsablePago🔒, EmailResponsablePago🔒, NombreResponsableContrato🔒, EmailResponsableContrato🔒, FonoResponsableContrato🔒 | nvarchar200 | |
| ProhibicionContratacion | nvarchar510 | |
| SubContratacion | bit | |
| UnidadTiempoDuracionContrato, TiempoDuracionContrato | int | |
| TipoDuracionContrato | nvarchar510 | |
| JustificacionMontoEstimado | varchar255 | |
| ExtensionPlazo | smallint | 1=extiende 2 días hábiles si llegan ≤2 ofertas |
| EsBaseTipo, EsRenovable | bit | |
| UnidadTiempoContratoLicitacion, ValorTiempoRenovacion | int | |
| PeriodoTiempoRenovacion | nvarchar510 | |
| Adjudicacion.{Tipo:int(§2.7), Fecha:datetime, Numero:nvarchar100, NumeroOferentes:entero, UrlActa:texto} | | Solo se despliega con estado Adjudicada (V: PL §3.7); si no, probablemente `null` (NV) |
| Items.Cantidad | entero | |
| Items.Listado[].{CodigoEstadoLicitacion:int, Correlativo:entero, CodigoProducto:entero (UNSPSC v7), CodigoCategoria:nvarchar100, Categoria:varchar400, NombreProducto, Descripcion, UnidadMedida:nvarchar510, Cantidad:float} | | El PDF escribe la ruta como `Listado/ítem/...`; en JSON es un array (NV) |
| Items.Listado[].Adjudicacion.{RutProveedor🔒*, NombreProveedor🔒*, CantidadAdjudicada, MontoUnitario:float} | | `CantidadAdjudicada` figura como **nvarchar500** ⚠. *🔒 cuando el proveedor es persona natural |

### Campos del detalle de OC (`Listado[]`), según (V: PO)

| Campo | Tipo PDF | Nota |
|---|---|---|
| Codigo | nvarchar50 | p. ej. `2097-241-SE14` |
| Nombre | nvarchar255 | |
| CodigoEstado | int | §2.8 |
| CodigoLicitacion | nvarchar50 | licitación asociada |
| Descripcion | nvarchar2000 | |
| CodigoTipo | nvarchar80 | §2.9 (¿numérico?) ⚠ |
| Tipo | nvarchar2 | abreviación, p. ej. `SE` |
| TipoMoneda | nvarchar255 | §2.3 |
| CodigoEstadoProveedor | int | |
| EstadoProveedor | nvarchar255 | |
| Fechas.{FechaCreacion, FechaEnvio, FechaAceptacion, FechaCancelacion, FechaUltimaModificacion} | DateTime | |
| TieneItems | nvarchar255 | "1"/"0" |
| PromedioCalificacion | float | |
| CantidadEvaluacion | int | |
| Descuentos, Cargos, TotalNeto, PorcentajeIva, Impuestos, Total | float | |
| Financiamiento, Pais | nvarchar255 | |
| TipoDespacho | nvarchar255 | código §2.10 |
| FormaPago | nvarchar255 | código §2.11 |
| Comprador.{CodigoOrganismo, NombreOrganismo, RutUnidad, CodigoUnidad, NombreUnidad, Actividad, DireccionUnidad, ComunaUnidad, RegionUnidad, Pais} | nvarchar | |
| Comprador.{NombreContacto🔒, CargoContacto🔒, FonoContacto🔒, MailContacto🔒} | nvarchar | |
| Proveedor.{Codigo, Nombre, Actividad, CodigoSucursal, NombreSucursal, RutSucursal, Direccion, Comuna, Region, Pais} | nvarchar | RutSucursal = RUT del proveedor (🔒 si es persona natural) |
| Proveedor.{NombreContacto🔒, CargoContacto🔒, FonoContacto🔒, MailContacto🔒} | nvarchar | |
| Items.Cantidad | int | |
| Items.Listado[].{Correlativo, CodigoCategoria:int, Categoria, CodigoProducto:int, EspecificacionComprador, EspecificacionProveedor, Cantidad:float, Moneda, PrecioNeto:float, TotalCargos, TotalDescuentos, TotalImpuestos, Total:float} | | PrecioNeto = precio unitario |

El PDF no lista un campo `Estado` en texto para OC (NV si existe).

### Errores v1

No hay documentación oficial de errores (NV en todos los puntos que siguen):
- Formato reportado por [3P]: `{"Codigo":<int>,"Mensaje":"<texto>"}`, sin `Cantidad` ni `Listado`.
- `10500`: "Lo sentimos. Hemos detectado que existen peticiones simultáneas." Aparece con concurrencia, así que hay que **serializar las requests** (NV; [3P]).
- `10300`: "El formato del parametro fechas es incorrecto", con HTTP 500 (NV; [3P]).
- Ticket inválido: código y mensaje no encontrados (NV).
- HTTP 429 al agotar la cuota: reportado por [3P] y no documentado para v1.
- Para el SDK: detectar error por la presencia de `Codigo` + `Mensaje` y **no** confiar en el status HTTP.

---

## 2. Tablas de códigos

### 2.1 CodigoEstado de licitación

| Código | Web (V: W) | OCDS `statusDetails` observado (V: OCDS-7z) |
|---|---|---|
| 5 | Publicada | `5-Publicada` |
| 6 | Cerrada | `6-Cerrada` |
| 7 | Desierta | `7-Desierta (o art. 3 ó 9 Ley 19.886)` |
| 8 | Adjudicada | `8-Adjudicada` |
| 9 | — | `9-Adjudicada` (en awards) |
| 11, 12, 14 | — | `11-Cerrada`, `12-Cerrada`, `14-Cerrada` |
| 15 | — | `15-Revocada` |
| 16 | — | `16-Suspendida` |
| 18 | Revocada | — |
| 19 | Suspendida | — |

⚠ **Contradicción:** según la web, Revocada=18 y Suspendida=19; en OCDS, 15 y 16. [PL] no trae la tabla. El SDK debería aceptar cualquier int y usar `Estado` (texto) como glosa.

### 2.2 Tipo de licitación (`Tipo`)

| Cód. | [PL] | Web [W] | OCDS `procurementMethodDetails` |
|---|---|---|---|
| L1 | Pública <100 UTM | igual | "Licitación Pública Menor a 100 UTM (L1)" |
| LE | Pública ≥100 <1.000 UTM | 100–1000 | "…Entre 100 y 1000 UTM (LE)" |
| LP | Pública **≥1.000 <2.000** UTM | "**Mayor 1000** UTM" ⚠ | "…Mayor 1000 UTM (LP)" |
| LQ | Pública ≥2.000 <5.000 | — | "…entre a 2000 y 5000 UTM (LQ)" |
| LR | Pública ≥5.000 | — | "…Mayor a 5000 (LR)" |
| LS | Pública servicios personales especializados | igual | igual |
| E2 | Privada <100 | igual | "Licitación Privada Menor a 100 UTM." |
| CO | Privada ≥100 <1.000 | igual | "…Privada entre 100 y 1000 UTM." |
| B2 | Privada ≥1.000 <2.000 | "Privada Mayor a 1000" ⚠ | "…Privada Mayor a 1000 UTM" |
| H2 | Privada ≥2.000 <5.000 | — | — |
| I2 | Privada >5.000 | — | "…Privada Mayor a 5000 (I2)" |
| O1 / O2 | — | — | "Licitación Pública MOP (O1)" / "Licitación Privada MOP (O2)" (no documentados) |
| R1 | — | OC <3 UTM | aparece como sufijo de licitación en [OCDS-7z] (p. ej. `2785-5-R126`) ⚠ |

Códigos que solo trae la web ("es necesario revisar las tipologías que ya no existen"):
- A1: privada por pública anterior sin oferentes.
- B1: privada por otras causales.
- J1: privada por servicios confidenciales.
- F1: privada por convenios con personas jurídicas extranjeras.
- E1: privada por remanente de contrato.
- A2: trato directo tras privada sin oferentes o desierta.
- D1: trato directo por proveedor único.
- C2, F2: trato directo (cotización).
- G2: directo (cotización).
- C1, F3, G1: compra directa (OC).
- CA: OC sin resolución.
- SE: OC sin emisión automática.

Formato del código: `{n}-{n}-{TIPO}{AA}`, p. ej. `1509-5-L114` = L1 + 2014 o `1057539-228-COT26` (Compra Ágil, sufijo de 3 letras). Un regex que funciona con todos los ejemplos vistos es `^(\d+)-(\d+)-([A-Z]+\d?)(\d{2})$`. El primer segmento **no** es necesariamente el CodigoUnidad (en OCDS, `1000-1-LE26` tiene comprador `CL-MP-1996`).

### 2.3 Moneda (`Moneda`, `TipoMoneda`)

CLP = Peso, CLF = UF, USD = Dólar, UTM = UTM, EUR = Euro (V: PL, PO, W).
- ⚠ En la tabla de OC de la web las glosas de UTM y EUR están invertidas (error de maquetación).
- En OCDS se observan CLP, CLF y USD.

### 2.4 Estimacion

1 = Presupuesto Disponible, 2 = Precio Referencial (V: W). [PL] agrega 3 = "Monto no es posible de estimar".

### 2.5 Modalidad de pago: ⚠ la web y el PDF no coinciden del 5 al 10

| Cód | [PL] | [W] |
|---|---|---|
| 1 | Pago a 30 días | = |
| 2 | 30, 60 y 90 días | = |
| 3 | Pago al día | = |
| 4 | Pago Anual | = |
| 5 | Pago Bimensual | Pago a 60 días |
| 6 | Contra Entrega Conforme | Pagos Mensuales |
| 7 | Pagos Mensuales | Contra Entrega Conforme |
| 8 | Por Estado de Avance | Pago Bimensual |
| 9 | Pago Trimestral | Por Estado de Avance |
| 10 | Pago a 60 días | Pago Trimestral |

### 2.6 Unidad de tiempo (evaluación y duración del contrato)

1 Horas, 2 Días, 3 Semanas, 4 Meses, 5 Años (V: W, PL). [PL] indica la ruta `<UnidadTiempo>` en ambas tablas, lo que es una errata para la de evaluación (debería ser `UnidadTiempoEvaluacion`).

### 2.7 Adjudicacion.Tipo (acto administrativo)

[PL]: 1 Autorización, 2 Resolución, 3 Acuerdo, 4 Decreto, 5 Otros.
⚠ [W]: 1 Autorización, 2 Resolución, **3 Otros**, 4 Decreto, **5 Acuerdo**.

### 2.8 CodigoEstado de OC

| Código | Glosa (V: W) |
|---|---|
| 4 | Enviada a Proveedor |
| 5 | En proceso |
| 6 | Aceptada |
| 9 | Cancelada |
| 12 | Recepción Conforme |
| 13 | Pendiente de Recepcionar |
| 14 | Recepcionada Parcialmente |
| 15 | Recepción Conforme Incompleta |

OCDS confirma 4, 6, 9 y 12 (`"12-Orden de Compra recepcionada conforme"`) (V: OCDS-gz).

### 2.9 Tipo de OC

Según [W] (Codigo, Abreviación):
- 1 OC: Automática
- 2 D1: TD proveedor único
- 3 C1: TD emergencia
- 4 F3: TD confidencialidad
- 5 G1: TD naturaleza de la negociación
- 6 R1: OC <3 UTM
- 7 CA: OC sin resolución
- 8 SE: sin emisión automática
- 9 CM: Convenio Marco
- 10 FG: TD art. 8 f y g
- 11 TL: CM Tienda de Libros (obsoleto)
- 12 MC: Microcompra
- 13 AG: Compra Ágil
- 14 CC: Compra Coordinada

[PO] solo trae 8 SE y 9 CM. Los sufijos de código de OC que se ven en datos reales (`-TD26`, `-CL25`, `-CM26`, `-AG26`, `-SE14`) no calzan 1:1 con esta tabla (TD y CL no están).

### 2.10 TipoDespacho de OC

7 Dirección de envío · 9 Según programa adjunto · 12 Otra forma (ver instrucciones) · 14 Retiramos de su bodega · 20 Courier aéreo · 21 Courier terrestre · 22 A convenir (V: W, PO).

### 2.11 FormaPago de OC

1 = 15 días contra factura · 2 = 30 días · 39 = Otra · 46 = 50 días · 47 = 60 días (V: PO). [W] agrega 48 = "A 45 días" y 49 = "A más de 30 días".

### 2.12 Banderas binarias de licitación ([W] y [PL])

`Informada`, `TomaRazon`, `EstadoPublicidadOfertas`, `VisibilidadMonto`, `SubContratacion`, `ExtensionPlazo`, `EsBaseTipo` y `EsRenovable` usan 1 = Sí, 0 = No. Excepciones: `CodigoTipo` es 1/2, y `Contrato` y `Obras` tienen las contradicciones descritas arriba. ⚠ En [W] las descripciones de "Licitación informada" y "Tipo de licitación" están intercambiadas.

### 2.13 Regiones (filtro `region` de v2)

1 Tarapacá, 2 Antofagasta, 3 Atacama, 4 Coquimbo, 5 Valparaíso, 6 O'Higgins, 7 Maule, 8 Biobío, 9 Araucanía, 10 Los Lagos, 11 Aysén, 12 Magallanes, 13 Metropolitana, 14 Los Ríos, 15 Arica y Parinacota, 16 Ñuble (V: CA).

---

## 3. API v2 Compra Ágil (Beta desde el 22-05-2026)

**Base:** `https://api2.mercadopublico.cl` (V: CA).
**Auth:** header HTTP **`ticket: <TICKET>`**, no un query param (V: CA). Es el mismo ticket de v1 (V: CA §2.2).

| Endpoint | Uso |
|---|---|
| `GET /v2/compra-agil` | listado paginado con filtros |
| `GET /v2/compra-agil/{codigo}` | detalle, p. ej. `1057539-228-COT26` |

### Query params del listado (V: CA §5.1)

| Grupo | Param | Tipo / valores |
|---|---|---|
| Cambios (A **o** B, no ambos) | `ttl_cambio_ms` | int ms, p. ej. `300000` |
| | `cambio_desde`, `cambio_hasta` | ISO-8601 `2026-01-19T00:00:00Z` |
| Publicación | `publicado_desde`, `publicado_hasta` | ISO-8601 |
| Estado | `estado` | coma-separado: `publicada`, `cerrada`, `desierta`, `cancelada`, `proveedor_seleccionado`, `oc_emitida` |
| Región | `region` | int 1–16 "repetible"; ejemplo `region=13,5` ⚠ (no queda claro si es coma o param repetido) |
| Búsqueda | `id` (código exacto) **xor** `q` (palabras clave en nombre/descripción) | mutuamente excluyentes |
| Página | `tamano_pagina` (default 15, máx. 50), `numero_pagina` (base 1) | |
| Orden | `ordenar_por` = `FechaUltimaModificacion` (default, desc) \| `FechaPublicacion` (desc) | |

- **No existe** `codigo_organismo`; hay que filtrar por `region` y luego localmente por `institucion.rut` (V: CA).
- `oc_emitida` "no se usa en la práctica": esos casos salen como `proveedor_seleccionado`. Para saber si hay OC, revisar `orden_compra.id_orden_compra != null` en el detalle (V: CA §8.6).

### Envelope

```
{"success":"OK"|"NOK", "trace":null, "payload":{…}|null, "errors":null|[{"codigo":"429","mensaje":"…","detalle":null}]}
```

`success` es **string** y `errors[].codigo` también es string (V: CA).

**Payload del listado:** `{items:[…], paginacion:{total_paginas, numero_pagina, tamano_pagina, total_resultados}}`. La paginación termina cuando `numero_pagina >= total_paginas` (V: CA).

### Campos del listado (`payload.items[]`)

| Campo | Tipo |
|---|---|
| codigo, nombre | string |
| estado.id_estado | int (los valores numéricos no están documentados) |
| estado.codigo | enum de arriba |
| estado.glosa | string |
| convocatoria.estado_convocatoria | 1 \| 2 (primer o segundo llamado) |
| convocatoria.descripcion | string |
| documentos[].{id (UUID), nombre} | string |
| fechas.{fecha_publicacion, fecha_cierre, fecha_ultimo_cambio, fecha_cancelacion\|null} | ISO-8601 |
| montos.{moneda, monto_disponible, monto_disponible_clp} | string / number |
| institucion.{organismo_comprador, rut, unidad_compra} | string |
| institucion.region | int\|null |
| institucion.nombre_region | string\|null |
| resumen.total_ofertas_recibidas | int |
| motivos.{motivo_cancelacion, motivo_desierta, motivo_seleccion} | string\|null |
| links.detalle | `"/v2/compra-agil/{codigo}"` |

### Campos del detalle (`payload`)

| Campo | Tipo |
|---|---|
| codigo, nombre, descripcion; estado.{id_estado, codigo, glosa} | |
| convocatoria.{estado_convocatoria, descripcion, fecha_cierre_primer_llamado, fecha_cierre_segundo_llamado\|null} | |
| fechas.{fecha_publicacion, fecha_cierre, fecha_ultimo_cambio, fecha_cancelacion} | |
| entrega.direccion_entrega | string |
| entrega.plazo_entrega_dias | int\|null |
| documentos[] | |
| presupuesto.tipo_presupuesto | "Disponible" \| "Estimado" |
| presupuesto.{moneda, presupuesto_estimado, monto_disponible, monto_disponible_clp, valor_cambio_moneda, fecha_cambio_moneda} | |
| orden_compra.{id_orden_compra, id_oc} | int\|null. `id_orden_compra` es el indicador confiable de que hay OC |
| orden_compra.codigo_orden_compra | string\|null; ⚠ en la práctica viene `null` aunque haya OC |
| orden_compra.estado_orden_compra | string\|null; ⚠ `null` en `proveedor_seleccionado` |
| institucion.{…igual que el listado} | |
| productos_solicitados[].{codigo_producto:int\|string, nombre, descripcion\|null, cantidad:number, unidad_medida (p. ej. "EA", "KG")} | |
| proveedores_cotizando[] | ver tabla siguiente |
| resumen.{multa_sancion\|null, total_ofertas_recibidas, total_demandas} | |
| motivos.{motivo_cancelacion, motivo_desierta} | |
| flags.{considera_requisitos_medioambientales, considera_requisitos_impacto_social_economico} | boolean |

`proveedores_cotizando[]`. Los campos sin ⚠ figuran en la v3.0 como presentes en la respuesta real:

| Campo | Tipo / nota |
|---|---|
| rut_proveedor🔒*, razon_social🔒* | string |
| es_emt | boolean |
| id_cotizacion | int |
| codigo_empresa, codigo_sucursal_empresa | string |
| estado_por_comprador | string\|null |
| activo | boolean |
| fecha_creacion, fecha_vigencia | en la **raíz** del objeto, no anidados |
| valor_neto, total_impuesto, monto_despacho, monto_total, nombre_impuesto, porcentaje_impuesto | en la raíz |
| descripcion_cotizacion, descripcion, justificacion_inadmisibilidad | string\|null |
| productos_cotizados[].{codigo_producto, nombre_producto, descripcion, cantidad, precio_unitario (neto)\|null, monto_total_producto\|null} | |
| ⚠ estado_cotizacion.{id, glosa ("ENVIADA", "INADMISIBLE"…)} | documentado pero "no confirmado en la respuesta real" |
| ⚠ seleccion.{proveedor_seleccionado:boolean, motivo_seleccion, criterio_seleccion} | documentado pero "no confirmado en la respuesta real" |

- *🔒 cuando el proveedor es persona natural.
- No existen campos llamados `cotizaciones` ni `seleccionada`: la guía usa `proveedores_cotizando` y `seleccion.proveedor_seleccionado`.

**Reglas** (V: CA):
- `proveedores_cotizando` trae solo el llamado vigente y es `[]` (no se omite) si no hay ofertas.
- El detalle completo de las cotizaciones se ve desde "Cerrada en segundo llamado".

### Errores v2

| HTTP | Causa (V: CA §7) |
|---|---|
| 400 | parámetros inválidos o combinación no permitida |
| 401 | falta el header `ticket` |
| 403 | ticket inexistente, inactivo o bloqueado |
| 404 | código inexistente o no público |
| 429 | cuota diaria agotada ("tokens del bucket"); respetar `Retry-After` |
| 500 | error inesperado del servidor |
| 503 | mantenimiento |

⚠ El ejemplo JSON de 401 trae el mensaje "El ticket no existe, es inválido o no tiene permisos", que la tabla asigna a 403.

---

## 4. Cuota y throttling

- **v1:** "Cada ticket de acceso cuenta con un límite diario de **10.000 solicitudes**. Este límite **no es modificable**" (V: W, Términos 7).
- **v2:** el límite depende del "tipo de ticket", `-1` = ilimitado y "si requiere una cuota mayor, contacte a ChileCompra" (V: CA §4). ⚠ Contradice el "no modificable" de v1.
- **Reset:** "por día calendario, no por período de 24 h" (V: CA). La zona horaria **no está documentada**: el código de ejemplo de la guía calcula con UTC, pero es razonable suponer America/Santiago (NV). Tampoco se sabe si v1 y v2 comparten contador (NV).
- **IP:** "validaciones por dirección IP, pudiendo establecerse restricciones de acceso según la cantidad de solicitudes realizadas desde una misma IP" (V: W). No hay números publicados.
- **Descargas masivas:** se recomienda hacerlas de 22:00 a 07:00 (V: W). Uso abusivo → suspensión o bloqueo (V: W).
- **Ticket:** 1 por persona, obtenido con Clave Única (nombre, RUT y correo reales), y llega por email (V: W, CA). Los **tickets institucionales** no aparecen en ninguna fuente oficial revisada (NV).
- **Concurrencia v1:** usar 1 request a la vez (error 10500, NV).
- ⚠ La documentación expone un ticket de ejemplo (`F8537A18-…`). No usarlo.

---

## 5. OCDS

**Prefijo:** `ocds-70d2nz`. `ocid = "ocds-70d2nz-" + código` (V: OCDS-gz, OCDS-7z).

| Código detrás del ocid | Qué representa |
|---|---|
| licitación (`-LE26`, `-LP26`, `-L126`, …) | proceso de licitación; tender + awards (+ contracts con id = código OC, p. ej. `1002588-4-CL25`) |
| `…-TD26` | OC de Trato Directo; el award **es** la OC y `awards[].statusDetails` = estado OC (`"6-Orden de Compra aceptada por el proveedor"`) |
| `…-CM26` | OC de Convenio Marco; `relatedProcesses[{relationship:["framework"], identifier:"ocds-70d2nz-2239-1-LR25"}]` apunta a la licitación del CM |
| Compra Ágil | **no publicada en OCDS** (V: OCP) |

### Descargas

1. **Espejo de OCP**, recomendado para un SDK sin dependencias porque es gzip y alcanza con `node:zlib`.
   - URL: `https://data.open-contracting.org/en/publication/144/download?name={AAAA}.jsonl.gz`, con `{AAAA}` = 2022…2026 o `full`. Hace 302 a `https://fastly.data.open-contracting.org/downloads/chile_compra_api_releases/{id}/{AAAA}.jsonl.gz`; el id es variable (hoy `3730`) (V: OCP, curl).
   - Contenido: **una compiled release por línea** (`tag:["compiled"]`), sin package. Incluye licitaciones, TD y CM.
   - Tamaño: 2026 ≈ 186 MB, full ≈ 2,5 GB.
   - Actualización: se re-descarga cada ~6 meses (última: 29-05-2026). Licencia CC0. También existe un archivo `2029.*` (< 1 MB, probablemente fechas erróneas).
2. **Publisher** (V: DA, con HEAD 200 verificado). Solo trae licitaciones.
   - Hasta 2022-04: `https://ocds.blob.core.windows.net/ocds/{AAAA}{MM}.zip`, p. ej. `202201.zip` ≈ 587 MB.
   - Desde 2022-05: `https://ocds-lic-files.da.mercadopublico.cl/{AAAA}/{AAAA}{MM}.7z`, con MM de 2 dígitos (p. ej. `2026/202601.7z` ≈ 25 MB). Un 7z no se puede descomprimir sin dependencias.
   - Cada archivo dentro del 7z se llama `{codigo}.json` y es un **record package**: `{uri, version:"1.1", extensions[12], publisher, license, publishedDate, records:[{ocid, releases:[{date, tag, url}] /*linked*/, compiledRelease}], packages:[".../allrelease/{codigo}"], publicationPolicy}`.
   - El archivo de 2026-01 incluye códigos `…LE25`. El mes **no** es necesariamente el año/mes de creación de la licitación (NV qué fecha usa).
3. **API OCDS del publisher** (V: DA, URLs vistas en los datos; no se llamó, y se desconoce si pide ticket):
   - `https://api.mercadopublico.cl/APISOCDS/OCDS/listaOCDSAgnoMes/{año}/{mes}/{desde}/{hasta}`, más las variantes `listaOCDSAgnoMesTratoDirecto/…` y `listaOCDSAgnoMesConvenio/…`. Ejemplo: `…/listaOCDSAgnoMesTratoDirecto/2020/01/0/1000`.
   - Por proceso: `/APISOCDS/OCDS/record/{codigo}`, `/tender/{codigo}`, `/award/{codigo}`, `/allrelease/{codigo}`.
   - Según OCP es "lenta": la descarga completa tarda más de un mes.

### Mapeo clave (V: OCDS-gz, OCDS-7z)

| OCDS | ↔ v1 / nota |
|---|---|
| `tender.id` | CodigoExterno |
| `tender.title`, `description` | Nombre, Descripcion |
| `tender.status` | `active` \| `complete` \| `unsuccessful` \| `cancelled` |
| `tender.statusDetails` | `"8-Adjudicada"`: el int inicial es CodigoEstado |
| `tender.procurementMethod` | `open` \| `direct` |
| `tender.procurementMethodDetails` | "… (LE)": el Tipo va entre paréntesis (falta en algunas glosas) |
| `tender.value` | `{amount, currency}`; **falta en muchos casos** (102 de 385) ↔ MontoEstimado/Moneda |
| `tender.tenderPeriod` | `{startDate, endDate, durationInDays}` ↔ FechaPublicacion / FechaCierre |
| `tender.enquiryPeriod` | foro |
| `tender.awardPeriod` | |
| `tender.items[]` | `{id, description, quantity, unit.name, classification:{scheme:"UNSPSC", id:"11111611", uri}}`. En CM `classification.id` puede ser `"0"` |
| `tender.tenderers[]`, `tender.procuringEntity` | `{id:"CL-MP-1996", name:"ORGANISMO \| UNIDAD"}` (el separador ` \| ` va dentro del string) |
| `buyer` | igual que procuringEntity; a veces falta |
| `parties[]` | `{id:"CL-MP-n", roles[], identifier:{scheme:"CL-RUT", id:"612020000"}` (RUT sin puntos ni guion), `additionalIdentifiers[{scheme:"CL-MP", id:codigoEmpresa}]`, `address{region, streetAddress, countryName}`, `contactPoint.name`🔒, `details.scale` (`micro`\|`small`\|`medium`\|`large`)} |
| `awards[]` | `{id, date, status, statusDetails, value{amount, currency, amountGross}, valueBreakdown[net, taxes], suppliers[{id, name}], items[{unit.value.amount` = precio unitario`}]}` |
| `contracts[]` | pocos; `{id, awardID, period, value, status:active\|terminated}` |
| `planning.budget` | |
| `bids.details[]` | solo en el 7z |

Extensiones usadas: budget_breakdown, location, planning_items, valueBreakdown, organizationClassification, partyDetails_scale, enquiry, bid, statusdetails, techniques, contract_suppliers, más una propia de ChileCompra.

Otras observaciones:
- 🔒 `suppliers[].name` puede incluir el nombre de una persona natural (p. ej. "EMPRESA LTDA | Nombre Apellido").
- ⚠ Las fechas vienen con sufijo `Z`. No se sabe si son UTC reales o la hora local etiquetada como UTC (NV).

---

## 6. Conversión de moneda (UF, UTM, USD, EUR)

- **mindicador.cl**: `https://mindicador.cl/api/{uf|utm|dolar|euro}/{dd-mm-aaaa}` (NV).
  - El 2026-10-13 el server no respondió: respuesta vacía por HTTPS y timeouts. **No es una fuente confiable para un SDK.**
  - Forma conocida de la respuesta (NV): `{version, autor, codigo, nombre, unidad_medida, serie:[{fecha, valor}]}`, con `serie` vacía en días sin dato (por ejemplo, fines de semana para dólar y euro).
- **Recomendado: [PAR] ParidadMoneda.csv** (oficial de ChileCompra, sin key, unos 100 KB) (V: PAR).
  - Formato: separador `;`, decimal con coma, CRLF, valores mensuales desde 2007-01. Cabecera: `"YEAR";"MONTH";"MONEDA";"VMUSD";"VMUTM";"VMCLP";"VMCLF";"VMEUR"`.
  - `VMCLP` = CLP por 1 unidad de `MONEDA`. Ejemplo: `2026;9;"UTM";…;71721;…` → UTM de septiembre de 2026 = 71.721.
  - Trae **filas duplicadas** (deduplicar). Last-Modified 2026-10-12.
  - Granularidad **mensual**: la UF diaria queda como promedio (NV cómo se calcula).
- **SII** (diario, HTML; hay que scrapear `table#table_export`):
  - `https://www.sii.cl/valores_y_fechas/uf/uf{AAAA}.htm`, `/utm/utm{AAAA}.htm` y `/dolar/dolar{AAAA}.htm` (V: HTTP 200).
  - EUR no está ahí (NV).

---

## 7. Ejemplos JSON

**v1 listado de licitaciones.** Reconstruido (NV):
```json
{"Cantidad":2,"FechaCreacion":"2026-06-12T10:15:30.123","Version":"v1","Listado":[
 {"CodigoExterno":"1509-5-L114","Nombre":"Adquisición de insumos","CodigoEstado":5,"FechaCierre":"2026-06-20T15:00:00"},
 {"CodigoExterno":"6945-12-LE26","Nombre":"Servicio de aseo","CodigoEstado":8,"FechaCierre":null}]}
```

**v1 detalle de licitación.** Reconstruido desde [PL]; se muestra un subconjunto, los demás campos de §1 van al mismo nivel:
```json
{"Cantidad":1,"FechaCreacion":"2026-06-12T10:15:30","Version":"v1","Listado":[{
 "CodigoExterno":"1509-5-L114","Nombre":"Adquisición de insumos","CodigoEstado":8,"Descripcion":"…","Estado":"Adjudicada",
 "Comprador":{"CodigoOrganismo":"6945","NombreOrganismo":"Dirección de Compras y Contratación Pública","RutUnidad":"<rut>","CodigoUnidad":"1509","NombreUnidad":"Unidad de compras","DireccionUnidad":"Monjitas 392","ComunaUnidad":"Santiago","RegionUnidad":"Región Metropolitana de Santiago","RutUsuario":"<rut>","CodigoUsuario":"<cod>","NombreUsuario":"<nombre>","CargoUsuario":"<cargo>"},
 "DiasCierreLicitacion":"0","Informada":0,"CodigoTipo":1,"Tipo":"L1","TipoConvocatoria":"1","Moneda":"CLP","Etapas":1,"EstadoEtapas":"0","TomaRazon":"0","EstadoPublicidadOfertas":1,"Contrato":"2","Obras":"0","CantidadReclamos":0,
 "Fechas":{"FechaCreacion":"2026-06-01T09:00:00","FechaCierre":"2026-06-10T15:00:00","FechaInicio":null,"FechaFinal":"2026-06-05T15:00:00","FechaPubRespuestas":"2026-06-06T15:00:00","FechaActoAperturaTecnica":"2026-06-10T15:01:00","FechaActoAperturaEconomica":"2026-06-10T15:01:00","FechaPublicacion":"2026-06-02T09:00:00","FechaAdjudicacion":"2026-06-11T12:00:00","FechaEstimadaAdjudicacion":"2026-06-15T15:00:00","FechaSoporteFisico":null,"FechaTiempoEvaluacion":null,"FechaEstimadaFirma":null,"FechasUsuario":null,"FechaVisitaTerreno":null,"FechaEntregaAntecedentes":null},
 "Estimacion":1,"VisibilidadMonto":1,"MontoEstimado":2500000,"Modalidad":1,"UnidadTiempo":"2","TiempoDuracionContrato":"30",
 "NombreResponsablePago":"<nombre>","EmailResponsablePago":"<email>","NombreResponsableContrato":"<nombre>","EmailResponsableContrato":"<email>","FonoResponsableContrato":"<fono>",
 "Adjudicacion":{"Tipo":2,"Fecha":"2026-06-11T00:00:00","Numero":"123","NumeroOferentes":3,"UrlActa":"<url>"},
 "Items":{"Cantidad":1,"Listado":[{"Correlativo":1,"CodigoProducto":44121701,"CodigoCategoria":"44121700","Categoria":"Artículos de oficina / …","NombreProducto":"Bolígrafos","Descripcion":"…","UnidadMedida":"Unidad","Cantidad":100,
  "Adjudicacion":{"RutProveedor":"76.000.000-0","NombreProveedor":"Proveedor SpA","CantidadAdjudicada":"100","MontoUnitario":250}}]}}]}
```
⚠ Las mezclas de string y número son intencionales: el tipo real es desconocido (NV). El SDK debería coercionar.

**v1 detalle de OC.** Reconstruido desde [PO]:
```json
{"Cantidad":1,"FechaCreacion":"2026-06-12T10:15:30","Version":"v1","Listado":[{
 "Codigo":"2097-241-SE14","Nombre":"OC insumos","CodigoEstado":6,"CodigoLicitacion":"1509-5-L114","Descripcion":"…","CodigoTipo":"8","Tipo":"SE","TipoMoneda":"CLP","CodigoEstadoProveedor":3,"EstadoProveedor":"Aceptada",
 "Fechas":{"FechaCreacion":"2026-06-11T12:00:00","FechaEnvio":"2026-06-11T12:05:00","FechaAceptacion":"2026-06-12T09:00:00","FechaCancelacion":null,"FechaUltimaModificacion":"2026-06-12T09:00:00"},
 "TieneItems":"1","PromedioCalificacion":0,"CantidadEvaluacion":0,"Descuentos":0,"Cargos":0,"TotalNeto":25000,"PorcentajeIva":19,"Impuestos":4750,"Total":29750,"Financiamiento":"…","Pais":"CL","TipoDespacho":"7","FormaPago":"2",
 "Comprador":{"CodigoOrganismo":"6945","NombreOrganismo":"…","RutUnidad":"…","CodigoUnidad":"…","NombreUnidad":"…","Actividad":"…","DireccionUnidad":"…","ComunaUnidad":"…","RegionUnidad":"…","Pais":"CL","NombreContacto":"<nombre>","CargoContacto":"<cargo>","FonoContacto":"<fono>","MailContacto":"<email>"},
 "Proveedor":{"Codigo":"17793","Nombre":"Cámara de Comercio de Santiago A.G. (CCS)","Actividad":"…","CodigoSucursal":"…","NombreSucursal":"…","RutSucursal":"70.017.820-k","Direccion":"…","Comuna":"…","Region":"…","Pais":"CL","NombreContacto":"<nombre>","CargoContacto":"<cargo>","FonoContacto":"<fono>","MailContacto":"<email>"},
 "Items":{"Cantidad":1,"Listado":[{"Correlativo":1,"CodigoCategoria":44121700,"Categoria":"…","CodigoProducto":44121701,"EspecificacionComprador":"…","EspecificacionProveedor":"…","Cantidad":100,"Moneda":"CLP","PrecioNeto":250,"TotalCargos":0,"TotalDescuentos":0,"TotalImpuestos":4750,"Total":25000}]}}]}
```

**v1 error.** [3P], NV:
```json
{"Codigo":10500,"Mensaje":"Lo sentimos. Hemos detectado que existen peticiones simultáneas."}
```

**v2 listado.** Reconstruido desde las tablas de [CA]; el envelope y las claves son las verificadas:
```json
{"success":"OK","trace":null,"errors":null,"payload":{
 "items":[{"codigo":"1057539-228-COT26","nombre":"Materiales eléctricos","estado":{"id_estado":2,"codigo":"publicada","glosa":"Publicada"},
  "convocatoria":{"estado_convocatoria":1,"descripcion":"Primer llamado"},"documentos":[{"id":"3f1c…","nombre":"bases.pdf"}],
  "fechas":{"fecha_publicacion":"2026-04-01T12:00:00Z","fecha_cierre":"2026-04-03T12:00:00Z","fecha_ultimo_cambio":"2026-04-01T12:00:00Z","fecha_cancelacion":null},
  "montos":{"moneda":"CLP","monto_disponible":500000,"monto_disponible_clp":500000},
  "institucion":{"organismo_comprador":"…","rut":"…","unidad_compra":"…","region":13,"nombre_region":"Metropolitana"},
  "resumen":{"total_ofertas_recibidas":0},"motivos":{"motivo_cancelacion":null,"motivo_desierta":null,"motivo_seleccion":null},
  "links":{"detalle":"/v2/compra-agil/1057539-228-COT26"}}],
 "paginacion":{"total_paginas":4,"numero_pagina":1,"tamano_pagina":15,"total_resultados":52}}}
```

**v2 detalle.** Reconstruido:
```json
{"success":"OK","trace":null,"errors":null,"payload":{
 "codigo":"1195-39-COT26","nombre":"…","descripcion":"…","estado":{"id_estado":5,"codigo":"proveedor_seleccionado","glosa":"Proveedor seleccionado"},
 "convocatoria":{"estado_convocatoria":1,"descripcion":"Primer llamado","fecha_cierre_primer_llamado":"2026-04-03T12:00:00Z","fecha_cierre_segundo_llamado":null},
 "fechas":{"fecha_publicacion":"…","fecha_cierre":"…","fecha_ultimo_cambio":"…","fecha_cancelacion":null},
 "entrega":{"direccion_entrega":"…","plazo_entrega_dias":5},"documentos":[],
 "presupuesto":{"tipo_presupuesto":"Disponible","moneda":"CLP","presupuesto_estimado":null,"monto_disponible":500000,"monto_disponible_clp":500000,"valor_cambio_moneda":null,"fecha_cambio_moneda":null},
 "orden_compra":{"id_orden_compra":123456789,"id_oc":123456789,"codigo_orden_compra":null,"estado_orden_compra":null},
 "institucion":{"organismo_comprador":"…","rut":"…","unidad_compra":"…","region":13,"nombre_region":"Metropolitana"},
 "productos_solicitados":[{"codigo_producto":39121011,"nombre":"…","descripcion":null,"cantidad":10,"unidad_medida":"EA"}],
 "proveedores_cotizando":[{"rut_proveedor":"…","razon_social":"…","es_emt":true,"id_cotizacion":1,"codigo_empresa":"…","codigo_sucursal_empresa":"…","estado_por_comprador":null,"activo":true,
  "fecha_creacion":"…","fecha_vigencia":null,"valor_neto":400000,"total_impuesto":76000,"monto_despacho":0,"monto_total":476000,"nombre_impuesto":"IVA","porcentaje_impuesto":19,
  "descripcion_cotizacion":null,"descripcion":null,"justificacion_inadmisibilidad":null,
  "productos_cotizados":[{"codigo_producto":39121011,"nombre_producto":"…","descripcion":null,"cantidad":10,"precio_unitario":40000,"monto_total_producto":400000}]}],
 "resumen":{"multa_sancion":null,"total_ofertas_recibidas":1,"total_demandas":0},"motivos":{"motivo_cancelacion":null,"motivo_desierta":null},
 "flags":{"considera_requisitos_medioambientales":false,"considera_requisitos_impacto_social_economico":false}}}
```

**v2 error.** Copiado de [CA] §4.2:
```json
{"success":"NOK","trace":null,"payload":null,"errors":[{"codigo":"429","mensaje":"Se ha alcanzado el límite de solicitudes permitido. Intente nuevamente más tarde.","detalle":null}]}
```

**Línea OCDS.** Real, de [OCDS-gz] 2026; se recortó la URL del documento (que queda incompleta) y se quitó `parties`:
```json
{"id":"ocds-70d2nz-1000-3-CM26-2026-03-26T16:07:44Z","tag":["compiled"],"date":"2026-03-26T16:07:44Z","ocid":"ocds-70d2nz-1000-3-CM26","buyer":{"id":"CL-MP-1996","name":"MINISTERIO DE OBRAS PUBLICAS DIREC CION GRAL DE OO PP DCYF | Dirección de Vialidad - VIII Región - Provincia Bio Bio"},"awards":[{"id":"54538838","date":"2026-03-26T16:07:44Z","items":[{"id":"147854674","unit":{"value":{"amount":325.0,"currency":"CLP"}},"quantity":698.0,"description":"GAS LICUADO GRANEL LITRO REGIÓN DEL BIOBÍO(4510616) GAS LICUADO GRANEL LITRO REGIÓN DEL BIOBÍO","classification":{"id":"0","uri":"http://api.mercadopublico.cl/APISOCDS/Productos/Categoria/0","scheme":"UNSPSC"},"valueBreakdown":[{"id":"net","value":{"amount":226850.0,"currency":"CLP"},"description":"Precio total neto"}]}],"title":"Adquisición de gas licuado a granel según Orden de Compra: 1000-3-CM26","value":{"amount":226850.0,"currency":"CLP","amountGross":269951.5},"status":"active","documents":[{"id":"1","url":"https://www.mercadopublico.cl/PurchaseOrder/Modules/PO/DetailsPurchaseOrder.aspx?codigoOC=","title":"Página documentos del proceso de contratación","format":"text/html","language":"es","documentType":"awardNotice"}],"suppliers":[{"id":"CL-MP-26592","name":"ABASTIBLE S.A. | ABASTIBLE S.A."}],"description":"Orden de Compra codigo: 1000-3-CM26 dirigida a ABASTIBLE S.A.","statusDetails":"12-Orden de Compra recepcionada conforme","valueBreakdown":[{"id":"net","value":{"amount":226850.0,"currency":"CLP"},"description":"Precio total neto"},{"id":"taxes","value":{"amount":43101.5,"currency":"CLP"},"description":"Impuestos"}]}],"tender":{"id":"1000-3-CM26","hasEnquiries":false,"classification":{"id":"Normal","scheme":"CL-EVENTS"},"procuringEntity":{"id":"CL-MP-1996","name":"MINISTERIO DE OBRAS PUBLICAS DIREC CION GRAL DE OO PP DCYF | Dirección de Vialidad - VIII Región - Provincia Bio Bio"},"procurementMethod":"direct","procurementMethodRationale":""},"language":"es","initiationType":"tender","relatedProcesses":[{"id":"1","uri":"http://api.mercadopublico.cl/APISOCDS/ocds/record/2239-1-LR25","title":"CM Gas Licuado de Petróleo","scheme":"ocid","identifier":"ocds-70d2nz-2239-1-LR25","relationship":["framework"]}]}
```

**mindicador.** Reconstruido (NV; el servicio estaba caído al momento de investigar):
```json
{"version":"1.7.0","autor":"mindicador.cl","codigo":"uf","nombre":"Unidad de fomento (UF)","unidad_medida":"Pesos","serie":[{"fecha":"2026-01-02T03:00:00.000Z","valor":39727.08}]}
```
