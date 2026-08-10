#!/usr/bin/env node
/**
 * Der globale Befehl `szks`.
 *
 * ## Warum diese Datei überhaupt existiert
 *
 * Ein `bin`-Eintrag muss auf **JavaScript** zeigen. npm erzeugt daraus auf macOS einen
 * Symlink und unter Windows zusätzlich `szks.cmd` und `szks.ps1`; alle drei übergeben die
 * Datei direkt an `node`. Zeigte der Eintrag auf `src/main.ts`, scheiterte der Aufruf auf
 * beiden Systemen — Node kennt kein TypeScript.
 *
 * ## Warum der Loader statt eines Kindprozesses
 *
 * Der naheliegende Weg wäre, `tsx` als Unterprozess zu starten. Das schiebt aber eine
 * Prozessebene zwischen Terminal und Werkzeug, und dort geht genau das verloren, worauf ein
 * interaktives Werkzeug angewiesen ist: **Strg+C** erreicht erst den Starter, das
 * Kindprozess-Signal kommt verzögert oder gar nicht, und der Exit-Code muss von Hand
 * durchgereicht werden. `tsx/esm/api` registriert den Loader stattdessen im **laufenden**
 * Prozess — danach ist `src/main.ts` ein ganz gewöhnlicher Import, mit einer einzigen
 * Prozess-Identität für Signale, Exit-Code und Terminal.
 *
 * ## Warum kein vorkompiliertes `dist/`
 *
 * Das wäre der dritte Weg und der schnellste beim Start (rund 0,3 s Loader-Aufschlag
 * entfielen). Er kostet dafür einen Build-Schritt, der nach jedem `git pull` vergessen
 * werden kann — und dann läuft ein Werkzeug, dessen Quelltext nicht mehr zu seinem Verhalten
 * passt. Für ein Testinstrument ist das der schlechtere Tausch: Ben soll nie in der Lage
 * sein, versehentlich einen alten Stand zu messen.
 */

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(
    `Node 20 oder neuer wird benötigt — installiert ist ${process.versions.node}.\n` +
      `  Aktuelle Fassung: https://nodejs.org`,
  );
  process.exit(1);
}

const { register } = await import("tsx/esm/api");
const { fileURLToPath, pathToFileURL } = await import("node:url");
const path = (await import("node:path")).default;

register();

// Der Pfad wird aus dem Ort dieser Datei abgeleitet, nicht aus dem Arbeitsverzeichnis:
// `szks` wird von überall aufgerufen, das Werkzeug liegt aber immer neben diesem Starter.
//
// `fileURLToPath` statt `new URL(...).pathname`: Letzteres liefert unter Windows
// `/C:/Users/...` — mit führendem Schrägstrich und prozentkodierten Leerzeichen, also
// keinen gültigen Pfad. Zurück in eine URL, weil ein dynamischer Import `C:\...` nicht als
// Bezeichner akzeptiert.
const hier = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(hier, "..", "src", "main.ts")).href);
