/**
 * Nachbearbeitung eines von Zod erzeugten JSON Schemas für OpenAI strict mode.
 *
 * Zod erzeugt gültiges JSON Schema, aber nicht das, was OpenAI im strict mode verlangt:
 *
 *   1. `additionalProperties: false` fehlt — OpenAI lehnt das Schema sonst ab.
 *   2. `required` enthält nur die nicht-optionalen Keys. Im strict mode müssen **alle**
 *      Properties in `required` stehen; Optionalität wird ausschließlich über Nullable-
 *      Unions ausgedrückt. Unser Schema nutzt deshalb durchgängig `.nullable()` statt
 *      `.optional()`, aber die required-Liste muss trotzdem vervollständigt werden.
 *   3. Validierungs-Keywords, die OpenAI im strict mode nicht unterstützt (`minLength`,
 *      `format`, `pattern` auf manchen Typen …), werden entfernt statt den Call scheitern
 *      zu lassen. Wir nutzen sie ohnehin nicht — die Prüfung passiert in den Gradern.
 *
 * Die Funktion arbeitet auf einer tiefen Kopie; das Eingabeschema bleibt unverändert.
 */

type JsonSchema = Record<string, unknown>;

/** Im strict mode nicht unterstützte Keywords. */
const UNSUPPORTED_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
] as const;

export function toStrictJsonSchema<T>(schema: T): T {
  const clone = JSON.parse(JSON.stringify(schema)) as unknown;
  walk(clone);
  return clone as T;
}

function walk(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (!node || typeof node !== "object") return;

  const obj = node as JsonSchema;

  for (const kw of UNSUPPORTED_KEYWORDS) delete obj[kw];

  if (obj.properties && typeof obj.properties === "object") {
    const props = obj.properties as Record<string, unknown>;
    obj.additionalProperties = false;
    // Alle Properties in required — im strict mode Pflicht. Optionalität steckt
    // ausschließlich in den Nullable-Unions der Werte.
    obj.required = Object.keys(props);
    for (const value of Object.values(props)) walk(value);
  }

  for (const key of ["anyOf", "oneOf", "allOf", "items", "$defs", "definitions"] as const) {
    if (obj[key]) walk(obj[key]);
  }
}
