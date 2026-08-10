/**
 * Wo das Werkzeug seine Dateien ablegt — die eine Stelle, an der macOS und Windows
 * auseinandergehen.
 *
 * ## Warum nicht einfach neben den Code
 *
 * Der Parser leitet sein Standard-Cache-Verzeichnis aus `import.meta.url` ab
 * (`vendor/pdf-markdown.ts`). Im Pipeline-Repo ist das harmlos — dort liegt der Code in
 * einem Arbeitsverzeichnis. Bei einem ausgelieferten Werkzeug ist das
 * Installationsverzeichnis unter Windows aber nicht verlässlich beschreibbar (Programme,
 * Netzlaufwerk, Richtlinie). Deshalb setzt das CLI `DOCLING_CACHE_DIR` und `DOCLING_BIN`
 * **explizit**, bevor irgendetwas parst, und die Vendor-Vorgabe kommt nie zum Zug.
 *
 * ## Zwei Orte, bewusst getrennt
 *
 * - **Werkzeuge und Cache** liegen im Repo (`.werkzeuge/`, `.cache/`) — sie gehören zur
 *   Installation und verschwinden mit ihr. 1,2 GB Python im Benutzerprofil
 *   zurückzulassen, nachdem jemand den Ordner gelöscht hat, wäre unhöflich.
 * - **Die Konfiguration** liegt im Benutzerprofil — sie überlebt ein Neuklonen des Repos,
 *   und genau das will man: die Schlüssel gibt man einmal ein.
 *
 * Ist das Repo nicht beschreibbar, weichen die ersten beiden ins Benutzerprofil aus.
 */

import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `src/pfade.ts` → das Repo ist ein Verzeichnis höher. */
export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const APP = "szks-extraktion";

/** Betriebssystem-Konvention für Anwendungsdaten. */
export function datenVerzeichnis(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), APP);
}

/**
 * Schreibt eine leere Datei und löscht sie sofort wieder.
 *
 * Nur für Windows. Dort beantwortet `accessSync(W_OK)` die gestellte Frage **nicht**: Die
 * Node-Dokumentation zu `fs.access` sagt ausdrücklich, dass die Zugriffssteuerungslisten
 * nicht geprüft werden und ein Pfad deshalb als zugänglich gemeldet wird, obwohl die Liste
 * das Schreiben verbietet. Für ein Verzeichnis bleibt am Ende nur das Nur-Lesen-Attribut,
 * und das bedeutet dort keine Schreibsperre — die Prüfung ginge also praktisch immer gut
 * aus.
 *
 * Damit wäre der Ausweichweg ins Benutzerprofil ausgerechnet auf dem System wirkungslos,
 * für das er geschrieben wurde: Installation unter `C:\Program Files`, auf einem
 * Netzlaufwerk oder unter einer Gruppenrichtlinie. Der Fehlschlag käme erst später und
 * anderswo — beim ersten `mkdir` mitten in der Einrichtung.
 *
 * Ein echter Schreibversuch ist die einzige Auskunft, die zählt. Er kostet eine Datei von
 * null Bytes.
 */
function schreibprobe(verzeichnis: string): boolean {
  const probe = path.join(verzeichnis, `.schreibprobe-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(probe, "");
    return true;
  } catch {
    return false;
  } finally {
    // Auch dann versuchen, wenn das Schreiben scheiterte: ein halb angelegter Rest wäre
    // schlimmer als ein überflüssiger Löschversuch.
    try {
      rmSync(probe, { force: true });
    } catch {
      // Nichts zu räumen, oder es darf nicht geräumt werden — beides ändert die Antwort nicht.
    }
  }
}

function beschreibbar(verzeichnis: string): boolean {
  try {
    // Geprüft wird das erste existierende Elternverzeichnis: `dir` selbst gibt es beim
    // ersten Start noch nicht, und `mkdir` würde es anlegen, bevor die Frage beantwortet
    // ist, ob es überhaupt darf.
    let p = verzeichnis;
    while (!existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
    if (process.platform === "win32") return schreibprobe(p);
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bevorzugt das Repo, weicht ins Benutzerprofil aus. Der Rückgabewert ist angelegt.
 */
function imRepoOderProfil(unterRepo: string, unterProfil: string): string {
  const bevorzugt = path.join(REPO_ROOT, unterRepo);
  const ziel = beschreibbar(bevorzugt) ? bevorzugt : path.join(datenVerzeichnis(), unterProfil);
  mkdirSync(ziel, { recursive: true });
  return ziel;
}

/** uv-Binary und die Docling-venv. */
export function werkzeugVerzeichnis(): string {
  return imRepoOderProfil(".werkzeuge", "werkzeuge");
}

/** Geparste Dokumente. Ein Dokument wird genau einmal gelesen und einmal per OCR bezahlt. */
export function cacheVerzeichnis(): string {
  return imRepoOderProfil(path.join(".cache", "docling"), path.join("cache", "docling"));
}

/** Voreinstellung für die CSV-Ausgabe; über die Konfiguration überschreibbar. */
export function ergebnisVerzeichnisDefault(): string {
  const imRepo = path.join(REPO_ROOT, "ergebnisse");
  if (beschreibbar(imRepo)) return imRepo;
  return path.join(os.homedir(), "Documents", "SZKS-Extraktion");
}

/** Pfad zur Konfigurationsdatei. Das Verzeichnis wird hier **nicht** angelegt. */
export function konfigDatei(): string {
  return path.join(datenVerzeichnis(), "config.json");
}
