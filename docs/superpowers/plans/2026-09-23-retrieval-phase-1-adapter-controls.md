# Retrieval Phase 1: MCP Adapter Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate MCP numeric arguments and expose the existing bounded search/chunk context controls.

**Architecture:** Put reusable argument parsing in a small MCP adapter module. Keep expansion, filtering, and neighbor behavior in existing application services; the handler only validates and maps JSON-RPC arguments.

**Tech Stack:** Bun 1.3.13, TypeScript 7, `bun:test`, MCP JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-09-23-magic-voice-retrieval-design.md`

## Global Constraints

- MCP remains a thin adapter; no retrieval logic moves into `apps/server`.
- Existing requests and response fields remain compatible.
- `before` and `after` are capped at 5; search/list limits remain bounded by environment values.
- MCP permits `none`, `neighbors`, and `section` expansion only.
- No new dependency.

## Review Focus

- `NaN`, infinity, booleans, arrays, objects, fractions, zero, and negatives return `INVALID_TOOL_ARGUMENTS`.
- Integer-valued numeric strings remain accepted because Magic Voice currently sends one.
- `expand.type=document` is rejected on MCP even though the service supports it for REST.
- Neighbor results remain ordered and include the requested chunk.
- Malformed metadata filters return `INVALID_FILTER`, not a driver error.

---

### Task 1: Bounded MCP integer parser

**Files:**
- Create: `apps/server/src/mcp/arguments.ts`
- Create: `tests/unit/mcp-arguments.test.ts`

**Interfaces:**
- Produces: `boundedInteger(value, { name, defaultValue, min, max }): number`

- [ ] **Step 1: Write the failing parser tests**

```ts
expect(boundedInteger(undefined, opts)).toBe(8);
expect(boundedInteger("20", opts)).toBe(20);
for (const value of [-1, 0, 1.5, true, [], {}, Number.POSITIVE_INFINITY]) {
  expect(() => boundedInteger(value, opts)).toThrow(/INVALID_TOOL_ARGUMENTS/);
}
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `bun test tests/unit/mcp-arguments.test.ts`  
Expected: FAIL because `arguments.ts` does not exist.

- [ ] **Step 3: Implement the parser**

```ts
type IntegerOptions = { name: string; defaultValue: number; min: number; max: number };

export function boundedInteger(value: unknown, options: IntegerOptions): number {
  if (value === undefined || value === null || value === "") return options.defaultValue;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new AppError("INVALID_TOOL_ARGUMENTS", `${options.name} must be an integer from ${options.min} to ${options.max}.`, 400);
  }
  return parsed;
}
```

- [ ] **Step 4: Run the focused test**

Run: `bun test tests/unit/mcp-arguments.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/arguments.ts tests/unit/mcp-arguments.test.ts
git commit -m "fix: validate bounded MCP integers"
```

### Task 2: Wire MCP search and chunk controls

**Files:**
- Modify: `apps/server/src/mcp/handler.ts`
- Modify: `tests/integration/mcp.test.ts`

**Interfaces:**
- Consumes: `boundedInteger`
- Produces: MCP schemas for `filters`, `expand`, `before`, and `after`

- [ ] **Step 1: Add failing integration assertions**

Add tests that inspect `tools/list`, call `search_documents` with
`expand: { type: "neighbors", before: 1, after: 1 }`, call `get_chunk` with neighbor counts,
and verify invalid limits and `expand.type=document` return `isError: true`.

- [ ] **Step 2: Run the MCP integration tests**

Run: `bun test tests/integration/mcp.test.ts`  
Expected: FAIL because the schemas and mappings are absent.

- [ ] **Step 3: Map validated arguments**

Use `boundedInteger` for search/list limits and neighbor counts. Pass:

```ts
filters: args.filters,
expand: { type, before, after },
```

to `SearchService.search`, and pass `{ before, after }` to `DocumentService.chunk`. Reject expansion
types outside `none | neighbors | section` with `INVALID_TOOL_ARGUMENTS`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test tests/unit/mcp-arguments.test.ts tests/integration/mcp.test.ts`  
Expected: PASS.  
Run: `bun run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/handler.ts tests/integration/mcp.test.ts
git commit -m "feat: expose bounded MCP context controls"
```

### Task 3: Document and verify Phase 1

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document exact request examples**

Add one `search_documents` expansion example and one `get_chunk` neighbor example; state that
`document` expansion remains REST-only.

- [ ] **Step 2: Run the complete gates**

Run: `bun test`  
Expected: all tests pass.  
Run: `bun run typecheck`  
Expected: exit 0.  
Run: `git diff --check`  
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe MCP context controls"
```
