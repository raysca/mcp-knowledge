import { AppError } from "../errors.ts";
import type { FilterClause } from "../ports.ts";

export type { FilterClause };
export type FilterOp = FilterClause["op"];

const FIELD = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const OPS: FilterOp[] = ["eq", "neq", "in", "exists", "gte", "lte"];

type Scalar = string | number | boolean | null;
function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";
}

// ponytail: values reach the driver as bind parameters (packages/retrieval/src/where.ts) -
// SQLite only binds numbers/strings/bigints/buffers/null. An array or object slipping through
// (e.g. `{"year":{"gte":[2020]}}`, a plausible client typo) crashed with an uncaught driver
// error -> 500 instead of a clean 400. Reject at parse time, before it's anywhere near SQL.
function validateValue(field: string, op: FilterOp, value: unknown): void {
  if (op === "exists") {
    if (value !== undefined && typeof value !== "boolean") {
      throw new AppError("INVALID_FILTER", `${field}.exists must be a boolean.`, 400);
    }
    return;
  }
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
      throw new AppError("INVALID_FILTER", `${field}.in must be a non-empty array of scalars.`, 400);
    }
    return;
  }
  if ((op === "gte" || op === "lte") && typeof value !== "number") {
    throw new AppError("INVALID_FILTER", `${field}.${op} must be a number.`, 400);
  }
  if (!isScalar(value)) {
    throw new AppError("INVALID_FILTER", `${field}.${op} must be a scalar.`, 400);
  }
}

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
          validateValue(field, op, obj[op]);
          clauses.push({ field, op, value: obj[op] });
          any = true;
        }
      }
      if (!any) throw new AppError("INVALID_FILTER", `Unknown operator on ${field}.`, 400);
    } else {
      validateValue(field, "eq", spec);
      clauses.push({ field, op: "eq", value: spec });
    }
  }
  return clauses;
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export function compileFilters(
  clauses: FilterClause[],
  dialect: "libsql" | "postgres" = "libsql",
): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  const isPg = dialect === "postgres";

  for (const cl of clauses) {
    const path = isPg ? `{${cl.field.split(".").join(",")}}` : `$.${cl.field}`;
    const extractC = isPg ? "c.metadata #>> ?::text[]" : "json_extract(c.metadata, ?)";
    const extractD = isPg ? "d.metadata #>> ?::text[]" : "json_extract(d.metadata, ?)";
    const numC = isPg ? `CAST(${extractC} AS NUMERIC)` : `CAST(${extractC} AS REAL)`;
    const numD = isPg ? `CAST(${extractD} AS NUMERIC)` : `CAST(${extractD} AS REAL)`;

    switch (cl.op) {
      case "eq":
        if (cl.value === null) {
          if (isPg) {
            parts.push("(jsonb_typeof(c.metadata #> ?::text[]) = 'null' OR jsonb_typeof(d.metadata #> ?::text[]) = 'null')");
          } else {
            // json_extract returns SQL NULL for both missing paths and JSON null.
            parts.push("(json_type(c.metadata, ?) = 'null' OR json_type(d.metadata, ?) = 'null')");
          }
          args.push(path, path);
        } else {
          parts.push(`(${extractC} = ? OR ${extractD} = ?)`);
          args.push(path, isPg ? String(cl.value) : cl.value, path, isPg ? String(cl.value) : cl.value);
        }
        break;
      case "neq":
        if (isPg) {
          if (cl.value === null) {
            parts.push(`(coalesce(${extractC}, ${extractD}) IS NOT NULL)`);
            args.push(path, path);
          } else {
            parts.push(`(coalesce(${extractC}, ${extractD}) IS DISTINCT FROM ?)`);
            args.push(path, path, String(cl.value));
          }
        } else {
          parts.push(
            "(coalesce(json_extract(c.metadata, ?), json_extract(d.metadata, ?)) IS NOT ?)",
          );
          args.push(path, path, cl.value);
        }
        break;
      case "exists": {
        const want = cl.value !== false;
        if (want) {
          parts.push(`(${extractC} IS NOT NULL OR ${extractD} IS NOT NULL)`);
          args.push(path, path);
        } else {
          parts.push(`(${extractC} IS NULL AND ${extractD} IS NULL)`);
          args.push(path, path);
        }
        break;
      }
      case "gte":
        parts.push(`(${numC} >= ? OR ${numD} >= ?)`);
        args.push(path, cl.value, path, cl.value);
        break;
      case "lte":
        parts.push(`(${numC} <= ? OR ${numD} <= ?)`);
        args.push(path, cl.value, path, cl.value);
        break;
      case "in": {
        const values = Array.isArray(cl.value) ? cl.value : [];
        if (values.length === 0) {
          parts.push("0 = 1");
          break;
        }
        const nonNull = values.filter((value) => value !== null);
        const matches: string[] = [];
        if (nonNull.length > 0) {
          const ph = placeholders(nonNull.length);
          matches.push(`${extractC} IN (${ph})`, `${extractD} IN (${ph})`);
          const serialized = isPg ? nonNull.map(String) : nonNull;
          args.push(path, ...serialized, path, ...serialized);
        }
        if (values.includes(null)) {
          if (isPg) {
            matches.push("jsonb_typeof(c.metadata #> ?::text[]) = 'null'", "jsonb_typeof(d.metadata #> ?::text[]) = 'null'");
          } else {
            matches.push("json_type(c.metadata, ?) = 'null'", "json_type(d.metadata, ?) = 'null'");
          }
          args.push(path, path);
        }
        parts.push(`(${matches.join(" OR ")})`);
        break;
      }
    }
  }
  return { sql: parts.join(" AND "), args };
}
