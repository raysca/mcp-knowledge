#!/usr/bin/env bash
# Uploads the docs in seed/ to a running server via the REST API, filed
# under a "Seed" collection. Usage: scripts/seed.sh [base_url]
# ponytail: csv is not seeded here — AnyDoc can't content-sniff plain CSV
# and every csv upload currently fails ingestion (see error-codes.txt).
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
SEED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../seed" && pwd)"

collection_id=$(curl -sS -X POST "$BASE_URL/api/v1/collections" \
  -H 'content-type: application/json' \
  -d '{"name":"Seed"}' | tee /dev/stderr | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

for f in "$SEED_DIR"/*; do
  echo "uploading $(basename "$f")"
  curl -sS -X POST "$BASE_URL/api/v1/documents" \
    -F "file=@$f" \
    -F "collectionId=$collection_id"
  echo
done
