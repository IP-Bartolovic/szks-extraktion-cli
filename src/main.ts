/**
 * Der Einstiegspunkt: eine Menüschleife, mehr nicht.
 *
 * Die Arbeit steckt in `run.ts` (ein Durchlauf), `dateiauswahl.ts` (welche Datei),
 * `ansicht.ts` (was danach zu sehen ist) und `setup.ts` (Schlüssel und Docling). Diese
 * Datei entscheidet nur, was als Nächstes dran ist — und kümmert sich um die zwei Fälle,
 * die ein interaktives Werkzeug sonst hässlich beendet:
 *
 * - **Strg+C.** `@inquirer/prompts` bricht die laufende Eingabe mit einem
 *   `ExitPromptError` ab. Unbehandelt landet er als Stacktrace im Terminal, und Ben sieht
 *   für einen bewussten Abbruch dasselbe Bild wie für einen Absturz. Erkannt wird er am
 *   `name`, nicht per `instanceof`: die Klasse liegt in `@inquirer/core`, das hier keine
 *   direkte Abhängigkeit ist — sie zu importieren hieße, sich auf die Auflösung eines
 *   transitiven Pakets zu verlassen.
 * - **Kein Terminal.** Ohne TTY (Doppelklick auf eine Verknüpfung, Weiterleitung in eine
 *   Datei, CI) kann keine Auswahlliste gelesen werden; die Bibliothek wartet dann
 *   stillschweigend für immer. Besser ein Satz und ein Exit-Code.
 */

import { spawnSync } from "node:child_process";
import { select } from "@inquirer/prompts";
import { ergebnisMenue, MENUE_THEMA } from "./ansicht.js";
import { pdfWaehlen } from "./dateiauswahl.js";
import { laden } from "./config.js";
import { auswerten } from "./run.js";
import { einrichtungsDialog, einstellungenDialog, istEingerichtet } from "./setup.js";

const TITEL = "SZKS Extraktion";

/** Ein vollständiger Durchgang: Datei wählen, auswerten, Ergebnis zeigen. */
async function anfrageAuswerten(): Promise<void> {
  // Frisch geladen, nicht zwischengespeichert: die Zuletzt-Liste und das
  // Ergebnisverzeichnis können sich seit dem letzten Durchgang geändert haben.
  const pdf = await pdfWaehlen(laden());
  if (!pdf) return;

  const ergebnis = await auswerten(pdf);
  if (!ergebnis) return;

  await ergebnisMenue(ergebnis.summary, ergebnis.csvPfad);
}

async function menueSchleife(): Promise<void> {
  for (;;) {
    console.log();
    const wahl = await select({
      message: TITEL,
      theme: MENUE_THEMA,
      choices: [
        { value: "auswerten", name: "Anfrage auswerten" },
        { value: "einstellungen", name: "Einstellungen" },
        { value: "beenden", name: "Beenden" },
      ],
    });

    if (wahl === "auswerten") await anfrageAuswerten();
    else if (wahl === "einstellungen") await einstellungenDialog();
    else return;
  }
}

/**
 * Windows-Konsole auf UTF-8 stellen.
 *
 * Node schreibt seine Ausgabe immer als UTF-8. Ein `conhost`-Fenster mit der deutschen
 * Vorgabe-Codepage 850 liest diese Bytes anders und macht aus „Kessellänge" ein
 * „KessellÃ¤nge". Windows Terminal und PowerShell 7 sind längst auf UTF-8, `cmd.exe` in
 * älteren Installationen nicht.
 *
 * Der naheliegende Ausweg — in den eigenen Texten auf Umlaute verzichten — trägt hier
 * nicht: Der größere Teil der Ausgabe sind Feldnamen aus der Anfragemaske, und die dürfen
 * nicht umgeschrieben werden, weil dieselben Namen der Suchschlüssel des Importers sind.
 *
 * `chcp` wirkt auf die Konsole, die sich Eltern- und Kindprozess teilen — der Aufruf im
 * Unterprozess stellt sie also für uns mit um. Schlägt er fehl (keine Konsole, gehärtete
 * Richtlinie, `chcp.com` nicht auffindbar), ist das kein Grund abzubrechen: dann sieht die
 * Ausgabe schlechter aus, funktioniert aber.
 */
function konsoleAufUtf8(): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("chcp.com", ["65001"], { stdio: "ignore", windowsHide: true });
  } catch {
    // bewusst still — siehe oben
  }
}

/** Strg+C an einer Eingabeaufforderung — ein Abbruch, kein Fehler. */
function istAbbruch(fehler: unknown): boolean {
  return fehler instanceof Error && (fehler.name === "ExitPromptError" || fehler.name === "AbortPromptError");
}

async function main(): Promise<void> {
  konsoleAufUtf8();

  if (!process.stdin.isTTY) {
    console.error(
      "Dieses Werkzeug braucht ein Terminal — es stellt Rückfragen.\n" +
        "  In einem Terminalfenster starten:  szks     (oder: npm start im Projektordner)",
    );
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(TITEL);

  // Ohne Schlüssel und Ergebnisverzeichnis kann kein Lauf gelingen; danach zu fragen,
  // wenn Ben schon ein PDF gewählt hat, wäre die spätere und ärgerlichere Stelle.
  //
  // Nach dem Dialog wird **erneut** geprüft: Er fängt Strg+C selbst ab und kehrt normal
  // zurück, auch wenn nichts eingetragen wurde. Ohne diese zweite Prüfung liefe Ben ins
  // Menü, wählte „Anfrage auswerten", suchte ein PDF aus und bekäme erst dann zu hören,
  // dass kein Schlüssel hinterlegt ist.
  if (!istEingerichtet()) {
    await einrichtungsDialog();
    if (!istEingerichtet()) {
      console.log();
      console.log(
        "Es ist noch kein API-Schlüssel hinterlegt — eine Auswertung schlägt so fehl.\n" +
          "  Nachholen über den Menüpunkt Einstellungen.",
      );
    }
  }

  await menueSchleife();

  console.log();
  console.log("Bis dann.");
}

try {
  await main();
} catch (fehler) {
  if (istAbbruch(fehler)) {
    console.log();
    console.log("Abgebrochen.");
  } else {
    console.error();
    console.error("Unerwarteter Fehler:");
    console.error(`  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    process.exitCode = 1;
  }
}
