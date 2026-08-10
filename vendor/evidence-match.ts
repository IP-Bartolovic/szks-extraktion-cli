/**
 * Ein Zitat im Quelltext wiederfinden — geteilt von Pipeline und Evaluation.
 *
 * Die Logik stand bis zum 2026-08-09 nur in `eval/graders.ts`. Sie wird jetzt auch in der
 * Pipeline gebraucht (`ground-evidence.ts` bestimmt daraus die Seitenzahl), und **zwei Kopien
 * derselben Normalisierung wären genau die Sorte Fehler, die dieses Projekt schon mehrfach
 * teuer bezahlt hat**: Der Grader würde einen Beleg als gefunden werten, den die Pipeline
 * nicht lokalisieren kann — oder umgekehrt. Deshalb eine Quelle, beide Seiten importieren sie.
 */

/**
 * Whitespace und Anführungszeichen vereinheitlichen.
 *
 * Docling erzeugt aus PDF-Blocksatz doppelte Leerzeichen, und hochgestellte Zeichen zerfallen
 * mit Lücke: aus "6 g/Nm³." wird "6 g/Nm 3 .". Das Modell zitiert die natürliche Schreibweise.
 * Entfernt wird ausschließlich Whitespace — nie ein Zeichen, damit keine Erfindung durchrutscht.
 */
export function normalizeQuoteText(s: string): string {
  return s
    .replace(/[„"‟”]/g, '"')
    .replace(/['']/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .trim();
}

/**
 * Ein Zitat in seine Teile zerlegen — an Auslassungen (`...`, `…`, `[...]`).
 *
 * Ein Satz betrifft oft mehrere Felder gleichzeitig ("Zu Beschichtung, Kanten und den übrigen
 * Farbvorgaben machen wir keine gesonderten Angaben" belegt sechs). Das Modell zitiert den
 * Satz und kürzt die fremden Teile heraus; der Beleg bleibt wahr, nur die wörtliche Suche
 * scheitert.
 */
export function quoteParts(quote: string): string[] {
  // Die geklammerten Formen zuerst, sonst bleiben die eckigen Klammern als Textreste stehen.
  return normalizeQuoteText(quote)
    .split(/\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Position des Zitats im **bereits normalisierten** Quelltext, oder `-1`.
 *
 * Die Teile müssen in der Reihenfolge des Textes stehen. Ohne diese Bedingung könnte "A … B"
 * zwei Fetzen aus verschiedenen Kapiteln zusammenkleben und einen Zusammenhang behaupten, den
 * das Dokument nicht hergibt. Zurückgegeben wird der Beginn des ERSTEN Teils — das ist die
 * Fundstelle, die ein Mensch aufschlagen würde.
 */
export function findQuoteOffset(normalizedSource: string, quote: string): number {
  const parts = quoteParts(quote);
  if (parts.length === 0) return -1;

  const start = normalizedSource.indexOf(parts[0]!);
  if (start === -1) return -1;

  let from = start + parts[0]!.length;
  for (const part of parts.slice(1)) {
    const at = normalizedSource.indexOf(part, from);
    if (at === -1) return -1;
    from = at + part.length;
  }
  return start;
}

/** Kommt das Zitat (mit erlaubten Auslassungen) im normalisierten Quelltext vor? */
export function quoteFoundInSource(normalizedSource: string, quote: string): boolean {
  return findQuoteOffset(normalizedSource, quote) !== -1;
}
