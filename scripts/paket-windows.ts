/**
 * Baut ein ZIP, das auf einem Windows-Rechner **ohne GitHub-Zugang und ohne
 * Installationsrechte** ausgepackt und benutzt werden kann.
 *
 * ## Wogegen das steht
 *
 * Der reguläre Weg — Repo klonen, `npm install` — setzt drei Dinge voraus, die auf einem
 * fremden Rechner alle fehlen können: ein GitHub-Konto mit Zugriff auf ein privates Repo,
 * ein installiertes Node und die Rechte, den Installer überhaupt auszuführen. Das ZIP
 * bringt Node und uv deshalb mit; entpacken genügt.
 *
 * ## Was mitgeliefert wird und was nicht
 *
 * | Bestandteil | im ZIP | Grund |
 * |---|---|---|
 * | Node (Windows x64, portabel) | ja | ersetzt die `.msi`, die Administratorrechte will |
 * | `node_modules` für win32-x64 | ja | kein npm-Registry-Zugriff nötig |
 * | uv (Windows x64) | ja | spart den GitHub-Download bei der Einrichtung |
 * | Quelltext des Werkzeugs | ja | aus `git archive HEAD`, also nur Eingechecktes |
 * | **Docling, Python, Modelle** | **nein** | siehe unten |
 *
 * **Docling lässt sich nicht mitliefern**, und das ist keine Bequemlichkeitsfrage: Es ist
 * Python mit kompilierten Rädern (torch), die für Windows anders aussehen als für macOS.
 * Eine venv für Windows auf einem Mac zu bauen hieße, einen Interpreter zu erzeugen, den
 * es hier nicht gibt. Die rund 1,7 GB lädt deshalb `EINRICHTEN.cmd` beim ersten Start —
 * über PyPI und HuggingFace, wofür kein Konto nötig ist. Nur die Leitung braucht es.
 *
 * ## Warum die Abhängigkeiten hier und nicht drüben installiert werden
 *
 * `npm ci --os=win32 --cpu=x64` beschafft die plattformabhängigen Pakete für das
 * **Zielsystem** statt für dieses. Betroffen sind genau zwei, und beide fielen sonst erst
 * beim Start auf: `@esbuild/*` (über tsx) und `@napi-rs/canvas-*` (über pdfjs-dist). Ein
 * hier gebautes `node_modules` trüge die Darwin-Fassungen und wäre auf Windows wertlos.
 *
 * `--ignore-scripts` ist dabei Pflicht, nicht Vorsicht: `postinstall.mjs` würde sonst auf
 * **diesem** Rechner `npm link` aufrufen und Docling für macOS einrichten — beides in einem
 * Baum, der für Windows gedacht ist.
 *
 * ## Aufruf
 *
 * ```
 * npm run paket:windows
 * ```
 *
 * Ergebnis: `paket/szks-windows.zip`. Heruntergeladene Archive bleiben in
 * `paket/downloads/` liegen, ein zweiter Lauf zieht sie nicht erneut.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, cp, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UV_VERSION } from "../src/docling.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAKET = path.join(REPO, "paket");
const DOWNLOADS = path.join(PAKET, "downloads");
const BAU = path.join(PAKET, "bau");
/** Kurzer Ordnername mit Absicht — unter Windows zählt jedes Zeichen im Pfad. */
const ZIEL = path.join(BAU, "szks");
const ZIP = path.join(PAKET, "szks-windows.zip");

/**
 * Gepinnt auf dieselbe Hauptversion, auf der entwickelt wird — nicht auf die neueste LTS.
 *
 * Node 24 ist inzwischen LTS, erprobt ist das Werkzeug aber auf 22. Eine Auslieferung ist
 * der schlechteste Ort, um herauszufinden, ob eine Hauptversion etwas verschoben hat: Der
 * Fehler träte auf einem fremden Rechner auf, an dem niemand nachsehen kann.
 */
const NODE_VERSION = "22.23.2";
const NODE_ASSET = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_BASIS = `https://nodejs.org/dist/v${NODE_VERSION}`;

const UV_ASSET = "uv-x86_64-pc-windows-msvc.zip";
const UV_BASIS = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

/**
 * Aus dem Paket entfernt, nachdem `git archive` alles Eingecheckte abgelegt hat.
 *
 * `CLAUDE.md` ist ein Symlink auf `AGENTS.md`. Ein Symlink überlebt den Weg durch ZIP und
 * Windows-Explorer nicht sinnvoll — dort entstünde je nach Werkzeug eine Textdatei mit dem
 * Wort „AGENTS.md" darin oder gar nichts. Für ein Paket ohne Claude ist die Datei ohnehin
 * bedeutungslos.
 */
const NICHT_INS_PAKET = ["CLAUDE.md"];

function melde(zeile: string): void {
  console.log(zeile);
}

/** Unterprozess mit Argumentliste, nie über eine Shell. */
function ausfuehren(befehl: string, argumente: string[], cwd = REPO): Promise<void> {
  return new Promise((erfuellen, ablehnen) => {
    const kind = spawn(befehl, argumente, { cwd, stdio: "inherit", shell: false });
    kind.on("error", (f) => ablehnen(new Error(`${befehl} nicht startbar: ${f.message}`)));
    kind.on("close", (code) =>
      code === 0
        ? erfuellen()
        : ablehnen(new Error(`${befehl} ${argumente[0] ?? ""}: Exit-Code ${code}`)),
    );
  });
}

async function holen(url: string): Promise<Buffer> {
  const antwort = await fetch(url, { redirect: "follow" });
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status} bei ${url}`);
  return Buffer.from(await antwort.arrayBuffer());
}

function sha256(daten: Buffer): string {
  return createHash("sha256").update(daten).digest("hex");
}

/**
 * Lädt ein Archiv und prüft es gegen die veröffentlichte Prüfsumme, bevor es auf die Platte
 * geht. Ein bereits geladenes Archiv wird erneut geprüft statt blind geglaubt — die Datei
 * liegt zwischen zwei Läufen offen im Dateisystem.
 *
 * Die Prüfsummen von nodejs.org sind nicht signiert; sie kommen über dieselbe TLS-Sitzung
 * wie das Archiv und beweisen deshalb keine Herkunft. Was sie beweisen, ist Vollständigkeit
 * — ein abgeschnittener Download landet nicht im Paket. Bei uv liegt neben jedem Asset eine
 * eigene `.sha256`, hier gilt dasselbe.
 */
async function archivBeschaffen(name: string, url: string, pruefsumme: string): Promise<string> {
  const datei = path.join(DOWNLOADS, name);

  if (existsSync(datei)) {
    const vorhanden = await readFile(datei);
    if (sha256(vorhanden) === pruefsumme) {
      melde(`  ${name} liegt bereits vor, Prüfsumme stimmt.`);
      return datei;
    }
    melde(`  ${name} liegt vor, Prüfsumme stimmt nicht — wird neu geladen.`);
  }

  melde(`  ${name} wird geladen ...`);
  const daten = await holen(url);
  const tatsaechlich = sha256(daten);
  if (tatsaechlich !== pruefsumme) {
    throw new Error(
      `Prüfsumme von ${name} stimmt nicht.\n` +
        `  erwartet:     ${pruefsumme}\n` +
        `  tatsächlich:  ${tatsaechlich}\n` +
        `  Quelle:       ${url}`,
    );
  }
  await writeFile(datei, daten);
  melde(`  Prüfsumme in Ordnung (sha256 ${tatsaechlich.slice(0, 16)}...).`);
  return datei;
}

/** Sucht in `SHASUMS256.txt` die Zeile zu einem Asset. Format: `<hex>  <datei>`. */
function pruefsummeAusListe(text: string, asset: string): string {
  for (const zeile of text.split("\n")) {
    const [hex, datei] = zeile.trim().split(/\s+/);
    if (datei === asset && /^[0-9a-f]{64}$/i.test(hex ?? "")) return hex!.toLowerCase();
  }
  throw new Error(`In SHASUMS256.txt fehlt ein Eintrag für ${asset}.`);
}

/** Menschenlesbare Dateigröße. */
async function groesse(pfad: string): Promise<string> {
  const bytes = (await stat(pfad)).size;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// Startdateien für Windows
// ---------------------------------------------------------------------------

/**
 * Batchdateien werden **rein in ASCII** geschrieben, obwohl das Werkzeug selbst Umlaute
 * ausgibt.
 *
 * Der Grund ist keine Sparsamkeit, sondern die Art, wie `cmd.exe` arbeitet: Es liest die
 * Datei nicht einmal ein, sondern springt beim Abarbeiten zwischen Byte-Positionen hin und
 * her und dekodiert dabei mit der Codepage, die **gerade** gilt. Ein `chcp 65001` in Zeile
 * zwei ändert also mitten im Lesen die Regeln — Umlaute hinter dieser Zeile kommen je nach
 * Windows-Fassung verstümmelt an oder verschieben die Positionen.
 *
 * Node schreibt seine Ausgabe dagegen immer als UTF-8, und dafür ist `chcp 65001` genau
 * richtig. Die Umlaute stehen deshalb dort, wo sie ankommen: im Werkzeug, nicht im Starter.
 *
 * Zeilenenden sind CRLF. Bei reinen Befehlsfolgen geht LF meist gut, bei `goto` auf ein
 * Label aber nicht verlässlich — und genau das steht hier drin.
 */
function batch(zeilen: string[]): string {
  const text = zeilen.join("\r\n") + "\r\n";
  const verstoss = text.match(/[^\x00-\x7F]/);
  if (verstoss) {
    throw new Error(`Batchdatei enthält ein Nicht-ASCII-Zeichen: "${verstoss[0]}"`);
  }
  return text;
}

const KOPF = [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  'set "PATH=%~dp0node;%PATH%"',
];

/**
 * Eigener Halt statt `pause`.
 *
 * `pause` gibt seinen Text über die Konsole des Systems aus, und der ist auf einem
 * deutschen Windows „Drücken Sie eine beliebige Taste . . ." — mit einem ü, das aus einer
 * Ressource in der Systemcodepage stammt und nach `chcp 65001` verstümmelt ankommt.
 * Ausgerechnet die letzte Zeile vor dem Schließen des Fensters sähe dann kaputt aus.
 */
const HALT = ["echo   Zum Schliessen eine beliebige Taste druecken.", "pause >nul"];

const EINRICHTEN_CMD = batch([
  ...KOPF,
  "title SZKS Extraktion - Einrichtung",
  "echo.",
  "echo   SZKS Extraktion - Einrichtung",
  "echo   ============================",
  "echo.",
  "echo   Jetzt wird der PDF-Leser installiert. Dabei werden rund 1,7 GB geladen.",
  "echo   Das dauert je nach Leitung 15 bis 45 Minuten und braucht Internet.",
  "echo.",
  "echo   Bitte dieses Fenster offen lassen. Es bleibt zwischendurch mehrere",
  "echo   Minuten still - das ist normal.",
  "echo.",
  '"%~dp0node\\node.exe" "%~dp0node_modules\\tsx\\dist\\cli.mjs" "%~dp0scripts\\setup-docling.ts"',
  "set FEHLER=%ERRORLEVEL%",
  "echo.",
  // In Anführungszeichen: wäre die Variable leer, stünde hier sonst `if not ==0` — ein
  // Syntaxfehler, der das Fenster mit einer Meldung über die Meldung schlösse.
  'if not "%FEHLER%"=="0" goto :fehler',
  "echo   Fertig. Jetzt STARTEN.cmd doppelklicken.",
  "goto :ende",
  ":fehler",
  "echo   Die Einrichtung ist fehlgeschlagen, Code %FEHLER%.",
  // Vorher stand hier „meist fehlt Internet, blockt eine Firewall oder ist die Platte
  // voll". Beim ersten echten Fehlschlag traf keine der drei Ursachen zu — die Pakete
  // waren vollstaendig installiert, gescheitert war der Start einer DLL. Ein Rateversuch
  // an dieser Stelle ueberschreibt die Ursache, die zwei Zeilen weiter oben steht.
  "echo   Die Ursache steht in den Zeilen darueber, meist in der letzten.",
  "echo   Diese Datei kann jederzeit erneut gestartet werden - schon Geladenes",
  "echo   wird dabei nicht noch einmal geholt.",
  ":ende",
  "echo.",
  ...HALT,
]);

const STARTEN_CMD = batch([
  ...KOPF,
  "title SZKS Extraktion",
  '"%~dp0node\\node.exe" "%~dp0bin\\szks.mjs"',
  "set FEHLER=%ERRORLEVEL%",
  'if not "%FEHLER%"=="0" goto :fehler',
  "goto :ende",
  ":fehler",
  "echo.",
  "echo   Das Werkzeug wurde mit Code %FEHLER% beendet.",
  "echo   Wenn hier steht, dass Docling fehlt: erst EINRICHTEN.cmd starten.",
  "echo.",
  ...HALT,
  ":ende",
]);

/**
 * Ein Fenster, in dem `node` und `npm` auf dem PATH liegen.
 *
 * Das Werkzeug nennt an drei Stellen Befehle wie `npm run setup:docling` — Meldungen, die
 * für einen regulären Klon geschrieben sind. In diesem Paket liegt Node aber nur im
 * Unterordner und nicht im System. Ohne dieses Fenster wäre jede dieser Meldungen ein
 * Hinweis, der beim Befolgen mit „npm ist kein Befehl" endet.
 */
const KONSOLE_CMD = batch([
  ...KOPF,
  "title SZKS Extraktion - Konsole",
  "echo.",
  "echo   In diesem Fenster sind node und npm nutzbar, zum Beispiel:",
  "echo.",
  "echo     npm run setup:docling",
  "echo.",
  "cmd /k",
]);

/** UTF-8 mit BOM und CRLF — so zeigt auch ein altes Notepad die Umlaute richtig an. */
function textdatei(zeilen: string[]): string {
  return "\uFEFF" + zeilen.join("\r\n") + "\r\n";
}

const ANLEITUNG = textdatei([
  "SZKS Extraktion — Windows-Paket",
  "===============================",
  "",
  "Alles Nötige liegt in diesem Ordner. Node, npm und uv sind mit dabei; es muss",
  "nichts installiert werden und es wird kein GitHub-Konto gebraucht.",
  "",
  "",
  "1. ENTPACKEN",
  "",
  "   Vor dem Entpacken: Rechtsklick auf die ZIP-Datei > Eigenschaften > unten",
  "   „Zulassen“ ankreuzen > OK. Ohne das hält Windows die enthaltenen Dateien für",
  "   heruntergeladen und fragt bei jedem Start nach.",
  "",
  "   Dann den Ordner „szks“ aus der ZIP-Datei nach  C:\\  ziehen, sodass er unter",
  "",
  "       C:\\szks",
  "",
  "   liegt. Der kurze Pfad ist kein Schönheitswunsch: Windows bricht bei 260",
  "   Zeichen ab, und die Python-Umgebung darin legt Dateien mit sehr langen Namen",
  "   an. Aus dem Download-Ordner heraus geht es meistens auch, aber eben nur",
  "   meistens.",
  "",
  "",
  "2. EINRICHTEN  (einmalig, braucht Internet)",
  "",
  "   Doppelklick auf   EINRICHTEN.cmd",
  "",
  "   Dabei wird der PDF-Leser geladen — rund 1,7 GB, je nach Leitung 15 bis 45",
  "   Minuten. Das Fenster bleibt zwischendurch mehrere Minuten still; das ist",
  "   normal und kein Absturz. Bricht es ab, kann die Datei einfach erneut",
  "   gestartet werden: schon Geladenes wird nicht noch einmal geholt.",
  "",
  "   Falls Windows „Der Computer wurde geschützt“ meldet:",
  "   auf „Weitere Informationen“ und dann auf „Trotzdem ausführen“ klicken.",
  "",
  "",
  "3. STARTEN",
  "",
  "   Doppelklick auf   STARTEN.cmd",
  "",
  "   Beim allerersten Start werden zwei Schlüssel abgefragt:",
  "",
  "     • OpenAI API Key      https://platform.openai.com/api-keys",
  "     • Mistral API Key     https://console.mistral.ai/api-keys",
  "",
  "   Sie werden gespeichert und danach nicht mehr erfragt.",
  "",
  "   Im Menü dann „Anfrage auswerten“ wählen, die PDF-Datei aussuchen und warten.",
  "   Ein Dokument braucht je nach Umfang wenige Minuten.",
  "",
  "",
  "4. WO DIE ERGEBNISSE LANDEN",
  "",
  "       C:\\szks\\ergebnisse\\",
  "",
  "   Eine CSV-Datei je Lauf, mit Datum und Uhrzeit im Namen — es wird also nie",
  "   etwas überschrieben. Die Datei lässt sich direkt in Excel öffnen.",
  "",
  "",
  "5. WENN ETWAS KLEMMT",
  "",
  "   „Docling ist nicht eingerichtet“   →  EINRICHTEN.cmd starten",
  "   Ein Befehl aus einer Meldung soll  →  KONSOLE.cmd öffnen; dort sind node",
  "   ausgeführt werden                     und npm verfügbar",
  "   Das Fenster schließt sofort        →  Rechtsklick auf die .cmd-Datei und",
  "                                         „Als Administrator ausführen“ ist NICHT",
  "                                         nötig; stattdessen KONSOLE.cmd öffnen",
  "                                         und dort  STARTEN.cmd  eintippen, dann",
  "                                         bleibt die Fehlermeldung stehen",
  "",
  "",
  "Was hier NICHT gebraucht wird: Python, ein Compiler, Poppler, Git, ein",
  "GitHub-Konto und Administratorrechte.",
]);

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  melde("SZKS — Windows-Paket bauen");
  melde("");

  // Nur Eingechecktes kommt ins Paket. Ein unbemerkt geänderter Arbeitsstand wäre die
  // schlechteste Sorte Auslieferung: Was drüben läuft, ließe sich hier nicht mehr
  // nachstellen.
  const offen = await new Promise<string>((erfuellen) => {
    const kind = spawn("git", ["status", "--porcelain"], { cwd: REPO });
    let aus = "";
    kind.stdout.on("data", (d) => (aus += d));
    kind.on("close", () => erfuellen(aus.trim()));
  });
  if (offen) {
    melde("Achtung: Es gibt uncommittete Änderungen. Sie kommen NICHT ins Paket:");
    for (const zeile of offen.split("\n")) melde(`  ${zeile}`);
    melde("");
  }

  await rm(BAU, { recursive: true, force: true });
  await mkdir(DOWNLOADS, { recursive: true });
  await mkdir(ZIEL, { recursive: true });

  // --- Quelltext -----------------------------------------------------------
  melde("Quelltext aus git archive HEAD ...");
  // Über eine Zwischendatei statt über eine Pipe: `sh -c "git archive | tar"` bräuchte eine
  // Shell, und in eine Shell gehören keine interpolierten Pfade.
  const quellArchiv = path.join(BAU, "quelltext.tar");
  await ausfuehren("git", ["archive", "-o", quellArchiv, "HEAD"]);
  await ausfuehren("tar", ["-xf", quellArchiv, "-C", ZIEL]);
  await rm(quellArchiv, { force: true });
  for (const name of NICHT_INS_PAKET) await rm(path.join(ZIEL, name), { force: true });

  // --- Node ----------------------------------------------------------------
  melde(`Node ${NODE_VERSION} für Windows x64 ...`);
  const summen = (await holen(`${NODE_BASIS}/SHASUMS256.txt`)).toString("utf8");
  const nodeArchiv = await archivBeschaffen(
    NODE_ASSET,
    `${NODE_BASIS}/${NODE_ASSET}`,
    pruefsummeAusListe(summen, NODE_ASSET),
  );
  await ausfuehren("tar", ["-xf", nodeArchiv, "-C", BAU]);
  await cp(path.join(BAU, `node-v${NODE_VERSION}-win-x64`), path.join(ZIEL, "node"), {
    recursive: true,
  });
  await rm(path.join(BAU, `node-v${NODE_VERSION}-win-x64`), { recursive: true, force: true });

  // --- uv ------------------------------------------------------------------
  melde(`uv ${UV_VERSION} für Windows x64 ...`);
  const uvSumme = (await holen(`${UV_BASIS}/${UV_ASSET}.sha256`)).toString("utf8").trim().split(/\s+/)[0]!;
  const uvArchiv = await archivBeschaffen(UV_ASSET, `${UV_BASIS}/${UV_ASSET}`, uvSumme.toLowerCase());
  const uvAus = path.join(BAU, "uv-entpackt");
  await mkdir(uvAus, { recursive: true });
  await ausfuehren("tar", ["-xf", uvArchiv, "-C", uvAus]);
  // Vorgelegt an genau die Stelle, an der `uvBeschaffen` in src/docling.ts nachsieht,
  // bevor es zu GitHub greift. Damit braucht die Einrichtung drüben kein github.com.
  await mkdir(path.join(ZIEL, ".werkzeuge"), { recursive: true });
  await cp(path.join(uvAus, "uv.exe"), path.join(ZIEL, ".werkzeuge", "uv.exe"));
  await rm(uvAus, { recursive: true, force: true });

  // --- Abhängigkeiten für das Zielsystem -----------------------------------
  melde("node_modules für win32-x64 ...");
  await ausfuehren(
    "npm",
    [
      "ci",
      "--prefix",
      ZIEL,
      "--os=win32",
      "--cpu=x64",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    ZIEL,
  );

  // --- Startdateien --------------------------------------------------------
  melde("Startdateien und Anleitung ...");
  // `batch()` hat auf reines ASCII geprüft — Kodierung ist damit keine Frage mehr.
  await writeFile(path.join(ZIEL, "EINRICHTEN.cmd"), EINRICHTEN_CMD, "utf8");
  await writeFile(path.join(ZIEL, "STARTEN.cmd"), STARTEN_CMD, "utf8");
  await writeFile(path.join(ZIEL, "KONSOLE.cmd"), KONSOLE_CMD, "utf8");
  await writeFile(path.join(ZIEL, "ANLEITUNG.txt"), ANLEITUNG, "utf8");

  // --- Gegenprobe ----------------------------------------------------------
  // Fehlt eines dieser Stücke, startet drüben nichts — und das fiele erst auf dem fremden
  // Rechner auf, an dem niemand nachsehen kann.
  const pflicht = [
    "node/node.exe",
    "node/npm.cmd",
    "node_modules/tsx/dist/cli.mjs",
    "node_modules/@esbuild/win32-x64/esbuild.exe",
    "node_modules/@napi-rs/canvas-win32-x64-msvc",
    ".werkzeuge/uv.exe",
    "bin/szks.mjs",
    "src/main.ts",
    "vendor/pdf-markdown.ts",
    "scripts/setup-docling.ts",
    "EINRICHTEN.cmd",
    "STARTEN.cmd",
    "ANLEITUNG.txt",
  ];
  const fehlend = pflicht.filter((p) => !existsSync(path.join(ZIEL, ...p.split("/"))));
  if (fehlend.length) throw new Error(`Im Paket fehlen:\n  ${fehlend.join("\n  ")}`);

  // Ein Darwin-Paket im Baum hieße: hier wurde ohne `--os=win32` installiert. Drüben
  // scheiterte dann tsx, und die Meldung führte in die Irre.
  for (const falsch of ["node_modules/@esbuild/darwin-arm64", "node_modules/@esbuild/darwin-x64"]) {
    if (existsSync(path.join(ZIEL, ...falsch.split("/")))) {
      throw new Error(`${falsch} liegt im Paket — es wurde für die falsche Plattform gebaut.`);
    }
  }

  // --- Packen --------------------------------------------------------------
  melde("ZIP schreiben ...");
  await rm(ZIP, { force: true });
  // `-X` lässt die macOS-Zusatzattribute weg; sie wären drüben nur Rauschen.
  await ausfuehren("zip", ["-r", "-q", "-X", ZIP, "szks", "-x", "*.DS_Store"], BAU);
  await rm(BAU, { recursive: true, force: true });

  melde("");
  melde(`Fertig: ${ZIP}  (${await groesse(ZIP)})`);
  melde("");
  melde("Drüben: ZIP entsperren, Ordner szks nach C:\\ ziehen, EINRICHTEN.cmd, STARTEN.cmd.");
}

await main();
