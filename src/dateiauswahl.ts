/**
 * Die PDF-Auswahl.
 *
 * ## Warum ein echter Datei-Dialog und kein Pfad-Eingabefeld
 *
 * Ben ist Tester, kein Entwickler. Einen Pfad abzutippen ist die fehleranfälligste
 * Eingabeart, die ein Werkzeug verlangen kann — und die einzige, bei der der Fehler erst
 * beim Absenden auffällt. Beide Zielsysteme können einen Datei-Dialog mit Bordmitteln
 * öffnen, ohne ein npm-Paket und ohne native Abhängigkeit:
 *
 * - **macOS**: `osascript` mit `choose file`. Der Rückgabewert ist eine AppleScript-Alias-
 *   Angabe (`Macintosh HD:Users:…`), deshalb die zweite Anweisung `POSIX path of`.
 * - **Windows**: `powershell -NoProfile -STA` mit `System.Windows.Forms.OpenFileDialog`.
 *   **`-STA` ist keine Feinheit, sondern Voraussetzung**: Windows Forms verlangt ein
 *   Single-Threaded Apartment; PowerShell startet je nach Version im MTA, und dann öffnet
 *   sich der Dialog nicht — ohne Fehlermeldung, ohne Fenster, ohne Hinweis darauf, was
 *   fehlt. Das Skript geht über `-Command` und nicht über eine `.ps1`-Datei, weil eine
 *   Datei der Ausführungsrichtlinie unterliegt und in verwalteten Umgebungen abgelehnt wird.
 *
 * ## Der Dialog ist der Hauptweg, nicht der einzige
 *
 * Über SSH, in einer Sitzung ohne Fenstermanager oder unter einer gesperrten Richtlinie
 * gibt es kein Fenster. Dann bricht die Auswahl **nicht** ab, sondern fällt auf die
 * Pfadeingabe zurück und sagt einmal, warum — ein roher `spawn`-Fehler wäre für Ben nicht
 * von einem Defekt des Werkzeugs zu unterscheiden.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { EINGABE_THEMA, MENUE_THEMA } from "./ansicht.js";
import type { Konfiguration } from "./config.js";
import { einstellungenDialog } from "./setup.js";

/** An jeder Texteingabe erreichbar — siehe `textFrage`. */
const CONFIG_BEFEHL = "/config";

// ---------------------------------------------------------------------------
// Pfadeingabe: aufräumen und prüfen
// ---------------------------------------------------------------------------

/**
 * Umschließende Anführungszeichen entfernen.
 *
 * Genau das liefern beide Systeme, wenn man eine Datei ins Terminalfenster zieht: das
 * Windows Terminal legt `"…"` um jeden Pfad, macOS' Terminal tut es bei Pfaden mit
 * Sonderzeichen. Ein Pfad mit einem führenden `"` existiert praktisch nie, ein
 * hineingezogener mit Anführungszeichen praktisch immer.
 */
export function anfuehrungszeichenStrippen(roh: string): string {
  const text = roh.trim();
  const erstes = text[0];
  if ((erstes === '"' || erstes === "'") && text.length >= 2 && text.endsWith(erstes)) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Backslash-Maskierung auflösen — aber nur, wenn sie die Datei überhaupt erst findet.
 *
 * macOS' Terminal maskiert beim Hineinziehen die Leerzeichen statt zu quoten
 * (`/Users/ben/Anfrage\ 2026.pdf`). Blind zu entmaskieren wäre falsch: unter Windows ist
 * der Backslash der Pfadtrenner, und auf POSIX darf ein Dateiname einen enthalten. Deshalb
 * die Bedingung: entmaskiert wird nur, wenn der Pfad so nicht existiert und entmaskiert
 * schon. Damit kann diese Regel keinen Pfad kaputtmachen, der vorher funktioniert hat.
 */
function maskierungAufloesen(pfad: string): string {
  if (process.platform === "win32") return pfad;
  if (existsSync(pfad) || !pfad.includes("\\")) return pfad;
  const entmaskiert = pfad.replace(/\\(.)/g, "$1");
  return existsSync(entmaskiert) ? entmaskiert : pfad;
}

export type PfadPruefung = { ok: true; pfad: string } | { ok: false; fehler: string };

/**
 * Eingabe → absoluter, geprüfter Pfad. Die Prüfung sagt, was konkret nicht stimmt: „nicht
 * gefunden" und „ist keine PDF-Datei" führen zu verschiedenen Korrekturen.
 */
export function pfadPruefen(roh: string): PfadPruefung {
  const bereinigt = maskierungAufloesen(anfuehrungszeichenStrippen(roh));
  if (!bereinigt) return { ok: false, fehler: "Kein Pfad eingegeben." };

  const abs = path.resolve(bereinigt);
  if (!existsSync(abs)) return { ok: false, fehler: `Nicht gefunden: ${abs}` };
  if (!statSync(abs).isFile()) return { ok: false, fehler: `Das ist ein Verzeichnis, keine Datei: ${abs}` };
  if (path.extname(abs).toLowerCase() !== ".pdf") {
    return { ok: false, fehler: `Keine PDF-Datei: ${path.basename(abs)}` };
  }
  return { ok: true, pfad: abs };
}

// ---------------------------------------------------------------------------
// Texteingabe mit /config
// ---------------------------------------------------------------------------

/**
 * Eine Texteingabe, an der zusätzlich `/config` getippt werden kann.
 *
 * Der Befehl ist bewusst an die **Text**eingaben gebunden: in einer Auswahlliste gibt es
 * keine Eingabezeile, in die man ihn tippen könnte — dort führt der Menüpunkt
 * „Einstellungen" an dieselbe Stelle.
 *
 * Rückgabe `null` heißt „zurück": eine leere Eingabe ist der einzige Weg, aus einer
 * Texteingabe herauszukommen, ohne das Programm zu beenden.
 */
async function textFrage(frage: string): Promise<string | null> {
  for (;;) {
    const eingabe = await input({
      message: frage,
      theme: EINGABE_THEMA,
    });
    const getrimmt = eingabe.trim();
    if (getrimmt.toLowerCase() === CONFIG_BEFEHL) {
      await einstellungenDialog();
      continue;
    }
    return getrimmt === "" ? null : eingabe;
  }
}

/** Fragt so lange nach einem Pfad, bis einer stimmt — oder die Eingabe leer bleibt. */
async function pfadEingeben(): Promise<string | null> {
  console.log();
  console.log("Pfad eingeben oder die PDF-Datei ins Fenster ziehen. Leer lassen = zurück.");
  for (;;) {
    const roh = await textFrage(`PDF-Pfad (oder ${CONFIG_BEFEHL})`);
    if (roh === null) return null;
    const ergebnis = pfadPruefen(roh);
    if (ergebnis.ok) return ergebnis.pfad;
    console.log(`  ${ergebnis.fehler}`);
  }
}

// ---------------------------------------------------------------------------
// Der System-Dialog
// ---------------------------------------------------------------------------

/** `null` = abgebrochen (kein Fehler), `fehler` = der Dialog stand nicht zur Verfügung. */
type DialogErgebnis = { art: "gewaehlt"; pfad: string } | { art: "abgebrochen" } | { art: "fehler"; grund: string };

/** Startet ein Programm und sammelt seine Ausgabe. Wirft nie — der Fehler ist Teil des Ergebnisses. */
function ausfuehren(
  befehl: string,
  argumente: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; startfehler: string | null }> {
  return new Promise((fertig) => {
    let stdout = "";
    let stderr = "";
    // `shell: false` ist zwar der Vorgabewert, steht hier aber ausdrücklich: Über eine
    // Shell würde das PowerShell-Skript ein zweites Mal zerlegt, und der zurückgelieferte
    // Pfad `C:\Users\Ben Meier\...` liefe durch eine Maskierungsschicht, die niemand
    // gerechnet hat.
    const kind = spawn(befehl, argumente, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    kind.stdout.setEncoding("utf8");
    kind.stderr.setEncoding("utf8");
    kind.stdout.on("data", (d: string) => (stdout += d));
    kind.stderr.on("data", (d: string) => (stderr += d));
    kind.on("error", (e) => fertig({ code: null, stdout, stderr, startfehler: e.message }));
    kind.on("close", (code) => fertig({ code, stdout, stderr, startfehler: null }));
  });
}

const DIALOG_TITEL = "SZKS Extraktion: PDF-Anfrage";

/**
 * macOS. Zwei `-e`-Anweisungen: die erste öffnet den Dialog und liefert einen Alias, die
 * zweite übersetzt ihn in einen POSIX-Pfad.
 *
 * Der Abbruch ist **nicht am Meldungstext erkennbar** — auf einem deutschen System steht
 * dort „Von Benutzer:in abgebrochen. (-128)", auf einem englischen „User canceled. (-128)".
 * Stabil ist allein der AppleScript-Fehlercode `-128`; auf ihn wird geprüft. Ein Abgleich
 * mit dem englischen Wortlaut hätte auf Bens System jeden Abbruch als Defekt gemeldet.
 */
async function dialogMac(): Promise<DialogErgebnis> {
  const ergebnis = await ausfuehren("osascript", [
    "-e",
    `set gewaehlt to choose file with prompt "${DIALOG_TITEL}" of type {"pdf"}`,
    "-e",
    "POSIX path of gewaehlt",
  ]);

  if (ergebnis.startfehler) return { art: "fehler", grund: ergebnis.startfehler };
  if (ergebnis.code === 0) {
    const pfad = ergebnis.stdout.trim();
    return pfad ? { art: "gewaehlt", pfad } : { art: "fehler", grund: "Der Dialog lieferte keinen Pfad." };
  }
  if (ergebnis.stderr.includes("-128")) return { art: "abgebrochen" };
  return { art: "fehler", grund: ergebnis.stderr.trim() || `osascript endete mit Code ${ergebnis.code}` };
}

/**
 * Windows. Das gesamte Skript geht als **ein** Argument an `-Command`; es enthält deshalb
 * ausschließlich einfache Anführungszeichen, damit beim Weiterreichen an die
 * Kommandozeile nichts zu maskieren ist.
 *
 * `[Console]::OutputEncoding` wird auf UTF-8 gesetzt, bevor der Pfad geschrieben wird —
 * sonst kommt ein Pfad mit Umlaut in der Konsolen-Codepage heraus und Node liest ihn als
 * UTF-8 falsch zurück. `[Console]::Out.Write` statt `Write-Output`, weil letzteres einen
 * Zeilenumbruch anhängt und bei schmalem Fenster umbricht.
 */
async function dialogWindows(): Promise<DialogErgebnis> {
  const skript = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$d = New-Object System.Windows.Forms.OpenFileDialog;",
    "$d.Filter = 'PDF-Dateien|*.pdf';",
    `$d.Title = '${DIALOG_TITEL}';`,
    "$d.Multiselect = $false;",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName); exit 0 } else { exit 2 }",
  ].join(" ");

  const ergebnis = await ausfuehren("powershell", ["-NoProfile", "-STA", "-Command", skript]);

  if (ergebnis.startfehler) return { art: "fehler", grund: ergebnis.startfehler };
  // Eigener Code für den Abbruch: `ShowDialog` unterscheidet Abbruch und Fehler, PowerShell
  // täte es über den Exit-Code nicht mehr — beides wäre ungleich null.
  if (ergebnis.code === 2) return { art: "abgebrochen" };
  if (ergebnis.code === 0) {
    const pfad = ergebnis.stdout.trim();
    return pfad ? { art: "gewaehlt", pfad } : { art: "fehler", grund: "Der Dialog lieferte keinen Pfad." };
  }
  return { art: "fehler", grund: ergebnis.stderr.trim() || `powershell endete mit Code ${ergebnis.code}` };
}

async function systemDialog(): Promise<DialogErgebnis> {
  if (process.platform === "darwin") return dialogMac();
  if (process.platform === "win32") return dialogWindows();
  // Linux ist kein Zielsystem; es gibt dort keinen Dialog, auf den man sich verlassen
  // könnte (zenity/kdialog sind nicht gesetzt). Der Rückfall auf die Pfadeingabe ist hier
  // der normale Weg, kein Notbehelf.
  return { art: "fehler", grund: "Auf diesem System gibt es keinen Datei-Dialog." };
}

/**
 * Der Dialog steht nur einmal pro Sitzung in der Kritik: Schlägt er fehl, wird der Grund
 * einmal erklärt und danach still auf die Pfadeingabe umgeleitet. Denselben Absatz bei
 * jeder Auswahl zu wiederholen, würde ihn zu Rauschen machen.
 */
let dialogAusgefallen = false;

async function dialogOderPfad(): Promise<string | null> {
  if (!dialogAusgefallen) {
    const ergebnis = await systemDialog();
    if (ergebnis.art === "gewaehlt") {
      const geprueft = pfadPruefen(ergebnis.pfad);
      if (geprueft.ok) return geprueft.pfad;
      console.log(`  ${geprueft.fehler}`);
      return null;
    }
    if (ergebnis.art === "abgebrochen") return null;

    dialogAusgefallen = true;
    console.log();
    console.log("Der Datei-Dialog ließ sich nicht öffnen.");
    console.log(`  Grund: ${ergebnis.grund}`);
    console.log("  Das passiert über SSH oder ohne Fensterverwaltung. Stattdessen: Pfad eingeben.");
  }
  return pfadEingeben();
}

// ---------------------------------------------------------------------------
// Die Auswahl
// ---------------------------------------------------------------------------

/**
 * Zuletzt ausgewertete PDFs — aber nur die, die es noch gibt.
 *
 * Ein Eintrag, der ins Leere zeigt, ist schlimmer als kein Eintrag: er sieht aus wie ein
 * Angebot und endet in einem Fehler. Die Liste wird hier nur gefiltert, nicht bereinigt —
 * eine Datei auf einem gerade nicht eingehängten Netzlaufwerk soll nach dem Einhängen
 * wieder auftauchen.
 */
function vorhandeneZuletzt(cfg: Konfiguration): string[] {
  return cfg.zuletzt.filter((p) => existsSync(p));
}

/**
 * Die PDF-Auswahl. Rückgabe `null` heißt „zurück ins Hauptmenü".
 */
export async function pdfWaehlen(cfg: Konfiguration): Promise<string | null> {
  const zuletzt = vorhandeneZuletzt(cfg);

  for (;;) {
    console.log();
    const wahl = await select({
      message: "PDF auswählen",
      theme: MENUE_THEMA,
      choices: [
        { value: "dialog", name: "Datei wählen ..." },
        // Der Dateiname genügt: der volle Pfad sprengt die Zeile, und Ben unterscheidet
        // seine Testdokumente am Namen, nicht am Verzeichnis.
        ...zuletzt.map((p, i) => ({ value: `zuletzt:${i}`, name: `Zuletzt: ${path.basename(p)}` })),
        { value: "pfad", name: "Pfad eingeben / hierher ziehen" },
        { value: "zurueck", name: "Zurück" },
      ],
    });

    if (wahl === "zurueck") return null;

    if (wahl.startsWith("zuletzt:")) {
      const pfad = zuletzt[Number(wahl.slice("zuletzt:".length))]!;
      const geprueft = pfadPruefen(pfad);
      if (geprueft.ok) return geprueft.pfad;
      // Zwischen Anzeige und Auswahl kann die Datei verschwunden sein.
      console.log(`  ${geprueft.fehler}`);
      continue;
    }

    const pfad = wahl === "dialog" ? await dialogOderPfad() : await pfadEingeben();
    if (pfad) return pfad;
    // Abbruch im Dialog oder leere Eingabe: zurück in diese Liste, nicht ins Hauptmenü —
    // wer den Dialog versehentlich schließt, will ihn wieder öffnen können.
  }
}
