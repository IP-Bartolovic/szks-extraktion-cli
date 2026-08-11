/**
 * Ein Durchlauf: PDF hinein, CSV heraus.
 *
 * ## Warum die Vendor-Module dynamisch geladen werden
 *
 * `umgebungSetzen` (siehe `config.ts`) übersetzt die Einstellungen in Umgebungsvariablen,
 * die der kopierte Laufzeitpfad direkt aus `process.env` liest — `DOCLING_CACHE_DIR`,
 * `DOCLING_BIN`, `MISTRAL_API_KEY`, und vor allem `LANGSMITH_TRACING=false`. Statische
 * `import`-Anweisungen werden vor dem ersten Anweisungsschritt eines Moduls ausgewertet;
 * ein `import` aus `vendor/` am Dateikopf liefe also **vor** dem Setzen der Variablen. Das
 * ist heute folgenlos (die Zugriffe stehen dort in Funktionsrümpfen), aber es ist eine
 * Reihenfolge, die niemand beim nächsten Vendor-Abgleich nachprüfen kann. Deshalb hier:
 * erst setzen, dann laden. Am Dateikopf stehen ausschließlich `import type` — die
 * verschwinden beim Übersetzen restlos.
 *
 * ## Warum `stream` und nicht `runPipeline`
 *
 * `vendor/graph.ts` bietet `runPipeline` an, das intern `app.invoke()` benutzt und erst am
 * Ende etwas zurückgibt. Ein Lauf dauert Minuten — Docling parst, danach laufen die
 * Extraktions-Calls. Ein Werkzeug, das in dieser Zeit nichts sagt, ist von einem
 * abgestürzten nicht zu unterscheiden. `build()` liefert denselben Graphen, und
 * `app.stream(..., { streamMode: "updates" })` meldet jeden fertigen Knoten einzeln. Der
 * Graph selbst bleibt unverändert — die Anzeige liest mit, sie greift nicht ein.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aufgeloest, laden, merkeDokument, speichern, umgebungSetzen } from "./config.js";
import { doclingPfad, doclingVerfuegbar } from "./docling.js";
import type { BatchResult } from "../vendor/nodes/extract.js";
import type { ExtractionSummary } from "../vendor/nodes/summarize.js";
import type { PdfParseResult } from "../vendor/pdf-markdown.js";
import type { PipelineStateType } from "../vendor/graph.js";

export interface Laufergebnis {
  summary: ExtractionSummary;
  csvPfad: string;
  /** Leer im Normalfall. Nicht leer heißt: das Ergebnis hat Lücken, die nicht am Dokument liegen. */
  fehlgeschlagene: BatchResult[];
}

// ---------------------------------------------------------------------------
// Fortschrittsanzeige
// ---------------------------------------------------------------------------

/** Breite der Schrittspalte inklusive der auffüllenden Punkte. */
const SCHRITT_BREITE = 18;

function schrittKopf(titel: string): string {
  return `${titel} ${".".repeat(Math.max(1, SCHRITT_BREITE - titel.length - 1))}`;
}

/**
 * Vier Zeilen, die sich selbst aktualisieren — bewusst ohne Fortschrittsbalken-Bibliothek.
 *
 * Ein Balken bräuchte einen Gesamtwert, den es für den langsamsten Schritt gar nicht gibt:
 * wie lange Docling für ein Dokument braucht, weiß niemand vorher. Was Ben wirklich
 * beantwortet haben will, ist „läuft es noch" — dafür genügt eine mitzählende Sekundenzahl.
 *
 * Aktualisiert wird nur, wenn die Ausgabe an einem Terminal hängt. Läuft sie in eine Datei
 * oder durch eine Pipe, hinterlässt jedes `\r` dort eine unleserliche Zeile; dann wird
 * ausschließlich das Ergebnis jedes Schritts geschrieben.
 *
 * Exportiert, obwohl außerhalb dieser Datei niemand sie benutzt: nur so lässt sich die
 * Anzeige vorführen und nachmessen, ohne einen echten Lauf zu starten — und ein echter Lauf
 * kostet Geld. Eine Anzeige, die man nur im Ernstfall zu sehen bekommt, ist eine Anzeige,
 * deren Spaltenausrichtung niemand geprüft hat.
 */
export class Fortschritt {
  private readonly interaktiv = Boolean(process.stdout.isTTY);
  private kopf = "";
  private zusatz = "";
  private start = 0;
  private takt: NodeJS.Timeout | null = null;
  /** Längste bisher geschriebene Zeile — zum Überschreiben mit Leerzeichen. */
  private breiteste = 0;

  starten(titel: string, zusatz = "läuft"): void {
    this.beenden();
    this.kopf = schrittKopf(titel);
    this.zusatz = zusatz;
    this.start = Date.now();
    if (!this.interaktiv) return;
    this.zeichnen();
    // Eine Sekunde ist langsam genug, um nicht zu flackern, und schnell genug, dass die
    // Zahl sich sichtbar bewegt.
    this.takt = setInterval(() => this.zeichnen(), 1000);
    this.takt.unref();
  }

  /** Text hinter den Punkten ersetzen, ohne den Schritt abzuschließen (z. B. „3/9"). */
  aktualisieren(zusatz: string): void {
    this.zusatz = zusatz;
    if (this.interaktiv) this.zeichnen();
  }

  /** Den laufenden Schritt festschreiben. Diese Zeile bleibt stehen. */
  abschliessen(zusatz: string): void {
    const zeile = `${this.kopf} ${zusatz}`;
    this.beenden();
    if (this.interaktiv) process.stdout.write(`\r${this.aufgefuellt(zeile)}\n`);
    else console.log(zeile);
    this.breiteste = 0;
  }

  /** Aufräumen, wenn ein Lauf mitten im Schritt scheitert — sonst bleibt der Takt hängen. */
  beenden(): void {
    if (this.takt) {
      clearInterval(this.takt);
      this.takt = null;
    }
  }

  private zeichnen(): void {
    const sekunden = Math.round((Date.now() - this.start) / 1000);
    const zeit = sekunden > 0 ? ` (${sekunden} s)` : "";
    process.stdout.write(`\r${this.aufgefuellt(`${this.kopf} ${this.zusatz}${zeit}`)}`);
  }

  /**
   * Mit Leerzeichen bis zur bisher längsten Zeile auffüllen. Der übliche Weg wäre die
   * ANSI-Sequenz zum Zeilenlöschen; sie ist unter Windows aber nur mit eingeschalteter
   * VT-Verarbeitung sichtbar und stünde sonst als Buchstabensalat in der Zeile. Leerzeichen
   * funktionieren überall.
   */
  private aufgefuellt(zeile: string): string {
    const laenge = Array.from(zeile).length;
    const gefuellt = zeile + " ".repeat(Math.max(0, this.breiteste - laenge));
    this.breiteste = Math.max(this.breiteste, laenge);
    return gefuellt;
  }
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

/**
 * Was nach dem Parsen über das Dokument feststeht.
 *
 * Seitenzahl und Scan-Seiten sind vorher **nicht** bekannt — sie stehen erst im Ergebnis
 * von Docling.
 *
 * **Ohne Betrag.** Die OCR-Kosten standen hier einmal (rund 8 Cent für ein 21-seitiges
 * Dokument) und sind für den Ablauf ohne Belang: Ben entscheidet nichts danach, und wer
 * abrechnet, sieht sie an anderer Stelle. Eine Zahl, die bei jedem Lauf mitläuft und nie
 * zu einer Handlung führt, ist Rauschen — und ein Preisschild an jedem Dokument setzt
 * beim Erproben genau den falschen Anreiz. Was **bleibt**, ist der Hinweis auf einen Lauf
 * ohne Mistral-Schlüssel: Der ändert die Qualität des Ergebnisses.
 */
function leseText(parsed: PdfParseResult): string {
  const teile = [`${parsed.pages} Seiten`];

  // Der abweichende Leser wird **immer** genannt, nicht nur auf Nachfrage. Ein Befund aus
  // dem OCR-Weg sagt über die produktive Pipeline nur bedingt etwas aus, und die einzige
  // Stelle, an der das noch auffallen kann, ist hier — später steht in der CSV nur der
  // Wert. Der Docling-Weg bleibt stumm: Er ist der Normalfall, und eine Zeile, die bei
  // jedem Lauf dasselbe sagt, wird nach dem dritten Mal nicht mehr gelesen.
  if (parsed.parser === "mistral-ocr") {
    teile.push("vollständig per Mistral OCR gelesen (nicht der geprüfte Weg)");
  } else if (parsed.scanPages.length > 0) {
    const zusatz = parsed.ocrPages.length > 0 ? "" : " (ohne Mistral-Schlüssel gelesen)";
    teile.push(`${parsed.scanPages.length} davon gescannt${zusatz}`);
  }
  return teile.join(", ");
}

/** Zeitstempel im Dateinamen: zwei Läufe desselben Dokuments bleiben nebeneinander vergleichbar. */
function zielDateiname(pdfPfad: string, jetzt: Date): string {
  const zwei = (n: number) => String(n).padStart(2, "0");
  const datum = `${jetzt.getFullYear()}-${zwei(jetzt.getMonth() + 1)}-${zwei(jetzt.getDate())}`;
  const uhrzeit = `${zwei(jetzt.getHours())}${zwei(jetzt.getMinutes())}`;
  // Windows verbietet diese Zeichen im Dateinamen; ein PDF darf sie im Namen tragen. Der
  // Bindestrich bleibt erhalten: er steckt in fast jeder Anfragenummer (VKB-2026-0143),
  // und ersetzt wäre die Datei schwerer wiederzuerkennen, als der Zeitstempel sie ordnet.
  const name = path
    .basename(pdfPfad, path.extname(pdfPfad))
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_");
  return `${datum}_${uhrzeit}_${name}.csv`;
}

// ---------------------------------------------------------------------------
// Der Durchlauf
// ---------------------------------------------------------------------------

/** Ein Ereignis aus `streamMode: "updates"`: Knotenname → das, was der Knoten geschrieben hat. */
type KnotenEreignis = Record<string, Partial<PipelineStateType> | undefined>;

/**
 * Wertet ein PDF aus und schreibt die CSV. `null` heißt: der Lauf hat nicht stattgefunden,
 * der Grund steht bereits im Terminal.
 */
export async function auswerten(pdfPfad: string): Promise<Laufergebnis | null> {
  const cfg = laden();

  // Muss vor dem ersten Vendor-Import stehen — siehe Modulkommentar.
  umgebungSetzen(cfg, doclingPfad());

  // Welcher Leser eingestellt ist, entscheidet, was überhaupt vorhanden sein muss. Beide
  // Prüfungen laufen **vor** dem ersten teuren Schritt: Ein Abbruch nach dem Parsen wäre
  // bei OCR ein bezahlter Abbruch.
  const gewaehlt = aufgeloest(cfg).parser;

  if (gewaehlt === "mistral-ocr") {
    if (!aufgeloest(cfg).mistralApiKey) {
      console.log();
      console.log("Der Leser „Mistral OCR“ ist eingeschaltet, aber es fehlt der Mistral API Key.");
      console.log("  Ohne ihn lässt sich das Dokument nicht lesen.");
      console.log("  Einstellungen → Mistral API Key eintragen,");
      console.log("  oder dort wieder auf Docling umstellen.");
      return null;
    }
  } else if (!(await doclingVerfuegbar())) {
    console.log();
    console.log("Docling ist nicht eingerichtet.");
    console.log("  Docling liest das PDF und erzeugt daraus Text, Überschriften und Tabellen.");
    console.log("  Ohne Docling lässt sich kein Dokument auswerten.");
    console.log("  Menüpunkt „Docling einrichten“ — oder in der Konsole: npm run setup:docling");
    console.log();
    console.log("  Alternative ohne Docling: Einstellungen → Leser auf „Mistral OCR“ stellen.");
    console.log("  Das liest das ganze Dokument per OCR, kostet rund 0,4 Cent je Seite und");
    console.log("  weicht vom geprüften Weg ab — die Ausgabe weist es aus.");
    return null;
  }

  const [{ build }, { istNotbehelf }, { toCsv }] = await Promise.all([
    import("../vendor/graph.js"),
    import("../vendor/pdf-markdown.js"),
    import("../vendor/export/csv.js"),
  ]);

  console.log();
  console.log(`Dokument: ${path.basename(pdfPfad)}`);
  console.log();

  const anzeige = new Fortschritt();
  const batchErgebnisse: BatchResult[] = [];
  let summary: ExtractionSummary | null = null;
  let batchAnzahl = 0;
  let notbehelf = false;

  try {
    const app = build();
    const strom = await app.stream({ sourcePath: pdfPfad }, { streamMode: "updates" });

    anzeige.starten("Lesen");
    for await (const roh of strom) {
      const ereignis = roh as unknown as KnotenEreignis;

      for (const [knoten, aktualisierung] of Object.entries(ereignis)) {
        if (!aktualisierung) continue;

        if (knoten === "parse") {
          const parsed = aktualisierung.parsed as PdfParseResult | null | undefined;
          if (!parsed) continue;
          notbehelf = istNotbehelf(parsed);
          anzeige.abschliessen(leseText(parsed));
          anzeige.starten("Aufteilen");
          continue;
        }

        if (knoten === "chunk") {
          batchAnzahl = aktualisierung.batches?.length ?? 0;
          anzeige.abschliessen(`${batchAnzahl} ${batchAnzahl === 1 ? "Batch" : "Batches"}`);
          anzeige.starten("Extraktion", `0/${batchAnzahl}`);
          continue;
        }

        if (knoten === "extract") {
          // Fan-out: derselbe Knotenname kommt einmal je Batch. Gezählt wird deshalb, was
          // angekommen ist, statt einen Zähler hochzuzählen — bei einem Ereignis, das
          // mehrere Ergebnisse trägt, wäre der Zähler sonst zu klein.
          const neu = (aktualisierung.batchResults ?? []) as BatchResult[];
          batchErgebnisse.push(...neu);
          anzeige.aktualisieren(`${batchErgebnisse.length}/${batchAnzahl}`);
          continue;
        }

        if (knoten === "merge") {
          anzeige.abschliessen(`${batchErgebnisse.length}/${batchAnzahl}`);
          // `derive` und `summarize` rechnen nur und brauchen zusammen Bruchteile einer
          // Sekunde; eine eigene Zeile je Schritt wäre Anzeige ohne Aussage.
          anzeige.starten("Zusammenführen");
          continue;
        }

        if (knoten === "summarize") {
          summary = (aktualisierung.summary ?? null) as ExtractionSummary | null;
          anzeige.abschliessen("fertig");
        }
      }
    }
  } catch (fehler) {
    anzeige.beenden();
    console.log();
    console.log("Der Lauf ist abgebrochen.");
    for (const zeile of String(fehler instanceof Error ? fehler.message : fehler).split("\n")) {
      console.log(`  ${zeile}`);
    }
    return null;
  } finally {
    anzeige.beenden();
  }

  if (!summary) {
    console.log();
    console.log("Der Lauf hat kein Ergebnis geliefert.");
    return null;
  }

  // Ein Teilausfall darf nicht als vollständiges Ergebnis durchgehen: die fehlenden Felder
  // sehen in der CSV genauso aus wie Felder, zu denen das Dokument nichts sagt.
  const fehlgeschlagene = batchErgebnisse.filter((b) => b.error);
  if (fehlgeschlagene.length > 0) {
    console.log();
    console.log(`Achtung: ${fehlgeschlagene.length} von ${batchErgebnisse.length} Teilauswertungen sind fehlgeschlagen.`);
    for (const b of fehlgeschlagene) {
      console.log(`  Teil ${b.batchIndex + 1} (Seiten ${b.pageRange[0]}-${b.pageRange[1]}): ${b.error}`);
    }
    console.log("  Fehlende Felder können daran liegen und nicht am Dokument.");
  }

  if (notbehelf) {
    console.log();
    console.log("Hinweis: Gescannte Seiten wurden ohne Mistral-Schlüssel gelesen.");
    console.log("  Werte von diesen Seiten sind weniger verlässlich. Schlüssel unter „Einstellungen“.");
  }

  const ziel = path.join(aufgeloest(cfg).ergebnisVerzeichnis, zielDateiname(pdfPfad, new Date()));
  mkdirSync(path.dirname(ziel), { recursive: true });
  writeFileSync(ziel, toCsv(summary), "utf8");

  speichern(merkeDokument(cfg, pdfPfad));

  return { summary, csvPfad: ziel, fehlgeschlagene };
}
