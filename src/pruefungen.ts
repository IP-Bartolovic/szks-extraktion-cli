/**
 * Verbindungsprüfungen — beide kostenlos.
 *
 * Beide Prüfungen rufen `/models` auf, nicht den eigentlichen Chat- oder OCR-Endpunkt: Sie
 * sollen zeigen, ob Basis-URL und Schlüssel überhaupt zusammenpassen, bevor Ben Zeit in
 * einen echten Lauf steckt — nicht, ob das Werkzeug funktioniert. Ein LLM- oder OCR-Aufruf
 * würde dasselbe zeigen, aber Geld kosten und einen Kunden-PDF-Umweg brauchen, den es beim
 * bloßen Einrichten noch nicht gibt.
 *
 * Jede Meldung nennt bewusst die Abhilfe statt nur den HTTP-Code — der Code allein sagt
 * niemandem ohne API-Erfahrung, ob die URL oder der Schlüssel falsch ist.
 */

import type { AufgelosteKonfiguration } from "./config.js";

export interface PruefErgebnis {
  ok: boolean;
  titel: string;
  meldung: string;
}

const ZEITLIMIT_MS = 10_000;

/** Ist der Fehler ein Timeout unseres eigenen `AbortSignal.timeout`? */
function istZeitueberschreitung(fehler: unknown): boolean {
  return fehler instanceof Error && fehler.name === "TimeoutError";
}

function netzfehlerMeldung(fehler: unknown, ziel: string): string {
  if (istZeitueberschreitung(fehler)) {
    return `${ziel} antwortet nicht innerhalb von ${ZEITLIMIT_MS / 1000} Sekunden. Netzverbindung und Basis-URL prüfen.`;
  }
  return `${ziel} ist nicht erreichbar. Netzverbindung und Basis-URL prüfen.`;
}

/**
 * OpenRouter validiert den Schlüssel auf `/models` nachweislich **nicht** — der Endpunkt
 * antwortet dort mit HTTP 200, egal ob der `Authorization`-Header fehlt, falsch oder gültig
 * ist (mit `curl` gegengeprüft). Für jeden anderen Anbieter reicht `/models` als Prüfung;
 * für OpenRouter selbst — den Vorgabe-Anbieter (`VORGABE.baseUrl`) — würde ein falscher
 * Schlüssel sonst als „alles gut" durchgehen. `/key` liefert dort echte Kontoinformationen
 * und lehnt einen falschen Schlüssel mit 401 ab; dasselbe Sonderwissen steckt bereits in
 * `modell.ts` (`OPENROUTER_ROUTING`).
 */
function istOpenRouter(basis: string): boolean {
  return basis.includes("openrouter.ai");
}

async function pruefeOpenRouterSchluessel(basis: string, apiKey: string): Promise<PruefErgebnis | null> {
  const titel = "Anbieter (Chat-Modell)";
  let antwort: Response;
  try {
    antwort = await fetch(`${basis}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
    });
  } catch {
    // Diese Zusatzprüfung darf nicht strenger sein als der eigentliche Erreichbarkeitstest:
    // ein Netzwackler hier blockiert nicht das Ergebnis von /models.
    return null;
  }
  if (antwort.status === 401 || antwort.status === 403) {
    return {
      ok: false,
      titel,
      meldung: `OpenRouter lehnt den Schlüssel ab (HTTP ${antwort.status} auf ${basis}/key). Schlüssel im Einrichtungsdialog prüfen und neu eintragen.`,
    };
  }
  return null;
}

/**
 * `GET {baseUrl}/models` mit dem hinterlegten Schlüssel.
 *
 * Unterscheidet fünf Fälle, weil ein pauschales „Verbindung fehlgeschlagen" bei genau den
 * drei häufigsten Fehlern (falscher Schlüssel, falsche Basis-URL, kein Netz) nichts über die
 * Abhilfe verrät.
 */
export async function pruefeAnbieter(cfg: AufgelosteKonfiguration): Promise<PruefErgebnis> {
  const titel = "Anbieter (Chat-Modell)";

  if (!cfg.apiKey) {
    return {
      ok: false,
      titel,
      meldung:
        `Kein Schlüssel hinterlegt (erwartet in der Umgebungsvariable ${cfg.apiKeyName}). ` +
        `Im Einrichtungsdialog eintragen oder die Umgebungsvariable setzen.`,
    };
  }

  const basis = cfg.baseUrl.replace(/\/+$/, "");
  let antwort: Response;
  try {
    antwort = await fetch(`${basis}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
    });
  } catch (fehler) {
    return { ok: false, titel, meldung: netzfehlerMeldung(fehler, basis) };
  }

  if (antwort.status === 401 || antwort.status === 403) {
    return {
      ok: false,
      titel,
      meldung: `${basis} lehnt den Schlüssel ab (HTTP ${antwort.status}). Schlüssel im Einrichtungsdialog prüfen und neu eintragen.`,
    };
  }
  if (antwort.status === 404) {
    return {
      ok: false,
      titel,
      meldung: `${basis} kennt /models nicht (HTTP 404) — das ist keine OpenAI-kompatible Basis-URL. Sie im Einrichtungsdialog korrigieren (z. B. https://openrouter.ai/api/v1).`,
    };
  }
  if (!antwort.ok) {
    return {
      ok: false,
      titel,
      meldung: `${basis} antwortet mit HTTP ${antwort.status}. Basis-URL und Schlüssel im Einrichtungsdialog prüfen.`,
    };
  }

  if (istOpenRouter(basis)) {
    const schluesselErgebnis = await pruefeOpenRouterSchluessel(basis, cfg.apiKey);
    if (schluesselErgebnis) return schluesselErgebnis;
  }

  return { ok: true, titel, meldung: `Erreichbar unter ${basis}.` };
}

/**
 * `GET https://api.mistral.ai/v1/models` mit dem Mistral-Schlüssel.
 *
 * Ein leerer Schlüssel ist hier **kein** Fehlschlag — er ist eine bewusste Betriebsart ohne
 * OCR für gescannte Seiten. Die Meldung nennt den gemessenen Preis dieser Betriebsart
 * (13 % Tokenverlust, in einem Testdokument ein Prio-Wert komplett verschluckt), statt nur
 * „fehlt" zu sagen — das eine ist eine Zahl zum Abwägen, das andere klingt nach einem Fehler,
 * den man beheben muss.
 */
export async function pruefeMistral(cfg: AufgelosteKonfiguration): Promise<PruefErgebnis> {
  const titel = "Mistral OCR (gescannte Seiten)";
  const basis = "https://api.mistral.ai/v1";

  if (!cfg.mistralApiKey) {
    return {
      ok: true,
      titel,
      meldung:
        "Kein Mistral-Schlüssel hinterlegt. Gescannte Seiten ohne Text-Layer werden dann von " +
        "Doclings eigenem OCR gelesen — das verliert gemessen rund 13 % der Token und hat in " +
        "einem Testdokument einen Prio-Wert vollständig verschluckt. Für verlässliche " +
        "Ergebnisse bei gescannten Anfragen im Einrichtungsdialog einen Mistral-Schlüssel " +
        "eintragen.",
    };
  }

  let antwort: Response;
  try {
    antwort = await fetch(`${basis}/models`, {
      headers: { Authorization: `Bearer ${cfg.mistralApiKey}` },
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
    });
  } catch (fehler) {
    return { ok: false, titel, meldung: netzfehlerMeldung(fehler, basis) };
  }

  if (antwort.status === 401 || antwort.status === 403) {
    return {
      ok: false,
      titel,
      meldung: `Mistral lehnt den Schlüssel ab (HTTP ${antwort.status}). Schlüssel im Einrichtungsdialog prüfen und neu eintragen.`,
    };
  }
  if (!antwort.ok) {
    return {
      ok: false,
      titel,
      meldung: `Mistral antwortet mit HTTP ${antwort.status}. Später erneut versuchen.`,
    };
  }
  return { ok: true, titel, meldung: "Mistral-Schlüssel gültig — OCR für gescannte Seiten verfügbar." };
}
