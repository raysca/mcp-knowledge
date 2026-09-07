import { resolve } from "node:path";
import { validateScaleReport } from "../scale/lib.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const documentCounts = [100, 500, 1000] as const;

for (const documents of documentCounts) {
  const path = resolve(repositoryRoot, `docs/results/scale-${documents}.json`);
  const report = Bun.file(path);
  if (!(await report.exists())) {
    throw new Error(`Missing scale report: docs/results/scale-${documents}.json`);
  }

  const value = await report.json();
  validateScaleReport(value);
  if (value.documents !== documents) {
    throw new Error(`${path}: expected documents=${documents}, got ${value.documents}`);
  }
}
