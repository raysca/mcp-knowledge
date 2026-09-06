import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../apps/server/src/ui/components/ui/table.tsx";

describe("Table", () => {
  test("keeps wide data reachable in a keyboard-focusable scroll region", () => {
    const html = renderToStaticMarkup(
      <Table aria-label="Documents">
        <TableHeader>
          <TableRow><TableHead>File</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <TableRow><TableCell>handbook.pdf</TableCell></TableRow>
        </TableBody>
      </Table>,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Documents"');
    expect(html).toContain("overflow-x-auto");
  });
});
