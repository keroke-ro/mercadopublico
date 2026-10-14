import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".stryker-tmp*/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "lcov"],
      // Nivel medido el 2026-10-13 (88.5 / 83.6 / 88.3 / 91.5) menos un margen de ~3 puntos. Subirlos cuando suba la cobertura.
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 88 },
    },
    // Los errores de tipos fuera de los *.test-d.ts los reporta `npm run typecheck`.
    typecheck: { include: ["test/**/*.test-d.ts"], tsconfig: "tsconfig.json", ignoreSourceErrors: true },
  },
});
