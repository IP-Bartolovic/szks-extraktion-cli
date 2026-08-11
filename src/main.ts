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
import { ergebnisMenue, MENUE_THEMA, zusammenfassungAusgeben } from "./ansicht.js";
import { pdfWaehlen, pfadPruefen } from "./dateiauswahl.js";
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

const HILFE = [
  "SZKS Extraktion — liest eine PDF-Anfrage und schreibt die 71 Felder als CSV.",
  "",
  "  szks                 Menü öffnen",
  "  szks <datei.pdf>     die Datei sofort auswerten, ohne Menü",
  "  szks --help          diese Hilfe",
  "",
  "Der Pfad darf in Anführungszeichen stehen — genau so liefert ihn das Terminal,",
  "wenn man eine Datei ins Fenster zieht.",
].join("\n");

type Aufruf =
  | { art: "menue" }
  | { art: "hilfe" }
  | { art: "direkt"; roh: string }
  | { art: "fehler"; meldung: string };

/**
 * Wertet die Befehlszeile aus.
 *
 * **Ein Dokument je Aufruf**, wie im Menü auch. Mehrere Dateien anzunehmen wäre eine
 * Stapelverarbeitung durch die Hintertür — sie ist ausdrücklich nicht Teil dieses
 * Werkzeugs, und ein Aufruf, der stillschweigend nur die erste Datei bearbeitet, wäre die
 * schlechteste Antwort darauf.
 *
 * Ein unbekannter Schalter wird **abgelehnt** und nicht als Dateiname gedeutet. Sonst
 * bekäme `szks --hlep` die Meldung „Nicht gefunden: /…/--hlep" — richtig, aber an der
 * falschen Stelle erklärt.
 */
export function argumenteLesen(argv: string[]): Aufruf {
  const args = argv.filter((a) => a !== "");
  if (args.length === 0) return { art: "menue" };
  if (args.some((a) => a === "-h" || a === "--help")) return { art: "hilfe" };

  const schalter = args.filter((a) => a.startsWith("-"));
  if (schalter.length > 0) {
    return { art: "fehler", meldung: `Unbekannter Schalter: ${schalter[0]}` };
  }
  if (args.length > 1) {
    return {
      art: "fehler",
      meldung:
        `Es geht ein Dokument je Aufruf — angegeben sind ${args.length}.\n` +
        `  Für mehrere nacheinander aufrufen.`,
    };
  }
  return { art: "direkt", roh: args[0]! };
}

/**
 * Ein Dokument auswerten, ohne durchs Menü zu gehen.
 *
 * **Ohne Terminal läuft das trotzdem durch.** Die Menüschleife braucht eines, weil sie
 * fragt; ein Aufruf mit fertigem Pfad fragt nichts mehr. Dann entfällt am Ende nur das
 * Ergebnismenü, und Zusammenfassung und CSV-Pfad gehen auf die Ausgabe — damit ist der
 * Aufruf skriptfähig, und zwar über genau denselben Code, der auch im Menü läuft.
 *
 * Die Einrichtung ist die Ausnahme: Ohne Schlüssel gelingt kein Lauf, und ohne Terminal
 * lässt sich keiner erfragen. Dann bleibt nur der Abbruch mit dem Hinweis, wo er
 * herkommt.
 */
async function direktAuswerten(roh: string): Promise<number> {
  const geprueft = pfadPruefen(roh);
  if (!geprueft.ok) {
    console.error(geprueft.fehler);
    return 1;
  }

  if (!istEingerichtet()) {
    if (!process.stdin.isTTY) {
      console.error(
        "Es ist noch kein API Key hinterlegt, und ohne Terminal lässt sich keiner erfragen.\n" +
          "  Einmalig `szks` in einem Terminalfenster starten und die Einrichtung durchlaufen.",
      );
      return 1;
    }
    await einrichtungsDialog();
    if (!istEingerichtet()) {
      console.error("Ohne API Key kann nicht ausgewertet werden.");
      return 1;
    }
  }

  const ergebnis = await auswerten(geprueft.pfad);
  if (!ergebnis) return 1;

  if (process.stdin.isTTY) {
    await ergebnisMenue(ergebnis.summary, ergebnis.csvPfad, "Beenden");
  } else {
    zusammenfassungAusgeben(ergebnis.summary);
    console.log();
    console.log(`CSV: ${ergebnis.csvPfad}`);
  }
  return 0;
}

async function main(): Promise<void> {
  konsoleAufUtf8();

  const aufruf = argumenteLesen(process.argv.slice(2));
  if (aufruf.art === "hilfe") {
    console.log(HILFE);
    return;
  }
  if (aufruf.art === "fehler") {
    console.error(aufruf.meldung);
    console.error();
    console.error(HILFE);
    process.exitCode = 1;
    return;
  }
  if (aufruf.art === "direkt") {
    process.exitCode = await direktAuswerten(aufruf.roh);
    return;
  }

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
        "Es ist noch kein API Key hinterlegt — eine Auswertung schlägt so fehl.\n" +
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
