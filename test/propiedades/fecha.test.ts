// Husos de America/Santiago: ida y vuelta entre hora de pared e instante, cambios de horario incluidos.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ddmmaaaa, desdeHoraSantiago, diaSantiago, isoSantiago, normalizarFecha, sumarDias } from "../../src/fecha.js";
import { ISO } from "./generadores.js";

const HORA = 3_600_000;
const pared = (iso: string) => iso.slice(0, 19);
const masUnaHora = (p: string) => new Date(new Date(`${p}Z`).getTime() + HORA).toISOString().slice(0, 19);

describe("fecha: cada hora de 2025 a 2027", () => {
  it("la hora de pared vuelve al mismo instante salvo la segunda pasada del cambio de otoño; el salto de primavera avanza 1 h", () => {
    const vistas = new Set<string>();
    const repetidas: string[] = [];
    for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1, 3); t += HORA) {
      const iso = isoSantiago(new Date(t));
      expect(iso).toMatch(ISO);
      expect(diaSantiago(new Date(t))).toBe(iso.slice(0, 10));
      const p = pared(iso);
      // Hora repetida: gana la primera ocurrencia, una hora antes.
      const esperado = vistas.has(p) ? t - HORA : t;
      if (vistas.has(p)) repetidas.push(p);
      vistas.add(p);
      expect(desdeHoraSantiago(p).getTime()).toBe(esperado);
    }

    const saltadas: string[] = [];
    for (let d = "2025-01-01"; d < "2028-01-01"; d = sumarDias(d, 1))
      for (let h = 0; h < 24; h++) {
        const p = `${d}T${String(h).padStart(2, "0")}:00:00`;
        if (vistas.has(p)) continue;
        saltadas.push(p);
        expect(pared(isoSantiago(desdeHoraSantiago(p)))).toBe(masUnaHora(p));
      }
    // Un cambio de cada tipo por año (abril y septiembre).
    expect(repetidas.map((p) => p.slice(5, 7))).toEqual(["04", "04", "04"]);
    expect(saltadas.map((p) => p.slice(5, 7))).toEqual(["09", "09", "09"]);
  });
});

describe("fecha: instantes al azar", () => {
  const instante = fc.date({ min: new Date("1971-01-01T00:00:00Z"), max: new Date("2099-12-31T00:00:00Z"), noInvalidDate: true });
  const segundo = (d: Date) => Math.floor(d.getTime() / 1000) * 1000;

  it("isoSantiago es ISO con -03:00/-04:00, Date.parse lo lee de vuelta y diaSantiago coincide", () => {
    fc.assert(
      fc.property(instante, (d) => {
        const iso = isoSantiago(d);
        expect(iso).toMatch(ISO);
        expect(Date.parse(iso)).toBe(segundo(d));
        expect(desdeHoraSantiago(iso).getTime()).toBe(segundo(d));
        expect(diaSantiago(d)).toBe(iso.slice(0, 10));
      }),
      { numRuns: 2000 },
    );
  });

  it("la pared de un instante vuelve a él o, si es hora repetida, a la primera pasada (1 h antes)", () => {
    fc.assert(
      fc.property(instante, (d) => {
        const t = desdeHoraSantiago(pared(isoSantiago(d))).getTime();
        expect([segundo(d), segundo(d) - HORA]).toContain(t);
        if (t !== segundo(d)) expect(pared(isoSantiago(new Date(t)))).toBe(pared(isoSantiago(d)));
      }),
      { numRuns: 2000 },
    );
  });

  it("sumarDias: n y −n se anulan, y se compone", () => {
    const dia = instante.map((d) => d.toISOString().slice(0, 10));
    const n = fc.integer({ min: -20_000, max: 20_000 });
    fc.assert(
      fc.property(dia, n, n, (d, a, b) => {
        expect(sumarDias(sumarDias(d, a), -a)).toBe(d);
        expect(sumarDias(sumarDias(d, a), b)).toBe(sumarDias(d, a + b));
        if (a > 0) expect(sumarDias(d, a) > d).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("ddmmaaaa", () => {
    fc.assert(
      fc.property(instante, (d) => {
        const [a, m, dd] = d.toISOString().slice(0, 10).split("-");
        const s = ddmmaaaa(d.toISOString().slice(0, 10));
        expect(s).toMatch(/^\d{8}$/);
        expect(s).toBe(`${dd}${m}${a}`);
      }),
      { numRuns: 500 },
    );
  });

  it("normalizarFecha con texto arbitrario: null, RangeError o ISO de Santiago; nunca inventa fechas", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.integer().map(String), fc.double().map(String)), (s) => {
        let r: string | null = null;
        try {
          r = normalizarFecha(s);
        } catch (e) {
          expect(e).toBeInstanceOf(RangeError);
        }
        if (r !== null) {
          expect(r).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
          expect(s).toMatch(/^\d{4}-\d{2}-\d{2}/);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe("fecha: regresiones", () => {
  it("antes de 1990 es relleno de la API, no una fecha", () => {
    expect(normalizarFecha("1900-01-11T00:00:00")).toBeNull();
    expect(normalizarFecha("1900-01-02")).toBeNull();
    expect(normalizarFecha("1990-01-01T00:00:00")).toBe("1990-01-01T00:00:00-03:00");
  });
  it("un número suelto no es una fecha (antes \"12\" daba 2001-11-30)", () => {
    expect(() => normalizarFecha("12")).toThrow(RangeError);
    expect(() => normalizarFecha("1")).toThrow(RangeError);
  });
  it("antes de 1910 Santiago tenía offset con segundos (LMT); se redondea a ±hh:mm para que siga siendo ISO", () => {
    // Fecha "vacía" típica de SQL Server; antes salía "1899-12-31T23:59:15-04:42:45", que Date.parse no lee.
    const r = isoSantiago(desdeHoraSantiago("1900-01-01T00:00:00"));
    expect(r).toBe("1900-01-01T00:00:00-04:42");
    expect(Number.isNaN(Date.parse(r))).toBe(false);
  });
});
