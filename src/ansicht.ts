/**
 * Alles, was das Werkzeug im Terminal zeigt: die Zusammenfassung eines Laufs und die
 * Bausteine, aus denen die übrigen Module ihre Anzeige zusammensetzen.
 *
 * ## Warum nicht einfach alle 71 Felder ausgeben
 *
 * Die vollständige Liste steht in der CSV, und dort gehört sie hin — sie wird
 * weiterverarbeitet. Im Terminal ist Vollständigkeit kontraproduktiv: 71 Zeilen scrollen
 * die drei Zeilen weg, die Ben tatsächlich braucht. Sofort sichtbar ist deshalb nur, was
 * eine Handlung auslöst — fehlende Prio-Werte (nachfragen), unklare Felder (prüfen) und die
 * ausdrücklichen Nicht-Vorgaben (frei wählbar, also eine Entscheidung von SZKS). Die
 * gefundenen Werte liegen hinter einem Menüpunkt; wer sie sehen will, findet sie, und wer
 * sie nicht sucht, wird nicht von ihnen zugedeckt.
 *
 * ## Umlaute: einstellen statt umgehen
 *
 * Eine erste Fassung schrieb die eigenen Beschriftungen absichtlich ohne Umlaute
 * („pruefen", „waehlbar"), aus Sorge vor einer alten Windows-Konsole mit Codepage 850.
 * Das löst nichts: Der weitaus größere Teil der Ausgabe kommt aus `vendor/`
 * (`STATUS_TEXT`, `UNKLAR_GRUND_TEXT`) und aus den Feldnamen des Katalogs —
 * „Kessellänge", „Gesamthöhe über Gelände" —, und die sind nicht verhandelbar: Sie sind
 * dieselbe Quelle, gegen die auch die CSV und der Importer arbeiten, eine transliterierte
 * Kopie liefe bei der nächsten Änderung still auseinander.
 *
 * Die Vermeidung hätte das Problem also nur halbiert und dafür ein Bild erzeugt, in dem
 * „Unklar - bitte pruefen" über „Kessellänge" steht. Stattdessen stellt `main.ts` die
 * Konsole einmalig auf UTF-8 (`chcp 65001`) — der eine Ort, an dem die Ursache liegt.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { select } from "@inquirer/prompts";
import { STATUS_TEXT, UNKLAR_GRUND_TEXT } from "../vendor/labels.js";
import type { ExtractionSummary, SummaryEntry } from "../vendor/nodes/summarize.js";

// ---------------------------------------------------------------------------
// Zeichenvorrat und Menü-Erscheinungsbild
// ---------------------------------------------------------------------------

/**
 * Kann die Konsole UTF-8 darstellen?
 *
 * Auf macOS immer. Unter Windows nur verlässlich im Windows Terminal — das alte
 * conhost-Fenster läuft standardmäßig auf Codepage 850, in der weder `›` noch `·`
 * existieren; dort erscheinen statt der Zeichen zwei Ersatzzeichen pro Glyphe. `WT_SESSION`
 * setzt ausschließlich das Windows Terminal, und im Zweifel wird zurückgefallen: ein
 * schlichteres Zeichen sieht nirgends kaputt aus, ein kaputtes Zeichen dagegen überall.
 */
function unicodeKonsole(): boolean {
  if (process.platform !== "win32") return true;
  return Boolean(process.env.WT_SESSION);
}

const UNICODE = unicodeKonsole();

/** Der Auswahlzeiger und der Aufzählungstrenner — je nach Konsole. */
export const ZEIGER = UNICODE ? "›" : ">";
const TRENNER = UNICODE ? " · " : ", ";

/**
 * Gemeinsames Erscheinungsbild aller Auswahllisten.
 *
 * Ohne `prefix` steht die Frage bündig links statt hinter einem `?`, und die beantwortete
 * Frage bleibt ohne Häkchen stehen — beides sind Glyphen aus demselben Risikobereich wie
 * oben, und beide tragen keine Information, die der Text nicht schon trägt.
 */
export const MENUE_THEMA = {
  prefix: "",
  icon: { cursor: ZEIGER },
  style: {
    // Der Vorgabetext ist englisch ("(Use arrow keys)"). Ben liest deutsch.
    keysHelpTip: () => "(Pfeiltasten bewegen, Enter wählt)",
  },
} as const;

/**
 * Dasselbe für Texteingaben. Eigene Konstante, weil `icon.cursor` und `style.keysHelpTip`
 * nur die Auswahlliste kennt — an einer Texteingabe wären es unbekannte Felder, und der
 * Übersetzer weist sie zu Recht ab.
 */
export const EINGABE_THEMA = {
  prefix: "",
} as const;

// ---------------------------------------------------------------------------
// Breiten und Kürzen
// ---------------------------------------------------------------------------

/**
 * Nutzbare Zeilenbreite.
 *
 * `process.stdout.columns` ist `undefined`, sobald die Ausgabe in eine Datei oder durch
 * eine Pipe läuft — dann gilt der Rückfallwert. Nach oben gedeckelt, weil eine über ein
 * breites Fenster gezogene Tabelle schlechter lesbar ist als eine kompakte: das Auge müsste
 * zwischen Feldname und Begründung eine handbreite Lücke überspringen.
 */
export function terminalBreite(): number {
  const roh = process.stdout.columns ?? 80;
  return Math.max(60, Math.min(100, roh));
}

/**
 * Auf `breite` **Zeichen** kürzen, nicht auf Bytes.
 *
 * `Buffer.byteLength("Höhe")` ist 5, die Spalte ist aber 4 Zeichen breit — an Bytes
 * gemessen würde jede Umlautzeile zu früh abgeschnitten. Gezählt wird über `Array.from`,
 * also in Code Points: `String.length` zählt UTF-16-Einheiten und würde ein Zeichen
 * außerhalb der Basisebene mitten im Surrogatpaar zerteilen, was ein Ersatzzeichen im
 * Terminal hinterlässt.
 */
export function kuerzen(text: string, breite: number): string {
  const zeichen = Array.from(text);
  if (zeichen.length <= breite) return text;
  if (breite <= 3) return zeichen.slice(0, Math.max(0, breite)).join("");
  return zeichen.slice(0, breite - 3).join("") + "...";
}

/** Kürzen und auf feste Breite auffüllen — ebenfalls in Zeichen gerechnet. */
function fuellen(text: string, breite: number): string {
  const gekuerzt = kuerzen(text, breite);
  return gekuerzt + " ".repeat(Math.max(0, breite - Array.from(gekuerzt).length));
}

/** Sichtbare Länge in Zeichen. */
function laenge(text: string): number {
  return Array.from(text).length;
}

/**
 * Breite der Feldnamen-Spalte. Fest, solange das Fenster es hergibt: eine mitwandernde
 * Spaltengrenze macht zwei Läufe nebeneinander unvergleichbar.
 */
function labelBreite(breite: number): number {
  return Math.max(18, Math.min(37, breite - 34));
}

const EINZUG = "  ";

// ---------------------------------------------------------------------------
// Werte lesbar machen
// ---------------------------------------------------------------------------

/**
 * Wie der CSV-Export (`vendor/export/csv.ts`), aber für Menschen statt für Excel: Komma als
 * Dezimaltrenner, Ja/Nein statt true/false. Bewusst eine eigene kleine Funktion und kein
 * Import — die dortige ist modulintern, und sie zu exportieren hieße, `vendor/` anzufassen.
 */
function wertText(e: SummaryEntry): string {
  const { value, unit } = e;
  if (value === null) return "";
  const roh =
    typeof value === "boolean" ? (value ? "Ja" : "Nein") : typeof value === "number" ? String(value).replace(".", ",") : value;
  const einzeilig = roh.replace(/\s+/g, " ").trim();
  if (!unit) return einzeilig;

  // Steht in einem Zahlenfeld ein Wortlaut, trägt er die Einheit fast immer schon mit sich
  // ("ca. 430-460 °C") — die zusätzliche Spalte ergäbe dann "ca. 430-460 °C °C". Bei
  // typkonformen Werten steht dort eine nackte Zahl, und die Einheit gehört daneben. Die
  // Prüfung ist absichtlich auf den Wortlaut-Fall beschränkt: ein Textwert wie
  // "Sonderlackierung" enthält zufällig ein "m", und eine allgemeine Suche würde die
  // Einheit "m" dort stillschweigend verschlucken.
  if (e.value_ist_wortlaut && einzeilig.toLowerCase().includes(unit.toLowerCase())) return einzeilig;
  return `${einzeilig} ${unit}`;
}

/** Rechtsbündige Zusatzangabe anhängen — ohne nachlaufende Leerzeichen, wenn es keine gibt. */
function rechtsbuendig(links: string, rechts: string, breite: number): string {
  if (!rechts) return links;
  return links + " ".repeat(Math.max(1, breite - laenge(links) - laenge(rechts))) + rechts;
}

/** `S. 7`, oder leer, wenn der Fundort nicht bestimmt werden konnte. */
function seitenText(e: SummaryEntry): string {
  return e.page !== null ? `S. ${e.page}` : "";
}

// ---------------------------------------------------------------------------
// Die Zusammenfassung
// ---------------------------------------------------------------------------

/**
 * Eine Gruppe: Überschrift mit Anzahl, dann je Feld eine Zeile aus Name und Begründung.
 * Die Überschrift entfällt samt Gruppe, wenn nichts drinsteht — eine Zeile "Unklar (0)"
 * kostet Platz und sagt dasselbe wie ihr Fehlen.
 */
function gruppeAusgeben(
  titel: string,
  eintraege: SummaryEntry[],
  begruendung: (e: SummaryEntry) => string,
  mitBeleg: boolean,
  breite: number,
): void {
  if (eintraege.length === 0) return;
  const lb = labelBreite(breite);

  console.log();
  console.log(`${titel} (${eintraege.length})`);
  for (const e of eintraege) {
    console.log(`${EINZUG}${fuellen(e.label, lb)}  ${kuerzen(begruendung(e), breite - lb - 4)}`);
    if (!mitBeleg || !e.evidence) continue;

    // Der Beleg ist der Grund, warum ein unklares Feld überhaupt entscheidbar ist: Ben soll
    // nicht ins PDF springen müssen, um zu sehen, worum es geht. Deshalb eingerückt unter
    // dem Feldnamen und mit der Seite rechtsbündig — die Seite ist die Angabe, die man
    // sucht, wenn der Beleg allein nicht reicht.
    const seite = seitenText(e);
    const platz = breite - 6 - (seite ? laenge(seite) + 2 : 0);
    const zitat = `"${kuerzen(e.evidence.replace(/\s+/g, " ").trim(), Math.max(10, platz - 2))}"`;
    console.log(`      ${rechtsbuendig(zitat, seite, breite - 6)}`);
  }
}

/**
 * Der Kopf eines Ergebnisses. Die zweite Zeile ist die eigentlich wichtige: die Prio-Felder
 * entscheiden, ob aus der Anfrage ein Angebot werden kann.
 */
export function zusammenfassungAusgeben(summary: ExtractionSummary): void {
  const breite = terminalBreite();
  const c = summary.counts;

  console.log();
  console.log(
    `Felder: ${c.found} gefunden${TRENNER}${c.uncertain} unklar${TRENNER}${c.missing} leer (von ${c.total})`,
  );
  console.log(`Prio:   ${c.prio_found} von ${c.prio_total} belegt`);

  gruppeAusgeben("Fehlende Prio-Werte", summary.missing_prio_fields, (e) => STATUS_TEXT[e.status], false, breite);

  gruppeAusgeben(
    "Unklar — bitte prüfen",
    summary.uncertain_fields,
    // Die Prio-Markierung steht **vor** dem Grund, nicht dahinter: die Spalte wird bei
    // schmalem Fenster von rechts gekürzt, und ein angehängtes "(Prio)" wäre genau das
    // Erste, was verschwindet. Nötig ist sie, damit die Zahlen im Kopf aufgehen — ein
    // unklares Prio-Feld fehlt in `prio_found`, steht aber nicht unter "Fehlende
    // Prio-Werte"; ohne die Markierung sucht Ben es in der falschen Liste.
    (e) => (e.prio ? "Prio: " : "") + (e.unklar_grund ? UNKLAR_GRUND_TEXT[e.unklar_grund] : STATUS_TEXT[e.status]),
    true,
    breite,
  );

  gruppeAusgeben(
    "Keine Vorgabe des Kunden",
    summary.missing_fields.filter((e) => e.status === "ausdruecklich_keine_vorgabe"),
    // Die Überschrift sagt bereits, worum es geht; `STATUS_TEXT` würde sie hier nur
    // wiederholen ("Keine Vorgabe (frei wählbar)"). Übrig bleibt die Folgerung.
    () => "frei wählbar",
    false,
    breite,
  );
}

/**
 * Die vollständige Werteliste — hinter einem Menüpunkt, nicht im Hauptbild.
 *
 * Gruppiert nach Kategorie statt als eine Kolonne aus 64 Zeilen: die Reihenfolge ist die
 * der Anfragemaske, und deren Kategorien sind die Struktur, in der Ben ohnehin denkt.
 */
export function gefundeneWerteAusgeben(summary: ExtractionSummary): void {
  const breite = terminalBreite();
  const lb = labelBreite(breite);

  console.log();
  console.log(`Gefundene Werte (${summary.fields_found.length})`);
  let letzteKategorie = "";
  for (const e of summary.fields_found) {
    if (e.category !== letzteKategorie) {
      console.log();
      console.log(`${e.category}`);
      letzteKategorie = e.category;
    }
    const seite = seitenText(e);
    const wert = kuerzen(wertText(e), Math.max(10, breite - lb - 6 - laenge(seite)));
    console.log(`${EINZUG}${fuellen(e.label, lb)}  ${rechtsbuendig(wert, seite, breite - lb - 4)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Ordner öffnen
// ---------------------------------------------------------------------------

/**
 * Den Ergebnisordner im Dateimanager zeigen.
 *
 * **`explorer.exe` liefert auch im Erfolgsfall den Exit-Code 1.** Das ist kein Fehler,
 * sondern seit jeher sein Verhalten: der Prozess startet ein Fenster im bereits laufenden
 * Explorer und beendet sich mit 1. Wer darauf eine Fehlermeldung baut, meldet Ben bei jedem
 * erfolgreichen Klick einen Fehler — deshalb wird der Code unter Windows gar nicht erst
 * ausgewertet.
 *
 * Der Prozess wird abgekoppelt (`detached` + `unref`), damit das Werkzeug nicht auf ein
 * Fenster wartet, das der Benutzer vielleicht stundenlang offen lässt.
 */
export function ordnerOeffnen(ordner: string): void {
  const befehl = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const kind = spawn(befehl, [ordner], { detached: true, stdio: "ignore" });
    kind.on("error", () => {
      console.log(`Ordner ließ sich nicht öffnen. Pfad: ${ordner}`);
    });
    kind.on("close", (code) => {
      if (process.platform !== "win32" && code !== 0) {
        console.log(`Ordner ließ sich nicht öffnen (Code ${code}). Pfad: ${ordner}`);
      }
    });
    kind.unref();
  } catch {
    console.log(`Ordner ließ sich nicht öffnen. Pfad: ${ordner}`);
  }
}

// ---------------------------------------------------------------------------
// Menü nach einem Lauf
// ---------------------------------------------------------------------------

/**
 * Was Ben nach einem Lauf tun kann. Bleibt offen, bis er zurück ins Hauptmenü will — die
 * Werteliste anzuzeigen soll nicht bedeuten, dass er den Weg zum Ordner verloren hat.
 */
export async function ergebnisMenue(summary: ExtractionSummary, csvPfad: string): Promise<void> {
  console.log();
  console.log(`CSV: ${csvPfad}`);

  for (;;) {
    console.log();
    const wahl = await select({
      message: "Weiter",
      theme: MENUE_THEMA,
      choices: [
        { value: "ordner", name: "Ordner öffnen" },
        { value: "werte", name: `Alle ${summary.fields_found.length} gefundenen Werte anzeigen` },
        { value: "zurueck", name: "Zurück zum Menü" },
      ],
    });

    if (wahl === "ordner") ordnerOeffnen(path.dirname(csvPfad));
    else if (wahl === "werte") gefundeneWerteAusgeben(summary);
    else return;
  }
}
