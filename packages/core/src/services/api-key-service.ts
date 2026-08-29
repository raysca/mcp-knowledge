import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.ts";
import type { ApiKey } from "../domain/types.ts";
import type { KnowledgeRepository } from "../ports.ts";

const SCOPES = new Set(["read", "write", "admin"]);

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export class ApiKeyService {
  constructor(private readonly repo: KnowledgeRepository) {}

  async create(input: { name: string; scopes?: string[] }): Promise<{ key: ApiKey; secret: string }> {
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_REQUEST", "Name is required.", 400);
    const scopes = (input.scopes?.length ? input.scopes : ["read"]).map((s) => s.trim());
    if (scopes.some((s) => !SCOPES.has(s))) {
      throw new AppError("INVALID_REQUEST", "Scopes must be read, write, or admin.", 400);
    }
    const secret = `key_${randomBytes(24).toString("hex")}`;
    const key = await this.repo.createApiKey({
      name,
      keyPrefix: secret.slice(0, 12),
      keyHash: hashSecret(secret),
      scopes,
    });
    return { key, secret };
  }

  async authenticate(bearer: string | null): Promise<ApiKey> {
    if (!bearer) throw new AppError("UNAUTHORIZED", "Missing API key.", 401);
    const key = await this.repo.findApiKeyByHash(hashSecret(bearer));
    if (!key || key.revokedAt) throw new AppError("UNAUTHORIZED", "Invalid API key.", 401);
    await this.repo.touchApiKey(key.id);
    return key;
  }

  list() {
    return this.repo.listApiKeys();
  }
}

export { hashSecret };
