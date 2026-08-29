import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";

export type SearchMode = "hybrid" | "vector" | "lexical";
export type ExpandType = "none" | "neighbors" | "section";

export type PlaygroundForm = {
  query: string;
  collectionIds: string[];
  documentIds: string[];
  metadataJson: string;
  mode: SearchMode;
  limit: number;
  expand: ExpandType;
  explain: boolean;
};

type SearchHit = {
  chunkId: string;
  documentId: string;
  title?: string;
  content: string;
  headingPath: string[];
  location?: Record<string, unknown>;
  ranking: {
    finalRank: number;
    vectorRank?: number;
    lexicalRank?: number;
    fusionScore?: number;
  };
};

type ExplainResult = {
  hits: SearchHit[];
  timings?: { totalMs: number; embeddingMs: number; vectorSearchMs: number; lexicalSearchMs: number; fusionMs: number };
  matchedTerms?: string[];
};

export function buildSearchRequest(form: PlaygroundForm): { path: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    query: form.query,
    mode: form.mode,
    limit: form.limit,
  };
  if (form.collectionIds.length) body.collectionIds = form.collectionIds;
  if (form.documentIds.length) body.documentIds = form.documentIds;
  const raw = form.metadataJson.trim();
  if (raw) {
    try {
      body.filters = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Metadata filters must be JSON, e.g. {\"dept\":\"legal\"}.");
    }
  }
  if (form.expand !== "none") body.expand = { type: form.expand, before: 2, after: 2 };
  return { path: form.explain ? "/api/v1/search/explain" : "/api/v1/search", body };
}

function pages(location?: Record<string, unknown>): string {
  if (!location) return "—";
  const start = location.pageStart ?? location.page;
  const end = location.pageEnd ?? start;
  if (start == null) {
    if (typeof location.sheet === "string") return location.sheet;
    if (typeof location.slide === "number") return `Slide ${location.slide}`;
    return "—";
  }
  return start === end ? String(start) : `${start}–${end}`;
}

const field = "block text-xs font-medium uppercase tracking-wide text-slate";
const selectClass =
  "min-h-9 w-full rounded-sm border border-rule bg-paper px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy";

export function PlaygroundPage() {
  const [query, setQuery] = useState("");
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [metadataJson, setMetadataJson] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [limit, setLimit] = useState(8);
  const [expand, setExpand] = useState<ExpandType>("none");
  const [explain, setExplain] = useState(true);
  const [collections, setCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [documents, setDocuments] = useState<Array<{ id: string; originalFilename: string }>>([]);
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/collections")
      .then((r) => r.json())
      .then((d: { items?: Array<{ id: string; name: string }> }) => setCollections(d.items ?? []));
    void fetch("/api/v1/documents")
      .then((r) => r.json())
      .then((d: { items?: Array<{ id: string; originalFilename: string }> }) => setDocuments(d.items ?? []));
  }, []);

  const search = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const req = buildSearchRequest({
        query,
        collectionIds,
        documentIds,
        metadataJson,
        mode,
        limit,
        expand,
        explain,
      });
      const res = await fetch(req.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
      });
      const data = (await res.json()) as ExplainResult & { error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? "Search failed.");
        setResult(null);
        return;
      }
      setResult(data);
      setSelected(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [query, collectionIds, documentIds, metadataJson, mode, limit, expand, explain]);

  async function expandHit(chunkId: string) {
    const res = await fetch(`/api/v1/chunks/${chunkId}?before=2&after=2`);
    const data = (await res.json()) as { items?: Array<{ content: string }>; error?: { message: string } };
    if (!res.ok || !data.items) {
      setError(data.error?.message ?? "Could not expand chunk.");
      return;
    }
    setResult((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        hits: cur.hits.map((h) =>
          h.chunkId === chunkId ? { ...h, content: data.items!.map((c) => c.content).join("\n\n") } : h,
        ),
      };
    });
  }

  const hits = result?.hits ?? [];
  const hit = hits[selected];

  return (
    <section>
      <p className="mb-4 max-w-xl text-slate">
        Same retrieval as HTTP and MCP. Ranks and fusion scores come from the explain API.
      </p>
      <form
        className="mb-8 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="sm:col-span-2">
          <span className={field}>Query</span>
          <Input
            className="mt-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What are the cancellation terms?"
          />
        </label>
        <label>
          <span className={field}>Collection filter</span>
          <select
            className={`mt-1 ${selectClass}`}
            multiple
            value={collectionIds}
            onChange={(e) => setCollectionIds([...e.target.selectedOptions].map((o) => o.value))}
          >
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={field}>Document filter</span>
          <select
            className={`mt-1 ${selectClass}`}
            multiple
            value={documentIds}
            onChange={(e) => setDocumentIds([...e.target.selectedOptions].map((o) => o.value))}
          >
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.originalFilename}
              </option>
            ))}
          </select>
        </label>
        <label className="sm:col-span-2">
          <span className={field}>Metadata filters</span>
          <Input
            className="mt-1 font-mono text-xs"
            value={metadataJson}
            onChange={(e) => setMetadataJson(e.target.value)}
            placeholder='{"dept":"legal"}'
          />
        </label>
        <label>
          <span className={field}>Mode</span>
          <select className={`mt-1 ${selectClass}`} value={mode} onChange={(e) => setMode(e.target.value as SearchMode)}>
            <option value="hybrid">hybrid</option>
            <option value="vector">vector</option>
            <option value="lexical">lexical</option>
          </select>
        </label>
        <label>
          <span className={field}>Limit</span>
          <Input
            className="mt-1"
            type="number"
            min={1}
            max={50}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 8)}
          />
        </label>
        <label>
          <span className={field}>Context expansion</span>
          <select
            className={`mt-1 ${selectClass}`}
            value={expand}
            onChange={(e) => setExpand(e.target.value as ExpandType)}
          >
            <option value="none">none</option>
            <option value="neighbors">neighbors</option>
            <option value="section">section</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={explain} onChange={(e) => setExplain(e.target.checked)} />
          Explain
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy || !query.trim()}>
            {busy ? "Searching…" : "Search"}
          </Button>
        </div>
      </form>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {result ? (
        <div className="mb-4 text-sm text-slate">
          {result.timings ? (
            <p>
              {result.timings.totalMs.toFixed(0)} ms
              {explain ? (
                <span className="ml-2 font-mono text-[11px]">
                  embed {result.timings.embeddingMs.toFixed(0)} · vec {result.timings.vectorSearchMs.toFixed(0)} · lex{" "}
                  {result.timings.lexicalSearchMs.toFixed(0)} · fuse {result.timings.fusionMs.toFixed(0)}
                </span>
              ) : null}
            </p>
          ) : null}
          {result.matchedTerms?.length ? (
            <p className="mt-1">
              Matched terms: {result.matchedTerms.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {hit ? (
        <article className="border border-rule bg-shelf/40 p-4">
          <p className="font-mono text-[11px] uppercase tracking-wide text-navy">Result #{hit.ranking.finalRank}</p>
          <h2 className="font-display text-2xl">{hit.title ?? hit.documentId}</h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className={field}>Section</dt>
              <dd>{hit.headingPath.length ? hit.headingPath.join(" > ") : "—"}</dd>
            </div>
            <div>
              <dt className={field}>Pages</dt>
              <dd>{pages(hit.location)}</dd>
            </div>
            <div>
              <dt className={field}>Final rank</dt>
              <dd>#{hit.ranking.finalRank}</dd>
            </div>
            <div>
              <dt className={field}>Vector rank</dt>
              <dd>{hit.ranking.vectorRank != null ? `#${hit.ranking.vectorRank}` : "—"}</dd>
            </div>
            <div>
              <dt className={field}>Lexical rank</dt>
              <dd>{hit.ranking.lexicalRank != null ? `#${hit.ranking.lexicalRank}` : "—"}</dd>
            </div>
            <div>
              <dt className={field}>Fusion score</dt>
              <dd className="font-mono text-xs">
                {hit.ranking.fusionScore != null ? hit.ranking.fusionScore.toFixed(4) : "—"}
              </dd>
            </div>
          </dl>
          <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap border border-rule bg-paper p-3 text-sm">
            {hit.content}
          </pre>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={selected === 0} onClick={() => setSelected((i) => i - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={selected >= hits.length - 1}
              onClick={() => setSelected((i) => i + 1)}
            >
              Next
            </Button>
            <Button variant="outline" size="sm" onClick={() => void expandHit(hit.chunkId)}>
              Expand section
            </Button>
            <a className="inline-flex h-8 items-center px-2 text-sm text-navy underline" href={`/api/v1/documents/${hit.documentId}/file`}>
              Open document
            </a>
          </div>
        </article>
      ) : result ? (
        <p className="border border-dashed border-rule px-4 py-12 text-center text-slate">No hits.</p>
      ) : null}
    </section>
  );
}
