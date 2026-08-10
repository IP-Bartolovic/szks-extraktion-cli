/**
 * Ergebnis-Zusammenfassung — deterministisch aus dem Extraktionsergebnis, nicht vom Modell.
 *
 * `final` ist vollständig, aber unlesbar: 71 Felder als Objekt, in dem gefundene Werte,
 * Leerstellen und Prüffälle gleich aussehen. Dieser Schritt gruppiert sie, ohne etwas
 * hinzuzufügen — jeder Eintrag stammt Feld für Feld aus `final` und dem Feldkatalog.
 *
 * **Warum das ein Code-Schritt ist und kein Prompt.** Das Modell könnte die Gruppierung
 * mitliefern, aber dann wäre sie eine Behauptung statt einer Ableitung: ein Feld könnte in
 * `fields_found` auftauchen, ohne dass `final` dazu einen Wert trägt, und niemand würde es
 * merken. Hier gilt die Gruppierung per Konstruktion — sie kann von `final` nicht abweichen.
 *
 * **Grundlage ist der Katalog, nicht `final`.** Iteriert würde über `final`, verschwiegen
 * die Zusammenfassung genau die Felder, die das Modell gar nicht erst geliefert hat. Fehlt
 * ein Feld, erscheint es als fehlend — mit Begründung. Stille Lücken sind der Fehlermodus,
 * den dieses Projekt am wenigsten gebrauchen kann.
 *
 * **Die Einträge tragen bereits das Format von der Importer:** `label` (exakter Wortlaut
 * der Excel-Spalte C, nach dem sein Importer sucht), `value`, `unit`. Der CSV-Export der
 * nächsten Phase liest die Zusammenfassung, nicht `final`.
 */

import { EXTRACTABLE_FIELDS, istWortlaut, type FieldStatus, type UnklarGrund } from "../schema.js";
import { FIELD_CATALOG } from "../field-catalog.generated.js";
import type { MergedField, MergedResult } from "./merge.js";

/**
 * Ein Feld in der Zusammenfassung. Die ersten drei Properties sind die CSV-Spalten,
 * der Rest ist Herkunft und Begründung.
 */
export interface SummaryEntry {
  /** Exakter Excel-Wortlaut (Spalte C) — der Schlüssel, über den zurückgeschrieben wird. */
  label: string;
  /** Der Wert, so wie er in die Zielzelle gehört — bei Zahlenfeldern ggf. als Wortlaut ("ca. 430–460 °C"). */
  value: string | number | boolean | null;
  /** true, wenn in einem Zahl-/Ja-Nein-Feld eine Zeichenkette steht — der Wert ist dann nicht rechenbar. */
  value_ist_wortlaut: boolean;
  /** Einheit, wie sie im Dokument stand. Nicht umgerechnet. `null`, wenn keine genannt. */
  unit: string | null;
  id: string;
  /** Excel-Zeile — bestimmt die Reihenfolge und später die Zielzelle. */
  row: number;
  category: string;
  prio: boolean;
  status: FieldStatus;
  /** Nur bei `unklar` gesetzt — sagt, was der Mensch klären muss. */
  unklar_grund: UnklarGrund | null;
  page: number | null;
  /** Überschrift, unter der der Beleg steht — wie `page` im Code abgeleitet, nicht vom Modell. */
  section: string | null;
  /** Wörtliches Zitat. Bei fehlenden Feldern `null`. */
  evidence: string | null;
  /** Wert stammt aus einem korrigierenden Abschnitt (Bieterfrage, Nachtrag, Protokoll). */
  is_correction: boolean;
  /** Begründung — bei `uncertain` und bei aufgelösten Konflikten gesetzt. */
  reason: string | null;
}

export interface SummaryCounts {
  /** Felder, die die Pipeline überhaupt füllen soll (extrahierbar + abgeleitet). */
  total: number;
  found: number;
  uncertain: number;
  missing: number;
  /**
   * Teilmenge von `missing`: der Kunde hat ausdrücklich gesagt, dass er nichts vorschreibt.
   * Für SZKS heißt das "frei wählbar" — der Rest von `missing` heißt "nachfragen".
   */
  missing_ausdruecklich_keine_vorgabe: number;
  prio_total: number;
  prio_found: number;
  prio_uncertain: number;
  prio_missing: number;
}

export interface ExtractionSummary {
  counts: SummaryCounts;
  /** Alles mit belegtem Wert, in Excel-Reihenfolge. */
  fields_found: SummaryEntry[];
  /**
   * Braucht einen Menschen: etwas steht im Dokument, ließ sich aber nicht eindeutig
   * zuordnen. Bewusst nicht unter `missing_fields` — dort würde es untergehen, obwohl
   * hier Information vorliegt, die nur eine Entscheidung braucht.
   */
  uncertain_fields: SummaryEntry[];
  missing_fields: SummaryEntry[];
  /**
   * Teilmenge von `missing_fields`. Redundant und trotzdem eigenständig: das ist die
   * Liste, die über ein Angebot entscheidet — die "Fehlende Prio Werte"-Tabelle der Anfragemaske (Zeile 140–143).
   */
  missing_prio_fields: SummaryEntry[];
}

/**
 * Zuordnung Status → Gruppe. Als Tabelle statt als `if`-Kette: ein neuer Status ist damit
 * eine Zeile, und das Fehlen einer Zeile ein Typfehler statt eines stillen Durchfallens.
 *
 * `ausdruecklich_keine_vorgabe` zählt zu den fehlenden Feldern, weil in der Anfragemaske dort
 * nichts steht — die Unterscheidung selbst geht nicht verloren, sie steckt im `status`
 * jedes Eintrags.
 */
const GROUP_OF: Record<FieldStatus, "found" | "uncertain" | "missing"> = {
  gefunden: "found",
  unklar: "uncertain",
  nicht_im_dokument: "missing",
  ausdruecklich_keine_vorgabe: "missing",
};

/** Felder, die die Pipeline füllen soll: extrahierbar plus die im Code abgeleiteten. */
const DERIVED_FIELD_IDS = ["anlage-druck-im-zug"];
const TARGET_FIELDS = [
  ...EXTRACTABLE_FIELDS,
  ...FIELD_CATALOG.filter((f) => !f.extractable && DERIVED_FIELD_IDS.includes(f.id)),
].sort((a, b) => a.row - b.row);

function toEntry(def: (typeof TARGET_FIELDS)[number], field: MergedField | undefined): SummaryEntry {
  return {
    label: def.label,
    value: field?.value ?? null,
    value_ist_wortlaut: istWortlaut(field?.value, def),
    unit: field?.unit ?? null,
    id: def.id,
    row: def.row,
    category: def.categoryLabel,
    prio: def.prio,
    status: field?.status ?? "nicht_im_dokument",
    unklar_grund: field?.unklar_grund ?? null,
    page: field?.page ?? null,
    section: field?.section ?? null,
    evidence: field?.evidence ?? null,
    is_correction: field?.is_correction ?? false,
    reason:
      field?.reason ??
      // Ein im Katalog geführtes Feld, das gar nicht im Ergebnis steht, ist keine
      // Fehlanzeige des Modells, sondern eine Lücke der Pipeline — und wird als solche
      // benannt, statt sich als gewöhnliches "nicht angegeben" zu tarnen.
      (field === undefined ? "Feld wurde nicht extrahiert (Batch fehlgeschlagen oder Schema unvollständig)." : null),
  };
}

export function summarize(final: MergedResult): ExtractionSummary {
  const buckets = {
    found: [] as SummaryEntry[],
    uncertain: [] as SummaryEntry[],
    missing: [] as SummaryEntry[],
  };

  // TARGET_FIELDS ist nach Excel-Zeile sortiert, die Listen erben diese Reihenfolge.
  for (const def of TARGET_FIELDS) {
    const entry = toEntry(def, final[def.id]);
    buckets[GROUP_OF[entry.status]].push(entry);
  }
  const { found, uncertain, missing } = buckets;

  const countPrio = (list: SummaryEntry[]) => list.filter((e) => e.prio).length;

  return {
    counts: {
      total: TARGET_FIELDS.length,
      found: found.length,
      uncertain: uncertain.length,
      missing: missing.length,
      missing_ausdruecklich_keine_vorgabe: missing.filter((e) => e.status === "ausdruecklich_keine_vorgabe").length,
      prio_total: TARGET_FIELDS.filter((f) => f.prio).length,
      prio_found: countPrio(found),
      prio_uncertain: countPrio(uncertain),
      prio_missing: countPrio(missing),
    },
    fields_found: found,
    uncertain_fields: uncertain,
    missing_fields: missing,
    missing_prio_fields: missing.filter((e) => e.prio),
  };
}
