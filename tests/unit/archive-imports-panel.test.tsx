import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArchiveImportsPanel,
  type ArchiveImportSummary,
} from "../../apps/server/src/ui/components/archive-imports-panel.tsx";

const base: ArchiveImportSummary = {
  id: "arc_1",
  originalFilename: "export.zip",
  state: "extracting",
  counts: { examined: 2, extracted: 1, duplicate: 0, unsupported: 1, oversized: 0, failed: 0 },
  error: null,
};

describe("ArchiveImportsPanel", () => {
  test("renders nothing when there are no imports and no error", () => {
    const html = renderToStaticMarkup(<ArchiveImportsPanel items={[]} error={null} />);
    expect(html).toBe("");
  });

  test("lists an in-progress import with its counts", () => {
    const html = renderToStaticMarkup(<ArchiveImportsPanel items={[base]} error={null} />);
    expect(html).toContain("Archive imports");
    expect(html).toContain("export.zip");
    expect(html).toContain("1 extracted");
  });

  test("shows a failed import's safe error without leaking paths", () => {
    const failed: ArchiveImportSummary = {
      ...base,
      state: "failed",
      error: "ARCHIVE_TOO_LARGE: This archive is too large uncompressed.",
    };
    const html = renderToStaticMarkup(<ArchiveImportsPanel items={[failed]} error={null} />);
    expect(html).toContain("ARCHIVE_TOO_LARGE: This archive is too large uncompressed.");
    expect(html).not.toContain("/Users/");
  });

  test("surfaces a fetch error without hiding existing items", () => {
    const html = renderToStaticMarkup(
      <ArchiveImportsPanel items={[base]} error="Could not load archive imports." />,
    );
    expect(html).toContain("export.zip");
    expect(html).toContain("Could not load archive imports.");
  });
});
