// Todos los temporales de una corrida (tests y mutación) van a una sola carpeta que se borra al final, aunque un
// test no limpie lo suyo. Los workers heredan TMPDIR porque se lanzan después de este setup.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function () {
  const dir = mkdtempSync(join(tmpdir(), "mp-tests-"));
  const antes = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = dir;
  return () => {
    for (const [k, v] of Object.entries(antes)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  };
}
