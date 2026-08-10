/**
 * Docling einrichten, ohne dass jemand etwas installieren muss.
 *
 * Docling ist Python. Ben ist Tester, kein Entwickler — ein „installiere erst Python 3.11"
 * wäre der Punkt, an dem der Test nicht stattfindet. Die Kette hier beschafft deshalb
 * alles selbst:
 *
 * ```
 * uv (gepinntes Release)  ->  venv mit eigenem CPython 3.11  ->  docling  ->  Modelle
 * ```
 *
 * ## Warum uv und nicht pip
 *
 * `pip` setzt ein Python auf dem Rechner voraus. `uv venv --python 3.11` lädt CPython
 * selbst — das ist der ganze Grund für diesen Umweg. Ein Windows-Rechner ohne Python ist
 * der Normalfall, nicht der Sonderfall.
 *
 * ## Warum nicht `curl | sh`
 *
 * Der offizielle uv-Installer ist ein Skript hinter einer URL, deren Inhalt sich jederzeit
 * ändern kann; was heute geprüft wurde, sagt über morgen nichts. Hier wird stattdessen ein
 * **namentlich gepinntes Release** geladen und gegen die **mitveröffentlichte Prüfsumme**
 * verifiziert, bevor auch nur entpackt wird. Beides zusammen ist der Punkt: die feste
 * Version macht einen Wechsel sichtbar, die Prüfsumme macht ihn nachweisbar.
 *
 * ## Warum die Modelle hier schon geladen werden
 *
 * Docling lädt Layout- und TableFormer-Modelle beim ersten echten Lauf nach. Ohne
 * Vorwärmen passiert das mitten in Bens erster Extraktion — mehrere hundert MB, ohne
 * erkennbaren Grund, mit einem Fortschrittsbalken an einer Stelle, an der er ein Ergebnis
 * erwartet.
 *
 * Vorgewärmt wird durch einen **echten Probelauf** auf einem winzigen erzeugten PDF, nicht
 * durch `docling-tools models download`. Der Grund ist nachgeprüft und nicht offensichtlich:
 * `models download` schreibt die Gewichte per `local_dir` nach `<DOCLING_CACHE_DIR>/models`.
 * Die Laufzeit liest dieses Verzeichnis aber nur, wenn `DOCLING_ARTIFACTS_PATH` gesetzt ist
 * — und das setzt das Werkzeug bewusst nicht, weil ein solches Verzeichnis dann *alle*
 * Modelle der Pipeline enthalten muss und Docling sonst hart abbricht. Ohne diese Variable
 * lädt Docling über `snapshot_download(local_dir=None)`, also in den HuggingFace-Hub-Cache.
 * `docling-tools models download` legte damit eine zweite Kopie an einer Stelle an, die
 * niemand liest, und die erste Extraktion lüde trotzdem nach. Der Probelauf trifft dagegen
 * genau die Pfade, die die Laufzeit nimmt — inklusive der OCR-Maschine, die Docling je nach
 * Plattform selbst auswählt.
 *
 * Der Unterschied ist messbar und nicht theoretisch: Docling wählt hier RapidOCR und lädt
 * dessen drei Gewichtsdateien (rund 31 MB) von `modelscope.cn` — im Kaltlauf am
 * 2026-08-10 knapp zwei Minuten, und das an einer Leitung, die den Rest in Sekunden zieht.
 * `docling-tools models download` holt diese Dateien überhaupt nicht mit. Steht der Server
 * schlecht oder gar nicht zur Verfügung, soll das bei der Einrichtung auffallen und nicht
 * beim ersten Kundendokument.
 *
 * ## Windows
 *
 * Unterprozesse laufen ausschließlich über `spawn` mit Argumentliste, nie über eine Shell.
 * Ein Pfad wie `C:\Users\Ben Meier\...` durch eine Shell zu schicken, wäre der klassische
 * Weg, das Werkzeug beim Kunden und nur dort kaputtgehen zu lassen.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { cacheVerzeichnis, REPO_ROOT, werkzeugVerzeichnis } from "./pfade.js";

/**
 * Gepinnt statt „latest": ein stiller Versionswechsel soll auffallen. Zieht ein neues
 * uv-Release ein anderes Verhalten nach sich, dann sichtbar in einem Commit und nicht
 * dadurch, dass die Einrichtung auf einem anderen Rechner anders ausgeht.
 */
export const UV_VERSION = "0.12.3";

/**
 * Dieselbe Version, die im Pipeline-Repo evaluiert wurde (`vendor/pdf-markdown.ts` nennt
 * 2.118.1 / docling-core 2.91.0 als geprüft). Ungepinnt würde Ben irgendwann gegen einen
 * anderen Parser messen als den, der produktiv läuft — dieselbe Falle, gegen die
 * `check:vendor` schützt, nur eine Ebene tiefer.
 */
const DOCLING_VERSION = "2.118.1";

/** Docling 2.118 ist auf 3.11 evaluiert; uv lädt genau diese Nebenversion selbst. */
const PYTHON_VERSION = "3.11";

const RELEASE_BASIS = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

/** Minuten, nicht Sekunden: `uv pip install docling` zieht rund 1,1 GB, überwiegend torch. */
const FRIST_INSTALL_MS = 60 * 60 * 1000;
const FRIST_VENV_MS = 15 * 60 * 1000;
const FRIST_PROBELAUF_MS = 45 * 60 * 1000;
const FRIST_VERSION_MS = 2 * 60 * 1000;
/** Ohne Frist hängt ein Download an einem stummen Proxy, bis jemand abbricht. */
const FRIST_DOWNLOAD_MS = 15 * 60 * 1000;
const FRIST_PRUEFSUMME_MS = 60 * 1000;

const IST_WINDOWS = process.platform === "win32";

/**
 * Umgebung, die **nur** unter Windows an jeden Unterprozess geht.
 *
 * Python richtet die Kodierung von `stdout`/`stderr` nach der Locale, sobald die Ausgabe
 * nicht an einem Terminal hängt — und hier hängt sie immer an einer Pipe. Auf einem
 * deutschen Windows ist das cp1252, während `ausfuehren` die Bytes als UTF-8 liest. Aus
 * einem Pfad `C:\Users\Ben Meier\Kessellänge.pdf` in einer Docling-Fehlermeldung würde so
 * `Kessell?nge`: eine Meldung, die ihre eigene Ursache unkenntlich macht.
 *
 * Auf macOS ist die Locale ohnehin UTF-8. Die Variable wird dort deshalb nicht gesetzt —
 * sie änderte nichts, und eine Umgebung, die auf beiden Systemen gleich aussieht, aber nur
 * auf einem gebraucht wird, verschleiert den Grund.
 */
const UNTERPROZESS_UMGEBUNG: Record<string, string> = IST_WINDOWS ? { PYTHONIOENCODING: "utf-8" } : {};

// ---------------------------------------------------------------------------
// Pfade
// ---------------------------------------------------------------------------

function venvVerzeichnis(): string {
  return path.join(werkzeugVerzeichnis(), "venv");
}

/** Ausführbare Dateien der venv: POSIX `bin/`, Windows `Scripts/` mit `.exe`. */
function venvBinaer(name: string): string {
  return IST_WINDOWS
    ? path.join(venvVerzeichnis(), "Scripts", `${name}.exe`)
    : path.join(venvVerzeichnis(), "bin", name);
}

/**
 * Längster Pfad **innerhalb** der venv, gemessen an der fertigen Installation
 * (2026-08-10, macOS): 196 Zeichen, tiefster Fund
 * `lib/python3.11/site-packages/torch-2.13.0.dist-info/licenses/third_party/kineto/…/duktape-1.5.2/LICENSE.txt`.
 * Unter Windows liegt dasselbe unter `Lib\site-packages\`, also ohne das Segment
 * `python3.11/` — rund 185 Zeichen. Der Wert ist eine Messung mit Übertragung, kein
 * Grenzwert von Docling: zieht ein Paket später tiefer, wird die Warnung zu spät ausgelöst,
 * nie zu früh.
 */
const LAENGSTER_PFAD_IN_VENV = 185;

/**
 * Die klassische Windows-Pfadgrenze (260 einschließlich abschließender Null). Sie gilt
 * weiterhin, solange weder die Richtlinie „Lange Win32-Pfade aktivieren" gesetzt ist noch
 * jedes beteiligte Programm sie umgeht.
 */
const MAX_PATH = 259;

/**
 * Warnt, bevor die teure Einrichtung beginnt.
 *
 * Der Fehlschlag, gegen den das hier steht, sieht in echt so aus: `npm install` lädt
 * minutenlang 1,1 GB, und irgendwo beim Auspacken bricht es mit einer Meldung über eine
 * Datei ab, deren Namen niemand liest. Die Ursache — der Projektordner liegt zu tief — ist
 * daran nicht zu erkennen, und sie ist unter Windows realistisch: ein aus dem
 * GitHub-Archiv entpacktes `…\Downloads\szks-extraktion-cli-main\szks-extraktion-cli`
 * verbraucht das Budget allein schon fast.
 *
 * Abgebrochen wird trotzdem nicht: Ist die Richtlinie für lange Pfade aktiv, geht alles
 * gut, und eine Verweigerung wäre dann schlicht falsch.
 *
 * `venv` ist ein Parameter und kein fest verdrahteter Aufruf, damit die Grenze mit echten
 * Windows-Pfaden nachgerechnet werden kann, ohne einen Windows-Rechner zu haben — eine
 * Warnschwelle, die nie jemand ausgelöst hat, ist eine Vermutung.
 */
export function langePfadeWarnen(melde: (zeile: string) => void, venv = venvVerzeichnis()): void {
  if (!IST_WINDOWS) return;
  const fehlend = venv.length + 1 + LAENGSTER_PFAD_IN_VENV - MAX_PATH;
  if (fehlend <= 0) return;
  melde("Achtung: Dieser Ordner liegt für Windows zu tief.");
  melde(`  Python-Umgebung: ${venv}`);
  melde(
    `  Windows bricht bei ${MAX_PATH + 1} Zeichen ab. Die Dateien darin brauchen rund ` +
      `${LAENGSTER_PFAD_IN_VENV} Zeichen — es fehlen ${fehlend}.`,
  );
  melde("  Abhilfe: den Projektordner näher an die Laufwerkswurzel legen, etwa nach C:\\szks,");
  melde("  und dort erneut  npm install  ausführen.");
  melde("  Die Einrichtung läuft weiter; sie kann aber mitten im Installieren abbrechen.");
}

/**
 * Merkzettel über eine abgeschlossene Einrichtung. Ohne ihn wäre nicht unterscheidbar, ob
 * die Modelle schon vorgewärmt sind oder nur zufällig ein `docling` existiert — der zweite
 * Aufruf würde dann jedes Mal einen Probelauf starten.
 */
function merkzettelDatei(): string {
  return path.join(werkzeugVerzeichnis(), "docling-eingerichtet.json");
}

/** Pfad zum docling-Binary, oder null wenn nicht eingerichtet. */
export function doclingPfad(): string | null {
  const p = venvBinaer("docling");
  return existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Unterprozesse
// ---------------------------------------------------------------------------

interface LaufOptionen {
  frist: number;
  /** Jede Ausgabezeile des Unterprozesses, sobald sie anfällt. */
  melde?: (zeile: string) => void;
  umgebung?: Record<string, string>;
}

/**
 * Startet einen Unterprozess und reicht dessen Ausgabe **zeilenweise** durch.
 *
 * Der `uv pip install` läuft Minuten. Die Ausgabe erst am Ende in einem Block zu zeigen,
 * hieße: Ben sieht minutenlang nichts und hält das Werkzeug für abgestürzt. Deshalb wird
 * hier auf Zeilengrenzen gepuffert statt auf Prozessende — `\r` zählt mit, weil
 * Fortschrittsanzeigen ihre Zeile so überschreiben.
 *
 * Dekodiert wird über `StringDecoder` und nicht über `Buffer.toString("utf8")`: Ein Chunk
 * endet dort, wo das Betriebssystem ihn beendet, nicht an einer Zeichengrenze. Fällt der
 * Schnitt mitten in ein mehrbyte-Zeichen — und jedes „ä" ist eines —, macht `toString` aus
 * beiden Hälften je ein Ersatzzeichen. Der Dekoder hält den Rest bis zum nächsten Chunk.
 */
function ausfuehren(befehl: string, argumente: string[], opt: LaufOptionen): Promise<string> {
  return new Promise((erfuellen, ablehnen) => {
    const kind = spawn(befehl, argumente, {
      // Kein `shell: true`. Pfade mit Leerzeichen wären sonst der erste Fehler beim Kunden.
      shell: false,
      windowsHide: true,
      timeout: opt.frist,
      killSignal: "SIGKILL",
      env: { ...process.env, ...UNTERPROZESS_UMGEBUNG, ...opt.umgebung },
    });

    let gesammelt = "";
    const puffer: Record<"out" | "err", string> = { out: "", err: "" };
    const dekoder: Record<"out" | "err", StringDecoder> = {
      out: new StringDecoder("utf8"),
      err: new StringDecoder("utf8"),
    };

    const verarbeiten = (kanal: "out" | "err", text: string): void => {
      if (!text) return;
      gesammelt += text;
      puffer[kanal] += text;
      const zeilen = puffer[kanal].split(/\r\n|\r|\n/);
      puffer[kanal] = zeilen.pop() ?? "";
      for (const zeile of zeilen) {
        const sauber = ohneFarbcodes(zeile).trimEnd();
        if (sauber) opt.melde?.(sauber);
      }
    };

    const aufnehmen = (kanal: "out" | "err") => (stueck: Buffer) => {
      verarbeiten(kanal, dekoder[kanal].write(stueck));
    };

    kind.stdout.on("data", aufnehmen("out"));
    kind.stderr.on("data", aufnehmen("err"));

    kind.on("error", (fehler) => {
      ablehnen(new Error(`${path.basename(befehl)} nicht startbar: ${fehler.message}`));
    });

    kind.on("close", (code, signal) => {
      // Erst den Dekoder leeren, dann die angebrochene letzte Zeile ausgeben: ein Prozess
      // muss seine Ausgabe nicht mit einem Zeilenumbruch beenden, und gerade die letzte
      // Zeile trägt bei einem Fehlschlag die Ursache.
      for (const kanal of ["out", "err"] as const) verarbeiten(kanal, dekoder[kanal].end());
      for (const kanal of ["out", "err"] as const) {
        const rest = ohneFarbcodes(puffer[kanal]).trimEnd();
        if (rest) opt.melde?.(rest);
      }
      if (code === 0) {
        erfuellen(gesammelt);
        return;
      }
      // `timeout` beendet per Signal; ohne diesen Hinweis liest sich der Abbruch wie ein
      // gewöhnlicher Fehlschlag und man sucht an der falschen Stelle.
      const grund = signal
        ? `abgebrochen nach ${Math.round(opt.frist / 60000)} Minuten (Signal ${signal})`
        : `Exit-Code ${code}`;
      ablehnen(
        new Error(
          `${path.basename(befehl)} ${argumente[0] ?? ""}: ${grund}\n${letzteZeilen(gesammelt)}`,
        ),
      );
    });
  });
}

/**
 * Entfernt ANSI-Sequenzen aus fremder Ausgabe.
 *
 * RapidOCR (in Docling enthalten) färbt seine Meldungen ein. Ein Windows-Terminal ohne
 * ANSI-Verarbeitung zeigt daraus `ESC[32m` mitten im Text — genau die exotischen Zeichen, die
 * dieses Werkzeug an der Konsole vermeidet. Der Kanal gehört uns, also wird hier gefiltert
 * und nicht gehofft.
 */
function ohneFarbcodes(zeile: string): string {
  return zeile.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Für Fehlermeldungen: der Schluss der Ausgabe steht dort, wo die Ursache steht. */
function letzteZeilen(text: string, anzahl = 12): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((z) => z.trimEnd())
    .filter(Boolean)
    .slice(-anzahl)
    .map((z) => `  ${z}`)
    .join("\n");
}

/** Läuft das Programm überhaupt? Antwort ohne Ausnahme, für Verfügbarkeitsprüfungen. */
async function laeuft(befehl: string, argumente: string[]): Promise<boolean> {
  try {
    await ausfuehren(befehl, argumente, { frist: FRIST_VERSION_MS });
    return true;
  } catch {
    return false;
  }
}

/** Ist Docling ausführbar? Ruft `docling --version` auf. */
export async function doclingVerfuegbar(): Promise<boolean> {
  const p = doclingPfad();
  if (!p) return false;
  return laeuft(p, ["--version"]);
}

// ---------------------------------------------------------------------------
// uv beschaffen
// ---------------------------------------------------------------------------

/**
 * Nur die vier geprüften Ziele. Linux fehlt bewusst — dort greift die PATH-Suche weiter
 * oben, und ein ungeprüftes fünftes Asset stillschweigend zu laden wäre schlechter als
 * eine klare Meldung.
 */
function uvAsset(): string {
  const arm = process.arch === "arm64";
  if (process.platform === "darwin") {
    return arm ? "uv-aarch64-apple-darwin.tar.gz" : "uv-x86_64-apple-darwin.tar.gz";
  }
  if (IST_WINDOWS) {
    return arm ? "uv-aarch64-pc-windows-msvc.zip" : "uv-x86_64-pc-windows-msvc.zip";
  }
  throw new Error(
    `Für ${process.platform}/${process.arch} gibt es hier kein gepinntes uv-Release.\n` +
      `  Abhilfe: uv selbst installieren (https://docs.astral.sh/uv/), danach erneut versuchen —\n` +
      `  ein uv im PATH wird bevorzugt benutzt.`,
  );
}

async function laden(url: string, frist: number): Promise<Buffer> {
  const antwort = await fetch(url, { signal: AbortSignal.timeout(frist), redirect: "follow" });
  if (!antwort.ok) {
    throw new Error(`Download fehlgeschlagen (HTTP ${antwort.status}): ${url}`);
  }
  return Buffer.from(await antwort.arrayBuffer());
}

/**
 * Die Prüfsummendateien von GitHub liefern `<hex>  <datei>` bzw. `<hex> *<datei>` — der
 * Stern markiert Binärmodus und steht nur bei den ZIPs. Interessiert nur das erste Feld.
 */
function prüfsummeAusText(text: string): string {
  const erstes = text.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(erstes)) {
    throw new Error(`Prüfsummendatei unlesbar: "${text.trim().slice(0, 80)}"`);
  }
  return erstes.toLowerCase();
}

/** `tar` liegt unter Windows in System32 und ist ab Windows 10 1803 dabei — aber nicht garantiert. */
async function tarPruefen(): Promise<void> {
  if (await laeuft("tar", ["--version"])) return;
  const hinweis = IST_WINDOWS
    ? `  Erwartet wird C:\\Windows\\System32\\tar.exe (ab Windows 10, Version 1803).\n` +
      `  Fehlt es, ist entweder das System älter oder der PATH beschnitten.`
    : `  Erwartet wird /usr/bin/tar.`;
  throw new Error(
    `"tar" ist nicht aufrufbar — ohne das Programm lässt sich uv nicht entpacken.\n${hinweis}`,
  );
}

/**
 * Sucht das Binary im entpackten Archiv, statt einen Pfad zu raten.
 *
 * Die beiden Archivformen sind unterschiedlich aufgebaut: das macOS-Tarball legt einen
 * Unterordner `uv-<ziel>/` an, das Windows-ZIP schüttet `uv.exe` direkt in die Wurzel. Eine
 * fest verdrahtete Annahme bräche beim nächsten Release der jeweils anderen Seite.
 */
function findeBinaer(wurzel: string, name: string, tiefe = 3): string | null {
  for (const eintrag of readdirSync(wurzel, { withFileTypes: true })) {
    const voll = path.join(wurzel, eintrag.name);
    if (eintrag.isFile() && eintrag.name === name) return voll;
    if (eintrag.isDirectory() && tiefe > 0) {
      const treffer = findeBinaer(voll, name, tiefe - 1);
      if (treffer) return treffer;
    }
  }
  return null;
}

/**
 * Liefert einen Pfad zu einem lauffähigen uv. Reihenfolge: PATH, eigenes
 * Werkzeugverzeichnis, sonst gepinntes Release laden.
 */
async function uvBeschaffen(melde: (zeile: string) => void): Promise<string> {
  if (await laeuft("uv", ["--version"])) {
    melde("uv im PATH gefunden.");
    return "uv";
  }

  const eigenes = path.join(werkzeugVerzeichnis(), IST_WINDOWS ? "uv.exe" : "uv");
  if (existsSync(eigenes) && (await laeuft(eigenes, ["--version"]))) {
    melde(`uv bereits vorhanden: ${eigenes}`);
    return eigenes;
  }

  await tarPruefen();

  const asset = uvAsset();
  const url = `${RELEASE_BASIS}/${asset}`;
  melde(`uv ${UV_VERSION} wird geladen (${asset}) ...`);

  const [archiv, prüfsummentext] = await Promise.all([
    laden(url, FRIST_DOWNLOAD_MS),
    laden(`${url}.sha256`, FRIST_PRUEFSUMME_MS).then((b) => b.toString("utf8")),
  ]);

  // Verifiziert wird, bevor irgendetwas auf die Platte oder durch `tar` geht: ein
  // manipuliertes Archiv soll nicht erst entpackt und dann bemängelt werden.
  const erwartet = prüfsummeAusText(prüfsummentext);
  const tatsächlich = createHash("sha256").update(archiv).digest("hex");
  if (tatsächlich !== erwartet) {
    throw new Error(
      `Prüfsumme von ${asset} stimmt nicht — Archiv wird nicht entpackt.\n` +
        `  erwartet:     ${erwartet}\n` +
        `  tatsächlich: ${tatsächlich}\n` +
        `  Quelle:       ${url}`,
    );
  }
  melde(`Prüfsumme in Ordnung (sha256 ${erwartet.slice(0, 16)}...).`);

  const arbeit = path.join(werkzeugVerzeichnis(), "uv-entpackt");
  await rm(arbeit, { recursive: true, force: true });
  await mkdir(arbeit, { recursive: true });
  const archivDatei = path.join(arbeit, asset);
  await writeFile(archivDatei, archiv);

  // `tar -xf` erkennt das Format selbst; das bsdtar unter Windows liest auch ZIP. Damit
  // braucht es kein zweites Entpackverfahren und keine Abhängigkeit.
  await ausfuehren("tar", ["-xf", archivDatei, "-C", arbeit], { frist: FRIST_VENV_MS });

  const gesucht = IST_WINDOWS ? "uv.exe" : "uv";
  const gefunden = findeBinaer(arbeit, gesucht);
  if (!gefunden) {
    throw new Error(`Im entpackten Archiv ${asset} ist kein "${gesucht}" zu finden.`);
  }

  await copyFile(gefunden, eigenes);
  if (!IST_WINDOWS) chmodSync(eigenes, 0o755);
  await rm(arbeit, { recursive: true, force: true });

  melde(`uv eingerichtet: ${eigenes}`);
  return eigenes;
}

// ---------------------------------------------------------------------------
// venv, Docling, Modelle
// ---------------------------------------------------------------------------

function uvCacheVerzeichnis(): string {
  return path.join(werkzeugVerzeichnis(), "uv-cache");
}

/**
 * uv legt seinen Paket-Cache sonst im Benutzerprofil ab — rund 1,1 GB entpackte Wheels,
 * überwiegend torch, die nach dem Löschen des Repos dort liegen blieben. Aus demselben
 * Grund wie in `src/pfade.ts` liegt er deshalb bei der Installation.
 *
 * Was der Cache wirklich kostet, hängt am Dateisystem und ist nicht das, was `du` sagt:
 * gemessen am 2026-08-10 meldet `du` für `.werkzeuge` 2,2 GB, `df` aber nur 1,26 GB
 * tatsächlich belegt — auf APFS klont uv die Dateien in die venv, die Blöcke sind geteilt.
 * Auf einem Dateisystem ohne Klone oder harte Links wären es die vollen 2,2 GB.
 *
 * Gebraucht wird der Cache nach der Installation ohnehin nicht mehr: nachinstalliert wird
 * hier nie etwas. Er wird deshalb am Ende gelöscht — siehe `doclingEinrichten`.
 */
function uvUmgebung(): Record<string, string> {
  return { UV_CACHE_DIR: uvCacheVerzeichnis() };
}

/**
 * Ein einseitiges PDF mit etwas Text — Futter für den Probelauf, der die Modelle holt.
 *
 * Erzeugt statt mitgeliefert, weil eine Binärdatei im Repo bei jedem Vendor-Abgleich
 * erklärt werden müsste. Die Querverweistabelle wird mitgerechnet; ein PDF ohne gültige
 * `xref` lassen manche Parser durchgehen und andere nicht, und diese Datei soll nicht die
 * Ursache eines Fehlschlags sein können.
 */
function probePdf(): Buffer {
  const objekte = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const inhalt = "BT /F1 12 Tf 72 760 Td (SZKS Einrichtung: Probelauf) Tj ET\n";
  objekte.push(`<< /Length ${inhalt.length} >>\nstream\n${inhalt}endstream`);

  let pdf = "%PDF-1.4\n";
  const versatz: number[] = [];
  objekte.forEach((koerper, i) => {
    versatz.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${koerper}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n`;
  for (const v of versatz) pdf += `${String(v).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/**
 * Wärmt die Modelle über einen echten Konvertierungslauf vor — mit denselben Schaltern, die
 * `vendor/pdf-markdown.ts` später benutzt, und derselben `DOCLING_CACHE_DIR` wie zur
 * Laufzeit. Alles andere wärmte einen Pfad vor, den niemand nimmt (siehe Kopf der Datei).
 */
async function modelleVorwaermen(doclingBin: string, melde: (zeile: string) => void): Promise<void> {
  const arbeit = await mkdtemp(path.join(os.tmpdir(), "szks-vorwaermen-"));
  try {
    const pdf = path.join(arbeit, "probe.pdf");
    await writeFile(pdf, probePdf());
    await ausfuehren(
      doclingBin,
      ["convert", "--to", "json", "--image-export-mode", "placeholder", "--output", arbeit, pdf],
      {
        frist: FRIST_PROBELAUF_MS,
        melde,
        umgebung: {
          // Dieselbe Variable wie zur Laufzeit (`umgebungSetzen` in `src/config.ts`).
          // RapidOCR und alles andere sollen ihre Gewichte dorthin legen, wo sie beim
          // ersten echten Lauf gesucht werden — sonst wäre der Probelauf umsonst.
          DOCLING_CACHE_DIR: cacheVerzeichnis(),
          // Ohne das kompiliert torch die Layout-Modelle und schreibt dabei 37 Zeilen
          // Graph-Break-Warnungen samt Python-Traceback. Gemessen: 14 s statt 7 s, und
          // ein Tester liest eine Wand aus `W... torch/_dynamo/...` als Absturz. Geholt
          // werden sollen hier die Gewichte; kompiliert wird ohnehin pro Prozess, der
          // erste echte Lauf tut es also so oder so.
          DOCLING_INFERENCE_COMPILE_TORCH_MODELS: "false",
          // tqdm zeichnet seine Balken aus Blockzeichen (U+2588) und überschreibt die
          // Zeile per `\r`. In einer zeilenweise mitgeschriebenen Ausgabe ist das keine
          // Anzeige mehr, sondern Müll — und auf einer älteren Windows-Konsole werden
          // daraus Fragezeichen. Die Balken tragen hier nichts bei: die
          // HuggingFace-Downloads laufen ohnehin ohne Fortschrittsanzeige (Docling ruft
          // `disable_progress_bars()`), sichtbar bleiben die INFO-Zeilen.
          TQDM_DISABLE: "1",
        },
      },
    );
  } finally {
    await rm(arbeit, { recursive: true, force: true });
  }
}

async function merkzettelSchreiben(): Promise<void> {
  const inhalt = {
    uv: UV_VERSION,
    docling: DOCLING_VERSION,
    python: PYTHON_VERSION,
    zeitpunkt: new Date().toISOString(),
  };
  await writeFile(merkzettelDatei(), JSON.stringify(inhalt, null, 2) + "\n", "utf8");
}

/**
 * War die Einrichtung schon einmal vollständig? Der Merkzettel allein genügt nicht — die
 * venv kann gelöscht worden sein, während die Datei liegen blieb.
 */
async function bereitsEingerichtet(): Promise<boolean> {
  if (!existsSync(merkzettelDatei())) return false;
  return doclingVerfuegbar();
}

/**
 * Übersetzt bekannte Fehlschläge in Klartext samt Abhilfe.
 *
 * Der Anlass ist ein echter Fehlschlag vom 2026-08-10 auf einem Windows-Rechner: Alle 104
 * Pakete installierten sauber, und erst der Probelauf endete mit
 * `OSError: [WinError 1114] ... Error loading "torch\lib\c10.dll"`. Darunter standen 40
 * Zeilen Python-Traceback, und die Batchdatei setzte obendrauf ihren Standardsatz „meist
 * fehlt Internet, blockt eine Firewall oder ist die Platte voll" — drei Ursachen, die hier
 * alle nachweislich **nicht** vorlagen. Wer das liest, sucht garantiert an der falschen
 * Stelle.
 *
 * Der Windows-Fehlercode trägt die Unterscheidung, auf die es ankommt:
 *
 * | Code | Bedeutung | heißt hier |
 * |---|---|---|
 * | 126 | Modul nicht gefunden | eine **fehlende** Abhängigkeit, meist die VC++-Laufzeit |
 * | 1114 | Initialisierungsroutine fehlgeschlagen | die DLL **wurde geladen** und ist dann gescheitert |
 *
 * 1114 schließt also aus, was der Standardsatz behauptet: Der Download war vollständig,
 * die Datei liegt da, sie wird gefunden. Gescheitert ist erst ihr Start — an einer
 * unpassenden Laufzeitbibliothek, einer älteren fremden DLL, die auf dem PATH zuerst
 * gefunden wird, oder einer CPU ohne die Befehlssätze, die dieses torch voraussetzt.
 */
function windowsHinweis(text: string): string | null {
  if (!IST_WINDOWS && !/WinError/.test(text)) return null;

  /**
   * Das ZIP-Paket legt einen fertigen Reparaturweg daneben, ein Klon nicht. Ein Hinweis,
   * der auf eine Datei zeigt, die es hier nicht gibt, schickt die Fehlersuche in die Irre
   * — also wird nachgesehen statt angenommen.
   */
  const reparieren = path.join(REPO_ROOT, "C++-LAUFZEIT-REPARIEREN.cmd");
  const laufzeitWeg = existsSync(reparieren)
    ? "     C++-LAUFZEIT-REPARIEREN.cmd im Programmordner doppelklicken,\n" +
      "     danach EINRICHTEN.cmd erneut starten."
    : "     https://aka.ms/vs/17/release/vc_redist.x64.exe   (Administratorrechte nötig)";

  if (/WinError 1114/.test(text) && /c10\.dll|torch/i.test(text)) {
    return [
      "Das ist kein Fehler der Einrichtung: Alle Pakete sind installiert, und die Datei",
      "torch\\lib\\c10.dll liegt vor und wurde gefunden. Windows-Fehler 1114 heißt, dass sie",
      "beim Starten gescheitert ist — nicht, dass sie fehlt. Netz, Firewall und",
      "Speicherplatz scheiden damit aus.",
      "",
      "Der Reihe nach:",
      "  1. Die Microsoft C++ Laufzeit reparieren — sie ist da, aber womöglich zu alt:",
      laufzeitWeg,
      "  2. Hilft das nicht, ist die CPU zu alt: Aktuelle torch-Fassungen setzen AVX2",
      "     voraus, Rechner von vor etwa 2013 haben es nicht. Die CPU zeigt",
      '     powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).Name"',
    ].join("\n");
  }

  if (/WinError 126/.test(text)) {
    return [
      "Windows-Fehler 126 heißt: eine benötigte Bibliothek wurde nicht gefunden. Auf einem",
      "frischen Windows fehlt dafür fast immer die Microsoft C++ Laufzeit.",
      laufzeitWeg.trimStart(),
    ].join("\n");
  }

  return null;
}

/** Richtet uv + venv + docling + Modelle ein. `melde` bekommt Fortschrittszeilen. */
export async function doclingEinrichten(
  melde: (zeile: string) => void,
): Promise<{ ok: boolean; pfad: string | null; meldung: string }> {
  try {
    if (await bereitsEingerichtet()) {
      const pfad = doclingPfad();
      melde("Docling ist bereits eingerichtet — nichts zu tun.");
      return { ok: true, pfad, meldung: `Docling einsatzbereit: ${pfad}` };
    }

    melde(`Werkzeugverzeichnis: ${werkzeugVerzeichnis()}`);
    langePfadeWarnen(melde);

    const venv = venvVerzeichnis();

    /**
     * Der teure Teil wird übersprungen, wenn er nachweislich schon steht. Nachweis ist
     * nicht „das Verzeichnis existiert", sondern „das Binary läuft" — ein abgebrochener
     * Download hinterlässt beides Mal ein Verzeichnis, aber nur einmal ein lauffähiges
     * Docling. Fehlt der Nachweis, ist die venv Schrott und wird neu gebaut: `uv pip
     * install` in eine halb angelegte venv hinein scheiterte später an fehlenden Teilen,
     * und zwar erst beim ersten Parse.
     */
    if (await doclingVerfuegbar()) {
      melde("venv mit Docling ist bereits vorhanden — es fehlen nur noch die Modelle.");
    } else {
      const uv = await uvBeschaffen(melde);

      if (existsSync(venv)) {
        melde("Unvollständige venv gefunden — wird neu angelegt.");
        await rm(venv, { recursive: true, force: true });
      }

      melde(`Python ${PYTHON_VERSION} und venv werden angelegt (uv lädt CPython selbst) ...`);
      await ausfuehren(uv, ["venv", "--python", PYTHON_VERSION, venv], {
        frist: FRIST_VENV_MS,
        melde,
        umgebung: uvUmgebung(),
      });

      const python = venvBinaer("python");
      melde(
        `Docling ${DOCLING_VERSION} wird installiert — rund 1,1 GB, das dauert einige Minuten ...`,
      );
      await ausfuehren(uv, ["pip", "install", "--python", python, `docling==${DOCLING_VERSION}`], {
        frist: FRIST_INSTALL_MS,
        melde,
        umgebung: uvUmgebung(),
      });
    }

    const doclingBin = doclingPfad();
    if (!doclingBin) {
      throw new Error(
        `Nach der Installation fehlt ${venvBinaer("docling")}.\n` +
          `  Das deutet auf eine abgebrochene Installation hin — Verzeichnis löschen und erneut versuchen:\n` +
          `  ${venv}`,
      );
    }

    // Der Hinweis auf die Stille ist kein Beiwerk: Docling lädt die HuggingFace-Modelle
    // mit abgeschalteter Fortschrittsanzeige (`download_hf_model(progress=False)`). Hier
    // vergehen also Minuten ohne eine einzige Zeile, und ohne diesen Satz sieht das aus
    // wie ein hängendes Programm.
    melde("Modelle werden vorgewärmt (Layout, TableFormer und OCR, rund 550 MB) ...");
    melde("Dabei bleibt es einige Minuten still — das ist normal.");
    await modelleVorwaermen(doclingBin, melde);

    if (!(await doclingVerfuegbar())) {
      throw new Error(`${doclingBin} ist vorhanden, aber "docling --version" schlägt fehl.`);
    }

    // Erst jetzt, nach dem letzten Schritt, der schiefgehen kann: Vorher gelöscht, müsste
    // ein zweiter Anlauf die 1,1 GB erneut ziehen.
    await rm(uvCacheVerzeichnis(), { recursive: true, force: true });

    await merkzettelSchreiben();
    melde("Fertig.");
    return { ok: true, pfad: doclingBin, meldung: `Docling einsatzbereit: ${doclingBin}` };
  } catch (fehler) {
    // Diese Funktion wirft nicht: sie wird aus dem postinstall und aus dem
    // Einrichtungsdialog gerufen, und beide sollen den Fehlschlag berichten statt daran
    // zu zerbrechen.
    const text = fehler instanceof Error ? fehler.message : String(fehler);
    const hinweis = windowsHinweis(text);
    return {
      ok: false,
      pfad: doclingPfad(),
      meldung:
        `Docling konnte nicht eingerichtet werden.\n${text}\n\n` +
        (hinweis ? `${hinweis}\n\n` : "") +
        `Nachholen mit:  npm run setup:docling`,
    };
  }
}
