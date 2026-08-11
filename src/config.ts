/**
 * Einstellungen: laden, speichern, auflösen.
 *
 * ## Was hier konfigurierbar ist — und was nicht
 *
 * Konfigurierbar ist alles, was von der **Umgebung** abhängt: welcher Anbieter, welcher
 * Schlüssel, wohin die Ergebnisse. Nicht konfigurierbar ist alles, was das **Ergebnis**
 * bestimmt: Modell, Prompts, Chunk-Größe, Schema. Ben soll die Extraktion testen, nicht
 * unbemerkt eine andere Extraktion testen — eine versehentlich verstellte Modell-ID würde
 * Befunde erzeugen, die auf die Pipeline nicht zutreffen.
 *
 * ## Vorrang
 *
 * Gesetzte Umgebungsvariable → Konfigurationsdatei → Vorgabewert. Die Umgebung gewinnt,
 * damit ein Testlauf mit abweichendem Schlüssel möglich ist, ohne die gespeicherte
 * Einstellung anzufassen.
 *
 * ## Die Schlüssel liegen im Klartext
 *
 * `config.json` ist unverschlüsselt, auf POSIX mit `chmod 600`. Ein Schlüsselbund
 * (`keytar`) wäre sicherer, ist aber ein natives Modul und bräuchte auf Windows eine
 * Compiler-Toolchain — das widerspricht der Zusage „ein `npm install`". Der
 * Einrichtungsdialog sagt es, und die README sagt es auch. Unter Windows greift `chmod`
 * nicht; dort schützt allein, dass die Datei im Benutzerprofil liegt.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cacheVerzeichnis, ergebnisVerzeichnisDefault, konfigDatei } from "./pfade.js";
// Nur der Typ. `import type` wird beim Übersetzen restlos entfernt und lädt zur Laufzeit
// nichts — die Regel „umgebungSetzen vor dem ersten Vendor-Import" bleibt damit unberührt.
import type { ParserQuelle } from "../vendor/pdf-markdown.js";

/** Höchstzahl gemerkter Dokumente in der Schnellauswahl. */
const ZULETZT_MAX = 5;

export interface Konfiguration {
  /** Basis-URL eines OpenAI-kompatiblen Endpunkts. */
  baseUrl: string;
  /** Name der Umgebungsvariablen, unter der der Schlüssel liegt. */
  apiKeyName: string;
  /** Der Schlüssel selbst. Leer = aus der Umgebung unter `apiKeyName` lesen. */
  apiKey: string;
  /** Schlüssel für Mistral OCR (Seiten ohne Text-Layer). Leer = kein OCR. */
  mistralApiKey: string;
  /**
   * Womit das PDF gelesen wird.
   *
   * `"docling"` ist der Normalfall und der **evaluierte** Weg: nativer Text-Layer, Tabellen
   * und Überschriften, kostenlos, lokal. `"mistral-ocr"` liest das ganze Dokument per
   * Vision-OCR und braucht keine Docling-Installation — der Ausweg für einen Rechner, auf
   * dem sich die 1,7 GB Python nicht einrichten lassen.
   *
   * Umgeschaltet wird **ausdrücklich** in den Einstellungen, nie selbsttätig: Ein Werkzeug,
   * das je nach Tagesform der Docling-Installation mit dem einen oder dem anderen Leser
   * misst, liefert Befunde, die niemand mehr zuordnen kann.
   */
  parser: ParserQuelle;
  /** Zielverzeichnis der CSV-Ausgabe. */
  ergebnisVerzeichnis: string;
  /** Zuletzt ausgewertete PDFs, neueste zuerst — nur für die Schnellauswahl. */
  zuletzt: string[];
}

export const VORGABE: Konfiguration = {
  // Die OpenAI-API direkt. Die Pipeline routet über OpenRouter, weil dort mehrere Modelle
  // nebeneinander erprobt werden; für ein Werkzeug mit **einem** festen Modell ist der
  // Umweg nur eine zusätzliche Stelle, an der etwas ausfallen kann. OpenRouter bleibt
  // einstellbar — die Basis-URL entscheidet, und `modell.ts` passt Modellnamen und
  // Provider-Routing daran an.
  baseUrl: "https://api.openai.com/v1",
  apiKeyName: "OPENAI_API_KEY",
  apiKey: "",
  mistralApiKey: "",
  parser: "docling",
  ergebnisVerzeichnis: "",
  zuletzt: [],
};

export function laden(): Konfiguration {
  const datei = konfigDatei();
  if (!existsSync(datei)) return { ...VORGABE };
  try {
    const roh = JSON.parse(readFileSync(datei, "utf8")) as Partial<Konfiguration>;
    return { ...VORGABE, ...roh, zuletzt: Array.isArray(roh.zuletzt) ? roh.zuletzt : [] };
  } catch {
    // Eine kaputte Datei darf das Werkzeug nicht blockieren — der Einrichtungsdialog
    // schreibt sie ohnehin neu. Stillschweigend zurückfallen wäre falsch, deshalb die
    // Meldung.
    console.warn(`Einstellungen unlesbar, Vorgaben werden genutzt: ${datei}`);
    return { ...VORGABE };
  }
}

export function speichern(cfg: Konfiguration): void {
  const datei = konfigDatei();
  mkdirSync(path.dirname(datei), { recursive: true });
  writeFileSync(datei, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  if (process.platform !== "win32") {
    try {
      chmodSync(datei, 0o600);
    } catch {
      // Ein Dateisystem ohne POSIX-Rechte (Netzlaufwerk, exFAT) ist kein Grund
      // abzubrechen — die Datei ist geschrieben, nur eben nicht enger gestellt.
    }
  }
}

/** Ein Dokument oben in die Zuletzt-Liste ziehen, ohne Dubletten. */
export function merkeDokument(cfg: Konfiguration, pdf: string): Konfiguration {
  const abs = path.resolve(pdf);
  return { ...cfg, zuletzt: [abs, ...cfg.zuletzt.filter((p) => p !== abs)].slice(0, ZULETZT_MAX) };
}

export interface AufgelosteKonfiguration {
  baseUrl: string;
  apiKeyName: string;
  apiKey: string;
  mistralApiKey: string;
  parser: ParserQuelle;
  ergebnisVerzeichnis: string;
}

/** Umgebung schlägt Datei, Datei schlägt Vorgabe. */
export function aufgeloest(cfg: Konfiguration): AufgelosteKonfiguration {
  const apiKeyName = process.env.API_KEY_NAME || cfg.apiKeyName || VORGABE.apiKeyName;
  return {
    baseUrl: process.env.OPENAI_BASE_URL || cfg.baseUrl || VORGABE.baseUrl,
    apiKeyName,
    apiKey: process.env[apiKeyName] || cfg.apiKey || "",
    mistralApiKey: process.env.MISTRAL_API_KEY || cfg.mistralApiKey || "",
    // Ein unbekannter Wert in der Datei fällt auf Docling zurück — anders als bei
    // `SZKS_PARSER`, wo ein Tippfehler abgelehnt wird. Der Unterschied ist beabsichtigt:
    // Die Umgebungsvariable tippt ein Mensch für diesen einen Lauf, die Datei schreibt das
    // Werkzeug selbst. Steht dort Unsinn, ist sie beschädigt, und dann ist der evaluierte
    // Weg die richtige Annahme — nicht ein Abbruch, der das Werkzeug unbenutzbar macht.
    parser: cfg.parser === "mistral-ocr" ? "mistral-ocr" : "docling",
    ergebnisVerzeichnis: cfg.ergebnisVerzeichnis || ergebnisVerzeichnisDefault(),
  };
}

/**
 * Setzt die Umgebungsvariablen, die der **kopierte** Laufzeitpfad direkt liest.
 *
 * `vendor/ocr-mistral.ts` und `vendor/pdf-markdown.ts` greifen auf `process.env` zu — sie
 * sind byte-gleiche Kopien und dürfen dafür nicht umgeschrieben werden. Die Konfiguration
 * wird deshalb hier in die Umgebung übersetzt, an genau einer Stelle, vor dem ersten
 * Parse.
 *
 * `LANGSMITH_TRACING=false` ist kein Detail: Das CLI importiert `langsmith` nirgends, aber
 * `@langchain/core` bringt es transitiv mit und schaltet Tracing allein anhand dieser
 * Variablen ein. Eine geerbte Shell-Variable würde also Kundendokumente an LangSmith
 * schicken, ohne dass es jemand bemerkt.
 *
 * **`DOCLING_CACHE_DIR` hat zwei Leser, nicht einen.** Neben `vendor/pdf-markdown.ts`
 * liest **Docling selbst** die Variable (pydantic-settings mit `env_prefix="DOCLING_"` auf
 * `AppSettings.cache_dir`). Deshalb setzt auch die Einrichtung in `docling.ts` denselben
 * Wert: Vorwärmen der Modelle und späterer Betrieb müssen auf dasselbe Verzeichnis zeigen,
 * sonst lädt der erste echte Lauf die Modelle ein zweites Mal — mitten in Bens erster
 * Extraktion. Wer diese Zeile für überflüssig hält und entfernt, bricht das Vorwärmen
 * still.
 */
export function umgebungSetzen(cfg: Konfiguration, doclingBin: string | null): void {
  const a = aufgeloest(cfg);
  process.env.LANGSMITH_TRACING = "false";
  // Unterdrückt die reinen Hinweiszeilen des Parsers (etwa den OCR-Kostenbeleg). Warnungen
  // über Auffälligkeiten laufen bewusst nicht darüber und bleiben sichtbar.
  process.env.SZKS_QUIET = "1";
  process.env.DOCLING_CACHE_DIR = cacheVerzeichnis();
  if (doclingBin) process.env.DOCLING_BIN = doclingBin;
  if (a.mistralApiKey) process.env.MISTRAL_API_KEY = a.mistralApiKey;
  else delete process.env.MISTRAL_API_KEY;
  // Gesetzt statt weggelassen, auch für den Normalfall: Eine geerbte Shell-Variable
  // `SZKS_PARSER=mistral-ocr` würde sonst die Einstellung überstimmen, und niemand käme
  // darauf, in der Umgebung nach der Ursache zu suchen.
  process.env.SZKS_PARSER = a.parser;
}
