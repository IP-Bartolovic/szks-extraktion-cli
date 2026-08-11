/**
 * Der native PDF-Layer: Seitenzahl, Seitengeometrie, Text-Layer und Bildabdeckung —
 * gelesen von `pdfjs-dist`, ohne externes Binary.
 *
 * ## Warum nicht mehr poppler
 *
 * Bis zum 2026-08-10 lief dieser Teil über vier poppler-Aufrufe (`pdfinfo`, zweimal
 * `pdftotext`, `pdfimages`) — vier Prozesse über dieselbe Datei. Das funktioniert, aber es
 * bindet die Pipeline an ein Binary, das unter **Windows keinen Paketmanager-Weg hat**: es
 * gibt dort nur inoffizielle Builds, die von Hand in den PATH gelegt werden müssen. Docling
 * kommt über pip/uv und läuft überall; poppler war damit die einzige Voraussetzung, die eine
 * Windows-Installation zu einer Bastelaufgabe gemacht hätte.
 *
 * `pdfjs-dist` ist eine npm-Abhängigkeit ohne eigene Abhängigkeiten und liest dieselben vier
 * Größen in-process. Der Ersatz ist bewusst ein **Austausch der Datenquelle, keine Änderung
 * der Logik**: Schwellen, Klassifikation und Zusammenbau in `pdf-markdown.ts` bleiben
 * unangetastet.
 *
 * ## Ein Lesefehler wird geworfen, nicht weggesteckt
 *
 * Die poppler-Fassung hatte um jeden Aufruf einen weichen Fallback: fehlt das Binary, wird
 * „viel Text" angenommen und weitergemacht. Das war richtig, solange ein Binary schlicht
 * fehlen konnte. Bei einer npm-Abhängigkeit gibt es diesen Fall nicht — sie ist da, oder das
 * Paket ist kaputt.
 *
 * Ein stiller Fallback wäre hier auch teurer als ein Abbruch: „viel Text" heißt **keine
 * Scan-Seite erkannt**, und dann kommen gescannte Seiten unbemerkt aus Doclings verlustreichem
 * OCR statt aus Mistral. Gemessen sind das 13,8 % Tokenverlust gegen 0,3 % — und der Lauf meldet
 * dabei Erfolg. Genau dieser Fehlermodus (Erfolg melden, das Falsche messen) ist der Grund,
 * warum es `istNotbehelf()` gibt. Also: Fehler werfen.
 *
 * ## Die Bildabdeckung braucht den Transformationsstapel
 *
 * Die naive Variante — „nimm den `transform`-Operator direkt vor dem Bild-Operator" — liefert
 * durchgehend **0**. In der Praxis steht die Skalierung nicht in einem einzelnen `transform`
 * unmittelbar davor, sondern verteilt sich über `save`/`transform`/`restore`-Ebenen; erst das
 * Produkt aller aktiven Transformationen (die CTM) beschreibt die tatsächliche Bildfläche.
 * `groesstesBild` führt den Stapel deshalb mit und nimmt die Determinante der CTM am
 * Bild-Operator als Fläche in Punkt².
 *
 * ## Warum die Fontdaten mitgegeben werden
 *
 * Ohne `standardFontDataUrl` meldet pdfjs beim Textlesen auf stderr „Ensure that the
 * `standardFontDataUrl` API parameter is provided." — zweimal je Dokument, mitten in die
 * CLI-Ausgabe. Der saubere Weg ist, den Parameter zu liefern statt die Meldung zu filtern
 * oder über `verbosity` alle Warnungen stumm zu schalten; letzteres würde auch die Warnungen
 * verschlucken, die man sehen will. Gemessen: Als **Dateisystempfad** übergeben ist die
 * Ausgabe still, als `file://`-URL nicht (Node lädt darüber keine Dateien).
 *
 * Auf das Ergebnis hat es keinen Einfluss — mit und ohne Fontdaten liefern alle acht
 * Testdokumente exakt dieselbe Zahl an Textelementen. Es geht allein um die stille Ausgabe.
 */

import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Verzeichnis mit den Standard-Fontdaten von pdfjs. Als Pfad, nicht als URL (siehe
 * Modul-Kommentar). Schlägt die Auflösung fehl, bleibt der Wert `undefined`: dann meldet
 * pdfjs seine Fontwarnung wieder — unschön, aber ein Signal, das man sehen soll, statt es
 * zu unterdrücken.
 */
const STANDARD_FONT_DIR = (() => {
  try {
    const paketRoot = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    // Der Schrägstrich am Ende ist **fest verdrahtet und nicht `path.sep`**. pdfjs prüft
    // den Wert wörtlich mit `val.endsWith("/")` und wirft sonst
    // `Invalid factory url: "…" must include trailing slash.`
    //
    // `path.sep` stand hier einmal und war der klassische Fall von „läuft bei mir": Auf
    // macOS ist er `/` und die Prüfung ging durch, auf Windows ist er `\` und jeder Lauf
    // brach ab, bevor eine Seite gelesen war. Aufgefallen ist es erst auf einem fremden
    // Rechner (2026-08-11).
    //
    // Ein Schrägstrich im Rest eines Windows-Pfads ist unbedenklich: Die Win32-API nimmt
    // `D:\…\standard_fonts/FoxitSans.pfb` genauso an wie den Backslash-Pfad.
    return path.join(paketRoot, "standard_fonts") + "/";
  } catch {
    return undefined;
  }
})();

export interface PdfInfo {
  pages: number;
  /** Seitengeometrie in pt, 1-basiert indiziert über `[page - 1]`. */
  pageSizes: { width: number; height: number }[];
}

/** Was eine einzige Lesung des Dokuments liefert. */
interface NativeLesung {
  info: PdfInfo;
  /** Text je Seite (Index 0 = Seite 1), Zeilen mit `\n` getrennt. */
  seitenTexte: string[];
  /**
   * Fläche des größten Rasterbildes der Seite, in pt² — **absolut**, nicht als Anteil.
   * Ins Verhältnis gesetzt wird erst in `getPerPageImageCoverage`, und zwar gegen die
   * Geometrie aus dem übergebenen `PdfInfo`. Genau so rechnete auch die poppler-Fassung
   * (Bildmaß aus `pdfimages`, Seitenmaß aus `pdfinfo`).
   */
  bildFlaechen: number[];
}

/**
 * Letzte Lesung, gemerkt für die Dauer eines Dokuments.
 *
 * Die vier öffentlichen Funktionen behalten die Signaturen der poppler-Fassung (`classifyPages`
 * ruft zwei davon unabhängig voneinander auf), sollen das Dokument aber **einmal** öffnen und
 * nicht viermal. Ein einzelner Slot reicht: `pdfToMarkdown` arbeitet ein Dokument nach dem
 * anderen ab.
 *
 * Der Schlüssel trägt Änderungszeit und Größe mit — `build-scan-corpus.ts` schreibt PDFs unter
 * gleichbleibenden Pfaden neu, und eine gemerkte Lesung der Vorgängerdatei wäre still falsch.
 */
let letzteLesung: { schluessel: string; lesung: Promise<NativeLesung> } | null = null;

async function lesen(absPdfPath: string): Promise<NativeLesung> {
  const { mtimeMs, size } = await stat(absPdfPath);
  const schluessel = `${absPdfPath}|${mtimeMs}|${size}`;
  if (letzteLesung?.schluessel !== schluessel) {
    // Ein Fehlschlag wird nicht zementiert: der Slot wird geleert, damit ein erneuter
    // Versuch wirklich neu liest statt dieselbe Ablehnung noch einmal auszuliefern.
    const lesung = dokumentLesen(absPdfPath).catch((err: unknown) => {
      if (letzteLesung?.schluessel === schluessel) letzteLesung = null;
      throw err;
    });
    letzteLesung = { schluessel, lesung };
  }
  return letzteLesung.lesung;
}

async function dokumentLesen(absPdfPath: string): Promise<NativeLesung> {
  const daten = new Uint8Array(await readFile(absPdfPath));

  const task = pdfjs.getDocument({
    data: daten,
    // Keine Systemfonts nachladen: das ginge nur über den optionalen Canvas-Zusatz
    // (`@napi-rs/canvas`) und änderte am extrahierten Text nichts.
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONT_DIR,
    // Bewusst **kein** `isEvalSupported: false`: die Option gibt es in pdfjs 6.2.108 nicht
    // mehr (im ganzen Paket kein Vorkommen, auch nicht in den Typen), der eval-Pfad für
    // Fontprogramme ist upstream entfallen. Sie mitzugeben wäre ein wirkungsloser
    // Schlüssel, der aussieht wie eine Absicherung.
  });

  try {
    const doc = await task.promise;
    const pageSizes: { width: number; height: number }[] = [];
    const seitenTexte: string[] = [];
    const bildFlaechen: number[] = [];

    for (let seite = 1; seite <= doc.numPages; seite++) {
      const page = await doc.getPage(seite);
      // `getViewport({ scale: 1 })` liefert die Seitengröße in pt und berücksichtigt dabei
      // `/Rotate` — eine querformatig gedrehte Seite kommt gedreht heraus, so wie sie auch
      // gelesen wird.
      const viewport = page.getViewport({ scale: 1 });

      pageSizes.push({ width: viewport.width, height: viewport.height });
      seitenTexte.push(await seitenText(page));
      bildFlaechen.push(await groesstesBild(page));
    }

    return { info: { pages: doc.numPages, pageSizes }, seitenTexte, bildFlaechen };
  } catch (err) {
    throw new Error(`PDF nicht lesbar: ${absPdfPath} (${(err as Error).message})`, { cause: err });
  } finally {
    await task.destroy();
  }
}

/**
 * Text einer Seite aus dem nativen Text-Layer.
 *
 * Zeilen entstehen über `item.hasEOL`; die Textelemente selbst werden **ohne Trennzeichen**
 * aneinandergehängt. Das ist die sichere Richtung: pdfjs zerlegt ein Wort bei Kerning
 * gelegentlich in mehrere Elemente ("Aus" + "schreibung"), und ein eingefügtes Leerzeichen
 * würde daraus zwei Tokens machen, die im Markdown nicht vorkommen — also einen erfundenen
 * Verlust in `findLostTokens`. Umgekehrt tragen die Elemente die Wortabstände des Dokuments
 * bereits selbst.
 *
 * Gemessen über alle fünf digitalen Testdokumente: dieselbe Tokenmenge wie `pdftotext -layout`
 * bei Dok 1–4, bei Dok 5 ein Token **mehr** — pdfjs hält `g/Nm3` und `Nm3/h` zusammen, wo
 * poppler `g/Nm` und `3` trennt. Das ist genau der Zerfall der hochgestellten Ziffer, den
 * `evidence-match.ts` bis heute abfangen muss.
 */
async function seitenText(page: Awaited<ReturnType<pdfjs.PDFDocumentProxy["getPage"]>>): Promise<string> {
  const inhalt = await page.getTextContent();
  let text = "";
  for (const item of inhalt.items) {
    // `getTextContent` kann auch Marked-Content-Marker liefern; die tragen kein `str`.
    if (!("str" in item)) continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text;
}

/** Multipliziert zwei 2D-Affintransformationen `[a, b, c, d, e, f]` (PDF-Konvention). */
function mal(a: number[], b: number[]): number[] {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ];
}

/** Fläche des Einheitsquadrats unter dieser Transformation = Betrag der Determinante. */
function determinante(m: number[]): number {
  return Math.abs(m[0]! * m[3]! - m[1]! * m[2]!);
}

/**
 * Die Bild-Operatoren, an denen die aktuelle CTM die Bildfläche beschreibt.
 *
 * Zusammengestellt aus dem, was diese pdfjs-Version tatsächlich kennt: `paintJpegXObject`
 * gab es in älteren Fassungen und ist in 6.x fort — ein unbekannter Name wäre `undefined`
 * und würde in einem naiven Vergleich stumm nie greifen. Der Filter macht das sichtbar,
 * statt es zu verstecken.
 */
const BILD_OPS: ReadonlySet<number> = new Set(
  (["paintImageXObject", "paintJpegXObject", "paintImageMaskXObject", "paintInlineImageXObject"] as const)
    .map((name) => (pdfjs.OPS as unknown as Record<string, number | undefined>)[name])
    .filter((op): op is number => typeof op === "number"),
);

/**
 * Fläche (in pt²) des größten Rasterbildes auf der Seite.
 *
 * Der Transformationsstapel muss mitlaufen — siehe Modul-Kommentar. `save`/`restore` klammern
 * die Grafikzustände, `transform` verkettet; erst die so entstandene CTM beschreibt, wie groß
 * das Bild auf der Seite wirklich landet.
 */
async function groesstesBild(page: Awaited<ReturnType<pdfjs.PDFDocumentProxy["getPage"]>>): Promise<number> {
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stapel: number[][] = [];
  let groesste = 0;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]!;
    if (fn === pdfjs.OPS.save) {
      stapel.push(ctm.slice());
    } else if (fn === pdfjs.OPS.restore) {
      ctm = stapel.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === pdfjs.OPS.transform) {
      ctm = mal(ctm, ops.argsArray[i] as number[]);
    } else if (BILD_OPS.has(fn)) {
      groesste = Math.max(groesste, determinante(ctm));
    }
  }

  return groesste;
}

// ---------------------------------------------------------------------------
// Öffentlich — dieselben Signaturen wie die früheren poppler-Helfer in pdf-markdown.ts.
// ---------------------------------------------------------------------------

/**
 * Seitenzahl und -geometrie. Muss **vor** dem Lesen feststehen, weil daran hängt, wofür Geld
 * ausgegeben wird (welche Seiten per OCR gelesen werden).
 */
export async function pdfInfo(absPdfPath: string): Promise<PdfInfo> {
  return (await lesen(absPdfPath)).info;
}

/**
 * Der native Text-Layer als Referenz für `findLostTokens` — die zweite, von Docling
 * unabhängige Lesung desselben PDFs. Kein OCR, keine Layout-Interpretation.
 *
 * Seiten werden mit Form-Feed getrennt, weil `withoutPages()` in `pdf-markdown.ts` genau
 * daran die Scan-Seiten ausblendet (poppler trennte ebenso).
 */
export async function getRawText(absPdfPath: string): Promise<string> {
  return (await lesen(absPdfPath)).seitenTexte.join("\f");
}

/**
 * Zeichen je Seite aus dem nativen Text-Layer — das Textsignal der Scan-Erkennung.
 *
 * `pages` wird bewusst weiterhin übergeben und bestimmt die Länge des Ergebnisses: die
 * Klassifikation läuft über `info.pages`, und ein Array anderer Länge würde dort still zu
 * `?? 0` und damit zu falschen Scan-Seiten führen.
 */
export async function getPerPageCharCounts(absPdfPath: string, pages: number): Promise<number[]> {
  const { seitenTexte } = await lesen(absPdfPath);
  return Array.from({ length: pages }, (_, i) => (seitenTexte[i] ?? "").trim().length);
}

/**
 * Anteil der Seitenfläche, den das größte Rasterbild abdeckt — das Bildsignal der
 * Scan-Erkennung.
 *
 * Bezugsfläche ist `info.pageSizes`, also dieselbe Geometrie, gegen die auch die
 * poppler-Fassung gerechnet hat. Fehlt sie für eine Seite, bleibt die Abdeckung 0: dann
 * entscheidet allein das Textsignal, und eine Seite wird eher nicht als Scan geführt, als
 * dass sie es fälschlich würde.
 */
export async function getPerPageImageCoverage(absPdfPath: string, info: PdfInfo): Promise<number[]> {
  const { bildFlaechen } = await lesen(absPdfPath);
  return Array.from({ length: info.pages }, (_, i) => {
    const size = info.pageSizes[i];
    if (!size || size.width <= 0 || size.height <= 0) return 0;
    return (bildFlaechen[i] ?? 0) / (size.width * size.height);
  });
}
