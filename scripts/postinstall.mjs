/**
 * Läuft automatisch bei `npm install`: legt den globalen Befehl `szks` an und richtet
 * Docling ein — in dieser Reihenfolge.
 *
 * ## Diese Datei darf nicht scheitern
 *
 * Offline, hinter einem Proxy, mit voller Platte, in einer CI ohne Netz — in all diesen
 * Fällen muss `npm install` trotzdem mit 0 enden. Ein Werkzeug, das sich nicht einmal
 * installieren lässt, ist unbrauchbar; eines ohne Docling ist startbar, meldet die Lücke
 * im Einrichtungsdialog und lässt sie mit `npm run setup:docling` schließen. Deshalb ist
 * hier jeder Pfad abgefangen und der Exit-Code fest 0.
 *
 * ## Warum reines .mjs ohne Import aus dem Projekt
 *
 * Zur postinstall-Zeit ist die Reihenfolge der Installation nicht in der Hand dieses
 * Skripts. Es benutzt deshalb ausschließlich die Node-Standardbibliothek und prüft die
 * Anwesenheit von tsx selbst, statt sie vorauszusetzen. Aufgerufen wird nicht der
 * `.bin`-Shim (unter Windows eine `.cmd`, die ohne Shell nicht startet), sondern direkt
 * `tsx/dist/cli.mjs` mit dem laufenden Node — damit braucht es weder Shell noch PATH.
 *
 * ## Zwei Abschalter
 *
 * `SZKS_SKIP_DOCLING=1` und `npm_config_ignore_scripts` (also `npm install
 * --ignore-scripts`). Ohne sie ließe sich das Repo in einer CI nicht klonen, ohne Python,
 * Wheels und Modelle zu ziehen — gemessen am 2026-08-10 rund 1,7 GB auf der Platte und
 * gut 1,6 GB durch die Leitung, für einen Lint-Lauf, der nichts davon anfasst.
 *
 * Bewusst *kein* automatisches Überspringen in CI-Umgebungen: Wer Docling dort nicht will,
 * sagt es. Ein stilles Abweichen je nach Umgebungsvariable wäre genau die Sorte
 * Überraschung, die man am Tag der Fehlersuche nicht gebrauchen kann.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const EINRICHTEN = path.join(REPO, "scripts", "setup-docling.ts");

const NACHHOLEN = "Nachholen jederzeit mit:  npm run setup:docling";
const NACHHOLEN_LINK = "Nachholen jederzeit mit:  npm link";

/**
 * `SZKS_SKIP_DOCLING=1 npm install` ist POSIX-Syntax. Weder `cmd.exe` noch PowerShell
 * verstehen sie: cmd hielte `SZKS_SKIP_DOCLING=1` für den Programmnamen, PowerShell
 * bemängelt einen unerwarteten Ausdruck. Ein Hinweis, der beim Befolgen einen Fehler
 * erzeugt, ist schlechter als keiner — also nennt jede Plattform ihre eigene Schreibweise.
 */
const UEBERSPRINGEN =
  process.platform === "win32"
    ? [
        "Überspringen mit (Eingabeaufforderung):  set SZKS_SKIP_DOCLING=1 && npm install",
        "Überspringen mit (PowerShell):           $env:SZKS_SKIP_DOCLING=1; npm install",
      ]
    : ["Überspringen mit:  SZKS_SKIP_DOCLING=1 npm install"];

/** Meldet und beendet ohne Fehler — der einzige Ausgang dieses Skripts. */
function beenden(zeilen) {
  for (const zeile of zeilen) console.log(`[szks] ${zeile}`);
  process.exitCode = 0;
}

function abgeschaltet() {
  if (process.env.SZKS_SKIP_DOCLING && process.env.SZKS_SKIP_DOCLING !== "0") {
    return "SZKS_SKIP_DOCLING ist gesetzt";
  }
  // npm setzt die Variable auf den String "true", wenn --ignore-scripts aktiv ist. Dass
  // dieses Skript dann überhaupt läuft, kommt vor: ein äußeres Werkzeug kann es
  // einzeln aufrufen. Die Absicht des Aufrufers gilt trotzdem.
  if (process.env.npm_config_ignore_scripts === "true") {
    return "npm läuft mit --ignore-scripts";
  }
  return null;
}

/**
 * Legt den globalen Befehl `szks` an — **vor** der Docling-Einrichtung.
 *
 * Die Reihenfolge ist der Punkt: Das Verlinken dauert eine Drittelsekunde, die
 * Docling-Einrichtung Minuten und kann an Netz, Proxy oder Platte scheitern. Liefe es
 * andersherum, hätte Ben nach einem gescheiterten Download **auch** keinen Befehl, mit dem
 * er die Lage ansehen könnte — obwohl das Werkzeug startbar ist und den Fehlschlag im
 * Einrichtungsdialog erklären würde.
 *
 * **`npm link` und nicht `npm install -g .`**: Gemessen löst Node den Symlink auf den
 * echten Ordner auf, `import.meta.url` zeigt also in den Klon. Damit bleiben
 * `.werkzeuge/`, `.cache/` und vor allem `ergebnisse/` dort, wo sie erwartet werden, und
 * ein `git pull` wirkt sofort. Ein globales `install` kopierte die Dateien stattdessen ins
 * globale `node_modules`, und die Ergebnis-CSVs landeten dort — praktisch unauffindbar.
 *
 * Aufgerufen wird npm über `npm_execpath` mit dem laufenden Node, nicht über den Namen
 * `npm`: Unter Windows ist das eine `.cmd`, die ohne Shell nicht startet, und eine Shell
 * will diese Datei aus gutem Grund nirgends (Repo-Pfade mit Leerzeichen).
 *
 * Gemessen mit npm 10: `npm link` führt `postinstall` **nicht** erneut aus. Der Wächter
 * `SZKS_IN_LINK` steht trotzdem da — die Lebenszyklus-Regeln haben sich zwischen
 * npm-Hauptversionen schon geändert, und eine Endlosschleife im Installationsschritt wäre
 * ein teurer Weg, das herauszufinden.
 */
function verlinken() {
  return new Promise((fertig) => {
    if (process.env.SZKS_IN_LINK === "1") return fertig(["Verlinken übersprungen (läuft bereits)."]);
    if (process.env.SZKS_SKIP_LINK && process.env.SZKS_SKIP_LINK !== "0") {
      return fertig(["Globaler Befehl übersprungen (SZKS_SKIP_LINK ist gesetzt)."]);
    }
    // Als Abhängigkeit eines anderen Projekts installiert: dann gehört uns der globale
    // Befehlspfad nicht. `INIT_CWD` ist das Verzeichnis, in dem npm aufgerufen wurde.
    if (process.env.INIT_CWD && path.resolve(process.env.INIT_CWD) !== REPO) {
      return fertig([]);
    }
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !existsSync(npmCli)) {
      return fertig(["Globaler Befehl nicht angelegt (npm nicht auffindbar).", NACHHOLEN_LINK]);
    }

    const kind = spawn(process.execPath, [npmCli, "link"], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      windowsHide: true,
      env: { ...process.env, SZKS_IN_LINK: "1" },
    });

    let fehlertext = "";
    kind.stderr.on("data", (d) => (fehlertext += d));
    kind.on("error", (f) => fertig([`Globaler Befehl nicht angelegt: ${f.message}`, NACHHOLEN_LINK]));
    kind.on("close", (code) => {
      if (code === 0) return fertig(["Der Befehl `szks` steht jetzt überall zur Verfügung."]);
      // Der häufigste Grund sind fehlende Rechte am globalen Befehlspfad (etwa
      // /usr/local/bin bei einer Node-Installation aus dem offiziellen Installer). Das ist
      // kein Grund, die Installation scheitern zu lassen — `npm start` funktioniert.
      const knapp = fehlertext.split("\n").find((z) => z.includes("EACCES") || z.includes("EPERM"));
      fertig([
        `Globaler Befehl nicht angelegt (Exit-Code ${code}).${knapp ? " Fehlende Rechte am globalen Befehlspfad." : ""}`,
        "Das Werkzeug läuft trotzdem — im Projektordner:  npm start",
        NACHHOLEN_LINK,
      ]);
    });
  });
}

for (const zeile of await verlinken()) console.log(`[szks] ${zeile}`);

const grund = abgeschaltet();
if (grund) {
  beenden([`Docling-Einrichtung übersprungen (${grund}).`, NACHHOLEN]);
} else if (!existsSync(TSX)) {
  // Kein Fehler, sondern eine Reihenfolge-Frage: fehlt tsx, ist die Installation noch
  // nicht so weit. Der Nachholweg funktioniert dann trotzdem.
  beenden(["Docling-Einrichtung übersprungen: tsx ist noch nicht verfügbar.", NACHHOLEN]);
} else if (!existsSync(EINRICHTEN)) {
  // Eigene Meldung, weil die Ursache eine andere ist: hier fehlt eine Datei des Repos,
  // nicht eine Abhängigkeit. Beides unter „tsx fehlt" zu melden, schickte die Fehlersuche
  // in die falsche Richtung.
  beenden([`Docling-Einrichtung übersprungen: ${EINRICHTEN} fehlt.`, NACHHOLEN]);
} else {
  console.log("[szks] Docling wird eingerichtet. Das dauert beim ersten Mal einige Minuten.");
  for (const zeile of UEBERSPRINGEN) console.log(`[szks] ${zeile}`);

  const kind = spawn(process.execPath, [TSX, EINRICHTEN], {
    cwd: REPO,
    stdio: "inherit",
    // Keine Shell: der Repo-Pfad kann Leerzeichen enthalten (`C:\Users\Ben Meier\...`).
    shell: false,
    windowsHide: true,
  });

  kind.on("error", (fehler) => {
    beenden([`Docling-Einrichtung nicht startbar: ${fehler.message}`, NACHHOLEN]);
  });

  kind.on("close", (code) => {
    if (code === 0) {
      beenden(["Docling ist eingerichtet."]);
      return;
    }
    beenden([
      `Docling-Einrichtung fehlgeschlagen (Exit-Code ${code}).`,
      "Die Installation gilt trotzdem als erfolgreich — das Werkzeug startet, kann aber",
      "noch keine PDFs lesen. Häufigste Ursachen: kein Netz, Proxy ohne Zugang zu",
      "github.com oder pypi.org, zu wenig Platz (rund 2,7 GB während der Installation,",
      "danach rund 1,7 GB).",
      NACHHOLEN,
    ]);
  });
}
