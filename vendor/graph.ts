/**
 * Die Extraktionspipeline als LangGraph.
 *
 *   parse → chunk → ⟨Send⟩ extract ×N → merge → derive → summarize
 *
 * Kein Agent — aber echtes Fan-out/Fan-in: `Send` startet einen Extraktions-Call je Batch,
 * der Concat-Reducer auf `batchResults` sammelt sie wieder ein. Bei einem 500-Seiten-Dokument
 * sind das 8–9 parallele Calls, bei den fünf Testdokumenten genau einer — die Pipeline ist
 * dann degeneriert identisch mit einem Einzelcall, ohne Sonderfall im Code.
 *
 * Der Graph ist zugleich der Andockpunkt für Schritt 2: der OCR-Zweig kommt vor `parse`,
 * das Excel-Rückschreiben nach `derive`.
 */

import { Annotation, END, START, Send, StateGraph } from "@langchain/langgraph";
import { chunkMarkdown, type Batch, type ChunkOptions } from "./chunk.js";
import { parseSource } from "./parse-source.js";
import type { PdfParseResult } from "./pdf-markdown.js";
import { deriveFields } from "./nodes/derive.js";
import { groundEvidence } from "./nodes/ground-evidence.js";
import { extractBatch, type BatchResult } from "./nodes/extract.js";
import { mergeBatches, type MergedResult, type MergeStats } from "./nodes/merge.js";
import { summarize, type ExtractionSummary } from "./nodes/summarize.js";

export const PipelineState = Annotation.Root({
  /** Eingabe: Pfad zu einem PDF **oder** zu einer Markdown-Datei (Stress-Korpus). */
  sourcePath: Annotation<string>({ default: () => "", reducer: (_, v) => v }),
  parsed: Annotation<PdfParseResult | null>({ default: () => null, reducer: (_, v) => v }),
  batches: Annotation<Batch[]>({ default: () => [], reducer: (_, v) => v }),
  /**
   * Der Concat-Reducer IST der Fan-in: jeder extract-Node schreibt sein Ergebnis, LangGraph
   * sammelt sie ein. Ohne ihn würde der letzte Batch alle vorherigen überschreiben.
   */
  batchResults: Annotation<BatchResult[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
  merged: Annotation<MergedResult | null>({ default: () => null, reducer: (_, v) => v }),
  mergeStats: Annotation<MergeStats | null>({ default: () => null, reducer: (_, v) => v }),
  final: Annotation<MergedResult | null>({ default: () => null, reducer: (_, v) => v }),
  /**
   * Gruppierte Sicht auf `final` — gefunden / unsicher / fehlend / fehlende Prio-Felder.
   * Rein abgeleitet, kein LLM-Schritt; siehe nodes/summarize.ts.
   */
  summary: Annotation<ExtractionSummary | null>({ default: () => null, reducer: (_, v) => v }),
});

export type PipelineStateType = typeof PipelineState.State;

async function parseNode(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  // parseSource entscheidet anhand der Endung: PDF → Docling, Markdown → direkt.
  return { parsed: await parseSource(state.sourcePath) };
}

function chunkNode(state: PipelineStateType, chunkOptions?: ChunkOptions): Partial<PipelineStateType> {
  if (!state.parsed) throw new Error("chunk: parsed fehlt");
  return { batches: chunkMarkdown(state.parsed, chunkOptions) };
}

/** Fan-out: ein extract-Node je Batch. */
function fanOut(state: PipelineStateType): Send[] {
  return state.batches.map((batch) => new Send("extract", { batch }));
}

async function extractNode(input: { batch: Batch }): Promise<Partial<PipelineStateType>> {
  const result = await extractBatch(input.batch);
  return { batchResults: [result] };
}

async function mergeNode(state: PipelineStateType): Promise<Partial<PipelineStateType>> {
  // Ein einzelner fehlgeschlagener Batch soll das Dokument nicht versenken (bei 9 Batches
  // darf ein Timeout nicht alles kosten) — schlagen aber ALLE fehl, ist das Ergebnis kein
  // "nichts gefunden", sondern ein ungültiger Lauf. Ohne diesen Abbruch liefert die
  // Pipeline 71 leere Felder, und die Eval wertet einen kaputten Lauf als schlechtes
  // Modellergebnis. Genau so blieb ein fehlender API-Key unbemerkt.
  const failed = state.batchResults.filter((b) => b.error);
  if (state.batchResults.length > 0 && failed.length === state.batchResults.length) {
    const reasons = [...new Set(failed.map((b) => b.error))].join(" | ");
    throw new Error(
      `Alle ${failed.length} Batch(es) fehlgeschlagen — kein verwertbares Ergebnis: ${reasons}`,
    );
  }
  if (failed.length > 0) {
    console.warn(
      `[graph] ${failed.length} von ${state.batchResults.length} Batches fehlgeschlagen — ` +
        `das Ergebnis ist unvollständig: ${[...new Set(failed.map((b) => b.error))].join(" | ")}`,
    );
  }

  // Reihenfolge sichern: der Fan-in sammelt in Abschlussreihenfolge, nicht in Dokumentreihenfolge.
  // Für die Konfliktauflösung ("der spätere gewinnt") ist die Dokumentreihenfolge maßgeblich.
  const ordered = [...state.batchResults].sort((a, b) => a.batchIndex - b.batchIndex);
  const { merged, stats } = await mergeBatches(ordered);
  return { merged, mergeStats: stats };
}

function deriveNode(state: PipelineStateType): Partial<PipelineStateType> {
  if (!state.merged) throw new Error("derive: merged fehlt");
  const abgeleitet = deriveFields(state.merged);

  // Fundort im Code bestimmen, nicht vom Modell übernehmen. Ohne diesen Schritt trug jedes
  // belegte Feld die Seite, die das Modell geraten hat — bei einem 21-Seiten-PDF 67× die 1,
  // weil das Docling-Markdown keine Seitenmarker enthält (siehe nodes/ground-evidence.ts).
  if (!state.parsed) return { final: abgeleitet };
  const { final, stats } = groundEvidence(abgeleitet, state.parsed, state.batches);
  if (stats.nichtGefunden > 0 || stats.unsicher > 0) {
    console.warn(`  ⚠ Fundort: ${stats.nichtGefunden} Beleg(e) ohne Seite, ${stats.unsicher} mehrdeutig.`);
  }
  return { final };
}

/**
 * Eigener Node statt eines Anhängsels an `derive`: `derive` verändert Werte, `summarize`
 * liest nur. Getrennt bleibt sichtbar, dass nach dem letzten schreibenden Schritt nichts
 * mehr am Ergebnis geändert wird — die Zusammenfassung kann per Konstruktion nicht von
 * `final` abweichen.
 */
function summarizeNode(state: PipelineStateType): Partial<PipelineStateType> {
  if (!state.final) throw new Error("summarize: final fehlt");
  return { summary: summarize(state.final) };
}

export interface PipelineOptions {
  /**
   * Reicht direkt an `chunkMarkdown` durch. Für den Eval-Längen-Sweep (`--single-call`): ein
   * sehr hohes `maxTokens` erzwingt genau einen Batch statt der normalen ~60k-Token-Bündelung —
   * so lässt sich Single-Call gegen gebatcht über die fünf Stress-Stufen vergleichen, ohne
   * Sonderfall-Code (siehe eval/run.ts).
   */
  chunkOptions?: ChunkOptions;
}

export function build(opts: PipelineOptions = {}) {
  const graph = new StateGraph(PipelineState)
    .addNode("parse", parseNode)
    .addNode("chunk", (state: PipelineStateType) => chunkNode(state, opts.chunkOptions))
    .addNode("extract", extractNode)
    .addNode("merge", mergeNode)
    .addNode("derive", deriveNode)
    .addNode("summarize", summarizeNode)
    .addEdge(START, "parse")
    .addEdge("parse", "chunk")
    .addConditionalEdges("chunk", fanOut, ["extract"])
    .addEdge("extract", "merge")
    .addEdge("merge", "derive")
    .addEdge("derive", "summarize")
    .addEdge("summarize", END);

  return graph.compile();
}

/** Bequemer Direktaufruf für CLI und Eval-Target. */
export async function runPipeline(sourcePath: string, opts: PipelineOptions = {}): Promise<PipelineStateType> {
  const app = build(opts);
  return (await app.invoke({ sourcePath })) as PipelineStateType;
}
