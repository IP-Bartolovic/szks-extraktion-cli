/**
 * Batch-Aufteilung, Stufe 2 der Extraktionspipeline. Rein deterministisch (kein LLM-Call).
 *
 * ## Warum überhaupt batchen
 *
 * Reale Eingaben gehen bis 500 Seiten ≈ 350k–500k Token. Bei der Größe verliert ein
 * einzelner Extraktions-Call rund die Hälfte der Felder (MRCR-8-Needle-Befund:
 * 256–512k Kontext → 57,5% Trefferquote), und zwar unsichtbar als stilles `not_found` —
 * das Modell "sieht" das Feld nicht, meldet aber keinen Fehler. Deshalb wird gebatcht: mehrere
 * kleinere Calls statt einem riesigen. Die fünf realen Testdokumente (0,5k–10,6k Token) liegen
 * weit unter der Schwelle und ergeben genau **einen** Batch — bei N=1 ist die Pipeline
 * degeneriert identisch mit dem Einzelcall, ohne Sonderfall im Code (kein `if (batches.length
 * === 1) ...`, die Batching-Logik läuft für sie einfach durch und stoppt beim ersten Unit, weil
 * nichts überläuft).
 *
 * ## Zwei Ebenen der Aufteilung
 *
 * 1. **Bündeln** (greedy, an Abschnittsgrenzen): Abschnitte werden der Reihe nach in einen
 *    Batch gepackt, bis der nächste Abschnitt `maxTokens` sprengen würde. Läuft ein Batch voll,
 *    wird bevorzugt an der letzten `level: 1`-Grenze geschlossen (Kapitelgrenze) statt mitten in
 *    einem Kapitel — aber nur, wenn das nicht selbst zu einem Überlauf führt (siehe unten).
 *    Abschnitte werden auf dieser Ebene nie zerteilt; ein Abschnitt landet immer vollständig in
 *    einem Batch (oder wird als Ganzes hart gesplittet, Punkt 2).
 * 2. **Hart splitten** (nur für einen einzelnen Abschnitt > `maxTokens`): an Absatzgrenzen
 *    (Leerzeilen), mit `overlapTokens` Überlappung zum jeweiligen Vorgänger-Teilstück. Der
 *    Overlap sitzt nur im an das Modell gesendeten `markdown`, nicht in `startLine`/`endLine` —
 *    die bleiben der kanonische, nicht überlappende Bereich (siehe "Verlustfreiheit" unten).
 *
 * Eine zusammenhängende Tabelle (Zeilen, die mit `|` beginnen) ist auf beiden Ebenen automatisch
 * geschützt: Bündeln zerteilt nie innerhalb eines Abschnitts, und der Absatz-Splitter behandelt
 * eine Tabelle immer als einen einzigen, unteilbaren Absatz (siehe `pdf-markdown.ts::emitTable` —
 * vor und nach jeder Tabelle steht garantiert eine Leerzeile, nie mittendrin). Sprengt eine
 * einzelne Tabelle dadurch `maxTokens`, bleibt sie trotzdem ganz — eine halbe Tabelle ist
 * wertlos, ein etwas teurerer Batch nur etwas teurer. Das ist die einzige Quelle für Batches
 * über `maxTokens`; die Kapitelgrenzen-Präferenz (Punkt 1) darf diese Garantie nicht brechen und
 * verzichtet deshalb auf den Kapitelschnitt, sobald er selbst überliefe.
 *
 * ## Verlustfreiheit
 *
 * `startLine`/`endLine` jedes Batches sind der *kanonische* Bereich (keine Überlappung). Über
 * alle Batches in Emissionsreihenfolge hinweg partitionieren diese Bereiche `[0, letzte Zeile]`
 * lückenlos und überlappungsfrei — jede Zeile des Eingabe-Markdown gehört zu genau einem Batch.
 * `chunkMarkdown` liefert nur `Batch[]` (der geforderte Vertrag); für den Overlap-Anteil (für
 * CLI/Reporting) gibt es zusätzlich `chunkMarkdownDetailed`.
 */

import type { PdfParseResult, PdfSection } from "./pdf-markdown.js";

export interface Batch {
  batchIndex: number; // 0-basiert
  markdown: string; // der Inhalt dieses Batches (inkl. Kontext-Header, inkl. Overlap bei Hard-Splits)
  tokens: number; // geschätzt (Zeichen/3.3), inkl. Header + Overlap
  pageRange: [number, number];
  sectionTitles: string[]; // Überschriften, die in diesem Batch beginnen (vollständige Liste)
  startLine: number; // kanonisch, keine Überlappung
  endLine: number; // kanonisch, keine Überlappung
}

export interface ChunkOptions {
  maxTokens?: number; // Default DEFAULT_MAX_TOKENS
  overlapTokens?: number; // Default 500, nur bei Hard-Splits
}

export interface ChunkResult {
  batches: Batch[];
  /**
   * Anteil der Gesamttoken (über alle Batches summiert), der aus Overlap-Duplikaten
   * stammt — 0, solange kein Abschnitt hart gesplittet wurde (bei allen fünf realen
   * Testdokumenten der Fall: je 1 Batch, kein Hard-Split, Overlap-Anteil 0).
   */
  overlapShare: number;
}

/**
 * Obergrenze je Batch — **100.000 Token, angehoben von 60.000 nach dem Stress-Sweep**.
 *
 * Der Sweep (Läufe `0d56b126` gebatcht / `76b83ebd` single-call, 2026-08-09) hat die Annahme
 * widerlegt, auf der die 60.000 beruhten: Ein einzelner Call über **423.000 Token** erreichte
 * dieselbe `treffer_quote` (100 %) und dieselbe Prio-Abdeckung wie neun Batches. Der aus MRCR
 * abgeleitete Einbruch jenseits 256k trat nicht ein — nicht abgeschwächt, sondern gar nicht.
 * Der einzige Unterschied lag bei 0,4 Punkten und damit tief unter der gemessenen
 * Rauschgrenze von 3,6 % (siehe `scripts/compare-runs.ts`).
 *
 * **Warum trotzdem nicht auf 250.000 oder ganz weg.** Der Stress-Korpus besteht zu ~98 % aus
 * bewusst *branchenfremdem* Füllmaterial; alle 71 Felder liegen in einem zusammenhängenden
 * 10k-Kern. Gemessen wurde damit "Nadel im Heuhaufen", nicht die Dichte einer echten
 * Ausschreibung mit verteilten technischen Daten und kollidierenden Werten aus mehreren
 * Losen. Der Befund trägt die Aussage "es bricht nicht an der Länge" — nicht die Aussage
 * "500 Seiten echte Ausschreibung sind unkritisch". Bis echte Dokumente vorliegen, bleibt der
 * Wert konservativ.
 *
 * Was das Batching unabhängig von der Qualität weiterhin trägt: die Kopffreiheit jenseits des
 * 1,05-M-Kontextfensters, und der Prüfpfad des Merge — nur er hinterlässt bei einer Korrektur
 * `superseded_value` und eine Begründung. Der Single-Call löst denselben Widerspruch
 * stillschweigend im Modell auf.
 */
export const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_OVERLAP_TOKENS = 500;
/** Gleiche Heuristik wie in cli.ts (`--markdown-only`): grobe Zeichen/Token-Schätzung. */
const CHARS_PER_TOKEN = 3.3;
/**
 * Reservierte Token-Marge während des Bündelns, damit der final tatsächlich gesendete Batch
 * (Header davor, bei Hard-Splits zusätzlich Overlap davor) `maxTokens` nicht durch das
 * nachträglich angehängte Beiwerk sprengt. Ein Kontext-Header ("<!-- Batch 3 von 9 · Seiten
 * 121–168 · Abschnitte: ..., … -->") bleibt auch mit fünf langen Abschnittstiteln deutlich
 * unter 150 Token; das Bündeln selbst rechnet außerdem in exakten Zeichenlängen statt in
 * pro-Abschnitt einzeln gerundeten Token-Schätzungen — sonst summiert sich Rundungsfehler über
 * hunderte Abschnitte zu einem Batch auf, der `maxTokens` überschreitet, ohne dass eine
 * unteilbare Tabelle daran schuld wäre (beobachtet im Stresstest: 60.468 statt ≤ 60.000 Token
 * bei einem 285k-Token-Korpus, 0 Tabellen beteiligt).
 */
const HEADER_TOKEN_RESERVE = 150;

/**
 * Ein Batch darf nur dann an der letzten `level: 1`-Grenze geschlossen werden (statt mitten in
 * einem Kapitel), wenn er bis dorthin bereits mindestens diesen Anteil von `maxTokens` gefüllt
 * ist. Ohne diese Schranke feuert die Präferenz bei jedem Dokument mit vielen kurzen
 * level:1-Abschnitten (z. B. der Stress-Korpus: 2023 Abschnitte, Median 238 Token, größter 1k)
 * praktisch bei jeder zweiten Grenze — beobachtet als abwechselnd volle/halbvolle Batches
 * (500k-Stufe: 13 statt der rechnerisch möglichen 9–10 Batches, u. a. 1,1k/59,2k/25,7k/59,8k/…).
 * Der Fehler betrifft nur diese Präferenz, nicht das Bündeln selbst: ohne level:1-Grenzen (die
 * fünf realen PDFs, Dok 1/2/3/5) bleibt das Verhalten unverändert.
 *
 * 70% ist ein Kompromiss aus zwei Seiten: zu niedrig (z. B. 30%) macht die Präferenz beliebig
 * ("jede Grenze passt"), zu hoch (z. B. 95%) verhindert sie fast immer, weil kaum eine
 * Kapitelgrenze zufällig exakt kurz vor dem Limit liegt — dann bündelt der Code de facto immer
 * mitten im Kapitel weiter, und Dok 4 (Teil A–G als echte Kapitel, wofür die Regel ursprünglich
 * gedacht ist) verlöre den Effekt wieder. Bei 70% verzichtet ein Batch im schlechtesten Fall auf
 * bis zu 30% Füllstand zugunsten der saubereren Grenze — das ist der Preis, den die Regel laut
 * Auftrag bewusst zahlen darf ("ein etwas teurerer Batch ist nur etwas teurer"), aber sie greift
 * nicht mehr bei jeder beliebigen Mini-Grenze.
 */
const CHAPTER_SPLIT_MIN_FILL_RATIO = 0.7;

/**
 * Batches, die nach dem Bündeln unter diesem Anteil von `maxTokens` liegen, werden mit einem
 * Nachbarn zusammengelegt (sofern das Budget es hergibt) — siehe `mergeSmallBatches`. Ein Batch
 * mit nur wenigen Prozent Füllstand kostet trotzdem einen vollen Extraktions-Call (~16,6k
 * Schema-Tokens allein fürs strukturierte Output-Schema) und bringt kaum zusätzliche Abdeckung.
 * 30% spiegelt exakt den Zielwert aus dem Auftrag ("keiner unter ~30% Füllgrad außer dem
 * letzten") — bewusst kein eigener, davon abweichender Wert, damit Zielvorgabe und
 * Implementierung nicht auseinanderlaufen.
 */
const MERGE_SMALL_BATCH_FILL_RATIO = 0.3;

function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/** `maxTokens` abzüglich Reserve für Header (und ggf. Overlap), nie kleiner als ein Viertel von `maxTokens`. */
function budgetTokens(maxTokens: number, extraReserve = 0): number {
  const reserve = Math.min(HEADER_TOKEN_RESERVE + extraReserve, Math.floor(maxTokens / 4));
  return Math.max(1, maxTokens - reserve);
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

export function chunkMarkdown(parsed: PdfParseResult, opts: ChunkOptions = {}): Batch[] {
  return chunkMarkdownDetailed(parsed, opts).batches;
}

export function chunkMarkdownDetailed(parsed: PdfParseResult, opts: ChunkOptions = {}): ChunkResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

  const lines = parsed.markdown.length === 0 ? [] : parsed.markdown.split("\n");
  if (lines.length === 0) {
    const batch = buildEmptyBatch(parsed);
    return { batches: [batch], overlapShare: 0 };
  }

  const units = buildUnits(lines, parsed.sections);
  const bundled: RawBatch[] = [];
  bundleUnits(units, lines, maxTokens, overlapTokens, bundled);
  const raw = mergeSmallBatches(bundled, lines, maxTokens);

  const overlapChars = raw.reduce((sum, rb) => sum + (rb.overlapText?.length ?? 0), 0);
  const batches = finalizeBatches(raw, parsed, lines);
  const totalChars = batches.reduce((sum, b) => sum + b.markdown.length, 0);
  const overlapShare = totalChars > 0 ? overlapChars / totalChars : 0;

  return { batches, overlapShare };
}

// ---------------------------------------------------------------------------
// Units — die Bündelungseinheit ist immer ein ganzer Abschnitt (oder, vor der ersten
// Überschrift bzw. bei Dokumenten ganz ohne Überschriften wie Dok 3, ein "Präambel"-Unit).
// ---------------------------------------------------------------------------

interface Unit {
  startLine: number;
  endLine: number;
  /** 0 = Präambel/kein Heading (kein Kapitelgrenzen-Kandidat). */
  level: number;
  heading?: string;
}

function buildUnits(lines: string[], sections: PdfSection[]): Unit[] {
  const totalLines = lines.length;

  if (sections.length === 0) {
    // Dok 3 (einseitige E-Mail): keine einzige Überschrift. Ein Unit über das ganze
    // Dokument — Bündeln greift nicht (nichts zu bündeln), Hard-Split nach Absätzen greift,
    // falls das Dokument trotzdem > maxTokens wäre (bei Dok 3 nicht der Fall).
    return [{ startLine: 0, endLine: totalLines - 1, level: 0 }];
  }

  const units: Unit[] = [];
  if (sections[0].startLine > 0) {
    units.push({ startLine: 0, endLine: sections[0].startLine - 1, level: 0 });
  }
  for (const s of sections) {
    units.push({ startLine: s.startLine, endLine: s.endLine, level: s.level, heading: s.heading });
  }
  return units;
}

function unitText(lines: string[], u: { startLine: number; endLine: number }): string {
  return lines.slice(u.startLine, u.endLine + 1).join("\n");
}

// ---------------------------------------------------------------------------
// Bündeln (greedy, Kapitelgrenzen-Präferenz)
// ---------------------------------------------------------------------------

interface RawBatch {
  startLine: number;
  endLine: number;
  /** Nur bei Hard-Splits gesetzt: Text aus dem Ende des Vorgänger-Teilstücks. */
  overlapText?: string;
}

/**
 * Exakte Zeichenlänge einer zusammenhängenden Folge von Units, so wie sie im finalen Batch
 * aussähe (`lines.slice(first.startLine, last.endLine + 1).join("\n")`), aber inkrementell in
 * O(1) pro Unit statt durch erneutes Slicen/Joinen: eine zusätzliche Unit hängt mit genau einem
 * Zeilenumbruch an die vorherige an (die Line-Ranges sind per Konstruktion lückenlos benachbart).
 */
function appendCharLen(currentChars: number, hasContent: boolean, newUnitChars: number): number {
  return hasContent ? currentChars + 1 + newUnitChars : newUnitChars;
}

function bundleUnits(
  units: Unit[],
  lines: string[],
  maxTokens: number,
  overlapTokens: number,
  out: RawBatch[],
): void {
  const budget = budgetTokens(maxTokens);
  const chapterSplitMinFillTokens = CHAPTER_SPLIT_MIN_FILL_RATIO * maxTokens;

  let current: Unit[] = [];
  let currentChars = 0;
  // Index in `current`, ab dem das *letzte* im Batch gesehene level:1-Kapitel beginnt.
  // -1 heißt: kein nutzbarer Schnittpunkt (0 wäre trivial — würde den ganzen Batch verwerfen).
  let lastChapterBoundary = -1;

  const flush = () => {
    if (current.length === 0) return;
    out.push({ startLine: current[0].startLine, endLine: current[current.length - 1].endLine });
    current = [];
    currentChars = 0;
    lastChapterBoundary = -1;
  };

  const findChapterBoundary = (arr: Unit[]): number => {
    let idx = -1;
    for (let i = 1; i < arr.length; i++) if (arr[i].level === 1) idx = i;
    return idx;
  };

  const charsOf = (arr: Unit[]): number => {
    if (arr.length === 0) return 0;
    return unitText(lines, { startLine: arr[0].startLine, endLine: arr[arr.length - 1].endLine }).length;
  };

  for (const unit of units) {
    const uChars = unitText(lines, unit).length;

    // Einzelner Abschnitt sprengt das Budget allein schon: kein Bündeln, direkt hart splitten.
    if (estimateTokensForChars(uChars) > budget) {
      flush();
      hardSplitUnit(unit, lines, maxTokens, overlapTokens, out);
      continue;
    }

    const candidateChars = appendCharLen(currentChars, current.length > 0, uChars);
    if (current.length > 0 && estimateTokensForChars(candidateChars) > budget) {
      let didChapterSplit = false;

      if (lastChapterBoundary > 0) {
        const front = current.slice(0, lastChapterBoundary);
        const frontChars = charsOf(front);
        // Nur an der Kapitelgrenze schneiden, wenn der Batch bis dorthin bereits gut gefüllt
        // ist (siehe CHAPTER_SPLIT_MIN_FILL_RATIO oben). Sonst kommt bei vielen kleinen
        // level:1-Abschnitten (z. B. der Stress-Korpus: 2023 Abschnitte, Median 238 Token) die
        // "Grenze" ständig, lange bevor der Batch nennenswert voll ist — und Bündeln würde
        // regelmäßig bei 30–50% Füllstand abbrechen statt das Budget auszunutzen.
        if (estimateTokensForChars(frontChars) >= chapterSplitMinFillTokens) {
          const deferred = current.slice(lastChapterBoundary);
          const deferredChars = charsOf(deferred);
          const deferredCandidateChars = appendCharLen(deferredChars, true, uChars);
          // Zusätzlich: nur schneiden, wenn das Ergebnis selbst innerhalb des Budgets bleibt —
          // sonst würde die "bevorzugt an hohen Ebenen schneiden"-Regel die härtere Garantie
          // "kein Batch über maxTokens außer wegen einer Tabelle" verletzen.
          if (estimateTokensForChars(deferredCandidateChars) <= budget) {
            current = front;
            out.push({ startLine: current[0].startLine, endLine: current[current.length - 1].endLine });
            current = deferred;
            currentChars = deferredChars;
            lastChapterBoundary = findChapterBoundary(current);
            didChapterSplit = true;
          }
        }
      }

      if (!didChapterSplit) {
        flush();
      }
    }

    currentChars = appendCharLen(currentChars, current.length > 0, uChars);
    current.push(unit);
    if (unit.level === 1) {
      const idx = current.length - 1;
      if (idx > 0) lastChapterBoundary = idx;
    }
  }

  flush();
}

function estimateTokensForChars(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * Nachlauf zum Bündeln: legt Batches unter `MERGE_SMALL_BATCH_FILL_RATIO * maxTokens` mit einem
 * Nachbarn zusammen, sofern das kombinierte Ergebnis innerhalb des Budgets bleibt. Arbeitet rein
 * auf den kanonischen `startLine`/`endLine`-Bereichen — die sind laut Konstruktion immer lückenlos
 * benachbart (egal ob ein Batch aus dem Bündeln oder aus einem Hard-Split stammt), ein "Merge"
 * ist deshalb nichts weiter als das Erweitern eines Bereichs auf den des Nachbarn.
 *
 * Bei einem Merge wird der Overlap-Text des verschluckten Nachbarn verworfen (nicht der des
 * überlebenden Batches): der Nachbar existiert als eigener Batch nicht mehr, sein Inhalt steht
 * jetzt wortwörtlich und lückenlos im selben Batch — die Duplizierung, die der Overlap absichern
 * sollte, ist damit gegenstandslos.
 *
 * Ein einziger Links-nach-rechts-Durchlauf genügt für beide Richtungen: verschmolzen wird immer
 * der bereits akkumulierte `prev` mit dem nächsten `b`, sobald *einer* von beiden zu klein ist
 * und das Ergebnis ins Budget passt — das deckt sowohl "kleiner Batch nimmt seinen Nachfolger
 * auf" als auch "kleiner Nachfolger wird von einem vollen Vorgänger aufgenommen" ab, inklusive
 * des Sonderfalls "der letzte Batch ist klein" (dann ist `b` beim letzten Schritt der kleine
 * Teil). Bleibt ein Batch trotzdem klein, weil kein Nachbar mehr Platz hat, ist das beim letzten
 * Batch laut Auftrag ausdrücklich zulässig ("keiner unter ~30% Füllgrad außer dem letzten").
 */
function mergeSmallBatches(raw: RawBatch[], lines: string[], maxTokens: number): RawBatch[] {
  if (raw.length <= 1) return raw;

  const budget = budgetTokens(maxTokens);
  const minFillTokens = MERGE_SMALL_BATCH_FILL_RATIO * maxTokens;
  const tokensOf = (b: RawBatch): number => estimateTokens(unitText(lines, b));

  const merged: RawBatch[] = [];
  for (const b of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (tokensOf(prev) < minFillTokens || tokensOf(b) < minFillTokens)) {
      const combined = { startLine: prev.startLine, endLine: b.endLine };
      if (estimateTokens(unitText(lines, combined)) <= budget) {
        merged[merged.length - 1] = { ...prev, endLine: b.endLine };
        continue;
      }
    }
    merged.push(b);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Hard-Split eines einzelnen übergroßen Abschnitts — an Absatzgrenzen (Leerzeilen),
// mit Overlap zwischen den Teilstücken.
// ---------------------------------------------------------------------------

interface Paragraph {
  startLine: number;
  endLine: number;
}

/**
 * Zerlegt [start, end] in zusammenhängende Absätze. Ein Absatz = ein Lauf nicht-leerer
 * Zeilen plus der darauffolgende Leerzeilen-Lauf (falls vorhanden) — so bleibt die Zerlegung
 * lückenlos (jede Zeile gehört zu genau einem Absatz), ohne dass Leerzeilen selbst als
 * eigene Einheit auftauchen. Eine Tabelle (siehe pdf-markdown.ts::emitTable) hat nie eine
 * Leerzeile in ihrem Inneren und bildet dadurch immer genau einen eigenen Absatz — sie kann
 * mit dieser Zerlegung nie mittendurch geschnitten werden.
 */
function splitIntoParagraphs(lines: string[], start: number, end: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let paraStart = start;
  let i = start;
  while (i <= end) {
    if (lines[i].trim() === "") {
      let j = i;
      while (j <= end && lines[j].trim() === "") j++;
      if (j - 1 >= paraStart) {
        paragraphs.push({ startLine: paraStart, endLine: j - 1 });
      }
      paraStart = j;
      i = j;
    } else {
      i++;
    }
  }
  if (paraStart <= end) {
    paragraphs.push({ startLine: paraStart, endLine: end });
  }
  return paragraphs;
}

function isTableParagraph(lines: string[], p: Paragraph): boolean {
  for (let i = p.startLine; i <= p.endLine; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    return trimmed.startsWith("|");
  }
  return false;
}

function takeOverlapTail(lines: string[], range: Paragraph, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const targetChars = overlapTokens * CHARS_PER_TOKEN;
  let charCount = 0;
  let tailStart = range.endLine;
  for (let i = range.endLine; i >= range.startLine; i--) {
    charCount += lines[i].length + 1; // +1 für den Zeilenumbruch
    tailStart = i;
    if (charCount >= targetChars) break;
  }
  return lines.slice(tailStart, range.endLine + 1).join("\n");
}

function hardSplitUnit(
  unit: Unit,
  lines: string[],
  maxTokens: number,
  overlapTokens: number,
  out: RawBatch[],
): void {
  // Jedes Teilstück außer dem ersten bekommt zusätzlich bis zu `overlapTokens` vorangestellt —
  // das Budget für die reine Absatz-Bündelung muss dafür also zusätzlich zum Header Platz lassen.
  const budget = budgetTokens(maxTokens, overlapTokens);

  const paragraphs = splitIntoParagraphs(lines, unit.startLine, unit.endLine);
  const subChunks: Paragraph[] = [];

  let current: Paragraph[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    subChunks.push({ startLine: current[0].startLine, endLine: current[current.length - 1].endLine });
    current = [];
    currentChars = 0;
  };

  for (const p of paragraphs) {
    const pChars = unitText(lines, p).length;

    if (estimateTokensForChars(pChars) > budget) {
      // Unteilbarer Absatz (typisch: eine einzelne große Tabelle) sprengt das Budget allein.
      // Bewusst nicht weiter zerlegt (Regel: Tabellen nie zerschneiden) — bleibt als eigener,
      // etwas teurerer Batch stehen.
      flush();
      subChunks.push({ startLine: p.startLine, endLine: p.endLine });
      const kind = isTableParagraph(lines, p) ? "Tabelle" : "Absatz";
      console.warn(
        `[chunk] ${kind} in Zeile ${p.startLine}-${p.endLine} (~${estimateTokensForChars(pChars)} Token) ` +
          `überschreitet maxTokens (${maxTokens}) und wird nicht zerschnitten.`,
      );
      continue;
    }

    const candidateChars = appendCharLen(currentChars, current.length > 0, pChars);
    if (current.length > 0 && estimateTokensForChars(candidateChars) > budget) {
      flush();
      current.push(p);
      currentChars = pChars;
    } else {
      current.push(p);
      currentChars = candidateChars;
    }
  }
  flush();

  for (let i = 0; i < subChunks.length; i++) {
    const sc = subChunks[i];
    const overlapText = i > 0 ? takeOverlapTail(lines, subChunks[i - 1], overlapTokens) : undefined;
    out.push({ startLine: sc.startLine, endLine: sc.endLine, overlapText });
  }
}

// ---------------------------------------------------------------------------
// Finalisierung — Header, Seitenbereich, Abschnittstitel, Tokenzahl.
// ---------------------------------------------------------------------------

function finalizeBatches(raw: RawBatch[], parsed: PdfParseResult, lines: string[]): Batch[] {
  const total = raw.length;
  return raw.map((rb, idx) => {
    const canonicalText = unitText(lines, rb);
    const sectionTitles = parsed.sections
      .filter((s) => s.startLine >= rb.startLine && s.startLine <= rb.endLine)
      .map((s) => s.heading);
    const pageRange = computePageRange(parsed.pageLineOffsets, parsed.pages, rb.startLine, rb.endLine);
    const header = buildHeader(idx, total, pageRange, sectionTitles);

    const parts = [header];
    if (rb.overlapText) parts.push(rb.overlapText);
    parts.push(canonicalText);
    const markdown = parts.join("\n\n");

    return {
      batchIndex: idx,
      markdown,
      tokens: estimateTokens(markdown),
      pageRange,
      sectionTitles,
      startLine: rb.startLine,
      endLine: rb.endLine,
    };
  });
}

function buildHeader(idx: number, total: number, pageRange: [number, number], sectionTitles: string[]): string {
  const pages = pageRange[0] === pageRange[1] ? `Seite ${pageRange[0]}` : `Seiten ${pageRange[0]}–${pageRange[1]}`;
  const maxTitlesInHeader = 5;
  let titlesText: string;
  if (sectionTitles.length === 0) {
    titlesText = "(keine neuen Überschriften)";
  } else if (sectionTitles.length <= maxTitlesInHeader) {
    titlesText = sectionTitles.join(", ");
  } else {
    titlesText = `${sectionTitles.slice(0, maxTitlesInHeader).join(", ")}, …`;
  }
  return `<!-- Batch ${idx + 1} von ${total} · ${pages} · Abschnitte: ${titlesText} -->`;
}

function computePageRange(
  pageLineOffsets: number[],
  pages: number,
  startLine: number,
  endLine: number,
): [number, number] {
  if (pageLineOffsets.length === 0) return [1, Math.max(pages, 1)];
  return [pageForLine(pageLineOffsets, startLine), pageForLine(pageLineOffsets, endLine)];
}

/** Größte Seite p (1-basiert) mit `pageLineOffsets[p-1] <= line` (Binärsuche, offsets sind monoton). */
function pageForLine(pageLineOffsets: number[], line: number): number {
  let lo = 0;
  let hi = pageLineOffsets.length - 1;
  let ans = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageLineOffsets[mid] <= line) {
      ans = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function buildEmptyBatch(parsed: PdfParseResult): Batch {
  const pageRange: [number, number] = [1, Math.max(parsed.pages, 1)];
  const header = buildHeader(0, 1, pageRange, []);
  return {
    batchIndex: 0,
    markdown: header,
    tokens: estimateTokens(header),
    pageRange,
    sectionTitles: [],
    startLine: 0,
    endLine: 0,
  };
}
