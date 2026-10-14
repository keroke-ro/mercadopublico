// Prompts del servidor MCP (`prompts/list` y `prompts/get`). Sin imports `node:`: corre en runtimes edge.
// ponytail: textos fijos en código, sin plantillas ni i18n; si crecen, pasarlos a archivos.

export const PROMPTS: {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
}[] = [
  {
    name: "radar-diario",
    title: "Agenda diaria del radar",
    description: "Qué postular primero hoy, a qué precio, por qué, y qué compras vienen. Usa el store local.",
    arguments: [{ name: "perfil", description: "Ruta a perfil.json o el JSON del perfil", required: true }],
  },
  {
    name: "analizar-licitacion",
    title: "Analizar una licitación",
    description: "Resumen, requisitos, fechas, monto, criterios, riesgos y preguntas abiertas de un proceso, con su URL.",
    arguments: [{ name: "codigo", description: "Código del proceso, p. ej. 1509-5-L114", required: true }],
  },
  {
    name: "estudiar-competencia",
    title: "Estudiar la competencia",
    description: "Quién gana, a qué precios y qué organismos compran en un rubro o con un organismo.",
    arguments: [
      { name: "rubro", description: "Palabras del rubro, p. ej. mobiliario escolar" },
      { name: "organismo", description: "Nombre del organismo comprador" },
    ],
  },
];

const TEXTOS: Record<string, (a: Record<string, string | undefined>) => string> = {
  "radar-diario": ({ perfil }) =>
    `Arma la agenda de postulación de hoy para este perfil.

Perfil: ${perfil}
Si es una ruta, léela con tu herramienta de archivos y úsala como objeto. Si es JSON, úsalo tal cual. Pásalo a \`radar\` como \`perfil\`.

Pasos:
1. Llama a \`radar\` con el perfil. Cuesta 0 consultas.
2. Si falla porque el store está vacío o no tiene datos recientes (mira \`ahora\` y los cierres más nuevos), no sigas. Propón \`sync\` con \`desde\` reciente y \`maxConsultas\` pequeño (p. ej. 50), y pregunta al usuario antes de lanzarlo.
3. Escribe la agenda en orden de \`turno\`: código, nombre, organismo, cierre y monto (\`montoClp\`; si es null, di que el organismo no lo publica). Cita cada \`porque\` tal cual.
4. Si un proceso trae \`precio\`, indica el precio sugerido o el rango.
5. Cierra con \`proximas\`: qué compras se repiten y cuándo.
Resume con \`conteo\`.

Reglas: no inventes datos que no estén en la respuesta. Cada herramienta informa \`costo\`; no gastes el tope diario. \`radar\` y \`trabajo_estado\` no cuestan consultas; \`sync\` sí.`,

  "analizar-licitacion": ({ codigo }) =>
    `Analiza el proceso de compra ${codigo}.

1. Llama a \`fetch\` con \`id\` = ${codigo}. Cuesta 1 consulta (2 si el código no existe en su familia).
2. Con \`text\` y \`metadata\`, responde en este orden:
   - Resumen: qué compra, para qué y quién compra.
   - Requisitos: documentos, garantías, experiencia y plazos de entrega, según aparezcan.
   - Fechas: publicación, cierre de ofertas, adjudicación y las demás, con fecha exacta.
   - Monto: la cifra publicada. Si el organismo no la publica, dilo explícitamente.
   - Criterios de evaluación, si aparecen.
   - Riesgos y preguntas abiertas: lo que falta o es ambiguo, y qué preguntarle al organismo.
3. Cierra con la \`url\` del proceso. Si es null, dilo.

Reglas: no inventes datos que no estén en el resultado; si un dato falta, escribe "no informado". No llames a otras herramientas salvo que el usuario lo pida. Cada herramienta informa \`costo\`.`,

  "estudiar-competencia": ({ rubro, organismo }) => {
    const alcance = [rubro && `rubro "${rubro}"`, organismo && `organismo "${organismo}"`].filter(Boolean).join(" y ");
    const pasos = [
      rubro && `Llama a \`search\` con \`query\` = "${rubro}". Cuesta 0 a 2 consultas.`,
      organismo && `Busca el código de "${organismo}" con \`organismos\` y lista sus compras con \`listar\` (\`organismo\`).`,
      "Si existen `competidores` y `precios` (requieren store local), úsalos: quién gana y con qué precios. Si no, trabaja con los procesos encontrados y `fetch` de 3 a 5 como máximo.",
      "Resume: quiénes ganan, precios típicos (como rango, nunca inventados) y qué organismos compran con más frecuencia. Cita el código del proceso de cada cifra.",
    ].filter(Boolean);
    return `Estudia la competencia para ${alcance}.

Pasos:
${pasos.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Reglas: antes de gastar más de ~10 consultas en total, dilo y pregunta. Cada herramienta informa \`costo\`; lleva la cuenta con él y no gastes el tope diario.`;
  },
};

/** Arma el prompt pedido con sus argumentos. Lanza Error (en español) si falta algo o no es válido. */
export function obtenerPrompt(
  nombre: string,
  args: Record<string, unknown>,
): { description: string; messages: { role: "user"; content: { type: "text"; text: string } }[] } {
  const p = PROMPTS.find((x) => x.name === nombre);
  if (!p) throw new Error(`Prompt desconocido: ${nombre}`);
  const valores: Record<string, string | undefined> = {};
  for (const arg of p.arguments) {
    const v = args?.[arg.name];
    if (v === undefined || v === null || v === "") {
      if (arg.required) throw new Error(`Falta el argumento \`${arg.name}\` del prompt ${nombre}`);
      continue;
    }
    if (typeof v !== "string") throw new Error(`El argumento \`${arg.name}\` del prompt ${nombre} debe ser texto`);
    valores[arg.name] = v;
  }
  if (nombre === "estudiar-competencia" && !valores.rubro && !valores.organismo)
    throw new Error("El prompt estudiar-competencia necesita `rubro`, `organismo` o ambos");
  return {
    description: p.description,
    messages: [{ role: "user", content: { type: "text", text: TEXTOS[nombre]!(valores) } }],
  };
}
