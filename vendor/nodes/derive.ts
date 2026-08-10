/**
 * Abgeleitete Felder — deterministisch im Code, nicht durchs Modell.
 *
 * Die Excel führt "Druck im Zug" zweimal: Zeile 49 als Rohwert in der Einheit der Anfrage
 * (mmH₂O/mmWS/Pa/mbar) und Zeile 50 als auf mbar umgerechneten Wert. Zeile 50 ist im
 * Feldkatalog `extractable: false` — sie steht in keinem Kundendokument, sondern entsteht
 * durch Umrechnung.
 *
 * Ein Modell mit dieser Umrechnung zu beauftragen wäre eine vermeidbare Fehlerquelle: drei
 * Zeilen Code sind exakt, ein LLM ist es bei Zahlen nicht zuverlässig.
 */

import type { MergedField, MergedResult } from "./merge.js";

/** Rohfeld (Zeile 49) und Zielfeld (Zeile 50) laut Feldkatalog. */
const PRESSURE_SOURCE = "anlage-druck-im-zug-lt-anfrage";
const PRESSURE_TARGET = "anlage-druck-im-zug";

/** Umrechnungsfaktoren auf mbar. */
const TO_MBAR: Record<string, number> = {
  mbar: 1,
  hpa: 1, // 1 hPa = 1 mbar
  pa: 0.01,
  // mmWS ("Millimeter Wassersäule") ist ein Synonym für mmH₂O, keine eigene Einheit.
  mmh2o: 0.0980665,
  "mmh₂o": 0.0980665,
  mmws: 0.0980665,
  mmwc: 0.0980665,
  bar: 1000,
};

function normalizeUnit(unit: string): string {
  return unit
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/₂/g, "2")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Ergänzt die abgeleiteten Felder. Schlägt die Umrechnung fehl (unbekannte Einheit, kein
 * numerischer Wert), bleibt das Zielfeld `not_found` mit Begründung — geraten wird nicht.
 */
export function deriveFields(merged: MergedResult): MergedResult {
  const out: MergedResult = { ...merged };
  const source = merged[PRESSURE_SOURCE];

  if (!source || source.status !== "gefunden" || source.value === null) {
    return out;
  }

  const value = typeof source.value === "number" ? source.value : Number(String(source.value).replace(/\./g, "").replace(",", "."));
  const unitKey = normalizeUnit(source.unit ?? "");
  const factor = TO_MBAR[unitKey];

  if (!Number.isFinite(value) || factor === undefined) {
    out[PRESSURE_TARGET] = {
      status: "unklar",
      value: null,
      unit: "mbar",
      unklar_grund: factor === undefined ? "kein_zulaessiger_wert" : "angabe_unpraezise",
      evidence: source.evidence,
      page: source.page,
      section: source.section,
      is_correction: source.is_correction,
      reason: factor === undefined
        ? `Einheit "${source.unit ?? "(fehlt)"}" unbekannt — keine Umrechnung nach mbar möglich.`
        : `Wert "${String(source.value)}" ist nicht numerisch — keine Umrechnung nach mbar möglich.`,
    };
    return out;
  }

  // Zwei Nachkommastellen, nicht vier.
  //
  // 1050 mmWS ergaben roh 102,9698 mbar — und genau so stand es in der CSV. Vier
  // Nachkommastellen behaupten eine Genauigkeit, die die Quelle nicht hat: Der Ausgangswert
  // ist auf 10 mmWS gerundet, die vierte Stelle des Ergebnisses entspricht 0,1 mmWS. Wer die
  // Zelle liest, hält das für eine Messung.
  //
  // 0,01 mbar ist auch praktisch die feinste sinnvolle Stufe: Der Zugdruck bewegt sich im
  // Bereich einiger zehn bis hundert mbar. Die Rohangabe bleibt daneben unverändert im Feld
  // "Druck im Zug lt. Anfrage" stehen — hier wird also nichts verworfen, nur nichts erfunden.
  const mbar = Math.round(value * factor * 100) / 100;
  const derived: MergedField = {
    status: source.status,
    value: mbar,
    unit: "mbar",
    unklar_grund: null,
    evidence: source.evidence,
    page: source.page,
    section: source.section,
    is_correction: source.is_correction,
    reason: `Abgeleitet aus ${value} ${source.unit} (Faktor ${factor}).`,
  };
  out[PRESSURE_TARGET] = derived;
  return out;
}
