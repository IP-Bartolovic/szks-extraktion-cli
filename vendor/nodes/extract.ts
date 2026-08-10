/**
 * Extraktion eines einzelnen Batches — der einzige LLM-Call im Normalfall.
 *
 * Ein Batch sieht nur seinen Ausschnitt und kann Widersprüche im Dokument gar nicht sehen.
 * Er trägt deshalb pro Feld nicht nur Wert und Status, sondern auch `evidence`, `page`,
 * `section` und `is_correction` — erst damit kann der Merge einen Konflikt begründet
 * auflösen statt nach "später gewinnt" zu raten.
 */

import { z } from "zod";
import type { Batch } from "../chunk.js";
import { resolvePrompt, renderTemplate } from "../model.js";
import { BATCH_SYSTEM_PROMPT, BATCH_USER_TEMPLATE } from "../prompts.js";
import { EXTRACTABLE_FIELDS, EXTRACTION_SCHEMA, type ExtractedField } from "../schema.js";
import { toStrictJsonSchema } from "../strict-schema.js";

export const BATCH_SLUG = "szks-extraktion-batch";

/** Ein Extraktionsergebnis, angereichert um die Herkunft aus dem Batch. */
export interface BatchResult {
  batchIndex: number;
  pageRange: [number, number];
  fields: Record<string, ExtractedField>;
  /** Fehlermeldung, falls dieser Batch fehlschlug. Dann ist `fields` leer. */
  error?: string;
}

/**
 * Das strict-JSON-Schema wird einmal gebaut und wiederverwendet — es ist ~53 KB groß,
 * und bei 9 Batches wäre neun Mal erzeugen unnötige Arbeit.
 */
let cachedStrictSchema: Record<string, unknown> | null = null;

function strictSchema(): Record<string, unknown> {
  if (!cachedStrictSchema) {
    const raw = z.toJSONSchema(EXTRACTION_SCHEMA, { target: "draft-2020-12", io: "output" });
    cachedStrictSchema = toStrictJsonSchema(raw) as Record<string, unknown>;
  }
  return cachedStrictSchema;
}

/**
 * Ein fehlgeschlagener Batch darf nicht die ganze Extraktion versenken: bei 9 Batches wäre
 * sonst ein einzelner Timeout gleichbedeutend mit einem verlorenen Dokument. Stattdessen
 * liefert er ein leeres Ergebnis mit Fehlermeldung — der Merge arbeitet mit dem Rest weiter
 * und der Ausfall bleibt im Ergebnis sichtbar.
 */
export async function extractBatch(batch: Batch): Promise<BatchResult> {
  try {
    const { system, user, model } = await resolvePrompt({
      applicationSlug: BATCH_SLUG,
      fallback: BATCH_SYSTEM_PROMPT,
      userFallback: BATCH_USER_TEMPLATE,
    });

    const structured = model.withStructuredOutput(strictSchema(), {
      name: "szks_extraktion",
      method: "jsonSchema",
      strict: true,
    });

    const raw = (await structured.invoke([
      { role: "system", content: system },
      { role: "user", content: renderTemplate(user, { document: batch.markdown }) },
    ])) as Record<string, unknown>;

    return {
      batchIndex: batch.batchIndex,
      pageRange: batch.pageRange,
      fields: normalize(raw, batch),
    };
  } catch (err) {
    return {
      batchIndex: batch.batchIndex,
      pageRange: batch.pageRange,
      fields: {},
      error: (err as Error).message,
    };
  }
}

/**
 * Räumt die Modellantwort auf, bevor sie in den Merge geht:
 *
 * - Felder, die das Modell weggelassen hat, werden als `not_found` ergänzt. Ein fehlender
 *   Schlüssel und ein bewusst leeres Feld sind für die Auswertung dasselbe, aber der Merge
 *   soll nicht mit Lücken umgehen müssen.
 * - Ein Wert ohne `evidence` wird auf `uncertain` zurückgestuft. Der Belegzwang ist die
 *   Absicherung gegen erfundene Werte; ein Wert, der ihn nicht erfüllt, hat ihn nicht
 *   verdient.
 * - Fehlt die Seitenzahl, wird der Batch-Anfang eingesetzt — grob, aber besser als null,
 *   weil der Merge sonst nicht chronologisch sortieren kann.
 */
function normalize(raw: Record<string, unknown>, batch: Batch): Record<string, ExtractedField> {
  const out: Record<string, ExtractedField> = {};

  for (const field of EXTRACTABLE_FIELDS) {
    const entry = raw[field.id] as Partial<ExtractedField> | undefined;

    if (!entry || typeof entry !== "object") {
      out[field.id] = emptyField();
      continue;
    }

    let status = entry.status ?? "nicht_im_dokument";
    const value = entry.value ?? null;
    const evidence = typeof entry.evidence === "string" && entry.evidence.trim() ? entry.evidence.trim() : null;

    // "gefunden" ohne Wert oder ohne Beleg ist kein Fund. Ohne Wert bleibt nichts übrig;
    // mit Wert, aber ohne Beleg, bleibt eine unbelegte Behauptung — die geht als Prüffall
    // weiter, nicht als Ergebnis.
    if (status === "gefunden" && (value === null || evidence === null)) {
      status = value === null ? "nicht_im_dokument" : "unklar";
    }
    // Ebenso muss eine ausdrückliche Nicht-Vorgabe belegt sein, sonst ist sie nur eine
    // Behauptung des Modells über das Dokument.
    if (status === "ausdruecklich_keine_vorgabe" && evidence === null) {
      status = "nicht_im_dokument";
    }

    out[field.id] = {
      status,
      value: status === "gefunden" ? value : null,
      unit: typeof entry.unit === "string" && entry.unit.trim() ? entry.unit.trim() : null,
      unklar_grund: status === "unklar" ? (entry.unklar_grund ?? "angabe_unpraezise") : null,
      evidence,
      page:
        typeof entry.page === "number" && Number.isFinite(entry.page)
          ? entry.page
          : status === "nicht_im_dokument"
            ? null
            : batch.pageRange[0],
      section: typeof entry.section === "string" && entry.section.trim() ? entry.section.trim() : null,
      is_correction: entry.is_correction === true,
    };
  }

  return out;
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
