/**
 * Menschlich lesbare Übersetzungen der Status- und Unklar-Enums.
 *
 * Eine gemeinsame Stelle statt einer Kopie in CLI-Ausgabe und CSV-Export — sonst laufen
 * die Texte bei der nächsten Statusänderung in schema.ts still auseinander, ohne dass ein
 * Typfehler das anzeigt (`Record<FieldStatus, string>` zwingt bei einem neuen Statuswert
 * zu einem Eintrag hier).
 */

import type { FieldStatus, UnklarGrund } from "./schema.js";

/** Der Enum-Wert sagt dem Code, was zu tun ist; dieser Text sagt es dem Menschen. */
export const UNKLAR_GRUND_TEXT: Record<UnklarGrund, string> = {
  zuordnung_mehrdeutig: "könnte zu mehreren Feldern gehören",
  kein_zulaessiger_wert: "passt in keinen zulässigen Wert",
  angabe_unpraezise: "Angabe zu ungenau für dieses Feld",
  widerspruechliche_fundstellen: "mehrere abweichende Fundstellen",
};

/**
 * Die beiden Leer-Status lesen sich absichtlich unterschiedlich: `ausdruecklich_keine_vorgabe`
 * heißt für SZKS "frei wählbar", `nicht_im_dokument` heißt "nachfragen" — dieselbe fachliche
 * Unterscheidung, derentwegen es in schema.ts den eigenen Status gibt (siehe dort), muss auch
 * hier lesbar bleiben statt in einem gemeinsamen "leer" zu verschwinden.
 */
export const STATUS_TEXT: Record<FieldStatus, string> = {
  gefunden: "Gefunden",
  nicht_im_dokument: "Nicht im Dokument (nachfragen)",
  ausdruecklich_keine_vorgabe: "Keine Vorgabe (frei wählbar)",
  unklar: "Unklar (prüfen)",
};
