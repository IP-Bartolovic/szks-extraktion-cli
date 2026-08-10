/**
 * Ersteinrichtung und Einstellungen — derselbe Dialog, zweimal aufgerufen.
 *
 * `einrichtungsDialog` (automatisch beim ersten Start) und `einstellungenDialog` (Menüpunkt
 * „Einstellungen", Slash-Befehl `/config`) fragen dieselben fünf Werte in derselben
 * Reihenfolge ab — der einzige Unterschied ist die Überschrift. Zwei fast identische
 * Kopien zu pflegen wäre die Quelle des nächsten Bugs, sobald sich an einer Stelle etwas
 * ändert und die andere vergessen wird.
 */

import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import { aufgeloest, laden, speichern, VORGABE, type Konfiguration } from "./config.js";
import { doclingEinrichten, doclingVerfuegbar } from "./docling.js";
import { modellZuruecksetzen } from "./modell.js";
import { ergebnisVerzeichnisDefault, konfigDatei } from "./pfade.js";
import { pruefeAnbieter, pruefeMistral, type PruefErgebnis } from "./pruefungen.js";

/** Entscheidet, ob der Ersteinrichtungsdialog läuft. Der Mistral-Schlüssel zählt nicht mit — er ist optional. */
export function istEingerichtet(): boolean {
  return aufgeloest(laden()).apiKey !== "";
}

function istInteraktiv(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function keinTtyMeldung(): void {
  console.error(
    "Kein interaktives Terminal erkannt — der Einrichtungsdialog braucht Tastatureingaben " +
      "und würde hier nur hängen.\n" +
      `Datei stattdessen von Hand anlegen oder in einem echten Terminal starten: ${konfigDatei()}`,
  );
}

/** `@inquirer/prompts` wirft das bei Strg+C. Kein Stacktrace, sauber zurück ins Menü. */
function istAbbruch(fehler: unknown): boolean {
  return fehler instanceof Error && fehler.name === "ExitPromptError";
}

function fehlertext(fehler: unknown): string {
  return fehler instanceof Error ? fehler.message : String(fehler);
}

function meldungAusgeben(ergebnis: PruefErgebnis): void {
  console.log(`[${ergebnis.ok ? "OK" : "FEHLER"}] ${ergebnis.titel}: ${ergebnis.meldung}`);
}

function normalisiereBasisUrl(wert: string): string | null {
  // Abschließenden Schrägstrich entfernen — sonst baut pruefeAnbieter/modell() `.../v1//models`.
  const bereinigt = wert.trim().replace(/\/+$/, "");
  try {
    const url = new URL(bereinigt);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return bereinigt;
  } catch {
    return null;
  }
}

async function frageBasisUrl(vorgabe: string): Promise<string> {
  const antwort = await input({
    message: "Basis-URL des Anbieters (OpenAI-kompatibel):",
    default: vorgabe,
    validate: (wert) => normalisiereBasisUrl(wert) !== null || "Muss eine http(s)-URL sein, z. B. https://openrouter.ai/api/v1",
  });
  // Validate garantiert bereits, dass dies nicht null ist.
  return normalisiereBasisUrl(antwort) as string;
}

async function frageSchluesselName(vorgabe: string): Promise<string> {
  return input({
    message: "Name der Umgebungsvariable für den Schlüssel:",
    default: vorgabe,
    validate: (wert) => wert.trim() !== "" || "Darf nicht leer sein.",
  });
}

/**
 * Maskierte Eingabe eines Schlüssels. Enter behält den bestehenden Wert (falls einer da
 * ist) oder überspringt (falls das erlaubt ist) — ein Passwortfeld kann anders als `input`
 * keinen sichtbaren Vorgabewert anzeigen, ohne den Schlüssel im Klartext auf den Schirm zu
 * schreiben.
 */
async function frageSchluessel(
  label: string,
  bestehend: string,
  pflicht: boolean,
  hinweisWennLeer = " (Enter überspringt)",
): Promise<string> {
  const hinweis = bestehend ? " (Enter behält den hinterlegten Schlüssel)" : pflicht ? "" : hinweisWennLeer;
  const eingabe = await password({
    message: `${label}${hinweis}:`,
    mask: "*",
    validate: (wert) => {
      if (wert.trim() !== "") return true;
      if (bestehend || !pflicht) return true;
      return "Ein Schlüssel wird benötigt.";
    },
  });
  return eingabe.trim() === "" ? bestehend : eingabe.trim();
}

function bereinigePfad(roh: string): string {
  // Drag-and-drop aus dem Explorer/Finder liefert den Pfad in Anführungszeichen.
  return roh.trim().replace(/^["']|["']$/g, "");
}

async function frageErgebnisVerzeichnis(vorgabe: string): Promise<string> {
  const antwort = await input({
    message: "Ergebnisverzeichnis (CSV-Ausgabe):",
    default: vorgabe,
    validate: (wert) => {
      const absolut = path.resolve(bereinigePfad(wert));
      try {
        // Anlegen und Schreibbarkeit sofort prüfen — nicht erst nach einem langen Lauf
        // feststellen, dass am Ziel nichts geschrieben werden kann.
        mkdirSync(absolut, { recursive: true });
        accessSync(absolut, constants.W_OK);
        return true;
      } catch (fehler) {
        return `Nicht beschreibbar: ${absolut} (${fehlertext(fehler)})`;
      }
    },
  });
  return path.resolve(bereinigePfad(antwort));
}

/**
 * Docling und Mistral sind **nicht** dasselbe und dürfen im Text nicht verwechselt werden:
 * Docling liest **jedes** PDF und erzeugt daraus strukturiertes Markdown (Überschriften,
 * Tabellen). Mistral OCR liest nur die Seiten **ohne** Text-Layer. Ohne Docling geht gar
 * nichts; ohne Mistral geht alles außer gescannten Seiten.
 */
async function doclingStatusUndEinrichtung(): Promise<void> {
  const verfuegbar = await doclingVerfuegbar();
  if (verfuegbar) {
    console.log("Docling: eingerichtet — PDFs können gelesen werden.");
    return;
  }
  console.log("Docling: nicht eingerichtet. Ohne Docling lässt sich kein PDF lesen.");
  const einrichten = await confirm({
    message:
      "Jetzt einrichten? Lädt rund 1,7 GB (Python-Laufzeit + Modelle), dauert etwa vier Minuten.",
    default: false,
  });
  if (!einrichten) return;
  const ergebnis = await doclingEinrichten((zeile) => console.log(zeile));
  console.log(ergebnis.meldung);
}

/**
 * Gezielte Korrektur statt Neustart des ganzen Dialogs: fragt nur den Wert nach, den die
 * fehlgeschlagene Prüfung tatsächlich betrifft.
 */
async function anbieterKorrigieren(cfg: Konfiguration): Promise<void> {
  const wahl = await select({
    message: "Was korrigieren?",
    choices: [
      { name: "Basis-URL", value: "url" as const },
      { name: "API-Schlüssel", value: "schluessel" as const },
      { name: "Beides", value: "beide" as const },
      { name: "Überspringen", value: "ueberspringen" as const },
    ],
  });
  if (wahl === "ueberspringen") return;
  if (wahl === "url" || wahl === "beide") cfg.baseUrl = await frageBasisUrl(cfg.baseUrl);
  // Nach einem Fehlschlag erzwungen neu eingeben statt "Enter behält" anzubieten — der
  // bestehende Schlüssel war ja gerade nachweislich falsch (oder die URL war es, und der
  // Schlüssel ist unbeteiligt; in dem Fall tippt Ben ihn unverändert erneut ein).
  if (wahl === "schluessel" || wahl === "beide") cfg.apiKey = await frageSchluessel("API-Schlüssel", "", true);
  speichern(cfg);
  modellZuruecksetzen();
}

async function mistralKorrigieren(cfg: Konfiguration): Promise<void> {
  const korrigieren = await confirm({ message: "Jetzt Mistral-Schlüssel korrigieren?", default: true });
  if (!korrigieren) return;
  cfg.mistralApiKey = await frageSchluessel("Mistral-API-Schlüssel", "", false);
  speichern(cfg);
  modellZuruecksetzen();
}

async function pruefenUndKorrigieren(cfg: Konfiguration): Promise<void> {
  let anbieter = await pruefeAnbieter(aufgeloest(cfg));
  meldungAusgeben(anbieter);
  while (!anbieter.ok) {
    await anbieterKorrigieren(cfg);
    const erneut = await pruefeAnbieter(aufgeloest(cfg));
    meldungAusgeben(erneut);
    if (erneut.ok === anbieter.ok && erneut.meldung === anbieter.meldung) break; // nichts geändert, nicht in Schleife hängen
    anbieter = erneut;
  }

  let mistral = await pruefeMistral(aufgeloest(cfg));
  meldungAusgeben(mistral);
  while (!mistral.ok) {
    await mistralKorrigieren(cfg);
    const erneut = await pruefeMistral(aufgeloest(cfg));
    meldungAusgeben(erneut);
    if (erneut.ok === mistral.ok && erneut.meldung === mistral.meldung) break;
    mistral = erneut;
  }
}

async function dialogAblauf(ueberschrift: string): Promise<void> {
  console.log(`\n${ueberschrift}`);
  console.log(
    `Die Schlüssel werden unverschlüsselt gespeichert (Klartext) unter: ${konfigDatei()}\n` +
      "Dort keinen Produktivschlüssel mit weitreichenden Rechten ablegen, den man nicht verlieren darf.",
  );

  const cfg = laden();

  cfg.baseUrl = await frageBasisUrl(cfg.baseUrl || VORGABE.baseUrl);
  cfg.apiKeyName = await frageSchluesselName(cfg.apiKeyName || VORGABE.apiKeyName);

  // Wer den Schlüssel über die Umgebung setzt, hat einen — und darf hier nicht gezwungen
  // werden, ihn zusätzlich in die Konfigurationsdatei zu tippen, nur um den Dialog
  // verlassen zu können. Ohne diese Unterscheidung bliebe nur Strg+C, und damit wären
  // auch alle anderen Änderungen dieses Durchlaufs verloren.
  const ausUmgebung = process.env[cfg.apiKeyName] ?? "";
  if (ausUmgebung && !cfg.apiKey) {
    console.log(`Ein Schlüssel steht bereits in der Umgebungsvariablen ${cfg.apiKeyName}.`);
  }
  cfg.apiKey = await frageSchluessel(
    "API-Schlüssel",
    cfg.apiKey,
    ausUmgebung === "",
    ` (Enter übernimmt den Schlüssel aus ${cfg.apiKeyName})`,
  );
  cfg.mistralApiKey = await frageSchluessel("Mistral-API-Schlüssel (OCR für gescannte Seiten)", cfg.mistralApiKey, false);
  cfg.ergebnisVerzeichnis = await frageErgebnisVerzeichnis(cfg.ergebnisVerzeichnis || ergebnisVerzeichnisDefault());

  speichern(cfg);
  modellZuruecksetzen();

  await pruefenUndKorrigieren(cfg);
  await doclingStatusUndEinrichtung();

  console.log("\nEinstellungen gespeichert.");
}

/** Erster Start: führt durch alle Einstellungen, prüft, speichert. */
export async function einrichtungsDialog(): Promise<void> {
  if (!istInteraktiv()) return keinTtyMeldung();
  try {
    await dialogAblauf("Ersteinrichtung — SZKS-Extraktion");
  } catch (fehler) {
    if (istAbbruch(fehler)) {
      console.log("\nAbgebrochen.");
      return;
    }
    throw fehler;
  }
}

/** Menüpunkt "Einstellungen" und Slash-Befehl /config. */
export async function einstellungenDialog(): Promise<void> {
  if (!istInteraktiv()) return keinTtyMeldung();
  try {
    await dialogAblauf("Einstellungen ändern");
  } catch (fehler) {
    if (istAbbruch(fehler)) {
      console.log("\nAbgebrochen.");
      return;
    }
    throw fehler;
  }
}
