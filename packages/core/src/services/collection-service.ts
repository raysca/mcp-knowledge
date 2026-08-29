import { AppError } from "../errors.ts";
import type { Collection } from "../domain/types.ts";
import type { KnowledgeRepository } from "../ports.ts";

export class CollectionService {
  constructor(private readonly repo: KnowledgeRepository) {}

  create(input: { name: string; description?: string }): Promise<Collection> {
    if (!input.name.trim()) {
      throw new AppError("INVALID_NAME", "Collection name is required.", 400);
    }
    return this.repo.createCollection(input);
  }

  list(): Promise<Collection[]> {
    return this.repo.listCollections();
  }

  async get(id: string): Promise<Collection> {
    const col = await this.repo.getCollection(id);
    if (!col) throw new AppError("COLLECTION_NOT_FOUND", "Collection was not found.", 404);
    return col;
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Collection> {
    await this.get(id);
    return this.repo.updateCollection(id, patch);
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    const n = await this.repo.countDocumentsInCollection(id);
    if (n > 0) {
      throw new AppError(
        "COLLECTION_NOT_EMPTY",
        "Delete or move documents before deleting this collection.",
        409,
      );
    }
    await this.repo.deleteCollection(id);
  }
}
