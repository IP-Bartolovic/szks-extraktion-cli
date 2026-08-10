/**
 * ERZEUGT von `scripts/sync-cli.ts` im Pipeline-Repo — nicht bearbeiten.
 *
 * Im Pipeline-Repo lädt `src/model.ts` Prompt und Provider aus der Registry und baut das
 * Modell über `@ip-bartolovic/langchain-kit`. Beides gibt es im CLI nicht: die Prompts
 * sind hartkodiert, das Modell entsteht direkt aus der Konfiguration. Diese Datei leitet
 * deshalb nur weiter — damit `nodes/extract.ts` und `nodes/merge.ts` unverändert
 * `../model.js` importieren können und byte-gleich zum Original bleiben.
 */
export { resolvePrompt, renderTemplate, type ResolvedPrompt } from "../src/modell.js";
