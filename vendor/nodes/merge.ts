/**
 * Zusammenführung der Batch-Ergebnisse — deterministisch, LLM nur bei echten Konflikten.
 *
 * Bei 9 Batches × 71 Feldern entstehen bis zu 639 Kandidaten. Sie alle einem Modell
 * vorzulegen kostet Token und gefährdet die Werte, die längst eindeutig sind. Entschieden
 * werden muss nur dort, wo zwei Batches **unterschiedliche** Werte melden — realistisch
 * eine Handvoll pro Dokument, und genau dort liegen die Korrektur-Fallen.
 */

import { z } from "zod";
import { resolvePrompt, renderTemplate } from "../model.js";
import { MERGE_SYSTEM_PROMPT, MERGE_USER_TEMPLATE } from "../prompts.js";
import { EXTRACTABLE_FIELDS, type ExtractedField } from "../schema.js";
import type { BatchResult } from "./extract.js";

export const MERGE_SLUG = "szks-extraktion-merge";

export interface MergedField extends ExtractedField {
  /** Unterlegener Wert bei einem aufgelösten Konflikt — Audit-Trail statt stillem Überschreiben. */
  superseded_value?: string | number | boolean | null;
  /** Begründung der Auflösung. Nur bei Konfliktfeldern gesetzt. */
  reason?: string;
  /**
   * Aus welchem Batch der übernommene Wert stammt.
   *
   * Nicht Kosmetik: `ground-evidence.ts` grenzt damit die Suche nach dem Zitat auf den
   * Abschnitt ein, den dieser Batch gesehen hat. Ohne diese Einschränkung nimmt die Suche den
   * ERSTEN Treffer im ganzen Dokument — bei einem sechs Zeichen langen Beleg ("Nein") ist das
   * in einer 500-Seiten-Ausschreibung mit hoher Wahrscheinlichkeit die falsche Stelle.
   */
  batch_index?: number;
}

export type MergedResult = Record<string, MergedField>;

export interface MergeStats {
  /** Felder, bei denen mehrere Batches abweichende Werte lieferten. */
  conflicts: string[];
  /** Felder, die in mehreren Batches gefunden wurden (auch bei identischem Wert). */
  multiSource: string[];
  llmCalled: boolean;
}

const ConflictDecision = z.object({
  decisions: z.array(
    z.object({
      field_id: z.string(),
      chosen_batch_index: z.number(),
      status: z.enum(["gefunden", "unklar"]),
      reason: z.string(),
    }),
  ),
});

/**
 * Zwei Werte gelten als gleich, wenn sie sich nur in Formatierung unterscheiden.
 * Exportiert, damit `eval/graders.ts` (fieldAccuracy: `49800` === `"49.800"`) exakt dieselbe
 * Normalisierung verwendet statt einer zweiten, potenziell abweichenden Kopie.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const norm = (v: unknown) =>
    String(v)
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/\.(?=\d{3}\b)/g, ""); // Tausenderpunkte: 49.800 === 49800
  return norm(a) === norm(b);
}

export async function mergeBatches(results: BatchResult[]): Promise<{ merged: MergedResult; stats: MergeStats }> {
  const merged: MergedResult = {};
  const conflicts: string[] = [];
  const multiSource: string[] = [];
  const conflictCandidates = new Map<string, { batchIndex: number; field: ExtractedField }[]>();

  for (const field of EXTRACTABLE_FIELDS) {
    const candidates = results
      .map((r) => ({ batchIndex: r.batchIndex, field: r.fields[field.id] }))
      .filter((c): c is { batchIndex: number; field: ExtractedField } => Boolean(c.field))
      // Vor jeder weiteren Entscheidung geraderücken — sonst würde ein als Text gelieferter
      // Zahlenwert unten als eigener Kandidat gegen denselben Wert als Zahl antreten und
      // einen Konflikt erzeugen, den es nicht gibt.
      .map((c) => ({ batchIndex: c.batchIndex, field: normalizeNumericValue(c.field, field.type) }));

    const withValue = candidates.filter((c) => c.field.status === "gefunden" && c.field.value !== null);

    // Fall 1: kein Batch hat einen Wert. Die Batches können sich trotzdem unterscheiden —
    // einer sah eine ausdrückliche Nicht-Vorgabe, ein anderer schlicht nichts. Die
    // Rangfolge stellt die aussagekräftigste Meldung nach vorn:
    //   unklar  >  ausdruecklich_keine_vorgabe  >  nicht_im_dokument
    // "unklar" gewinnt, weil es einen Menschen einschaltet. Ein Feld fälschlich zur
    // Prüfung zu stellen kostet Zeit; es fälschlich als geklärt zu führen kostet ein
    // falsches Angebot.
    if (withValue.length === 0) {
      const beste =
        candidates.find((c) => c.field.status === "unklar") ??
        candidates.find((c) => c.field.status === "ausdruecklich_keine_vorgabe");
      merged[field.id] = beste ? { ...beste.field, batch_index: beste.batchIndex } : emptyField();
      continue;
    }

    if (withValue.length > 1) multiSource.push(field.id);

    // Fall 2: genau ein Kandidat.
    if (withValue.length === 1) {
      merged[field.id] = { ...withValue[0]!.field, batch_index: withValue[0]!.batchIndex };
      continue;
    }

    // Fall 3: mehrere Kandidaten, alle mit demselben Wert. Den mit dem besten Beleg nehmen —
    // bevorzugt einen Korrekturabschnitt, sonst den mit Zitat.
    const first = withValue[0]!;
    if (withValue.every((c) => sameValue(c.field.value, first.field.value))) {
      const best = withValue.find((c) => c.field.is_correction) ?? withValue.find((c) => c.field.evidence) ?? first;
      merged[field.id] = { ...best.field, batch_index: best.batchIndex };
      continue;
    }

    // Fall 4: echter Wertkonflikt → sammeln, gemeinsam an das Modell.
    conflicts.push(field.id);
    conflictCandidates.set(field.id, withValue);
    merged[field.id] = { ...first.field, batch_index: first.batchIndex }; // vorläufig, wird unten überschrieben
  }

  if (conflicts.length === 0) {
    return { merged, stats: { conflicts, multiSource, llmCalled: false } };
  }

  await resolveConflicts(conflictCandidates, merged);
  return { merged, stats: { conflicts, multiSource, llmCalled: true } };
}

/**
 * Ein einziger Call für alle Konflikte des Dokuments — nicht einer pro Feld. Die Konflikte
 * sind selten, aber sie hängen inhaltlich zusammen (dieselbe Bieterfrage kann mehrere Werte
 * korrigieren), und ein gemeinsamer Blick darauf ist billiger und besser.
 *
 * Das Modell sieht nie das Dokument, nur die Kandidaten mit Beleg — das hält den Call klein
 * und verhindert, dass es unabhängig davon neue Werte "findet".
 */
async function resolveConflicts(
  candidates: Map<string, { batchIndex: number; field: ExtractedField }[]>,
  merged: MergedResult,
): Promise<void> {
  const labels = new Map(EXTRACTABLE_FIELDS.map((f) => [f.id, f.label]));

  const rendered = [...candidates.entries()]
    .map(([fieldId, list]) => {
      const lines = list.map(
        (c) =>
          // Ohne Seitenangabe: die kommt erst nach dem Merge aus dem Beleg (ground-evidence.ts).
          // Der Abschnitt steht dagegen schon hier — er ist die Ortsangabe, die das Modell
          // selbst gelesen hat, und für die Konfliktentscheidung die relevantere.
          `    - Batch ${c.batchIndex} · Abschnitt "${c.field.section ?? "?"}"` +
          `${c.field.is_correction ? " · KORREKTURABSCHNITT" : ""}\n` +
          `      Wert: ${JSON.stringify(c.field.value)}${c.field.unit ? ` ${c.field.unit}` : ""}\n` +
          `      Beleg: "${c.field.evidence ?? "— kein Zitat —"}"`,
      );
      return `  ${fieldId} (${labels.get(fieldId) ?? fieldId}):\n${lines.join("\n")}`;
    })
    .join("\n\n");

  try {
    const { system, user, model } = await resolvePrompt({
      applicationSlug: MERGE_SLUG,
      fallback: MERGE_SYSTEM_PROMPT,
      userFallback: MERGE_USER_TEMPLATE,
    });

    const structured = model.withStructuredOutput(ConflictDecision, { name: "konflikt_aufloesung" });
    const decision = (await structured.invoke([
      { role: "system", content: system },
      { role: "user", content: renderTemplate(user, { conflicts: rendered }) },
    ])) as z.infer<typeof ConflictDecision>;

    for (const d of decision.decisions) {
      const list = candidates.get(d.field_id);
      if (!list) continue;
      const chosen = list.find((c) => c.batchIndex === d.chosen_batch_index) ?? list[0]!;
      const loser = list.find((c) => c !== chosen);
      // Entscheidet der Merge "unklar", darf der Wert NICHT stehenbleiben: ein Feld mit
      // status "unklar" und gefülltem value widerspricht dem Schema-Vertrag (Wert nur bei
      // "gefunden") und erschiene in der Zusammenfassung als Prüffall MIT Wert — also als
      // Entscheidung, die keine ist. Der unterlegene Wert bleibt über superseded_value
      // nachvollziehbar, der gewählte steht im reason.
      const unklar = d.status === "unklar";
      merged[d.field_id] = {
        ...chosen.field,
        batch_index: chosen.batchIndex,
        status: d.status,
        value: unklar ? null : chosen.field.value,
        unklar_grund: unklar ? "widerspruechliche_fundstellen" : null,
        superseded_value: loser?.field.value ?? null,
        reason: unklar
          ? `${d.reason} (Kandidat aus Batch ${chosen.batchIndex}: ${JSON.stringify(chosen.field.value)})`
          : d.reason,
      };
    }
  } catch (err) {
    // Fällt der Merge-Call aus, bleibt es bei der deterministischen Vorbelegung — aber
    // als `unklar` markiert, damit ein ungelöster Konflikt nicht wie eine Entscheidung
    // aussieht.
    for (const [fieldId, list] of candidates) {
      const fallback = list.find((c) => c.field.is_correction) ?? list[list.length - 1]!;
      merged[fieldId] = {
        ...fallback.field,
        batch_index: fallback.batchIndex,
        status: "unklar",
        value: null,
        unklar_grund: "widerspruechliche_fundstellen",
        superseded_value: list.find((c) => c !== fallback)?.field.value ?? null,
        reason:
          `Konfliktauflösung fehlgeschlagen (${(err as Error).message}); ` +
          `aussichtsreichster Kandidat war ${JSON.stringify(fallback.field.value)} aus ` +
          `${fallback.field.is_correction ? "dem Korrekturabschnitt" : "dem letzten Batch"} — bitte prüfen.`,
      };
    }
  }
}

function emptyField(): ExtractedField {
  return {
    status: "nicht_im_dokument",
    value: null,
    unit: null,
    unklar_grund: null,
    evidence: null,
    page: null,
    section: null,
    is_correction: false,
  };
}

/**
 * Hebt eine reine Zahl, die als Zeichenkette geliefert wurde, in ihren Typ zurück —
 * deterministisch, bevor irgendetwas anderes das Feld anfasst.
 *
 * `value` darf bei Zahlenfeldern eine Zeichenkette sein, damit "430–460 °C" nicht verloren
 * geht. Der Preis dieser Erlaubnis ist, dass sie auch dort greift, wo sie nicht gebraucht
 * wird: "5600" als Text ist derselbe Wert wie 5600, aber nicht mehr rechenbar. Ohne diese
 * Rückführung würde der bequeme Weg mit der Zeit zum Normalweg und die Typunterscheidung
 * liefe leer.
 *
 * Bewusst eng: nur wenn NICHTS außer der Zahl dasteht. "430–460" und "ca. 450" bleiben Text —
 * dort wäre jede Umwandlung eine Auswahl, und die trifft das Modell so wenig wie dieser Code.
 */
export function normalizeNumericValue(field: ExtractedField, fieldType: string): ExtractedField {
  if (fieldType !== "number" || typeof field.value !== "string") return field;
  // Deutsches Dezimalkomma und Tausenderpunkte zulassen.
  const raw = field.value.trim().replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(raw) ? { ...field, value: Number(raw) } : field;
}
