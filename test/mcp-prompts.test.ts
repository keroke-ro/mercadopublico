import { describe, expect, it } from "vitest";
import { obtenerPrompt, PROMPTS } from "../src/mcp-prompts.js";

const texto = (nombre: string, args: Record<string, unknown>) => obtenerPrompt(nombre, args).messages[0]!.content.text;

describe("PROMPTS", () => {
  it("lista los tres prompts con sus argumentos", () => {
    expect(PROMPTS.map((p) => p.name)).toEqual(["radar-diario", "analizar-licitacion", "estudiar-competencia"]);
    for (const p of PROMPTS) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.arguments.length).toBeGreaterThan(0);
    }
    expect(PROMPTS[0]!.arguments).toEqual([expect.objectContaining({ name: "perfil", required: true })]);
    expect(PROMPTS[1]!.arguments).toEqual([expect.objectContaining({ name: "codigo", required: true })]);
    expect(PROMPTS[2]!.arguments.map((a) => a.name)).toEqual(["rubro", "organismo"]);
    expect(PROMPTS[2]!.arguments.every((a) => !a.required)).toBe(true);
  });
});

describe("obtenerPrompt", () => {
  it("radar-diario rellena la ruta del perfil y menciona radar, sync y proximas", () => {
    const r = obtenerPrompt("radar-diario", { perfil: "/tmp/perfil.json" });
    expect(r.description).toBe(PROMPTS[0]!.description);
    expect(r.messages).toEqual([{ role: "user", content: { type: "text", text: expect.any(String) } }]);
    const t = texto("radar-diario", { perfil: "/tmp/perfil.json" });
    expect(t).toContain("Perfil: /tmp/perfil.json");
    expect(t).toContain("`radar`");
    expect(t).toContain("`sync`");
    expect(t).toContain("`proximas`");
  });

  it("radar-diario acepta el JSON del perfil tal cual", () => {
    const json = '{"pesos":{"rubro":1}}';
    expect(texto("radar-diario", { perfil: json })).toContain(`Perfil: ${json}`);
  });

  it("analizar-licitacion rellena el código y cita la url", () => {
    const t = texto("analizar-licitacion", { codigo: "1509-5-L114" });
    expect(t).toContain("1509-5-L114");
    expect(t).toContain("`fetch`");
    expect(t).toContain("`url`");
  });

  it("estudiar-competencia con solo rubro, solo organismo o ambos", () => {
    const solo = texto("estudiar-competencia", { rubro: "mobiliario escolar" });
    expect(solo).toContain("mobiliario escolar");
    expect(solo).toContain("`search`");
    expect(solo).not.toContain("organismo \"");

    const org = texto("estudiar-competencia", { organismo: "Municipalidad de Ñuñoa" });
    expect(org).toContain("Municipalidad de Ñuñoa");
    expect(org).toContain("`organismos`");
    expect(org).toContain("`listar`");

    const ambos = texto("estudiar-competencia", { rubro: "aseo", organismo: "Hospital X" });
    expect(ambos).toContain("aseo");
    expect(ambos).toContain("Hospital X");
    expect(ambos).toContain("`competidores`");
    expect(ambos).toContain("`precios`");
  });

  it("los textos quedan bajo ~1.200 caracteres", () => {
    for (const [nombre, args] of [
      ["radar-diario", { perfil: "/Users/damian/perfil.json" }],
      ["analizar-licitacion", { codigo: "1509-5-L114" }],
      ["estudiar-competencia", { rubro: "mobiliario escolar", organismo: "Municipalidad de Ñuñoa" }],
    ] as const) {
      expect(texto(nombre, args).length).toBeLessThan(1200);
    }
  });

  it("lanza error en prompt desconocido", () => {
    expect(() => obtenerPrompt("nada", {})).toThrow("Prompt desconocido: nada");
  });

  it("lanza error si falta un argumento requerido (ausente, null o vacío)", () => {
    expect(() => obtenerPrompt("radar-diario", {})).toThrow("Falta el argumento `perfil`");
    expect(() => obtenerPrompt("analizar-licitacion", { codigo: null })).toThrow("Falta el argumento `codigo`");
    expect(() => obtenerPrompt("analizar-licitacion", { codigo: "" })).toThrow("Falta el argumento `codigo`");
  });

  it("lanza error si un argumento no es texto", () => {
    expect(() => obtenerPrompt("analizar-licitacion", { codigo: 123 })).toThrow("debe ser texto");
    expect(() => obtenerPrompt("estudiar-competencia", { rubro: ["a"] })).toThrow("debe ser texto");
  });

  it("estudiar-competencia lanza error sin rubro ni organismo", () => {
    expect(() => obtenerPrompt("estudiar-competencia", {})).toThrow("`rubro`, `organismo` o ambos");
    expect(() => obtenerPrompt("estudiar-competencia", { rubro: "", organismo: undefined })).toThrow("`rubro`, `organismo` o ambos");
  });
});
