import { AppError } from "../errors.ts";
import type { DocumentStatus } from "../domain/types.ts";
import type { CatalogField, CatalogPage, KnowledgeRepository } from "../ports.ts";
import { parseFilters } from "../retrieval/filters.ts";

export const CATALOG_FIELDS: readonly CatalogField[] = [
  "id", "revisionId", "title", "sourcePath", "metadata", "status", "updatedAt",
];

export type CatalogInput = {
  collectionId?: unknown;
  status?: unknown;
  cursor?: unknown;
  limit?: unknown;
  fields?: unknown;
  filters?: unknown;
  ifCorpusVersion?: unknown;
};

export type CatalogResponse =
  | { corpusVersion: string; unchanged: true }
  | (CatalogPage & { corpusVersion: string });

/**
 * Pages are live keyset reads, not a frozen snapshot. Collectors must compare every
 * page's corpusVersion and restart if it changes. Use ifCorpusVersion for refresh
 * checks only; an equal version suppresses the page even when a cursor is supplied.
 */
export class DocumentCatalogService {
  constructor(
    private repo: Pick<KnowledgeRepository, "getCorpusGeneration" | "listDocumentCatalog">,
    private maxLimit: number,
  ) {}

  async list(input: CatalogInput = {}): Promise<CatalogResponse> {
    const limit = input.limit === undefined ? Math.min(50, this.maxLimit) : input.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > this.maxLimit) {
      throw new AppError("INVALID_ARGUMENT", `limit must be an integer between 1 and ${this.maxLimit}.`, 400);
    }
    const status = input.status === undefined ? "ready" : input.status;
    if (typeof status !== "string" || !["pending", "processing", "ready", "failed", "deleted"].includes(status)) {
      throw new AppError("INVALID_ARGUMENT", "status must be pending, processing, ready, failed, or deleted.", 400);
    }
    const collectionId = input.collectionId;
    if (collectionId !== undefined && (typeof collectionId !== "string" || !collectionId.trim())) {
      throw new AppError("INVALID_ARGUMENT", "collectionId must be a non-empty string.", 400);
    }
    const cursor = input.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
      throw new AppError("INVALID_CURSOR", "cursor must be a non-empty string.", 400);
    }
    const fields = input.fields === undefined ? CATALOG_FIELDS.slice(0, 5) : input.fields;
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => !CATALOG_FIELDS.includes(field))) {
      throw new AppError("INVALID_PROJECTION", "fields must be a non-empty array from the catalog projection.", 400);
    }
    const filters = parseFilters(input.filters);
    const version = input.ifCorpusVersion;
    if (version !== undefined) {
      const generation = typeof version === "string" && /^generation:(0|[1-9]\d*)$/.test(version)
        ? Number(version.slice("generation:".length)) : NaN;
      if (!Number.isSafeInteger(generation) || generation < 0 || version !== `generation:${generation}`) {
        throw new AppError("INVALID_CORPUS_VERSION", "ifCorpusVersion must be generation:<nonnegative safe integer>.", 400);
      }
    }

    // Read first: a concurrent mutation must never stamp older rows with a newer
    // generation. Returning the older version forces a later conditional refresh.
    const corpusVersion = `generation:${await this.repo.getCorpusGeneration()}`;
    if (version === corpusVersion) return { corpusVersion, unchanged: true };
    const page = await this.repo.listDocumentCatalog({
      limit, status: status as DocumentStatus, collectionId, cursor, fields, filters,
    });
    return { corpusVersion, ...page };
  }
}
