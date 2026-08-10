/**
 * Einheitlicher Einstieg für beide Eingabearten: PDF (über Docling) und Markdown.
 *
 * Der Stress-Korpus liegt als `.md` vor — er wird prozedural erzeugt, nicht aus einem PDF
 * gewonnen. Ohne diese Weiche müsste jede Aufrufstelle (CLI, Graph, Eval-Target) die
 * Fallunterscheidung selbst treffen, und der Markdown-Pfad wäre je nach Einstieg
 * unterschiedlich implementiert.
 */

import { readFile } from "node:fs/promises";
import { pdfToMarkdown, type PdfParseResult, type PdfToMarkdownOptions } from "./pdf-markdown.js";

/**
 * Grobe Seitenannahme für Markdown-Eingaben. Sie dient nur der Nachvollziehbarkeit in der
 * Ausgabe (`page` an jedem Feld) — bei einem generierten Korpus gibt es keine echten
 * Seitenumbrüche, und die Auswertung stützt sich auf `evidence`, nicht auf die Seitenzahl.
 */
const LINES_PER_PAGE = 45;

export async function parseMarkdownSource(path: string): Promise<PdfParseResult> {
  const markdown = await readFile(path, "utf8");
  const lines = markdown.split("\n");
  const pages = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));

  const sections = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => /^#{1,6}\s/.test(line))
    .map(({ line, idx }) => ({
      heading: line.replace(/^#+\s*/, "").trim(),
      level: (line.match(/^#+/) ?? ["#"])[0].length,
      startLine: idx,
      endLine: idx,
      page: Math.floor(idx / LINES_PER_PAGE) + 1,
    }));

  for (let i = 0; i < sections.length; i++) {
    sections[i]!.endLine = i + 1 < sections.length ? sections[i + 1]!.startLine - 1 : lines.length - 1;
  }

  return {
    markdown,
    sections,
    pages,
    // Markdown-Eingaben haben per Definition Text; OCR kommt hier nie zum Zug.
    hasTextLayer: true,
    scanPages: [],
    ocrPages: [],
    ocrConfidence: [],
    pageLineOffsets: Array.from({ length: pages }, (_, i) => i * LINES_PER_PAGE),
    lostTokens: [],
    parseMs: 0,
  };
}

/** PDF → Docling, Markdown → direkt. Entscheidet anhand der Dateiendung. */
export async function parseSource(path: string, opts: PdfToMarkdownOptions = {}): Promise<PdfParseResult> {
  return /\.(md|markdown|txt)$/i.test(path) ? parseMarkdownSource(path) : pdfToMarkdown(path, opts);
}
