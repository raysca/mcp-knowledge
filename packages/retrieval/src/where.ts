import type { FilterClause } from "@mcp-knowledge/core";
import { compileFilters } from "@mcp-knowledge/core";

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export function extraWhere(input: {
  collectionIds?: string[];
  documentIds?: string[];
  filters?: FilterClause[];
}): { sql: string; args: unknown[] } {
  let sql = "";
  const args: unknown[] = [];
  if (input.documentIds?.length) {
    sql += ` AND c.document_id IN (${placeholders(input.documentIds.length)})`;
    args.push(...input.documentIds);
  }
  if (input.collectionIds?.length) {
    sql += ` AND c.collection_id IN (${placeholders(input.collectionIds.length)})`;
    args.push(...input.collectionIds);
  }
  if (input.filters?.length) {
    const compiled = compileFilters(input.filters);
    if (compiled.sql) {
      sql += ` AND ${compiled.sql}`;
      args.push(...compiled.args);
    }
  }
  return { sql, args };
}
