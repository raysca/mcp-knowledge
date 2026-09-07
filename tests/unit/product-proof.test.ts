import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const expectedPngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readPngDimensions(path: string) {
  const image = await readFile(resolve(repositoryRoot, path));

  expect(image.subarray(0, 8)).toEqual(expectedPngSignature);
  expect(image.subarray(12, 16).toString("ascii")).toBe("IHDR");

  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
}

function imageTag(markup: string, source: string) {
  const tag = markup.match(new RegExp(`<img\\b(?=[^>]*\\bsrc=["']${source}["'])[^>]*>`, "i"))?.[0];
  expect(tag).toBeDefined();
  return tag ?? "";
}

function expectAccessibleImage(tag: string, width: number, height: number) {
  expect(tag).toMatch(/\balt=["'][^"']+["']/i);
  expect(tag).toContain(`width="${width}"`);
  expect(tag).toContain(`height="${height}"`);
}

function metaContent(markup: string, attribute: "name" | "property", key: string) {
  const tag = markup.match(new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${key}["'])[^>]*>`, "i"))?.[0];
  expect(tag).toBeDefined();
  return tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
}

describe("public product proof", () => {
  test("ships real PNG captures and a 1200 by 630 social preview", async () => {
    expect(await readPngDimensions("assets/screenshots/dashboard.png")).toEqual({
      width: 1440,
      height: 900,
    });
    expect(await readPngDimensions("assets/screenshots/playground.png")).toEqual({
      width: 1440,
      height: 900,
    });
    expect(await readPngDimensions("assets/social-preview.png")).toEqual({
      width: 1200,
      height: 630,
    });

    const editableSource = await readFile(resolve(repositoryRoot, "assets/social-preview.svg"), "utf8");
    expect(editableSource).toMatch(/<svg[^>]*\bwidth="1200"[^>]*\bheight="630"[^>]*\bviewBox="0 0 1200 630"/);
  });

  test("README shows both product surfaces with descriptive alternatives", async () => {
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
    const dashboard = imageTag(readme, "assets/screenshots/dashboard.png");
    const playground = imageTag(readme, "assets/screenshots/playground.png");

    expectAccessibleImage(dashboard, 1440, 900);
    expectAccessibleImage(playground, 1440, 900);
  });

  test("landing page includes responsive, accessible visual proof", async () => {
    const landingPage = await readFile(resolve(repositoryRoot, "index.html"), "utf8");
    const proof = landingPage.match(/<section\b[^>]*\bid="product-proof"[^>]*>[\s\S]*?<\/section>/i)?.[0];

    expect(proof).toBeDefined();
    for (const source of ["assets/screenshots/dashboard.png", "assets/screenshots/playground.png"]) {
      const image = imageTag(proof ?? "", source);
      expectAccessibleImage(image, 1440, 900);
      expect(image).toContain('loading="lazy"');
      expect(image).toContain('decoding="async"');
    }

    expect(landingPage).toMatch(/\.product-proof-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(landingPage).toMatch(/@media\s*\(max-width:\s*940px\)[\s\S]*?\.product-proof-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  test("social metadata describes an absolute large-card image", async () => {
    const landingPage = await readFile(resolve(repositoryRoot, "index.html"), "utf8");
    const socialImage = "https://raysca.github.io/mcp-knowledge/assets/social-preview.png";

    expect(metaContent(landingPage, "property", "og:image")).toBe(socialImage);
    expect(metaContent(landingPage, "property", "og:image:secure_url")).toBe(socialImage);
    expect(metaContent(landingPage, "property", "og:image:width")).toBe("1200");
    expect(metaContent(landingPage, "property", "og:image:height")).toBe("630");
    expect(metaContent(landingPage, "property", "og:image:type")).toBe("image/png");
    expect(metaContent(landingPage, "property", "og:image:alt")).toMatch(/MCP Knowledge.+dashboard.+playground/i);
    expect(metaContent(landingPage, "name", "twitter:card")).toBe("summary_large_image");
    expect(metaContent(landingPage, "name", "twitter:image")).toBe(socialImage);
    expect(metaContent(landingPage, "name", "twitter:image:alt")).toMatch(/MCP Knowledge.+dashboard.+playground/i);
  });

  test("landing page local asset references resolve", async () => {
    const landingPage = await readFile(resolve(repositoryRoot, "index.html"), "utf8");
    const references = [...landingPage.matchAll(/\b(?:src|href)=["'](assets\/[^"']+)["']/g)].map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    await Promise.all(references.map((reference) => access(resolve(repositoryRoot, reference))));
  });
});
