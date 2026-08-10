/**
 * PDF → Markdown, Stufe 1 der Extraktionspipeline. Rein deterministisch (kein LLM-Call).
 *
 * ## Warum der JSON-Export von Docling, nicht der direkte Markdown-Export
 *
 * `docling convert --to md` liefert Markdown ohne Seitenzahlen. Wir brauchen aber pro
 * Abschnitt und pro Tabellenzelle eine Seitenzahl, weil jedes später extrahierte Feld einen
 * Beleg (`page`) mitführt. Der JSON-Export (`--to json`, ein `DoclingDocument`) trägt diese
 * Information: jedes Element hat `prov: [{ page_no, bbox, charspan }]`. Der Dokumentbaum
 * selbst ist eine flache Sammlung (`texts[]`, `tables[]`, `groups[]`, …), verknüpft über
 * `body.children` als JSON-Pointer-Refs (`{"$ref": "#/texts/12"}`) in Lesereihenfolge. Wir
 * laufen diesen Baum selbst ab und bauen daraus Markdown + Seiten-Offsets — das ist genau der
 * "tragfähige Weg", den die Aufgabenstellung nahelegt, und in der Praxis (Eval-Data/1..5)
 * unkompliziert: Docling 2.118.1 liefert saubere `section_header`/`table`-Items mit
 * Provenienz für alle Testdokumente.
 *
 * Geprüfte Docling-Version: 2.118.1 / docling-core 2.91.0. Falls ein Docling-Update das
 * JSON-Schema bricht (Feldnamen, `$ref`-Format), schlägt `pdfToMarkdown` mit einer Exception
 * fehl statt still falsches Markdown zu produzieren — bewusst, damit ein Schema-Drift auffällt.
 *
 * ## Warum Docling-Levels nicht direkt übernommen werden
 *
 * Docling klassifiziert alle Section-Header in den Testdokumenten strukturell flach als
 * `level: 1` (Layout-Modell erkennt keine visuelle Font-Hierarchie zwischen "Teil A" und
 * "A.1"). Für Dok 4 (Ausschreibung Teil A–G) ist die Ebene aber Teil der Abnahme. Wir leiten
 * die Ebene daher aus der üblichen Gliederungsnotation ab ("Teil A" → 1, "A.1" → 2,
 * "F.3.1" → 3, …) und fallen für unnummerierte Überschriften auf "eine Ebene unter der
 * letzten erkannten Gliederungsebene" zurück. Eine generische, aber unvermeidlich heuristische
 * Lösung ohne visuelles Font-Signal von Docling.
 *
 * ## hasTextLayer unabhängig von Docling
 *
 * Docling führt beim Standard-Convert standardmäßig OCR auf Bitmap-Content aus (`--ocr`
 * default: an). Würden wir Dockling's eigenen Text-Output zur Scan-Erkennung heranziehen,
 * wäre das zirkulär: OCR-generierter Text auf einer Scan-Seite sähe wie ein Text-Layer aus.
 * Die hasTextLayer-Heuristik nutzt daher bewusst eine von Docling unabhängige Quelle: den
 * nativen PDF-Text-Layer (kein OCR) für die Zeichenausbeute pro Seite, die Bildoperatoren
 * für "nahezu seitenfüllendes Bild" und die Seitengeometrie aus dem PDF selbst. Alle drei
 * liefert `src/pdf-native.ts` (pdfjs).
 *
 * Die Seitengröße kam bis zum 2026-08-09 aus Dockling's JSON (`pages[n].size`). Das war
 * korrekt, band die Klassifikation aber an einen Schritt, der erst *danach* laufen soll:
 * Welche Seiten OCR brauchen, muss feststehen, bevor irgendetwas gelesen wird. Der native
 * Layer liefert dieselbe Geometrie ohne diese Abhängigkeit.
 *
 * Bis zum 2026-08-10 stammten diese vier Größen aus vier poppler-Aufrufen (`pdfinfo`,
 * zweimal `pdftotext`, `pdfimages`). Sie kommen jetzt aus `pdfjs-dist`, in-process und mit
 * **einer** Lesung — damit das Parsing außer Docling kein externes Binary mehr braucht und
 * die Pipeline unter Windows installierbar ist (poppler hat dort keinen Paketmanager-Weg).
 * Begründung und Messwerte stehen in `src/pdf-native.ts`.
 *
 * ## Seiten ohne Text-Layer: seitenweise ersetzt
 *
 * Die Klassifikation arbeitete schon immer je Seite, das Ergebnis wurde nur zu einem
 * Dokument-Boolean verdichtet und verworfen. Jetzt bleibt die Seitenliste erhalten: Docling
 * läuft weiterhin über das **ganze** PDF (lokal, kostenlos), und nur die Zeilen der
 * Scan-Seiten werden durch die OCR-Ausgabe ersetzt (`replacePageLines`).
 *
 * Das ist bewusst kein Alles-oder-nichts. Ein nativer Text-Layer ist jeder OCR-Ausgabe
 * überlegen; zwölf gescannte Anhangseiten in einer 210-Seiten-Ausschreibung dürfen die
 * übrigen 198 nicht verschlechtern.
 *
 * **Ersetzt wird an Ort und Stelle, nicht nach Seiten gruppiert.** Doclings `body.children`
 * ist Lesereihenfolge, nicht garantiert Seitenreihenfolge — ein Umbau auf "Seitenblöcke
 * sammeln und neu zusammensetzen" könnte die Textreihenfolge verändern. Die Zeilenliste
 * bleibt deshalb flach, und der OCR-Block tritt genau dort ein, wo die erste Zeile der
 * betroffenen Seite stand.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OCR_PRICE_PER_PAGE, ocrPages } from "./ocr-mistral.js";
import {
  getPerPageCharCounts,
  getPerPageImageCoverage,
  getRawText,
  pdfInfo,
  type PdfInfo,
} from "./pdf-native.js";

const execFileAsync = promisify(execFile);

// src/pdf-markdown.ts -> Projekt-Root ist ein Verzeichnis höher.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "docling");
const DEFAULT_DOCLING_VENV_BIN = path.join(PROJECT_ROOT, ".venv", "bin", "docling");

/**
 * Geht in den Cache-Key ein. **Bei jeder Änderung an der Markdown-Erzeugung
 * hochzählen** (buildMarkdown, emitText, emitTable, classifyHeadingLevel,
 * Scan-Erkennung), sonst liefert der Cache still das Ergebnis der alten
 * Code-Version zurück und alle nachgelagerten Prüfungen laufen auf Altdaten.
 *
 * Der PDF-Inhalt allein reicht als Schlüssel nicht: das gecachte Artefakt ist
 * unser abgeleitetes Markdown, nicht die Docling-Rohausgabe.
 *
 * v6: Der native Text-Layer kommt aus pdfjs statt aus poppler `pdftotext`. Die
 *     Klassifikation ist dieselbe (auf allen vier Testdokumenten Seite für Seite
 *     identisch), aber die **Rohtextquelle** für `findLostTokens` ist eine andere:
 *     pdfjs hält `g/Nm3` zusammen, wo poppler `g/Nm` + `3` trennt. Damit ändert
 *     sich der Ergänzungsblock im Markdown — und der geht in jeden Batch ein.
 *     Ohne Bump lieferte der Cache still die Lesung der Vorversion.
 * v5: Seiten ohne Text-Layer werden durch OCR ersetzt (Mistral); Abschnitte
 *     entstehen nach dem Zusammenbau aus dem Markdown statt beim Schreiben.
 * v4: Abgleich gegen den nativen Text-Layer; verlorene Tabellenzellen-Tokens
 *     werden als Ergänzungsblock gerettet (lostTokens).
 * v3: Tabellen-Fußnoten (Docling hängt sie als Kinder an das Tabellen-Item)
 *     werden nicht mehr verworfen.
 * v2: `page_footer` wird dedupliziert an den Dokumentanfang gezogen statt 26×
 *     zwischen die Absätze gestreut; `footnote` bleibt inline erhalten.
 */
const PARSER_VERSION = 6;

/** Seite gilt als Scan, wenn ihre Zeichenausbeute darunter liegt (und ein seitenfüllendes Bild vorliegt). */
const SCAN_PAGE_CHAR_THRESHOLD = 30;
/** Ab welchem Flächenanteil ein Bild als "seitenfüllend" gilt. */
const SCAN_PAGE_IMAGE_COVERAGE_THRESHOLD = 0.85;
/**
 * Dokumentweit: mehr als dieser Anteil Scan-Seiten → `hasTextLayer: false`.
 *
 * Steuert seit dem OCR-Umbau **nur noch die Meldung**, nicht mehr die Verarbeitung. Ob eine
 * Seite per OCR gelesen wird, entscheidet allein ihre eigene Klassifikation — sonst bliebe
 * der häufigste reale Fall unbehandelt: die digital erzeugte Ausschreibung mit ein paar
 * eingescannten Anhangseiten, die weit unter jeder Dokumentschwelle liegt und trotzdem
 * genau die Seiten betrifft, auf denen die technischen Daten stehen.
 */
const SCAN_DOCUMENT_RATIO_THRESHOLD = 0.2;

/** Unterhalb dieser OCR-Zuversicht wird die Seite gemeldet (nicht verworfen). */
const OCR_CONFIDENCE_WARN_THRESHOLD = 0.9;

export interface PdfSection {
  heading: string;
  /** Gliederungsebene, 1..6 (siehe Modul-Kommentar: aus der Nummerierung abgeleitet, nicht Dockling's Roh-Level). */
  level: number;
  /** Zeilenindex (0-basiert) der Überschriftenzeile selbst im `markdown`-String. */
  startLine: number;
  /** Zeilenindex (0-basiert) der letzten Zeile, die noch zu diesem Abschnitt gehört (vor der nächsten Überschrift). */
  endLine: number;
  /** Seite, auf der der Abschnitt beginnt (1-basiert). */
  page: number;
}

export interface PdfParseResult {
  /** Überschriften als `#`, Tabellen als Markdown-Tabellen. */
  markdown: string;
  /** Flache Liste in Dokumentreihenfolge. */
  sections: PdfSection[];
  pages: number;
  /**
   * false → überwiegend Scan. **Rein informativ.** Die Verzweigung hängt seit dem
   * OCR-Umbau nicht mehr an diesem Boolean, sondern an `scanPages` — eine einzelne
   * gescannte Anhangseite wird behandelt, auch wenn das Dokument insgesamt als
   * textbasiert gilt.
   */
  hasTextLayer: boolean;
  /** Seiten (1-basiert) ohne nativen Text-Layer — erkannt, unabhängig davon, wer sie gelesen hat. */
  scanPages: number[];
  /**
   * Seiten, die **tatsächlich per OCR** gelesen wurden. Leer, wenn kein Schlüssel vorlag
   * oder der Aufruf scheiterte — dann stammen die Scan-Seiten aus Doclings eigenem OCR.
   *
   * Getrennt von `scanPages`, weil der Unterschied über die Gültigkeit des Cache-Eintrags
   * entscheidet: Ein Ergebnis aus einem Lauf ohne Schlüssel ist ein **Notbehelf**, kein
   * fertiges Resultat. Ohne diese Unterscheidung liefert der Cache später stillschweigend
   * die schwächere Lesung, auch wenn inzwischen ein Schlüssel gesetzt ist — und ein
   * Eval-Lauf misst dann etwas anderes, als er behauptet.
   */
  ocrPages: number[];
  /**
   * Zuversicht des OCR je gelesener Seite (0..1), leer ohne OCR-Lauf.
   *
   * Das ist der **Ersatz für eine Absicherung, die auf Scan-Seiten nicht existiert**: Auf
   * einer Textseite lässt sich das Ergebnis gegen den nativen Text-Layer prüfen, also gegen eine
   * zweite, unabhängige Lesung desselben PDFs (`lostTokens`). Auf einer Scan-Seite gibt es
   * die nicht — der Text existiert nur, weil das OCR ihn erzeugt hat.
   *
   * Daraus folgt ein Fehlermodus, den die Grader **nicht** sehen können: Liest das OCR
   * "56OO mm" statt "5600 mm", ist der Wert falsch und der Beleg trotzdem korrekt, denn
   * das Zitat steht wörtlich im gelesenen Text. `beleg_im_dokument` misst dann gegen
   * denselben Fehler. Bewusst ohne Schwellwert-Automatik: die Zahl wird protokolliert,
   * damit sie messbar ist, statt still zu wachsen.
   */
  ocrConfidence: { page: number; confidence: number }[];
  /**
   * `pageLineOffsets[i]` = Zeilenindex (0-basiert), an dem Seite `i + 1` im `markdown`-String
   * beginnt (erste Zeile mit Inhalt von dieser Seite). Länge === `pages`. Seiten ohne eigenen
   * Inhalt (z. B. eine leere Seite) übernehmen den Offset der letzten Seite mit Inhalt, damit
   * das Array monoton steigend bleibt und sich per Binärsuche nach Zeilenindex → Seite auflösen lässt.
   */
  pageLineOffsets: number[];
  /**
   * Tokens, die im nativen PDF-Text-Layer stehen, aber im Docling-Markdown
   * fehlten (typisch: letztes Wort vor dem Umbruch in mehrzeiligen
   * Tabellenzellen). Die betroffenen Rohzeilen wurden dem Markdown als
   * Ergänzungsblock angehängt — dieses Feld dient der Diagnose, damit die
   * Verlustrate messbar bleibt statt still zu wachsen.
   */
  lostTokens: string[];
  parseMs: number;
}

export interface PdfToMarkdownOptions {
  /** Default: `.cache/docling` im Projekt-Root, bzw. `DOCLING_CACHE_DIR`. */
  cacheDir?: string;
  /** Default: `.venv/bin/docling` im Projekt-Root, bzw. `DOCLING_BIN`, bzw. `docling` im PATH. */
  doclingBin?: string;
}

export async function pdfToMarkdown(pdfPath: string, opts: PdfToMarkdownOptions = {}): Promise<PdfParseResult> {
  const start = performance.now();
  const absPdfPath = path.resolve(pdfPath);
  const pdfBuffer = await readFile(absPdfPath);
  // PARSER_VERSION geht in den Schlüssel ein: gecacht wird unser abgeleitetes
  // Markdown, nicht die Docling-Rohausgabe. Ohne die Version liefert ein alter
  // Cache-Eintrag nach einer Codeänderung still das Ergebnis der Vorversion.
  // Das OCR-Modell geht mit in den Schlüssel: bei einem Scan-Dokument ist es
  // mitbestimmend für den Inhalt. Für reine Textdokumente ist es wirkungslos und
  // invalidiert den Eintrag bei einem Modellwechsel unnötig — ein Docling-Lauf ist der
  // günstigere Preis als ein Cache, der still die Lesung eines anderen Modells liefert.
  const contentHash = createHash("sha256")
    .update(pdfBuffer)
    .update(`|parser-v${PARSER_VERSION}`)
    .update(`|ocr-${process.env.SZKS_OCR_MODEL || "mistral-ocr-4-0"}`)
    .digest("hex");

  const cacheDir = path.resolve(opts.cacheDir ?? process.env.DOCLING_CACHE_DIR ?? DEFAULT_CACHE_DIR);
  const cachePath = path.join(cacheDir, `${contentHash}.json`);

  const cached = await readCache(cachePath);
  if (cached && !istNotbehelf(cached)) {
    return { ...cached, parseMs: performance.now() - start };
  }
  // Ein verworfener Notbehelf wird bewusst nicht gemeldet: Was den Nutzer angeht, ist die
  // Folge — dass jetzt OCR läuft und was es kostet —, und die steht ohnehin gleich darunter.

  // Zuerst klassifizieren, dann lesen: welche Seiten OCR brauchen, muss feststehen, bevor
  // irgendetwas Geld kostet. Rein aus dem PDF selbst (pdfjs), kein Netz, kein Docling.
  const info = await pdfInfo(absPdfPath);
  const { scanPages, hasTextLayer } = await classifyPages(absPdfPath, info);

  const doclingBin = resolveDoclingBin(opts.doclingBin);
  const doc = await runDocling(doclingBin, absPdfPath);
  const pages = info.pages > 0 ? info.pages : countPages(doc);
  const built = buildMarkdown(doc, pages);

  // Seiten ohne Text-Layer durch die OCR-Lesung ersetzen. Docling hat sie zwar auch
  // gelesen (es macht selbst OCR), aber mit erkennbar schwächerer Tabellenerkennung —
  // und die Belege dieses Projekts sind überwiegend Tabellenzeilen.
  let lines = built.lines;
  let linePages = built.linePages;
  let ocrConfidence: { page: number; confidence: number }[] = [];
  let ocrPages: number[] = [];

  if (scanPages.length > 0) {
    const ocr = await readScanPages(absPdfPath, pdfBuffer, scanPages, pages);
    if (ocr) {
      ({ lines, linePages } = replacePageLines(lines, linePages, ocr.blocks));
      ocrConfidence = ocr.confidences;
      ocrPages = [...ocr.blocks.keys()].sort((a, b) => a - b);
    }
  }

  const assembled = assemble(lines, linePages, pages);

  // Abgleich gegen den nativen Text-Layer: fängt Docling-Verluste in mehrzeiligen
  // Tabellenzellen ab (siehe findLostTokens). Scan-Seiten sind davon ausgenommen — sie
  // haben per Definition keinen Text-Layer, gegen den sich prüfen ließe. Ein Rest an
  // Zeichen unterhalb der Erkennungsschwelle (Stempel, Seitenzahl) würde sonst als
  // "verloren" gemeldet, obwohl er nur nicht aus derselben Quelle stammt.
  let markdown = assembled.markdown;
  const rawText = withoutPages(await getRawText(absPdfPath), scanPages);
  const { tokens: lostTokens, lines: lostLines } = rawText
    ? findLostTokens(markdown, rawText)
    : { tokens: [], lines: [] };

  if (lostLines.length > 0) {
    console.warn(
      `[pdf-markdown] ${path.basename(absPdfPath)}: ${lostTokens.length} Token aus dem Text-Layer fehlten ` +
        `(${lostTokens.slice(0, 5).join(", ")}${lostTokens.length > 5 ? ", …" : ""}) — als Ergänzungsblock angehängt.`,
    );
    markdown +=
      "\n\n<!-- Ergänzung: Textstellen aus demselben Dokument, die die Tabellenerkennung " +
      "unvollständig übernommen hat. Kein Nachtrag und keine Korrektur — derselbe Stand, " +
      "nur vollständiger. -->\n" +
      lostLines.map((l) => l.replace(/\s{2,}/g, "  ")).join("\n") +
      "\n";
  }

  const result: PdfParseResult = {
    markdown,
    sections: assembled.sections,
    pages,
    hasTextLayer,
    scanPages,
    ocrPages,
    ocrConfidence,
    pageLineOffsets: assembled.pageLineOffsets,
    lostTokens,
    parseMs: performance.now() - start,
  };

  // Eine niedrige Zuversicht ist kein Fehler, sondern ein Hinweis, wo ein Mensch
  // nachsehen sollte — die Seite ist der einzige Ort, an dem sich das noch prüfen lässt.
  // Auf diesen Seiten stammt der Beleg aus derselben Lesung wie der Wert — ein Lesefehler
  // fällt dort nicht auf (siehe `ocrConfidence`). Deshalb gemeldet, aber nicht verworfen.
  const unsicher = ocrConfidence.filter((c) => c.confidence < OCR_CONFIDENCE_WARN_THRESHOLD);
  if (unsicher.length > 0) {
    console.warn(
      `[pdf-markdown] ${path.basename(absPdfPath)}: geringe OCR-Zuversicht auf ` +
        `${unsicher.map((c) => `S.${c.page} (${(c.confidence * 100).toFixed(0)} %)`).join(", ")} — dort nachsehen.`,
    );
  }

  await writeCache(cachePath, result);
  return result;
}

/**
 * OCR für die Seiten ohne Text-Layer. Gibt `null` zurück, wenn kein Schlüssel gesetzt ist
 * oder der Aufruf scheitert — dann bleibt Doclings eigene Lesung stehen.
 *
 * **Warum ein Fehlschlag den Lauf nicht abbricht:** Docling hat die Seite bereits gelesen,
 * das Ergebnis ist also nicht leer, nur schwächer. Ein harter Abbruch würde ein
 * verwertbares Teilergebnis gegen gar keines eintauschen. Die Warnung benennt den
 * Unterschied, damit er nicht still bleibt.
 */
async function readScanPages(
  absPdfPath: string,
  pdfBuffer: Buffer,
  scanPages: number[],
  pages: number,
): Promise<{ blocks: Map<number, string[]>; confidences: { page: number; confidence: number }[] } | null> {
  const name = path.basename(absPdfPath);

  if (!process.env.MISTRAL_API_KEY) {
    console.warn(
      `[pdf-markdown] ${name}: ${scanPages.length}/${pages} Seiten ohne Text-Layer (${formatPageList(scanPages)}), ` +
        `MISTRAL_API_KEY fehlt — gelesen hat Docling.`,
    );
    return null;
  }

  try {
    const ocr = await ocrPages(pdfBuffer, scanPages);
    console.warn(
      `[pdf-markdown] ${name}: ${scanPages.length} Seite(n) per OCR gelesen (${formatPageList(scanPages)}), ` +
        `~$${(ocr.pagesProcessed * OCR_PRICE_PER_PAGE).toFixed(3)}.`,
    );
    // Weicht die abgerechnete Seitenzahl von der angeforderten ab, filtert der
    // pages-Parameter nur die Ausgabe und nicht die Abrechnung — dann wäre ein Teil-PDF
    // nötig. Das soll auffallen, nicht in der Rechnung untergehen.
    if (ocr.pagesProcessed > scanPages.length) {
      console.warn(
        `[pdf-markdown] ${name}: ${ocr.pagesProcessed} Seiten abgerechnet statt ${scanPages.length} — ` +
          `Kosten skalieren mit dem ganzen Dokument.`,
      );
    }
    return ocr;
  } catch (err) {
    console.warn(`[pdf-markdown] ${name}: OCR fehlgeschlagen (${(err as Error).message}) — gelesen hat Docling.`);
    return null;
  }
}

/** "3, 7-9, 14" — kompakt, weil die Liste bei einem Scan-Dokument sonst die Zeile sprengt. */
function formatPageList(pages: number[]): string {
  const teile: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    teile.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return `S. ${teile.join(", ")}`;
}

/**
 * Ist der Cache-Eintrag ein **Notbehelf** — Scan-Seiten, die ungelesen blieben, obwohl
 * inzwischen ein Schlüssel vorliegt?
 *
 * ## Warum das nötig ist
 *
 * Am 2026-08-09 lief ein vollständiger Eval-Lauf über den OCR-Datensatz — mit gesetztem
 * `MISTRAL_API_KEY`, und **trotzdem gegen Doclings Lesung**. Die Dokumente lagen aus
 * früheren Läufen ohne Schlüssel im Cache, der Schlüssel geht aber nicht in den Cache-Key
 * ein (er darf es auch nicht: ein Schlüsselwechsel ändert das Ergebnis nicht). Der Lauf
 * meldete Erfolg und maß etwas anderes, als er behauptete — echte LLM-Kosten für eine
 * Aussage über den falschen Parser.
 *
 * Die Richtung ist bewusst **einseitig**: Ein Eintrag, der mit OCR entstand, bleibt auch
 * ohne Schlüssel gültig. Ihn zu verwerfen hieße, ein besseres Ergebnis gegen ein
 * schlechteres zu tauschen — und dafür auch noch neu zu parsen.
 */
export function istNotbehelf(c: Pick<PdfParseResult, "scanPages" | "ocrPages">): boolean {
  const ungelesen = (c.scanPages?.length ?? 0) - (c.ocrPages?.length ?? 0);
  return ungelesen > 0 && Boolean(process.env.MISTRAL_API_KEY);
}

function resolveDoclingBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.DOCLING_BIN) return process.env.DOCLING_BIN;
  if (existsSync(DEFAULT_DOCLING_VENV_BIN)) return DEFAULT_DOCLING_VENV_BIN;
  return "docling";
}

// ---------------------------------------------------------------------------
// Docling CLI
// ---------------------------------------------------------------------------

async function runDocling(doclingBin: string, absPdfPath: string): Promise<DoclingDocumentJson> {
  const workDir = await mkdtemp(path.join(tmpdir(), "docling-"));
  try {
    const args = [
      "convert",
      "--to",
      "json",
      // "placeholder" statt des Default "embedded": Seiten-Thumbnails würden sonst als
      // Base64-PNG in jedes Item eingebettet — für ein 21-Seiten-Dokument mehrere MB JSON
      // ohne jeden Nutzen für uns (wir lesen nur Text/Tabellen/Provenienz).
      "--image-export-mode",
      "placeholder",
      "--output",
      workDir,
      absPdfPath,
    ];
    await execFileAsync(doclingBin, args, {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });

    const stem = path.basename(absPdfPath, path.extname(absPdfPath));
    const jsonPath = path.join(workDir, `${stem}.json`);
    const raw = await readFile(jsonPath, "utf8");
    return JSON.parse(raw) as DoclingDocumentJson;
  } catch (err) {
    throw new Error(`docling convert fehlgeschlagen für ${absPdfPath}: ${(err as Error).message}`, { cause: err });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// DoclingDocument JSON — nur die Teile, die wir tatsächlich lesen.
// Quelle: docling_core.types.doc.document.DoclingDocument (docling-core 2.91.0).
// ---------------------------------------------------------------------------

interface DoclingRef {
  $ref: string;
}

interface DoclingProv {
  page_no: number;
  charspan?: [number, number];
}

interface DoclingNodeBase {
  self_ref: string;
  children?: DoclingRef[];
  label?: string;
}

interface DoclingTextItem extends DoclingNodeBase {
  text: string;
  /** Nur bei `section_header` gesetzt (Default 1); Docling klassifiziert i.d.R. flach. */
  level?: number;
  prov?: DoclingProv[];
}

interface DoclingTableCell {
  text: string;
}

interface DoclingTableItem extends DoclingNodeBase {
  prov?: DoclingProv[];
  data: {
    num_rows: number;
    num_cols: number;
    /** Computed field von Docling: bereits row/col-span-aufgelöstes Grid (leere Zellen mit `text: ""`). */
    grid: DoclingTableCell[][];
  };
}

interface DoclingGroupItem extends DoclingNodeBase {}

interface DoclingPageItem {
  size: { width: number; height: number };
}

interface DoclingDocumentJson {
  body: DoclingNodeBase;
  groups: DoclingGroupItem[];
  texts: DoclingTextItem[];
  tables: DoclingTableItem[];
  pictures: DoclingNodeBase[];
  pages: Record<string, DoclingPageItem>;
}

function countPages(doc: DoclingDocumentJson): number {
  const pageNumbers = Object.keys(doc.pages ?? {})
    .map(Number)
    .filter(Number.isFinite);
  return pageNumbers.length > 0 ? Math.max(...pageNumbers) : 0;
}

/** Löst einen JSON-Pointer-Ref wie `"#/texts/12"` auf `{ kind: "texts", item }` auf. */
function resolveRef(doc: DoclingDocumentJson, ref: string): { kind: string; item: DoclingNodeBase | undefined } {
  const parts = ref.split("/"); // ["#", "texts", "12"]
  const kind = parts[1];
  const index = parts.length === 3 ? Number(parts[2]) : undefined;
  const collection = (doc as unknown as Record<string, unknown>)[kind];
  if (!Array.isArray(collection) || index === undefined) {
    return { kind, item: undefined };
  }
  return { kind, item: collection[index] as DoclingNodeBase | undefined };
}

// ---------------------------------------------------------------------------
// Markdown-Aufbau
// ---------------------------------------------------------------------------

/** "Teil A - ..." .. "Teil G - ..." → Ebene 1. */
const TEIL_HEADING_RE = /^Teil\s+[A-Z]\b/;
/** "A.1", "C.4", "F.3.1" → Ebene = 1 + Anzahl der ".N"-Gruppen. */
const OUTLINE_HEADING_RE = /^[A-Z](\.\d+)+\b/;

function classifyHeadingLevel(headingText: string, lastRecognizedLevel: { value: number }): number {
  const text = headingText.trim();

  if (TEIL_HEADING_RE.test(text)) {
    lastRecognizedLevel.value = 1;
    return 1;
  }

  const outlineMatch = OUTLINE_HEADING_RE.exec(text);
  if (outlineMatch) {
    // Nur die Gliederungsnummer selbst zählen (z. B. "F.3.1"), nicht Ziffern-mit-Punkt
    // weiter hinten im Überschriftentext (Datumsangaben wie "20.08.2026" würden sonst
    // mitgezählt und die Ebene künstlich vertiefen).
    const groupCount = (outlineMatch[0].match(/\.\d+/g) ?? []).length;
    const level = clampLevel(1 + groupCount);
    lastRecognizedLevel.value = level;
    return level;
  }

  // Unnummerierte Überschrift (z. B. "Frage 3: ...", "1. Vertragsgegenstand" innerhalb eines
  // Musterdokuments): nicht Teil der erkannten Gliederung, wird als eine Ebene unter der
  // zuletzt *erkannten* Gliederungsebene eingeordnet. lastRecognizedLevel wird hier bewusst
  // NICHT aktualisiert, damit aufeinanderfolgende unnummerierte Überschriften nicht immer
  // tiefer verschachtelt werden ("Frage 1".."Frage 16" landen alle auf derselben Ebene).
  return clampLevel(lastRecognizedLevel.value + 1);
}

function clampLevel(level: number): number {
  return Math.min(Math.max(level, 1), 6);
}

function escapeTableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Reine Seitenzähler — tragen nie einen Feldwert. */
const PAGE_COUNTER_RE = /^(seite\s*\d+(\s*(von|\/)\s*\d+)?|[-–—\s]*\d+[-–—\s]*|page\s*\d+.*)$/i;

/**
 * Sammelt Kopf-/Fußzeilen dedupliziert in Dokumentreihenfolge. Sie wiederholen
 * sich auf jeder Seite; inline würden sie den Fließtext zerhacken. Verworfen
 * werden sie trotzdem nicht — in Dok 1 steht die Kundenfirma
 * ("Vogtland Kesselbau GmbH") auch in der Fußzeile.
 */
function collectRunningHeaders(doc: DoclingDocumentJson): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of doc.texts ?? []) {
    if (item.label !== "page_footer" && item.label !== "page_header") continue;
    const text = (item.text ?? "").trim();
    if (!text || PAGE_COUNTER_RE.test(text) || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Docling-Baum → flache Zeilenliste mit Seitenzuordnung.
 *
 * Gibt bewusst **kein** fertiges Dokument zurück: Markdown, Abschnitte und Seiten-Offsets
 * entstehen erst in `assemble`, nachdem eventuelle Scan-Seiten ersetzt wurden. Sonst müsste
 * jede dieser drei Ableitungen zweimal existieren — einmal für Docling und einmal für die
 * gemischte Fassung — und die beiden könnten auseinanderlaufen, ohne dass es auffällt.
 */
function buildMarkdown(doc: DoclingDocumentJson, pages: number): { lines: string[]; linePages: number[] } {
  const lines: string[] = [];
  const linePages: number[] = [];
  const lastRecognizedLevel = { value: 0 };
  const visited = new Set<string>();

  function pushLine(text: string, page: number | undefined): void {
    lines.push(text);
    const fallbackPage = linePages.length > 0 ? linePages[linePages.length - 1] : 1;
    linePages.push(page ?? fallbackPage);
  }

  function pushBlank(): void {
    pushLine("", undefined);
  }

  function emitText(item: DoclingTextItem): void {
    const page = item.prov?.[0]?.page_no;
    const text = (item.text ?? "").trim();
    if (!text) return;

    if (item.label === "section_header" || item.label === "title") {
      // Die Ebene wird in `assemble` erneut bestimmt — dort für alle Quellen gemeinsam.
      // Hier steht sie trotzdem korrekt im Text, damit die Zeilenliste auch für sich
      // genommen gültiges Markdown ist (Zwischenausgaben, Fehlersuche).
      const level = classifyHeadingLevel(text, lastRecognizedLevel);
      if (lines.length > 0) pushBlank();
      pushLine(`${"#".repeat(level)} ${text}`, page);
      pushBlank();
      return;
    }

    if (item.label === "list_item") {
      pushLine(`- ${text}`, page);
      return;
    }

    // Kopf-/Fußzeilen wiederholen sich auf jeder Seite (Dok 1: 26 Items für 13
    // Seiten). Inline würden sie den Fließtext zerhacken und beim Chunking
    // Token kosten. Verwerfen wäre aber falsch — der Kunden-Firmenname steht
    // teils nur dort. Sie werden deshalb vorab dedupliziert als Block an den
    // Dokumentanfang gezogen (siehe collectRunningHeaders) und hier übersprungen.
    if (item.label === "page_footer" || item.label === "page_header") {
      return;
    }

    // Alles andere (Fließtext, Fußnoten, Caption, Kopf-/Fußzeilen, Formular-Felder, …) als
    // eigener Absatz. Bewusst nicht gefiltert: jede dieser Kategorien kann einen relevanten
    // Feldwert tragen (siehe Dok 4, "49.800 mm"-Korrektur steckt in einem normalen Absatz).
    pushLine(text, page);
    pushBlank();
  }

  function emitTable(item: DoclingTableItem): void {
    const grid = item.data?.grid ?? [];
    if (grid.length === 0 || grid[0]?.length === 0) return;

    const page = item.prov?.[0]?.page_no;
    if (lines.length > 0) pushBlank();

    const header = grid[0];
    pushLine(`| ${header.map((cell) => escapeTableCell(cell.text)).join(" | ")} |`, page);
    pushLine(`| ${header.map(() => "---").join(" | ")} |`, page);
    for (let rowIdx = 1; rowIdx < grid.length; rowIdx++) {
      pushLine(`| ${grid[rowIdx].map((cell) => escapeTableCell(cell.text)).join(" | ")} |`, page);
    }
    pushBlank();
  }

  function walkRef(ref: string): void {
    if (visited.has(ref)) return; // Zyklen-Schutz, sollte bei Docling nicht vorkommen
    visited.add(ref);

    const { kind, item } = resolveRef(doc, ref);
    if (!item) return;

    if (kind === "texts") {
      emitText(item as DoclingTextItem);
      return;
    }
    if (kind === "tables") {
      emitTable(item as DoclingTableItem);
      // KEIN return: Docling hängt Nachsätze unterhalb einer Tabelle als
      // `footnote`-Kinder an das Tabellen-Item, nicht als Geschwister in
      // body.children. Wer hier abbricht, verliert sie lautlos — und das sind
      // ausgerechnet die Sätze, die ein Feld explizit als leer bestätigen:
      //   Dok 1: "Zu Motoren/Getrieben sowie zu kundenspezifischen Werksnormen
      //           liegen uns keine gesonderten Vorgaben vor."
      //   Dok 5: "Zu Rohranordnung, Kesselhöhe und Abstand Trichter–Boden
      //           liegen noch keine endgültigen Werte vor."
      // Ohne sie ist "explizit bestätigt nicht vorhanden" nicht mehr von
      // "im Dokument nicht erwähnt" unterscheidbar.
    }
    // groups (inkl. Listen), pictures, key_value_items, form_items, … tragen selbst keinen
    // Markdown-Output; wir laufen nur rekursiv in ihre Kinder (Bilder daher: kein OCR/Vision
    // in Phase 1, aber eine eigenständige Bildunterschrift als Text-Item bleibt erhalten,
    // weil sie ein eigenes Geschwister-Item im Baum ist).
    for (const child of item.children ?? []) walkRef(child.$ref);
  }

  // Kopf-/Fußzeilen zuerst, dedupliziert, als kompakter Block. Reine
  // Seitenzähler ("Seite 7", "- 3 -") fliegen raus, alles andere bleibt:
  // Dok 1 nennt die Kundenfirma u.a. nur in der Fußzeile.
  const runningHeaders = collectRunningHeaders(doc);
  if (runningHeaders.length > 0) {
    pushLine("<!-- Kopf-/Fußzeilen (auf jeder Seite wiederholt) -->", 1);
    for (const h of runningHeaders) pushLine(h, 1);
    pushBlank();
  }

  for (const child of doc.body.children ?? []) walkRef(child.$ref);

  return { lines, linePages };
}

/**
 * Zeilenliste → fertiges Dokument: Markdown, Abschnittsindex, Seiten-Offsets.
 *
 * Rein und ohne I/O. Die **einzige** Stelle, an der `pageLineOffsets` und `sections`
 * entstehen — für den reinen Docling-Pfad wie für die gemischte Fassung.
 *
 * **Die Überschriftenebene wird hier neu bestimmt**, nicht aus dem `#`-Präfix übernommen.
 * Docling liefert die Ebene ohnehin flach (siehe Modul-Kommentar), und ein OCR bringt seine
 * eigene Zählung mit — ohne Normalisierung trüge dasselbe "Teil C" je nach Herkunft der
 * Seite eine andere Ebene, und die Abschnitts-Eingrenzung in `ground-evidence.ts` liefe für
 * gemischte Dokumente uneinheitlich. `classifyHeadingLevel` ist deterministisch: für ein
 * unvermischtes Docling-Dokument ist dieser Schritt die Identität.
 */
export function assemble(
  lines: string[],
  linePages: number[],
  pages: number,
): { markdown: string; sections: PdfSection[]; pageLineOffsets: number[] } {
  const HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const lastRecognizedLevel = { value: 0 };
  const sections: PdfSection[] = [];
  const out = [...lines];

  for (let i = 0; i < out.length; i++) {
    const m = HEADING_RE.exec(out[i]!);
    if (!m) continue;
    const heading = m[2]!.trim();
    if (!heading) continue;

    const level = classifyHeadingLevel(heading, lastRecognizedLevel);
    out[i] = `${"#".repeat(level)} ${heading}`;
    sections.push({ heading, level, startLine: i, endLine: i, page: linePages[i] ?? 1 });
  }

  for (let i = 0; i < sections.length; i++) {
    const nextStart = i + 1 < sections.length ? sections[i + 1]!.startLine : out.length;
    sections[i]!.endLine = Math.max(sections[i]!.startLine, nextStart - 1);
  }

  return { markdown: out.join("\n"), sections, pageLineOffsets: buildPageLineOffsets(linePages, pages) };
}

/**
 * Ersetzt die Zeilen der angegebenen Seiten durch neue Blöcke — an Ort und Stelle.
 *
 * Der Ersatzblock tritt dort ein, wo die **erste** Zeile der Seite stand; alle weiteren
 * Zeilen dieser Seite entfallen. Damit bleibt die Reihenfolge des Restdokuments exakt
 * erhalten, auch wenn Doclings Lesereihenfolge von der Seitenreihenfolge abweicht.
 *
 * Seiten ohne eigene Zeilen (Docling hat dort nichts erkannt — bei einem Scan der
 * Normalfall) werden **nicht** verschluckt: ihr Block wird vor der ersten Zeile der
 * nächsten Seite mit Inhalt eingefügt. Ohne diesen Zweig verschwände ausgerechnet die
 * Seite, die das OCR als einzige lesen konnte.
 */
export function replacePageLines(
  lines: string[],
  linePages: number[],
  ersatz: Map<number, string[]>,
): { lines: string[]; linePages: number[] } {
  if (ersatz.size === 0) return { lines, linePages };

  const outLines: string[] = [];
  const outPages: number[] = [];
  const eingefuegt = new Set<number>();

  const einfuegen = (page: number): void => {
    if (eingefuegt.has(page)) return;
    eingefuegt.add(page);
    for (const line of ersatz.get(page) ?? []) {
      outLines.push(line);
      outPages.push(page);
    }
  };

  // Welche Ersatzseiten kommen in der Zeilenliste überhaupt vor? Nur die übrigen brauchen
  // einen Einfügepunkt. Das **vorab** zu bestimmen ist wesentlich: Unterwegs zu entscheiden
  // ("Seite p ist kleiner als die aktuelle, also fehlt sie") wäre bei einer Lesereihenfolge,
  // die nicht der Seitenreihenfolge folgt, schlicht falsch — der Block landete vor einer
  // Zeile, die erst später kommt, und die Umsortierung wäre durch die Hintertür zurück.
  const vorhanden = new Set(linePages);
  const fehlend = [...ersatz.keys()].filter((p) => !vorhanden.has(p)).sort((a, b) => a - b);

  for (let i = 0; i < lines.length; i++) {
    const page = linePages[i] ?? 1;

    // Eine Seite, die Docling gar nicht gelesen hat (bei einem Scan der Normalfall), wird
    // vor der ersten Zeile der nächsthöheren Seite eingesetzt. Ohne diesen Zweig verschwände
    // ausgerechnet die Seite, die als einzige OCR gebraucht hat.
    for (const p of fehlend) {
      if (p < page) einfuegen(p);
    }

    if (ersatz.has(page)) {
      einfuegen(page);
      continue; // Originalzeile dieser Seite entfällt — der Block steht schon.
    }

    outLines.push(lines[i]!);
    outPages.push(page);
  }

  // Ersatzseiten hinter der letzten Originalzeile (leeres Docling-Ergebnis am Dokumentende).
  for (const p of [...ersatz.keys()].sort((a, b) => a - b)) einfuegen(p);

  return { lines: outLines, linePages: outPages };
}

function buildPageLineOffsets(linePages: number[], pages: number): number[] {
  const offsets: number[] = [];
  let lastOffset = 0;
  for (let page = 1; page <= pages; page++) {
    const firstLineIdx = linePages.indexOf(page);
    if (firstLineIdx >= 0) {
      lastOffset = firstLineIdx;
    }
    offsets.push(lastOffset);
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// hasTextLayer — bewusst unabhängig von Docling/OCR, siehe Modul-Kommentar oben.
// Die Rohdaten (Seitenzahl, Geometrie, Text-Layer, Bildabdeckung) liefert
// `src/pdf-native.ts`; hier steht nur noch die Klassifikation darauf.
// ---------------------------------------------------------------------------

/**
 * Welche Seiten haben keinen nativen Text-Layer?
 *
 * Die Heuristik ist unverändert (wenig Text **und** nahezu seitenfüllendes Bild); neu ist
 * allein, dass die Seitenliste erhalten bleibt, statt zu einem Dokument-Boolean zu
 * verdichten. Beide Bedingungen zusammen sind nötig: eine Deckblattseite mit nur einem
 * Titel hat ebenfalls wenig Text, aber kein seitenfüllendes Bild.
 */
async function classifyPages(
  absPdfPath: string,
  info: PdfInfo,
): Promise<{ scanPages: number[]; hasTextLayer: boolean }> {
  if (info.pages === 0) return { scanPages: [], hasTextLayer: true };

  const [charCounts, imageCoverage] = await Promise.all([
    getPerPageCharCounts(absPdfPath, info.pages),
    getPerPageImageCoverage(absPdfPath, info),
  ]);

  const scanPages: number[] = [];
  for (let page = 1; page <= info.pages; page++) {
    const chars = charCounts[page - 1] ?? 0;
    const coverage = imageCoverage[page - 1] ?? 0;
    if (chars < SCAN_PAGE_CHAR_THRESHOLD && coverage >= SCAN_PAGE_IMAGE_COVERAGE_THRESHOLD) {
      scanPages.push(page);
    }
  }

  return { scanPages, hasTextLayer: scanPages.length / info.pages <= SCAN_DOCUMENT_RATIO_THRESHOLD };
}

/**
 * Blendet die angegebenen Seiten aus dem Rohtext aus (`getRawText` trennt Seiten mit
 * Form-Feed, wie zuvor `pdftotext`). Gebraucht für `findLostTokens`: auf einer Scan-Seite
 * gibt es keinen Text-Layer, gegen den sich prüfen ließe — die wenigen Zeichen, die dort
 * trotzdem stehen (Stempel, Seitenzahl), würden sonst als Verlust gemeldet.
 */
function withoutPages(rawText: string, pages: number[]): string {
  if (!rawText || pages.length === 0) return rawText;
  const aus = new Set(pages);
  return rawText
    .split("\f")
    .map((seite, idx) => (aus.has(idx + 1) ? "" : seite))
    .join("\f");
}

// ---------------------------------------------------------------------------
// Vollständigkeits-Absicherung gegen den nativen Text-Layer
// ---------------------------------------------------------------------------

/**
 * Docling verliert in mehrzeiligen Tabellenzellen gelegentlich das letzte Token
 * vor dem Umbruch. Belegt an Eval-Data/1, "Anforderungen Klemmkästen / Kabel":
 *
 *   PDF (2 Zeilen):  "Außenaufstellung, daher Schutzart mindestens IP65"
 *                    "gefordert"
 *   Docling-Zelle:   "Außenaufstellung, daher Schutzart mindestens gefordert"
 *
 * "IP65" ist genau der Wert, den die Extraktion für dieses Feld braucht.
 * `--table-mode` steht bereits auf `accurate`; wegkonfigurieren lässt es sich
 * nicht. Statt den Verlust hinzunehmen, gleichen wir gegen den nativen
 * Text-Layer ab (`getRawText` aus `pdf-native.ts` — kein OCR, keine
 * Layout-Interpretation) und hängen die betroffenen Rohzeilen als klar
 * markierten Block an.
 *
 * Der Block ist bewusst als Rohtext-Ergänzung ausgewiesen und nicht als
 * Nachtrag/Korrektur formuliert — sonst würde ihn das Extraktionsmodell als
 * spätere Korrektur werten und `is_correction` setzen.
 */
export function findLostTokens(markdown: string, rawText: string): { tokens: string[]; lines: string[] } {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const haystack = norm(markdown);

  const lostLines = new Set<string>();
  const lost = new Set<string>();

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const tok of line.match(/[A-Za-zÄÖÜäöüß0-9][A-Za-zÄÖÜäöüß0-9.,\-/§°²³]{2,}/g) ?? []) {
      // Am Zeilenende getrennte Wörter ("Ursprungs-", "Betriebs-") sind keine
      // Verluste — Docling fügt sie korrekt wieder zusammen.
      if (tok.endsWith("-")) continue;
      if (haystack.includes(norm(tok))) continue;
      lost.add(tok);
      lostLines.add(line);
    }
  }
  return { tokens: [...lost], lines: [...lostLines] };
}

// ---------------------------------------------------------------------------
// Cache — Key ist der SHA-256 des PDF-Inhalts, Wert das komplette PdfParseResult.
// Kein Schema-Versionsfeld: ändert sich die Markdown-Aufbaulogik, `.cache/docling` löschen.
// ---------------------------------------------------------------------------

/**
 * Cache-Eintrag lesen und auf die **aktuelle** Feldmenge normalisieren.
 *
 * Der Cache überlebt Code-Änderungen: `PARSER_VERSION` wird nur hochgezählt, wenn sich die
 * Markdown-Erzeugung ändert — ein rein additives Feld (`scanPages`, `ocrPages`,
 * `ocrConfidence`) rechtfertigt das nicht, weil sonst jedes Dokument grundlos neu geparst
 * würde. Die Folge ist, dass hier Einträge aus mehreren Code-Ständen ankommen.
 *
 * Ohne diese Normalisierung stirbt der erste Zugriff auf ein neues Feld mit
 * `Cannot read properties of undefined` — an einer Stelle, die mit der Ursache nichts zu tun
 * hat. Genau so passiert, als `ocrPages` hinzukam.
 */
export function normalizeCacheEntry(c: Partial<PdfParseResult> | null | undefined): PdfParseResult | null {
  if (!c || typeof c.markdown !== "string") return null; // unbrauchbar — lieber neu parsen

  return {
    markdown: c.markdown,
    sections: c.sections ?? [],
    pages: c.pages ?? 0,
    hasTextLayer: c.hasTextLayer ?? true,
    scanPages: c.scanPages ?? [],
    ocrPages: c.ocrPages ?? [],
    ocrConfidence: c.ocrConfidence ?? [],
    pageLineOffsets: c.pageLineOffsets ?? [],
    lostTokens: c.lostTokens ?? [],
    parseMs: 0,
  };
}

async function readCache(cachePath: string): Promise<PdfParseResult | null> {
  try {
    return normalizeCacheEntry(JSON.parse(await readFile(cachePath, "utf8")) as Partial<PdfParseResult>);
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, result: PdfParseResult): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(result), "utf8");
}
