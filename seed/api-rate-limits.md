# API Rate Limits

The Document Knowledge API enforces per-key rate limits to keep search latency
predictable for every tenant sharing the process.

## Default limits

- 60 requests per minute for `read` scoped keys.
- 20 requests per minute for `write` scoped keys (uploads, reindex, deletes).
- 5 concurrent ingestion jobs per key at a time.

## Exceeding a limit

When a key exceeds its limit the API responds with HTTP 429 and a
`Retry-After` header in seconds. The response body follows the standard
error envelope:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests for this API key.",
    "requestId": "req_01hxyz"
  }
}
```

## Requesting a higher limit

Self-hosted deployments can raise limits by setting
`API_RATE_LIMIT_PER_MINUTE` in the server environment. There is no hosted
quota to request against — this is a self-hosted service.

## Best practices

1. Batch document uploads instead of issuing one request per file when
   possible.
2. Use the `/api/v1/jobs` endpoint to poll ingestion status rather than
   re-uploading to check completion.
3. Cache search results client-side for repeated identical queries within a
   short window.
