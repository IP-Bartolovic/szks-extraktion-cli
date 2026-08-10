/**
 * Zod-Schema für die Extraktion, generiert aus dem Feldkatalog.
 *
 * ## Warum jedes Feld mehr trägt als Wert + Status
 *
 * Ein Batch, der die Gesamthöhe auf Seite 40 sieht, kann nicht wissen, dass Seite 280 sie
 * korrigiert — beide Batches melden guten Gewissens `found`. Der Konflikt ist im Batch
 * strukturell unsichtbar und ausschließlich im Merge auflösbar. Damit der Merge das kann,
 * muss jeder gefundene Wert seinen Fundort mitbringen:
 *
 *   - `evidence`      wörtliches Zitat — zugleich das wirksamste bekannte Mittel gegen
 *                     erfundene Werte, und es macht Distraktortreffer beim Debuggen sichtbar
 *   - `page`/`section` wo im Dokument
 *   - `is_correction` steht der Wert in einem Abschnitt, der frühere Angaben korrigiert?
 *
 * Ohne `section` und `is_correction` bliebe dem Merge nur "später gewinnt" — und das ist
 * falsch, sobald ein Anhang mit alten Daten hinter der Bieterfrage steht.
 *
 * ## OpenAI strict Structured Outputs
 *
 * `openai/gpt-5.6-luna` listet `structured_outputs` in `supported_parameters`. Strict mode
 * verlangt: `additionalProperties: false` in jedem Objekt, **alle** Properties in `required`,
 * Optionalität ausschließlich über Nullable-Unions. Deshalb konsequent `.nullable()` statt
 * `.optional()` — ein `.optional()` würde das Feld aus `required` nehmen und den Aufruf
 * ablehnen lassen.
 *
 * Limits (Stand 08/2026): ≤5.000 Properties, ≤10 Nesting-Ebenen, ≤120.000 Zeichen für alle
 * Namen/Enum-Werte zusammen, ≤1.000 Enum-Werte. Wir liegen bei ~500 Properties und Nesting 2.
 * `assertOpenAiStrictCompatible()` prüft das ohne API-Call — siehe scripts/check-schema.ts.
 */

import { z } from "zod";
import { FIELD_CATALOG, type FieldDef } from "./field-catalog.generated.js";

/** Nur diese Felder werden extrahiert (71 von 74). */
export const EXTRACTABLE_FIELDS: FieldDef[] = FIELD_CATALOG.filter((f) => f.extractable);

/**
 * Vier Status, nicht drei — die Trennung der beiden Leer-Fälle ist fachlich, nicht kosmetisch.
 *
 * "Der Kunde hat ausdrücklich gesagt, es gibt keine Vorgabe" und "dazu steht nichts im
 * Dokument" führen beide zu einem leeren Wertfeld, bedeuten für SZKS aber Gegenteiliges:
 * das eine heißt "wir dürfen frei wählen", das andere "nachfragen". Ohne eigenen Status
 * wäre diese Unterscheidung nur um den Preis eines erfundenen Wertes zu haben — genau das
 * hat das Modell im ersten Eval-Lauf getan ("Keine gesonderten Vorgaben" als Wert, 31×
 * wörtlich belegt und trotzdem falsch abgelegt).
 *
 * Deutsch, weil diese Werte im Ergebnis stehen, das ein Mensch sichtet.
 */
export const STATUS_VALUES = [
  "gefunden",
  "nicht_im_dokument",
  "ausdruecklich_keine_vorgabe",
  "unklar",
] as const;
export type FieldStatus = (typeof STATUS_VALUES)[number];

/** Die beiden Status, die ein leeres Wertfeld bedeuten. */
export const LEER_STATUS: readonly FieldStatus[] = ["nicht_im_dokument", "ausdruecklich_keine_vorgabe"];

/**
 * Warum ein Feld unklar ist — als Enum statt als Confidence-Zahl.
 *
 * Eine vom Modell verbalisierte Confidence wäre schlecht kalibriert (die Werte klumpen bei
 * 0,85–0,95, unabhängig davon, ob die Extraktion stimmt) und ein Schwellwert darauf wäre
 * eine erfundene Grenze. Der Grund dagegen ist überprüfbar — er lässt sich gegen den
 * Ground Truth halten — und er sagt, was zu tun ist.
 */
export const UNKLAR_GRUENDE = [
  "zuordnung_mehrdeutig",
  "kein_zulaessiger_wert",
  "angabe_unpraezise",
  "widerspruechliche_fundstellen",
] as const;
export type UnklarGrund = (typeof UNKLAR_GRUENDE)[number];

export interface ExtractedField {
  status: FieldStatus;
  /**
   * Der Wert im Typ des Feldes — bei Zahl- und Ja/Nein-Feldern **zusätzlich als Zeichenkette
   * erlaubt**, wenn die Angabe in eine Zahl nicht hineinpasst ("430–460 °C", "400 V,
   * alternativ 415 V").
   *
   * Der Anlass: `Rauchgastemperatur` ist `type: "number"`, im Dokument stand "ca. 430–460 °C".
   * Es gibt keine Zahl, die das abbildet. Solange nur `number` zulässig war, blieb dem Modell
   * `unklar` — ein Prio-Feld verlor seinen belegten Wert, obwohl `evidence` ihn korrekt
   * zitierte. Die Alternative wäre gewesen, es eine Zahl **wählen** zu lassen; genau das ist
   * die Entscheidung, die es nie treffen soll.
   *
   * **Warum die Union und nicht eine eigene Property.** Der erste Versuch war ein zusätzliches
   * `value_text`. Es hat nie funktioniert: Das Modell hat die Property in **keinem** selbst
   * gefüllten Feld ausgegeben — obwohl sie in `required` stand, `additionalProperties: false`
   * galt und `strict: true` mitging. Die strict-Garantie trägt bei diesem Anbieter nicht.
   * `value` dagegen liefert das Modell ausnahmslos in jedem Feld. Der Ausweg hängt jetzt an
   * einer Property, deren Auslieferung belegt ist, statt an einer Zusage, die nicht hält.
   *
   * Bewusst nicht für Aufzählungsfelder: dort ist die Werteliste eine fachliche Vorgabe,
   * keine Darstellungsgrenze. Ein Wert außerhalb der Liste bleibt `unklar` mit
   * `kein_zulaessiger_wert` und gehört vor einen Menschen.
   */
  value: string | number | boolean | null;
  unit: string | null;
  /** Nur bei status "unklar" gesetzt, sonst null. */
  unklar_grund: UnklarGrund | null;
  evidence: string | null;
  /**
   * Seite des Fundorts — **nicht vom Modell**, sondern in `nodes/ground-evidence.ts` aus dem
   * Beleg abgeleitet. Deshalb optional: im Extraktionsschema gibt es die Property nicht mehr.
   * Das Modell hatte nie eine Information, aus der es eine Seite hätte ablesen können (das
   * Docling-Markdown trägt keine Seitenmarker) und lieferte deshalb durchweg 1.
   */
  page?: number | null;
  /** Überschrift des Fundorts. Das Modell nennt sie (es sieht die Überschriften im Text) und
   *  der Code prüft sie: sie grenzt die Suche nach dem Zitat ein und wird danach durch die
   *  tatsächlich getroffene Überschrift ersetzt. */
  section: string | null;
  is_correction: boolean;
}

export type ExtractionResult = Record<string, ExtractedField>;

/**
 * Feldtypen, bei denen `value` zusätzlich eine Zeichenkette aufnehmen darf — dort ist der
 * Typ eine Darstellungsgrenze. Textfelder brauchen es nicht (`value` ist dort schon
 * Freitext), Aufzählungsfelder sollen es nicht (siehe `ExtractedField.value`).
 */
export function erlaubtWortlaut(f: FieldDef): boolean {
  return f.type === "number" || f.type === "boolean";
}

/**
 * Steht in einem Zahl-/Ja-Nein-Feld ein Wortlaut statt eines typkonformen Werts?
 * Für die CSV und die Zusammenfassung — wer die Zahlen später weiterrechnet, muss
 * wissen, welche davon keine sind.
 */
export function istWortlaut(value: unknown, f: Pick<FieldDef, "type">): boolean {
  return typeof value === "string" && (f.type === "number" || f.type === "boolean");
}

/**
 * Beschreibungstext pro Feld. Er ist der eigentliche Hebel gegen Fehlzuordnungen: die
 * Excel-Zellkommentare tragen Domänenwissen, das im Feldnamen nicht steckt — "Anzahl Zugänge
 * KRA" heißt "Einlässe für Kugeln an der Kesseldecke", ohne diesen Satz rät das Modell.
 *
 * Die Beispiele aus Spalte G kommen mit, aber ausdrücklich als Beispiele markiert: sonst
 * setzt das Modell sie als Vorgabewerte ein, wenn es nichts findet — genau der Fehler, den
 * die Spec ausschließt.
 */
function describeField(f: FieldDef): string {
  const parts: string[] = [`${f.categoryLabel}${f.subgroup ? ` / ${f.subgroup}` : ""} — ${f.label}`];
  if (f.description) parts.push(f.description.replace(/\s+/g, " ").trim());
  if (f.unit) parts.push(`Einheit: ${f.unit} (Wert als Zahl ohne Einheit angeben).`);
  if (f.enumValues) parts.push(`Zulässige Werte: ${f.enumValues.join(" | ")}.`);
  if (f.examples && !f.enumValues) {
    parts.push(`Beispiel für die Art der Angabe (NICHT als Wert übernehmen): ${f.examples.replace(/\s+/g, " ").trim()}`);
  }
  if (f.prio) parts.push("Priorisiert: wird für die Kalkulation zwingend benötigt.");
  return parts.join(" ");
}

/**
 * Der Werttyp je Feld — **inklusive `null`**, bewusst nicht über ein nachgelagertes
 * `.nullable()`. Sonst entsteht bei den Unions ein verschachteltes `anyOf: [anyOf[…], null]`.
 * Das ist gültiges JSON Schema, aber die strict-Verarbeitung dieses Anbieters hat sich heute
 * schon einmal als nachsichtiger erwiesen als zugesagt; eine flache Liste gibt ihr weniger
 * Gelegenheit dazu.
 *
 * Die Zeichenketten-Variante bei Zahl und Ja/Nein ist der Ausweg für Bereiche und
 * Alternativen ("430–460 °C"). Sie steht an zweiter Stelle: Die Reihenfolge ist das einzige
 * Signal im Schema selbst, welche Form die Regel und welche die Ausnahme ist.
 */
function valueSchema(f: FieldDef) {
  switch (f.type) {
    case "number":
      return z.union([z.number(), z.string(), z.null()]);
    case "boolean":
      return z.union([z.boolean(), z.string(), z.null()]);
    case "enum":
      // enumValues ist bei type "enum" per Katalog-Assertion immer gesetzt.
      return z.enum(f.enumValues as [string, ...string[]]).nullable();
    default:
      return z.string().nullable();
  }
}

/**
 * Die Properties sind für alle 71 Felder identisch — bis auf `value_text`, das nur dort
 * existiert, wo der Werttyp eine Darstellungsgrenze ist. Ihre Bedeutung wird **einmal**
 * im System-Prompt erklärt (siehe PROPERTY_SEMANTICS), nicht 71× im Schema:
 *
 * Mit `.describe()` an jeder Property wuchs das Schema auf ~32.000 Prompt-Tokens, davon
 * rund 15.000 allein für 71 identische Wiederholungen derselben Erklärungen. Bei 9 Batches
 * wären das 135.000 Token für Text, den das Modell einmal lesen muss. Feldspezifisch bleibt
 * nur die Objekt-Beschreibung (describeField) — dort steckt das Domänenwissen aus den
 * Excel-Zellkommentaren, und das ist pro Feld tatsächlich verschieden.
 */
function fieldSchema(f: FieldDef) {
  return z
    .object({
      status: z.enum(STATUS_VALUES),
      value: valueSchema(f),
      unit: z.string().nullable(),
      unklar_grund: z.enum(UNKLAR_GRUENDE).nullable(),
      evidence: z.string().nullable(),
      section: z.string().nullable(),
      is_correction: z.boolean(),
    })
    .describe(describeField(f));
}

/**
 * Erklärung der sieben Properties — gehört in den System-Prompt, damit sie einmal statt
 * 71× übertragen wird.
 */
export const PROPERTY_SEMANTICS = `Jedes Feld ist ein Objekt mit genau diesen Schlüsseln:

- status: einer von vier Werten.

  "gefunden"
      Der Kunde nennt für dieses Feld eine Angabe. value trägt sie.

  "nicht_im_dokument"
      Zu diesem Feld steht in diesem Abschnitt nichts. Auch dann, wenn der Kunde sagt,
      dass er sich noch nicht geäußert hat ("dazu haben wir uns noch nicht festgelegt",
      "wird nachgereicht"). value = null.

  "ausdruecklich_keine_vorgabe"
      Der Kunde sagt ausdrücklich, dass er für dieses Feld keine Vorgabe macht:
      "zu Motoren und Getrieben bestehen keine gesonderten Vorgaben", "keine
      herstellerspezifischen Vorgaben". Das ist etwas anderes als "steht nichts dazu
      drin". value = null, der Wortlaut gehört in evidence — nie in value.
      Nicht für Felder mit Werteliste, deren Liste diesen Fall schon abbildet
      ("SZKS Standard", "Keine Ex-Zone") — dort ist der Listenwert die Antwort.

  "unklar"
      Es steht etwas dazu im Text, du kannst es aber nicht zweifelsfrei eintragen.
      value = null, Wortlaut in evidence, Grund in unklar_grund.

      NICHT "unklar", nur weil der Kunde sich ungenau ausdrückt. Eine unpräzise
      Formulierung ist trotzdem eine Angabe — sie gehört übertragen, nicht gemeldet:
        "möglichst noch dieses Jahr"            → gefunden, value: "möglichst noch dieses Jahr"
        "Hersteller steht noch nicht fest"      → gefunden, value: "Hersteller steht noch
                                                   nicht fest"
        "ca. 430–460 °C"  (Zahlenfeld)          → gefunden, value: "ca. 430–460 °C"
      "unklar" bleibt richtig, wenn DU die Angabe nicht zuordnen kannst — "insgesamt
      ungefähr 40 Meter hoch" gehört zu Kesselhöhe ODER Gesamthöhe, und das ist eine Frage
      an den Menschen, keine an dich. Ebenso, wenn kein zulässiger Wert passt. Nur die vage
      Sprache des Kunden allein ist kein Grund.

- value:  der extrahierte Wert im Typ des Feldes. Zahlen ohne Einheit und ohne
          Tausenderpunkte. Bei jedem status außer "gefunden": null.
          Bei Zahl- und Ja/Nein-Feldern darf hier AUSNAHMSWEISE eine Zeichenkette stehen —
          dann, wenn die Angabe in EINE Zahl nicht hineinpasst. Die Trennlinie:
            "5600 mm"                   → 5600
            "ca. 480 °C"                → 480              (Näherungswort, eine Zahl)
            "um die 500 Grad"           → 500              (dasselbe, umgangssprachlich)
            "430–460 °C"                → "430–460 °C"     (Bereich, zwei Zahlen)
            "400 V, alternativ 415 V"   → "400 V, alternativ 415 V"   (Alternativen)
            "hängt vom Preis ab"        → "hängt vom Preis ab"        (Ja/Nein-Feld)
          "ca.", "circa", "rund", "etwa", "um die" sind keine zweite Angabe, sondern eine
          Färbung — die Zahl gehört als Zahl ins Feld, die Färbung bewahrt evidence. Die
          Zeichenkette ist kein bequemerer Weg, sondern der Ausweg für das, was sich nicht
          als eine Zahl schreiben lässt. Bei Feldern mit Werteliste gibt es diesen Ausweg
          nicht: eine Angabe außerhalb der Liste bleibt "unklar" mit "kein_zulaessiger_wert".
- unit:   die Einheit genau so, wie sie im Dokument steht (mmWS, mmH₂O, Pa, mm, °C, Meter …).
          Nicht umrechnen — die Umrechnung passiert nachgelagert im Code. Sonst null.
- unklar_grund: nur bei status "unklar", sonst null.
          "zuordnung_mehrdeutig" = die Angabe könnte zu mehreren Feldern gehören
              ("insgesamt ungefähr 40 Meter hoch" — Kesselhöhe oder Gesamthöhe?)
          "kein_zulaessiger_wert" = die Angabe passt in keinen der zulässigen Werte
          "angabe_unpraezise" = die Aussage trägt auch im Wortlaut keine verwertbare
              Information ("die Anlage ist relativ groß"). NICHT für Bereiche, Näherungen
              oder Bedingungen — die sind Angaben und gehören in value bzw. value_text.
          "widerspruechliche_fundstellen" = derselbe Abschnitt nennt zwei verschiedene Werte
- evidence: wörtliches Zitat aus dem Text, nicht umformuliert. Ein Zitat gehört zu JEDEM
          status außer "nicht_im_dokument" — auch zu "ausdruecklich_keine_vorgabe" und
          "unklar".
          Zitiere den GANZEN Satz bzw. die ganze Tabellenzeile, nicht nur den Wert. Ein Zitat
          wie "Nein" oder "3.200" steht in einem langen Dokument dutzendfach; der Beleg wäre
          dann nicht wiederauffindbar. Richtwert: 40 Zeichen, und lieber die umgebende Zeile
          zu viel als zu wenig.
            falsch:  "6"
            richtig: "| Anzahl Zugänge KRA | 6 |"
          Betrifft ein Satz mehrere Felder, darfst du die fremden Teile mit " ... "
          auslassen — aber NUR sie. Die Aussage zu DIESEM Feld muss vollständig im Zitat
          stehen, samt Zahl, Einheit und Bedingung:
            Text:   "Außenaufstellung, daher Schutzart mindestens IP65 gefordert"
            falsch: "Außenaufstellung, daher Schutzart mindestens gefordert"   (IP65 fehlt)
            richtig: der ganze Satz
            Text:   "Zu Beschichtung, Kanten und den übrigen Farbvorgaben machen wir keine
                     gesonderten Angaben."
            richtig (Feld Kanten): "Zu Beschichtung, Kanten ... machen wir keine
                     gesonderten Angaben."
          Auslassungen dürfen nichts überspringen, was zwischen den Teilen die Bedeutung
          ändert, und die Teile müssen in der Reihenfolge des Textes stehen.
- section: die Überschrift, unter der du den Beleg gelesen hast — wörtlich, wie sie im Text
          steht. Sie ist die Ortsangabe: der Code findet damit die Fundstelle wieder und
          bestimmt daraus die Seite. Eine ungefähre oder erfundene Überschrift macht den
          Fundort unbrauchbar; im Zweifel die nächstgelegene echte Überschrift darüber.
- is_correction: true, wenn der Fundort ein Abschnitt ist, der frühere Angaben korrigiert
          (Bieterfrage, Nachtrag, Besprechungsprotokoll, Änderungsmitteilung, "abweichend
          von", "ersetzt"). Sonst false.`;

/** Das vollständige Extraktionsschema über alle 71 extrahierbaren Felder. */
export function buildExtractionSchema(fields: FieldDef[] = EXTRACTABLE_FIELDS) {
  const shape: Record<string, ReturnType<typeof fieldSchema>> = {};
  for (const f of fields) shape[f.id] = fieldSchema(f);
  return z.object(shape);
}

export const EXTRACTION_SCHEMA = buildExtractionSchema();

// ---------------------------------------------------------------------------
// Strict-Mode-Prüfung ohne API-Call
// ---------------------------------------------------------------------------

export interface SchemaStats {
  properties: number;
  maxDepth: number;
  nameChars: number;
  enumValues: number;
  violations: string[];
}

const OPENAI_LIMITS = {
  properties: 5000,
  depth: 10,
  nameChars: 120_000,
  enumValues: 1000,
} as const;

/**
 * Prüft ein JSON Schema gegen die OpenAI-strict-Regeln und -Limits. Läuft rein lokal —
 * ein Verstoß soll beim Build auffallen, nicht erst als API-Fehler im ersten Eval-Lauf.
 */
export function checkOpenAiStrict(schema: unknown): SchemaStats {
  const violations: string[] = [];
  let properties = 0;
  let maxDepth = 0;
  let nameChars = 0;
  let enumValues = 0;

  function walk(node: unknown, depth: number, path: string): void {
    if (!node || typeof node !== "object") return;
    maxDepth = Math.max(maxDepth, depth);
    const obj = node as Record<string, unknown>;

    if (Array.isArray(obj.enum)) {
      enumValues += obj.enum.length;
      for (const v of obj.enum) nameChars += String(v).length;
    }

    if (obj.type === "object" || obj.properties) {
      const props = (obj.properties ?? {}) as Record<string, unknown>;
      const keys = Object.keys(props);
      properties += keys.length;
      for (const k of keys) nameChars += k.length;

      if (obj.additionalProperties !== false) {
        violations.push(`${path || "#"}: additionalProperties muss false sein`);
      }
      const required = new Set((obj.required as string[] | undefined) ?? []);
      const missing = keys.filter((k) => !required.has(k));
      if (missing.length > 0) {
        violations.push(`${path || "#"}: nicht in required — ${missing.join(", ")}`);
      }
      for (const k of keys) walk(props[k], depth + 1, `${path}/${k}`);
    }

    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (Array.isArray(obj[key])) {
        (obj[key] as unknown[]).forEach((sub, i) => walk(sub, depth + 1, `${path}/${key}[${i}]`));
      }
    }
    if (obj.items) walk(obj.items, depth + 1, `${path}/items`);
    if (obj.$defs) {
      for (const [k, v] of Object.entries(obj.$defs as Record<string, unknown>)) walk(v, depth + 1, `${path}/$defs/${k}`);
    }
  }

  walk(schema, 0, "");

  if (properties > OPENAI_LIMITS.properties) violations.push(`${properties} Properties > Limit ${OPENAI_LIMITS.properties}`);
  if (maxDepth > OPENAI_LIMITS.depth) violations.push(`Nesting ${maxDepth} > Limit ${OPENAI_LIMITS.depth}`);
  if (nameChars > OPENAI_LIMITS.nameChars) violations.push(`${nameChars} Namenszeichen > Limit ${OPENAI_LIMITS.nameChars}`);
  if (enumValues > OPENAI_LIMITS.enumValues) violations.push(`${enumValues} Enum-Werte > Limit ${OPENAI_LIMITS.enumValues}`);

  return { properties, maxDepth, nameChars, enumValues, violations };
}
