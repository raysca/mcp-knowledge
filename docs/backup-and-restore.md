# Backup and restore

The local profile keeps both the libSQL database and every canonical document
original in the named Docker volume `mcp-knowledge-data`. Back up the whole
volume while the `knowledge` service is stopped; a database-only or
documents-only copy is not a recoverable backup.

These archives contain the original documents, extracted content, embeddings,
job history, collections, and API-key records. Store them with the same access
controls as the running service's data.

## Create an offline backup

Run these commands from the repository root. The destination directory must
already exist, and the archive path must not already exist.

```sh
mkdir -p backups
docker compose stop knowledge
./scripts/backup-volume.sh "$PWD/backups/mcp-knowledge-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose up -d
```

The script checks that Docker is available, the Compose service is stopped,
the exact volume `mcp-knowledge-data` exists, and the existing local app image
`mcp-knowledge:local` exists. It mounts the data volume read-only and will not
replace an existing archive. Do not use `docker compose down --volumes` as a
backup step; that removes the data being backed up.

## Restore into a new empty volume

Restore only while the service is stopped. On a new Docker host, build or load
the app image first, then create the named volume:

```sh
docker compose build
docker volume create mcp-knowledge-data
./scripts/restore-volume.sh /absolute/path/to/mcp-knowledge-backup.tar.gz
docker compose up -d
```

On an existing host, `docker compose down` preserves the named volume. The
restore script deliberately refuses to write if that volume contains anything.
To replace damaged data, first preserve or independently copy the old volume.
Only after confirming that the old data may be discarded should an operator
remove and recreate this one explicit volume:

```sh
docker compose down
docker volume inspect mcp-knowledge-data
# Destructive: run only after the old volume has been preserved or is disposable.
docker volume rm mcp-knowledge-data
docker volume create mcp-knowledge-data
./scripts/restore-volume.sh /absolute/path/to/mcp-knowledge-backup.tar.gz
docker compose up -d
```

The restore script validates the gzip tar archive before mounting the volume
writable. It rejects absolute paths, parent traversal, entries outside `data/`,
links, special files, a running Compose service, and a non-empty target. It
never deletes or overwrites existing volume contents.

## Verify the restored service

Wait for `/health` to succeed, list the restored documents, and select a known
document ID from the response:

```sh
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/api/v1/documents
DOCUMENT_ID=doc_replace_with_a_restored_id
curl --fail --output restored-original \
  "http://127.0.0.1:3000/api/v1/documents/$DOCUMENT_ID/file"
curl --fail -H 'content-type: application/json' \
  --data '{"query":"a distinctive phrase from the document","mode":"hybrid","limit":8}' \
  http://127.0.0.1:3000/api/v1/search
```

Compare `restored-original` with the source file or a previously recorded
checksum. To prove derived data can be rebuilt from the restored canonical
original, enqueue a reindex and inspect the document and job until both return
to `ready`/`completed`:

```sh
curl --fail -X POST \
  "http://127.0.0.1:3000/api/v1/documents/$DOCUMENT_ID/reindex"
curl --fail "http://127.0.0.1:3000/api/v1/documents/$DOCUMENT_ID"
curl --fail http://127.0.0.1:3000/api/v1/jobs
```

This v0.1 procedure is an offline snapshot. It does not claim online,
incremental, remote-replication, or scheduled-backup support.
