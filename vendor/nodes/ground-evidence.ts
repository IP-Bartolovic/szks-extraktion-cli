/**
 * Fundort eines Belegs — im Code bestimmt, nicht vom Modell behauptet.
 *
 * ## Der Anlass
 *
 * Im Lauf `996cdd7a` trugen **67 von 67** belegten Feldern in Dokument 4 die Seite 1 — bei
 * einem PDF mit 21 Seiten. Dasselbe in Dok 1 (13 Seiten) und Dok 5 (13 Seiten). Der Grund ist
 * banal und vollständig: **Das Docling-Markdown enthält keine Seitenmarker.** Das Modell hatte
 * nie eine Information, aus der es eine Seite hätte ablesen können — es hat eine plausible
 * Zahl geliefert, weil das Schema eine verlangt.
 *
 * Das ist derselbe Fehlermodus, gegen den dieses Projekt an mehreren Stellen gebaut ist: ein
 * Wert, der wie ein Nachweis aussieht und keiner ist. Er steht ausgerechnet im Prüfpfad —
 * dort, wo ein Mensch nachschlagen soll, ob der Wert stimmt. Bei 21 Seiten ist "Seite 1" nur
 * unbrauchbar; bei 500 wäre es irreführend.
 *
 * ## Warum das ableitbar ist
 *
 * `pdfToMarkdown` kennt die Seiten längst: `pageLineOffsets[i]` ist die Zeile, an der Seite
 * `i + 1` beginnt (aus Doclings `prov[].page_no`, also aus dem PDF selbst). Und `evidence`
 * kommt nachweislich wörtlich im Quelltext vor — `beleg_im_dokument` steht seit zwei Läufen
 * auf 1,000. Aus beidem folgt die Seite exakt, ohne Modell und ohne Kosten.
 *
 * ## Eindeutigkeit
 *
 * Ein kurzes Zitat ("Nein") kommt in einem langen Dokument vielfach vor. Dagegen wirken drei
 * Dinge zusammen, in dieser Reihenfolge:
 *
 * 1. **Der Prompt fordert ganze Sätze bzw. Tabellenzeilen** (Richtwert 40 Zeichen — Größenordnung, keine Untergrenze). Das ist
 *    die eigentliche Abhilfe — ein eindeutiges Zitat braucht keine Eingrenzung.
 * 2. **Abschnitt und Batch grenzen ein.** Beides sind Angaben, die das Modell wirklich sehen
 *    konnte, und beide können den Fundort nur verbessern: Passt die Angabe nicht, greift die
 *    Eingrenzung einfach nicht.
 * 3. **Bleibt es mehrdeutig, gilt die erste Fundstelle im engsten Bereich** — und `stats.unsicher`
 *    zählt den Fall. Kein leeres Feld: das würde die Sucharbeit zurück auf den Menschen
 *    verlagern, die der Fundort ihm gerade abnehmen soll.
 *
 * Wird das Zitat gar nicht gefunden, steht `page: null` — dort gibt es nichts zu wählen.
 */

import { normalizeQuoteText, quoteParts } from "../evidence-match.js";
import type { Batch } from "../chunk.js";
import type { PdfParseResult } from "../pdf-markdown.js";
import type { MergedResult } from "./merge.js";

export interface GroundingStats {
  /** Felder mit Beleg, deren Fundort bestimmt werden konnte. */
  lokalisiert: number;
  /** Felder mit Beleg, deren Zitat sich nicht wiederfinden ließ — `page`/`section` werden null. */
  nichtGefunden: number;
  /**
   * Felder, deren Zitat mehrfach auf verschiedenen Seiten steht und sich weder über den Batch
   * noch über den Abschnitt auf eine reduzieren ließ. Sie bekommen trotzdem einen Fundort —
   * den ersten im engsten verfügbaren Bereich.
   *
   * **Warum nicht leer lassen.** Ein leeres Feld verlagert die Sucharbeit zurück auf den
   * Menschen, und genau die soll der Fundort abnehmen. Die erste Fundstelle im engsten Bereich
   * ist die mit Abstand wahrscheinlichste; diese Zahl sagt, wie oft überhaupt eine Wahl nötig
   * war. Steigt sie, ist die Ursache fast immer ein zu kurzes Zitat — dagegen hilft die
   * Zitatregel im Prompt, nicht ein leeres Feld.
   */
  unsicher: number;
}

/**
 * Zeilenweise normalisierter Quelltext plus die Startposition jeder Zeile darin.
 *
 * Die Normalisierung schluckt Zeilenumbrüche (`\s+` → " "), ein Offset im normalisierten Text
 * ließe sich danach nicht mehr auf eine Zeile zurückführen. Deshalb wird Zeile für Zeile
 * normalisiert und die Position mitgeschrieben.
 *
 * Kleiner Unterschied zur Grader-Seite, die den ganzen Text am Stück normalisiert: Ein Zitat,
 * das über einen Zeilenumbruch **direkt vor ein Satzzeichen** läuft, kann hier scheitern, wo
 * der Grader es findet. Folge ist dann `page: null`, nie eine falsche Seite.
 */
export function buildLineIndex(markdown: string): { normalized: string; lineStart: number[] } {
  const lines = markdown.split("\n");
  const lineStart = new Array<number>(lines.length).fill(-1);
  const parts: string[] = [];
  let pos = 0;

  for (let i = 0; i < lines.length; i++) {
    const n = normalizeQuoteText(lines[i]!);
    if (n.length === 0) {
      lineStart[i] = pos;
      continue;
    }
    if (parts.length > 0) pos += 1; // das verbindende Leerzeichen
    lineStart[i] = pos;
    parts.push(n);
    pos += n.length;
  }

  return { normalized: parts.join(" "), lineStart };
}

/** Größter Index mit `werte[i] <= ziel` — für Zeilen- und Seitenzuordnung. */
export function letzterNichtGroesser(werte: number[], ziel: number): number {
  let lo = 0;
  let hi = werte.length - 1;
  let treffer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (werte[mid]! <= ziel) {
      treffer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return treffer;
}

/**
 * Alle Fundstellen des Zitats im normalisierten Text — nicht nur die erste.
 *
 * Die erste zu nehmen wäre bei langen Zitaten fast immer richtig und bei kurzen fast immer
 * falsch: Das kürzeste beobachtete Zitat war **sechs Zeichen** lang ("Nein"). In einem
 * 13-Seiten-Dokument ist das zufällig eindeutig, in einer 500-Seiten-Ausschreibung nicht.
 */
function alleFundstellen(normalized: string, quote: string): number[] {
  const parts = quoteParts(quote);
  if (parts.length === 0) return [];

  const stellen: number[] = [];
  let suchAb = 0;
  // Obergrenze, damit ein extrem kurzes Zitat in einem 500-Seiten-Dokument die Schleife nicht
  // zehntausendfach durchläuft — mehr als eine Handvoll Treffer heißt ohnehin "mehrdeutig".
  while (stellen.length < 64) {
    const start = normalized.indexOf(parts[0]!, suchAb);
    if (start === -1) break;

    // Die Folgeteile müssen der Reihe nach dahinter liegen, sonst zählt diese Stelle nicht.
    let from = start + parts[0]!.length;
    let vollstaendig = true;
    for (const part of parts.slice(1)) {
      const at = normalized.indexOf(part, from);
      if (at === -1) { vollstaendig = false; break; }
      from = at + part.length;
    }
    if (vollstaendig) stellen.push(start);
    suchAb = start + 1;
  }
  return stellen;
}

export function groundEvidence(
  final: MergedResult,
  parsed: Pick<PdfParseResult, "markdown" | "sections" | "pageLineOffsets">,
  batches: Pick<Batch, "batchIndex" | "startLine" | "endLine">[] = [],
): { final: MergedResult; stats: GroundingStats } {
  const { normalized, lineStart } = buildLineIndex(parsed.markdown);
  // Zeilen ohne Inhalt tragen dieselbe Position wie die folgende — für die Suche nach der
  // Zeile zu einem Offset ist die Liste trotzdem monoton, das genügt.
  const seitenStart = parsed.pageLineOffsets ?? [];

  const batchVonIndex = new Map(batches.map((b) => [b.batchIndex, b]));
  const zeileVonOffset = (off: number) => letzterNichtGroesser(lineStart, off);
  const seiteVonZeile = (zeile: number) =>
    seitenStart.length > 0 ? letzterNichtGroesser(seitenStart, zeile) + 1 : null;

  // Überschrift → Zeilenbereich. Das Modell nennt die Überschrift, unter der es gelesen hat;
  // sie ist die zweite Eingrenzung neben dem Batch und oft die schärfere (ein Abschnitt ist
  // typisch ein paar Zeilen, ein Batch bei 100k Token gut 50 Seiten).
  const abschnittVonTitel = new Map<string, { startLine: number; endLine: number }>();
  for (const sec of parsed.sections) {
    abschnittVonTitel.set(normalizeQuoteText(sec.heading).toLowerCase(), sec);
  }

  const out: MergedResult = {};
  let lokalisiert = 0;
  let nichtGefunden = 0;
  let unsicher = 0;

  for (const [fieldId, feld] of Object.entries(final)) {
    if (!feld.evidence) {
      out[fieldId] = feld;
      continue;
    }

    const stellen = alleFundstellen(normalized, feld.evidence);
    if (stellen.length === 0) {
      nichtGefunden++;
      out[fieldId] = { ...feld, page: null, section: null };
      continue;
    }

    let offset = stellen[0]!;
    if (stellen.length > 1) {
      // Zwei Eingrenzungen, von grob nach fein. Beide sind Angaben, die das Modell WIRKLICH
      // sehen konnte: den Batch hat es gelesen, die Überschrift steht im Text. Falsch liegen
      // können sie trotzdem — dann greift die Eingrenzung schlicht nicht und der Bereich
      // bleibt weiter. Sie können den Fundort also verbessern, aber nicht verfälschen.
      const b = feld.batch_index !== undefined ? batchVonIndex.get(feld.batch_index) : undefined;
      const sec = feld.section ? abschnittVonTitel.get(normalizeQuoteText(feld.section).toLowerCase()) : undefined;
      const imBereich = (bereich: { startLine: number; endLine: number } | undefined) =>
        bereich
          ? stellen.filter((o) => { const z = zeileVonOffset(o); return z >= bereich.startLine && z <= bereich.endLine; })
          : [];

      const imBatch = imBereich(b);
      const imAbschnitt = imBereich(sec);
      // Der Schnitt aus beidem ist der engste Bereich; danach der Abschnitt, dann der Batch.
      const geschnitten = imAbschnitt.filter((o) => imBatch.includes(o));
      const kandidaten =
        geschnitten.length > 0 ? geschnitten
        : imAbschnitt.length > 0 ? imAbschnitt
        : imBatch.length > 0 ? imBatch
        : stellen;

      if (new Set(kandidaten.map((o) => seiteVonZeile(zeileVonOffset(o)))).size > 1) unsicher++;
      offset = kandidaten[0]!;
    }

    const zeile = zeileVonOffset(offset);
    const seite = seiteVonZeile(zeile);
    // Die Überschrift, unter der die Fundstelle steht — auch sie war bisher eine Behauptung
    // des Modells und ist hier ableitbar.
    const abschnitt = [...parsed.sections].reverse().find((s) => s.startLine <= zeile)?.heading ?? null;

    lokalisiert++;
    out[fieldId] = { ...feld, page: seite, section: abschnitt };
  }

  return { final: out, stats: { lokalisiert, nichtGefunden, unsicher } };
}
