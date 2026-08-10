/**
 * CSV-Export — **eine** Datei mit allen Daten. Reine Funktionen, kein I/O.
 *
 * ## Warum nur eine Datei
 *
 * Bis zum 2026-08-10 gab es zwei: eine schmale Importdatei (`Bezeichnung;Wert;Dimension`)
 * und eine breite Prüfdatei. Die Trennung sollte die Zielzelle sauber halten — sie war
 * überflüssig. Die breite Datei **enthält** die schmale: Wer nur Bezeichnung, Wert und
 * Dimension braucht, liest drei Spalten und ignoriert den Rest. Eine zweite Datei zu
 * erzeugen, deren Inhalt vollständig in der ersten steckt, schafft nur eine Gelegenheit,
 * die falsche zu erwischen.
 *
 * Der Vertrag zum Importer bleibt unberührt: `label` unverändert als Suchschlüssel, alle
 * Zielfelder in Excel-Reihenfolge (`row`), jedes Feld genau einmal, keine
 * Einheitenumrechnung.
 *
 * ## Was das Wertfeld trägt — und was nicht
 *
 * `unklar`, `nicht_im_dokument` und `ausdruecklich_keine_vorgabe` haben per Schema
 * `value: null` und bleiben im Wertfeld **leer**. Ein Marker dort („?", „unklar") würde
 * keine fehlende Information ergänzen, sondern in die Zielzelle wandern — der Importer
 * kennt ihn nicht. Was den Fall erklärt, steht in eigenen Spalten: `Status`, `Grund`,
 * `Beleg`, `Seite`. Wer nur die drei Importspalten liest, sieht ein leeres Feld, und genau
 * das ist richtig.
 *
 * ## Schlüssel statt Anzeigetexte
 *
 * `Status` und `Grund` tragen die Enum-Werte (`gefunden`, `zuordnung_mehrdeutig`), nicht
 * ausformulierte Sätze. Auf einen Satz kann kein Filter und keine Pivot-Tabelle verlässlich
 * matchen, und eine Umformulierung im Code bräche jede darauf gebaute Auswertung still. Die
 * Werte sind ohnehin deutsch — Lesbarkeit kostet hier nichts. Die Klartextfassung gibt es in
 * der Terminalausgabe (`src/labels.ts`).
 */

import type { ExtractionSummary, SummaryEntry } from "../nodes/summarize.js";

export interface CsvExportOptions {
  /** Spaltentrennzeichen. Default `;` — so vom Importer vorgegeben, deutsches Excel-Standardformat. */
  delimiter?: string;
  /** UTF-8-BOM voranstellen. Default `true` — ohne BOM zerlegt Excel unter Windows die Umlaute. */
  bom?: boolean;
  /** Zeilenende. Default CRLF (RFC 4180). */
  eol?: string;
}

const DEFAULT_DELIMITER = ";";
const DEFAULT_EOL = "\r\n";

function resolveOptions(opts: CsvExportOptions | undefined) {
  return {
    delimiter: opts?.delimiter ?? DEFAULT_DELIMITER,
    bom: opts?.bom ?? true,
    eol: opts?.eol ?? DEFAULT_EOL,
  };
}

/**
 * RFC-4180-Quoting: ein Feld wird nur dann in `"` eingefasst, wenn es das Trennzeichen,
 * ein `"`, CR oder LF enthält; enthaltene `"` werden verdoppelt. Alles andere bliebe
 * unnötig gequotet und würde den Import ohne Not erschweren.
 */
function escapeField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes("\r") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Deutsches Zahlenformat: Komma statt Punkt, kein Tausenderpunkt. `String(number)` liefert
 * für die hier vorkommenden Größenordnungen (mm, °C, mbar, Stückzahlen) nie Exponential-
 * oder Gruppierungsnotation, ein einzelnes `.` genügt deshalb als Ersetzung. Booleans als
 * `Ja`/`Nein` (deutschsprachige Maske), `null` als leeres Feld.
 */
function formatValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "Ja" : "Nein";
  if (typeof value === "number") return String(value).replace(".", ",");
  return value;
}

/**
 * Ein Feld auf eine Zeile bringen.
 *
 * Ein Beleg kann über einen Absatz hinweg zitieren und dann einen Zeilenumbruch enthalten —
 * seit der Prompt ganze Sätze statt Wortfetzen verlangt, häufiger als vorher. RFC 4180
 * erlaubt das (gequotet), und Excel liest es korrekt. **Wer die Datei zeilenweise
 * verarbeitet, bekommt aber Geisterzeilen** — ein naives `split("\\n")` sieht eine
 * Datenzeile mehr, als es gibt.
 *
 * Die CSV ist genau dafür da, weiterverarbeitet zu werden. Der Umbruch trägt keine
 * Information (das Zitat bleibt vollständig), also wird er zum Leerzeichen — der Vorteil für
 * jeden Leser wiegt schwerer als die Absatzgrenze im Zitat.
 */
function einzeilig(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ").trim();
}

function buildCsv(rows: string[][], opts: CsvExportOptions | undefined): string {
  const { delimiter, bom, eol } = resolveOptions(opts);
  const body =
    rows.map((row) => row.map((cell) => escapeField(einzeilig(cell), delimiter)).join(delimiter)).join(eol) + eol;
  const BOM = "﻿";
  return (bom ? BOM : "") + body;
}

/**
 * Alle Zielfelder in Excel-Reihenfolge — die drei Bucket-Listen der Zusammenfassung sind
 * je für sich schon nach `row` sortiert, zusammengeführt müssen sie es erneut werden, damit
 * sie ineinander verzahnt bleiben statt blockweise hintereinanderzustehen.
 */
function orderedEntries(summary: ExtractionSummary): SummaryEntry[] {
  return [...summary.fields_found, ...summary.uncertain_fields, ...summary.missing_fields].sort((a, b) => a.row - b.row);
}

/**
 * Der Export: alle Zielfelder, alle Angaben, eine Datei.
 *
 * **Spaltenreihenfolge.** `Bezeichnung`, `Wert` und `Dimension` stehen bewusst nebeneinander
 * an Position 3–5: In dieser Reihenfolge erwartet der Importer sie, wer nur diese drei
 * braucht, greift einen zusammenhängenden Block heraus.
 *
 * Davor stehen die beiden **stabilen Schlüssel**: `Zeile` ist die Zeile der Anfragemaske
 * (dieselbe, über die ein Rückschreiben später adressiert), `Feld-ID` überlebt jede
 * Umbenennung in Spalte C. Die `Bezeichnung` ist der Suchschlüssel des Importers, aber sie
 * ist Excel-Text und kann sich ändern.
 *
 * `Wortlaut` markiert Werte, die im Typ des Feldes nicht darstellbar waren („ca. 430–460 °C"
 * in einem Zahlenfeld). Wer die Zahlen weiterrechnet, muss wissen, welche davon keine sind.
 * Ja/leer statt Ja/Nein: eine leere Zelle filtert sich schneller.
 */
export function toCsv(summary: ExtractionSummary, opts?: CsvExportOptions): string {
  const rows: string[][] = [
    [
      "Zeile",
      "Feld-ID",
      "Bezeichnung",
      "Wert",
      "Dimension",
      "Status",
      "Grund",
      "Prio",
      "Korrektur",
      "Wortlaut",
      "Seite",
      "Abschnitt",
      "Beleg",
    ],
  ];
  for (const e of orderedEntries(summary)) {
    rows.push([
      String(e.row),
      e.id,
      e.label,
      formatValue(e.value),
      e.unit ?? "",
      e.status,
      e.unklar_grund ?? "",
      e.prio ? "ja" : "",
      e.is_correction ? "ja" : "",
      e.value_ist_wortlaut ? "ja" : "",
      e.page !== null ? String(e.page) : "",
      e.section ?? "",
      e.evidence ?? "",
    ]);
  }
  return buildCsv(rows, opts);
}
