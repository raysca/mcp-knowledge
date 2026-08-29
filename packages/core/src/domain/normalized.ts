export type SourceLocation = {
  pageStart?: number;
  pageEnd?: number;
  slide?: number;
  sheet?: string;
  cellRange?: string;
  section?: string;
  charStart?: number;
  charEnd?: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
};

export type HeadingBlock = {
  type: "heading";
  level: number;
  text: string;
  location?: SourceLocation;
};

export type ParagraphBlock = {
  type: "paragraph";
  text: string;
  location?: SourceLocation;
};

export type TableBlock = {
  type: "table";
  headers?: string[];
  rows: string[][];
  location?: SourceLocation;
};

export type CodeBlock = {
  type: "code";
  text: string;
  language?: string;
  location?: SourceLocation;
};

export type ListBlock = {
  type: "list";
  ordered: boolean;
  items: string[];
  location?: SourceLocation;
};

export type QuoteBlock = {
  type: "quote";
  text: string;
  location?: SourceLocation;
};

export type ImageBlock = {
  type: "image";
  alt: string;
  location?: SourceLocation;
};

export type PageBreakBlock = {
  type: "pageBreak";
  location?: SourceLocation;
};

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | TableBlock
  | CodeBlock
  | ListBlock
  | QuoteBlock
  | ImageBlock
  | PageBreakBlock;

export type NormalizedDocument = {
  title?: string;
  metadata: Record<string, unknown>;
  blocks: DocumentBlock[];
};
