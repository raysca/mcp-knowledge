import { AppError } from "../errors.ts";
import type { FilterClause } from "../ports.ts";

export type { FilterClause };
export type FilterOp = FilterClause["op"];

const FIELD = /^[A-Za-z0-9_.]+$/;
const OPS: FilterOp[] = ["eq", "neq", "in", "exists", "gte", "lte"];

export function parseFilters(raw: unknown): FilterClause[] {
  if (raw == null || raw === undefined) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("INVALID_FILTER", "filters must be an object.", 400);
  }
  const clauses: FilterClause[] = [];
  for (const [field, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD.test(field)) throw new AppError("INVALID_FILTER", `Invalid filter field: ${field}`, 400);
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      const obj = spec as Record<string, unknown>;
      let any = false;
      for (const op of OPS) {
        if (op in obj) {
          clauses.push({ field, op, value: obj[op] });
          any = true;
        }
      }
      if (!any) throw new AppError("INVALID_FILTER", `Unknown operator on ${field}.`, 400);
    } else {
      clauses.push({ field, op: "eq", value: spec });
    }
  }
  return clauses;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export function compileFilters(clauses: FilterClause[]): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  for (const cl of clauses) {
    const path = `$.${cl.field}`;
    switch (cl.op) {
      case "eq":
        parts.push("(json_extract(c.metadata, ?) = ? OR json_extract(d.metadata, ?) = ?)");
        args.push(path, cl.value, path, cl.value);
        break;
      case "neq":
        parts.push(
          "(coalesce(json_extract(c.metadata, ?), json_extract(d.metadata, ?)) IS NOT ?)",
        );
        args.push(path, path, cl.value);
        break;
      case "exists": {
        const want = cl.value !== false;
        if (want) {
          parts.push("(json_extract(c.metadata, ?) IS NOT NULL OR json_extract(d.metadata, ?) IS NOT NULL)");
          args.push(path, path);
        } else {
          parts.push("(json_extract(c.metadata, ?) IS NULL AND json_extract(d.metadata, ?) IS NULL)");
          args.push(path, path);
        }
        break;
      }
      case "gte":
        parts.push(
          "(CAST(json_extract(c.metadata, ?) AS REAL) >= ? OR CAST(json_extract(d.metadata, ?) AS REAL) >= ?)",
        );
        args.push(path, cl.value, path, cl.value);
        break;
      case "lte":
        parts.push(
          "(CAST(json_extract(c.metadata, ?) AS REAL) <= ? OR CAST(json_extract(d.metadata, ?) AS REAL) <= ?)",
        );
        args.push(path, cl.value, path, cl.value);
        break;
      case "in": {
        const values = Array.isArray(cl.value) ? cl.value : [];
        if (values.length === 0) {
          parts.push("0");
          break;
        }
        const ph = placeholders(values.length);
        parts.push(
          `(json_extract(c.metadata, ?) IN (${ph}) OR json_extract(d.metadata, ?) IN (${ph}))`,
        );
        args.push(path, ...values, path, ...values);
        break;
      }
    }
  }
  return { sql: parts.join(" AND "), args };
}
