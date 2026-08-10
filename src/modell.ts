/**
 * Modellzugriff — direkt, ohne Registry und ohne Paket-Zwischenschicht.
 *
 * Im Pipeline-Repo lädt `src/model.ts` Prompt und Providerdaten aus der Registry
 * (`agents.prompts` via Supabase) und baut das Modell über
 * `@ip-bartolovic/langchain-kit`. Beides entfällt hier:
 *
 * - **Die Prompts sind hartkodiert.** Sie stehen in `vendor/prompts.ts` und werden von den
 *   Aufrufern ohnehin als Fallback mitgegeben. Im Pipeline-Repo sind sie faktisch längst
 *   der real gesendete Text — die Supabase-Zugangsdaten sind dort leer, der Registry-Zweig
 *   ist toter Code. Es geht also nichts verloren.
 * - **`createModel` reduziert sich auf dem genommenen Pfad auf einen `ChatOpenAI`.** Die
 *   Zwischenschicht zöge `@azure/identity`, `@langchain/anthropic`, `pg` und
 *   `@supabase/supabase-js` mit und käme aus einer privaten Paketregistry, für die Ben
 *   einen Token bräuchte.
 *
 * ## Die Modell-ID ist Absicht hartkodiert
 *
 * Konfigurierbar sind Endpunkt und Schlüssel — jeder OpenAI-kompatible Anbieter lässt sich
 * ansprechen. Das Modell selbst nicht: Ben soll die evaluierte Extraktion testen, und eine
 * verstellte Modell-ID erzeugte Befunde, die auf die Pipeline nicht zutreffen.
 */

import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { aufgeloest, laden } from "./config.js";

/**
 * Dasselbe Modell wie im Pipeline-Repo (`.env: SZKS_EXTRAKTION_MODEL`), hier fest im Code.
 *
 * **Der Name hängt am Endpunkt.** Die OpenAI-API kennt es als `gpt-5.6-luna`, OpenRouter
 * verlangt den Anbieter als Präfix (`openai/gpt-5.6-luna`) — es ist dasselbe Modell, nur
 * anders adressiert. Deshalb steht hier der nackte Name und das Präfix kommt erst beim
 * Bauen dazu; zwei Konstanten nebeneinander wären zwei Stellen, die beim nächsten
 * Modellwechsel auseinanderlaufen.
 */
export const MODELL_ID = "gpt-5.6-luna";

/** OpenRouter adressiert Modelle als `<anbieter>/<modell>`. */
const OPENROUTER_PRAEFIX = "openai/";

/**
 * Erzwingt OpenAI als Upstream statt eines beliebigen OpenRouter-Anbieters.
 *
 * **Nur bei OpenRouter.** Das Feld reist im Anfragekörper mit; ein anderer
 * OpenAI-kompatibler Endpunkt kennt es nicht und lehnt die Anfrage ab. Es an alle zu
 * schicken hieße, die Zusage „jeder OpenAI-kompatible Anbieter" durch ein einzelnes Feld
 * zu widerrufen.
 */
const OPENROUTER_ROUTING = { provider: { only: ["openai"], allow_fallbacks: false } } as const;

export interface ResolvedPrompt {
  system: string;
  user: string;
  model: BaseChatModel;
  /** Bleibt `false` — es gibt hier keine Registry. Das Feld existiert nur für den Vertrag. */
  fromRegistry: boolean;
}

/**
 * Das Modell wird einmal gebaut und wiederverwendet. Bei neun Batches neunmal denselben
 * Client zu erzeugen wäre unnötig; wichtiger ist, dass alle Batches nachweislich dasselbe
 * Modell mit denselben Parametern benutzen.
 */
let zwischengespeichert: BaseChatModel | null = null;

export function modell(): BaseChatModel {
  if (zwischengespeichert) return zwischengespeichert;

  const cfg = aufgeloest(laden());
  if (!cfg.apiKey) {
    throw new Error(
      `Kein API Key hinterlegt.\n` +
        `  Entweder im Menü unter "Einstellungen" eintragen,\n` +
        `  oder die Umgebungsvariable ${cfg.apiKeyName} setzen.`,
    );
  }

  const beiOpenRouter = cfg.baseUrl.includes("openrouter.ai");

  zwischengespeichert = new ChatOpenAI({
    model: beiOpenRouter ? OPENROUTER_PRAEFIX + MODELL_ID : MODELL_ID,
    temperature: 0,
    apiKey: cfg.apiKey,
    configuration: { baseURL: cfg.baseUrl },
    // Chat Completions spricht jeder OpenAI-kompatible Anbieter, die Responses-API nicht.
    // LangChain würde für IDs, die auf `gpt-`/`o1` passen, sonst selbsttätig umschalten.
    useResponsesApi: false,
    ...(beiOpenRouter ? { modelKwargs: { ...OPENROUTER_ROUTING } } : {}),
  }) as unknown as BaseChatModel;

  return zwischengespeichert;
}

/** Nach einer Änderung der Einstellungen muss das Modell neu gebaut werden. */
export function modellZuruecksetzen(): void {
  zwischengespeichert = null;
}

/**
 * Vertragsgleicher Ersatz für `resolvePrompt` aus dem Pipeline-Repo. Die Aufrufer
 * (`vendor/nodes/extract.ts`, `vendor/nodes/merge.ts`) bleiben dadurch unverändert; der
 * `applicationSlug` wird nicht gebraucht, weil es keine Registry gibt, nach der man fragen
 * könnte.
 */
export async function resolvePrompt(opts: {
  applicationSlug: string;
  fallback: string;
  userFallback: string;
}): Promise<ResolvedPrompt> {
  return { system: opts.fallback, user: opts.userFallback, model: modell(), fromRegistry: false };
}

/** Ersetzt `{name}`-Platzhalter im User-Template. Unverändert aus dem Pipeline-Repo. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}
