/**
 * OCR für Seiten ohne nativen Text-Layer — Mistral `/v1/ocr`.
 *
 * ## Warum überhaupt ein externer Dienst
 *
 * Docling bringt eigenes OCR mit und liest Scan-Seiten auch ohne diesen Baustein. Die
 * Belege dieses Projekts sind aber überwiegend **Tabellenzeilen** ("| Anzahl Zugänge KRA |
 * 6 |"), und dort trennt sich klassisches OCR von der aktuellen Generation: Zeilen- und
 * Spaltenzuordnung in einer gescannten Tabelle ist genau die Aufgabe, an der EasyOCR und
 * Tesseract scheitern. Ein zerfallener Tabellenkopf erzeugt keinen Fehler, sondern
 * plausiblen Text mit falscher Zuordnung — der teuerste Fehlermodus, den dieses Projekt
 * kennt.
 *
 * ## Warum Mistral und nicht die Registry
 *
 * `createModel`/`agents.prompts` bilden Chat-Modelle mit System- und Nutzernachricht ab.
 * Hier gibt es weder Prompt noch Konversation, sondern einen Werkzeugaufruf wie
 * `docling convert` — Konfiguration entsprechend über ENV (`SZKS_OCR_MODEL`,
 * `MISTRAL_API_KEY`), nicht über die Prompt-Registry.
 *
 * Das Modell ist **fest gepinnt**, nicht `-latest`, aus demselben Grund wie die
 * Docling-Version: Ein stiller Modellwechsel würde die Ergebnisse verschieben, ohne dass
 * eine Zeile Code sich geändert hätte — und die Ursache wäre Monate später nicht mehr
 * auffindbar.
 *
 * ## Zwei Einstellungen, die den Ausschlag geben
 *
 * 1. **`table_format` wird NICHT gesetzt.** Der Default rendert Tabellen inline als
 *    Markdown-Tabellen. Mit `"markdown"` oder `"html"` wandert der Inhalt in ein separates
 *    `tables`-Feld, und im Text bleibt ein Platzhalter `[tbl-3.html](tbl-3.html)` zurück.
 *    Die Extraktion fände die Tabellenzeile dann nicht mehr — und meldete `nicht_im_dokument`
 *    für ein Feld, das sehr wohl im Dokument steht. Ein Fehler, der wie ein Ergebnis aussieht.
 * 2. **`include_blocks: false`.** Der Default ist `true` und liefert Bounding Boxes für
 *    jeden Absatz, die wir nicht lesen. Bei einem Scan-Dokument bläht das die Antwort auf,
 *    ohne irgendetwas beizutragen.
 */

/** $4 je 1000 Seiten (Stand 2026-08, `mistral-ocr-4-0`). Nur für die Kostenmeldung. */
export const OCR_PRICE_PER_PAGE = 0.004;

const DEFAULT_MODEL = "mistral-ocr-4-0";
const ENDPOINT = "https://api.mistral.ai/v1/ocr";

/** Grenzen des Dienstes. Darüber bricht der Aufruf ab — mit klarer Ansage statt HTTP 413. */
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 1000;

const TIMEOUT_MS = 10 * 60 * 1000;
/** Ein zweiter Versuch bei Netz-/Serverfehlern; danach entscheidet der Aufrufer. */
const ATTEMPTS = 2;

export interface OcrResult {
  /** 1-basierte Seite → Markdown-Zeilen dieser Seite. */
  blocks: Map<number, string[]>;
  /** Zuversicht je Seite (0..1), leer wenn der Dienst keine liefert. */
  confidences: { page: number; confidence: number }[];
  /** Aus `usage_info` — der Kostenbeleg, nicht unsere Anforderung. */
  pagesProcessed: number;
}

interface OcrApiPage {
  index: number;
  markdown?: string;
  confidence_scores?: number | { page?: number; mean?: number };
}

interface OcrApiResponse {
  pages?: OcrApiPage[];
  usage_info?: { pages_processed?: number };
}

/**
 * Liest die angegebenen Seiten (1-basiert) per OCR.
 *
 * Wirft bei fehlendem Schlüssel, überschrittenen Grenzen oder endgültigem Fehlschlag —
 * der Aufrufer in `pdf-markdown.ts` fängt das ab und behält Doclings eigene Lesung.
 */
export async function ocrPages(pdf: Buffer, pages: number[]): Promise<OcrResult> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY ist nicht gesetzt.");
  if (pages.length === 0) return { blocks: new Map(), confidences: [], pagesProcessed: 0 };

  if (pdf.byteLength > MAX_BYTES) {
    throw new Error(
      `PDF ist ${(pdf.byteLength / 1024 / 1024).toFixed(1)} MB, das Limit liegt bei ${MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (pages.length > MAX_PAGES) {
    throw new Error(`${pages.length} Seiten angefordert, das Limit liegt bei ${MAX_PAGES}.`);
  }

  const model = process.env.SZKS_OCR_MODEL || DEFAULT_MODEL;
  const body = {
    model,
    document: {
      type: "document_url",
      document_url: `data:application/pdf;base64,${pdf.toString("base64")}`,
    },
    // Der Dienst zählt 0-basiert, das Projekt durchgängig 1-basiert (Seite 1 = erste
    // Seite, wie in `pageLineOffsets` und in jedem Beleg). Die Umrechnung steht genau
    // hier und in `zuordnen` — nirgends sonst.
    pages: pages.map((p) => p - 1),
    include_image_base64: false,
    include_blocks: false,
    confidence_scores_granularity: "page",
    // table_format bewusst nicht gesetzt — siehe Modul-Kommentar.
  };

  const antwort = await postMitWiederholung(ENDPOINT, apiKey, body, model);
  return zuordnen(antwort, pages);
}

async function postMitWiederholung(
  url: string,
  apiKey: string,
  body: unknown,
  model: string,
): Promise<OcrApiResponse> {
  let letzterFehler: Error | undefined;

  for (let versuch = 1; versuch <= ATTEMPTS; versuch++) {
    const abbruch = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: abbruch,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const fehler = new Error(`HTTP ${res.status} von ${model}: ${text.slice(0, 300)}`);
        // 4xx außer 429 sind Anfragefehler — ein zweiter Versuch ändert daran nichts.
        if (res.status < 500 && res.status !== 429) throw fehler;
        letzterFehler = fehler;
        continue;
      }

      return (await res.json()) as OcrApiResponse;
    } catch (err) {
      letzterFehler = err as Error;
      if (versuch === ATTEMPTS) break;
    }
  }

  throw letzterFehler ?? new Error("OCR-Aufruf fehlgeschlagen.");
}

/**
 * Antwort-Seiten den angeforderten Seitennummern zuordnen.
 *
 * `index` sollte die 0-basierte Original-Seitennummer sein. Verlassen wird sich darauf
 * **nicht**: Liefert der Dienst stattdessen laufende Nummern innerhalb der Auswahl (0,1,2
 * für die Seiten 12,13,14), landete jeder Text auf der falschen Seite — und das Ergebnis
 * sähe vollkommen plausibel aus. Passen die Indizes nicht zur Anforderung, entscheidet die
 * Reihenfolge, und die Abweichung wird gemeldet.
 */
function zuordnen(antwort: OcrApiResponse, angefordert: number[]): OcrResult {
  const seiten = antwort.pages ?? [];
  const erwartet = new Set(angefordert.map((p) => p - 1));
  const indizesPassen = seiten.length > 0 && seiten.every((s) => erwartet.has(s.index));

  if (!indizesPassen && seiten.length > 0) {
    console.warn(
      `[ocr-mistral] Seitenindizes (${seiten.map((s) => s.index).join(", ")}) passen nicht zur Anforderung ` +
        `(${angefordert.map((p) => p - 1).join(", ")}) — Zuordnung über die Reihenfolge.`,
    );
  }

  const blocks = new Map<number, string[]>();
  const confidences: { page: number; confidence: number }[] = [];

  seiten.forEach((seite, i) => {
    const page = indizesPassen ? seite.index + 1 : (angefordert[i] ?? seite.index + 1);
    const markdown = (seite.markdown ?? "").replace(/\r\n/g, "\n");
    blocks.set(page, markdown.length > 0 ? markdown.split("\n") : []);

    const c = seite.confidence_scores;
    const wert = typeof c === "number" ? c : (c?.page ?? c?.mean);
    if (typeof wert === "number" && Number.isFinite(wert)) {
      // Manche Fassungen liefern Prozent statt Anteil.
      confidences.push({ page, confidence: wert > 1 ? wert / 100 : wert });
    }
  });

  return {
    blocks,
    confidences,
    pagesProcessed: antwort.usage_info?.pages_processed ?? seiten.length,
  };
}
