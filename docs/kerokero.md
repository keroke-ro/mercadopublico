# Borrador: página de mercadopublico en kerokero.cl

> **Borrador** para que Damián lo revise y lo pegue en kerokero.cl. No se publica en el sitio de la documentación.

---

## mercadopublico: la API de Mercado Público, bien usada

Más de 850 organismos del Estado compran en Mercado Público, y la mayoría de sus proveedores son mypes. La API de ChileCompra es gratis, pero usarla bien cuesta: son tres APIs con modelos distintos, un ticket con 10.000 consultas al día que se bloquea si le mandas dos a la vez, y una documentación que se contradice.

**mercadopublico** es una librería abierta en TypeScript que resuelve esa parte:

- **Un solo modelo** para licitaciones, órdenes de compra y Compra Ágil, venga el dato de la API v1, de la v2 o del histórico OCDS.
- **Cuida tu cuota.** Manda las consultas de a una, reintenta solo cuando sirve y te dice cuánto va a gastar una sincronización antes de empezar.
- **Montos comparables.** Convierte UF, UTM, dólares y euros a pesos con el valor del día del documento.
- **Datos personales protegidos.** Los datos de funcionarios quedan ocultos por defecto.
- **Vigilada todas las noches** contra la API real, para enterarnos antes que tú si algo cambia.

Licencia MIT, sin dependencias, en npm como `mercadopublico`.

### ¿Para quién?

- Equipos de desarrollo que quieren integrar licitaciones o Compra Ágil sin reescribir el cliente, la cola, los reintentos y los parsers.
- Analistas y periodistas de datos que quieren bajar y cruzar compras públicas con una CLI.
- Empresas que venden al Estado y quieren armar su propio radar de oportunidades.

### Empieza

```sh
npx mercadopublico licitaciones
```

[Ver el código en GitHub](https://github.com/keroke-ro/mercadopublico) · [Documentación](https://keroke-ro.github.io/mercadopublico/)

### ¿Quieres algo hecho a tu medida?

La librería es la base. En KeroKero armamos sobre ella lo que tu empresa necesita: un radar con tus rubros, regiones y márgenes, alertas, tableros o la integración con tus sistemas. Tu criterio queda en tu empresa, no en un repo público.

[Conversemos](https://www.kerokero.cl/contacto)

<small>No oficial: no está afiliado a la Dirección ChileCompra. Los datos son de ChileCompra.</small>

---

Pendiente de confirmar antes de publicar: la URL del sitio de documentación (GitHub Pages desde `/docs` en `main`) y la del formulario de contacto de kerokero.cl.
