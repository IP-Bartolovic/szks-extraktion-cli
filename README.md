# SZKS Extraktion — Werkzeug zum Testen

Liest eine PDF-Anfrage ein, extrahiert die 71 Felder der SZKS-Anfragemaske und schreibt
eine CSV plus eine Zusammenfassung im Terminal.

Läuft auf **macOS und Windows**.

---

## Voraussetzungen

Zwei Programme, beide mit Standard-Installer, beide für macOS und Windows. Wer das
**[Windows-ZIP](#weg-2-windows-zip)** benutzt, braucht keines von beiden — dort liegen sie
bei; nur die [zwei Zugangsschlüssel](#zwei-zugangsschlüssel) weiter unten werden auch dann
gebraucht.

| | Wozu | Download |
|---|---|---|
| **Node.js 20 oder neuer** | Laufzeit des Werkzeugs | **[nodejs.org/en/download](https://nodejs.org/en/download)** → die **LTS**-Fassung, `.pkg` (macOS) bzw. `.msi` (Windows) |
| **Git** | um das Werkzeug zu holen und aktuell zu halten | **[git-scm.com/downloads](https://git-scm.com/downloads)** — unter macOS meist schon da (`git --version` im Terminal probieren) |

**Mehr nicht.** Insbesondere **kein Python**, kein Compiler, kein poppler: Den PDF-Parser
samt eigener Python-Laufzeit richtet `npm install` selbst ein.

Prüfen, ob es reicht — im Terminal (macOS) bzw. in der Eingabeaufforderung oder PowerShell
(Windows):

```bash
node --version    # muss v20.x oder höher zeigen
git --version
```

### Zwei Zugangsschlüssel

| | Wozu | Wo anlegen |
|---|---|---|
| **OpenAI API Key** | die Extraktion selbst — **erforderlich** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Mistral API Key** | Texterkennung für **gescannte** Seiten — optional, aber empfohlen | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |

Beide werden beim ersten Start abgefragt; vorher besorgen spart einen Durchgang. Warum der
Mistral-Schlüssel trotz „optional" wichtig ist, steht [weiter unten](#warum-der-mistral-api-key-wichtig-ist).

### Empfohlen unter Windows

**[Windows Terminal](https://aka.ms/terminal)** (kostenlos, Microsoft Store). Es stellt
Umlaute in Feldnamen wie „Kessellänge" zuverlässig dar. Das Werkzeug schaltet die alte
Eingabeaufforderung zwar selbst auf UTF-8 um, aber Windows Terminal ist der ruhigere Weg.

---

## Installation

Es gibt zwei Wege. **Der ZIP-Weg braucht kein GitHub-Konto und keine Installationsrechte**
— er ist für einen Windows-Rechner gedacht, an dem beides fehlt.

| | Klon | ZIP |
|---|---|---|
| GitHub-Konto nötig | ja | **nein** |
| Node vorher installieren | ja | **nein** (liegt bei) |
| Internet beim Einrichten | ja (rund 1,7 GB) | ja (rund 1,7 GB) |
| Aktualisieren per `git pull` | ja | nein — neues ZIP |

### Weg 1: Klon

```bash
git clone https://github.com/IP-Bartolovic/szks-extraktion-cli.git
cd szks-extraktion-cli
npm install
```

`npm install` richtet im Hintergrund alles Weitere ein: den PDF-Parser (Docling) samt
eigener Python-Umgebung und den Erkennungsmodellen. Das sind einmalig rund **1,7 GB** und
je nach Leitung einige Minuten. Python muss **nicht** installiert sein — es wird
mitgeliefert.

Schlägt dieser Schritt fehl (kein Netz, Firma-Proxy), bricht die Installation **nicht** ab.
Nachholen lässt er sich jederzeit:

```bash
npm run setup:docling
```

### Weg 2: Windows-ZIP

Gebaut wird es auf einem Rechner, der das Repo hat:

```bash
npm run paket:windows      # ergibt paket/szks-windows.zip, rund 110 MB
```

Im ZIP liegen Node, uv und alle npm-Abhängigkeiten bereits fertig für Windows x64 — es
muss nichts installiert werden. Auf dem Zielrechner dann:

1. **Rechtsklick auf die ZIP-Datei → Eigenschaften → „Zulassen" → OK.** Ohne das hält
   Windows jede entpackte Datei für heruntergeladen und fragt bei jedem Start nach.
2. Den Ordner `szks` aus dem ZIP nach `C:\` ziehen, also nach `C:\szks`.
3. Doppelklick auf **`EINRICHTEN.cmd`** — lädt den PDF-Leser, einmalig rund 1,7 GB.
4. Doppelklick auf **`STARTEN.cmd`**.

`KONSOLE.cmd` öffnet ein Fenster, in dem `node` und `npm` verfügbar sind — dort laufen
Befehle wie `npm run setup:docling`, die das Werkzeug in seinen Meldungen nennt.

Die Voraussetzungen oben gelten für diesen Weg **nicht**: weder Node noch Git werden
gebraucht. Die beiden API Keys schon — sie werden beim ersten Start abgefragt.

### Windows: Pfadlänge und Befehlssyntax

**Den Projektordner nah an die Laufwerkswurzel legen** — etwa `C:\szks`. Windows bricht bei
260 Zeichen Pfadlänge ab, und die Python-Umgebung legt darunter Dateien mit rund 185
Zeichen an. Für den Ordner selbst bleiben damit knapp 60 Zeichen übrig; ein aus dem
GitHub-Archiv entpacktes `C:\Users\…\Downloads\szks-extraktion-cli-main\szks-extraktion-cli`
reißt die Grenze allein schon. Ist der Pfad zu lang, sagt es die Einrichtung vor dem
Download.

Die Befehle laufen in der Eingabeaufforderung und in PowerShell gleichermaßen. Nur
Umgebungsvariablen schreiben sich anders:

| | Eingabeaufforderung | PowerShell |
|---|---|---|
| Docling-Einrichtung überspringen | `set SZKS_SKIP_DOCLING=1 && npm install` | `$env:SZKS_SKIP_DOCLING=1; npm install` |
| API Key als Variable setzen | `set OPENAI_API_KEY=sk-...` | `$env:OPENAI_API_KEY="sk-..."` |

Die Konsole wird beim Start selbsttätig auf UTF-8 gestellt (`chcp 65001`) — siehe
[Empfohlen unter Windows](#empfohlen-unter-windows).

## Starten

Ein Befehl, von überall — wie `git` oder `node`:

```bash
szks
```

`npm install` hat ihn eingerichtet, es ist kein weiterer Schritt nötig. Der Befehl zeigt
auf **diesen** Projektordner: Ein `git pull` wirkt sofort, und Ergebnisse, Einstellungen
und die Docling-Umgebung bleiben hier, auch wenn `szks` von ganz woanders gestartet wird.

Sollte der globale Befehl nicht angelegt worden sein — das meldet `npm install` dann
ausdrücklich, meist wegen fehlender Rechte am globalen Befehlspfad —, geht es genauso aus
dem Projektordner heraus:

```bash
npm start
```

Beim ersten Start führt ein Dialog durch die Einstellungen. Danach:

```
SZKS Extraktion

  › Anfrage auswerten
    Einstellungen
    Beenden
```

### Direkt ein Dokument auswerten

Wer den Pfad schon hat, kann das Menü überspringen:

```bash
szks Anfrage_VKB-2026-0143.pdf
szks "~/Downloads/Ausschreibung Los 7.pdf"     # Anführungszeichen sind erlaubt
```

Ohne den globalen Befehl geht es genauso — dann aber **aus dem Projektordner heraus**:

```bash
cd szks-extraktion-cli
npm start -- "C:\Daten\OneDrive\Desktop\test.pdf"
```

Zwei Stolperstellen, beide von npm und nicht vom Werkzeug:

- **`npm start` will im Projektordner ausgeführt werden.** Ein Verzeichnis darüber meldet
  npm `Could not read package.json` und nennt dabei den Pfad, an dem es gesucht hat — das
  ist der Hinweis, dass nur ein `cd` fehlt.
- **Die zwei Bindestriche** trennen die eigenen Argumente von denen für npm. Aktuelle
  npm-Fassungen reichen sie bei `start` auch ohne durch; ein einzelner Bindestrich (`-"…"`)
  wird dagegen als npm-Schalter gelesen und quittiert mit `Unknown cli config`.

Die Datei wird sofort ausgewertet; danach erscheinen Zusammenfassung, CSV-Pfad und die
gewohnten Punkte („Ordner öffnen", „Alle Werte anzeigen"), nur endet es dort statt im
Hauptmenü.

**Anführungszeichen um den Pfad sind ausdrücklich erlaubt** — genau so liefert ihn das
Terminal, wenn man eine Datei ins Fenster zieht. Sie werden entfernt.

Es geht **ein** Dokument je Aufruf. Für mehrere nacheinander aufrufen; eine
Stapelverarbeitung ist bewusst nicht Teil des Werkzeugs.

Nebeneffekt: In dieser Form braucht das Werkzeug kein Terminal mehr, weil es nichts mehr
fragt. Der Aufruf lässt sich also auch in ein Skript schreiben — dann entfällt am Ende nur
die Auswahlliste, und Zusammenfassung und CSV-Pfad gehen auf die Ausgabe. Der Exit-Code ist
`0` bei Erfolg und `1`, wenn der Lauf nicht stattgefunden hat.

```bash
szks --help          # kurze Übersicht der Aufrufformen
```

---

## Was man einstellen muss

| Einstellung | Wozu |
|---|---|
| **Base URL** | Der Endpunkt des KI-Anbieters. Vorgabe: die OpenAI-API. Jeder OpenAI-kompatible Anbieter geht, etwa OpenRouter. |
| **API Key Name** | Name der Umgebungsvariablen, unter der der Key liegt (Vorgabe `OPENAI_API_KEY`). |
| **API Key** | Der Schlüssel. Leer lassen, wenn er als Umgebungsvariable gesetzt ist. |
| **Mistral API Key** | Für **gescannte** Seiten. Optional, aber empfohlen — siehe unten. |
| **PDF-Leser** | Womit das Dokument gelesen wird. Vorgabe: Docling — siehe [unten](#der-pdf-leser-umschalten-nur-im-notfall). |
| **Output Directory** | Wohin die CSV geschrieben wird. Vorgabe: `ergebnisse/` im Projektordner. |

Änderbar über den Menüpunkt „Einstellungen" oder durch Eingabe von `/config` an jeder
Stelle. Dort steht jeder Wert mit seinem aktuellen Stand; geändert wird nur, was man
auswählt — per Zifferntaste, mit den Pfeiltasten, und **Esc** führt zurück.

```
Einstellungen

  › 1  Base URL           https://api.openai.com/v1
    2  API Key Name       OPENAI_API_KEY
    3  API Key            hinterlegt
    4  Mistral API Key    nicht hinterlegt
    5  PDF-Leser          Docling — geprüfter Weg, kostenlos
    6  Output Directory   /Users/ben/szks/ergebnisse
    7  Verbindung prüfen  kostenlos
    8  Docling            eingerichtet
```

> **Die Schlüssel werden im Klartext gespeichert**, in der Konfigurationsdatei im
> Benutzerprofil (der Dialog nennt den genauen Pfad). Auf macOS ist die Datei auf den
> eigenen Benutzer beschränkt. Kein Schlüssel gehört ins Repo.

### Der PDF-Leser: umschalten nur im Notfall

Normalerweise liest **Docling** das Dokument: Es nimmt den Text, der im PDF steht, und
erkennt Überschriften und Tabellen. Das kostet nichts, läuft lokal, und es ist der Weg, für
den die Extraktion geprüft wurde.

Lässt sich Docling auf einem Rechner nicht einrichten — 1,7 GB Python scheitern an einem
Firmenproxy, einer alten CPU oder einer fehlenden Systembibliothek —, gibt es einen zweiten
Weg: **Mistral OCR** liest das ganze Dokument als Bild.

| | Docling (Vorgabe) | Mistral OCR |
|---|---|---|
| Einrichtung nötig | ja, einmalig 1,7 GB | **nein** |
| Kosten | keine | rund 0,4 ct je Seite |
| Mistral API Key | nur für gescannte Seiten | **zwingend** |
| geprüfter Weg | **ja** | nein |

Drei Dinge dazu:

- **Es wird nichts selbsttätig umgeschaltet.** Fehlt Docling, bricht der Lauf ab und weist
  auf den Schalter hin. Ein Werkzeug, das je nach Tagesform mal so und mal anders liest,
  liefert Ergebnisse, die niemand mehr zuordnen kann.
- **Jeder OCR-Lauf weist sich aus** — in der Kopfzeile steht dann „vollständig per Mistral
  OCR gelesen (nicht der geprüfte Weg)". In der CSV steht das **nicht**; wer sie später
  ansieht, kann es dort nicht mehr erkennen.
- **Die Ergebnisse können abweichen.** Eine Seite per Bilderkennung zu lesen, deren Text
  ohnehin im PDF steht, tauscht eine sichere Quelle gegen eine erkannte. Liest die
  Erkennung „56OO mm" statt „5600 mm", ist der Wert falsch und das Zitat trotzdem
  stimmig — auffallen würde das niemandem.

### Warum der Mistral API Key wichtig ist

Seiten **ohne** Text-Layer — eingescannte Anhänge, unterschriebene Formblätter,
weitergeleitete Fax-PDFs — müssen per Texterkennung gelesen werden. Dafür gibt es zwei
Wege, und der Unterschied ist gemessen:

| | ohne Mistral API Key | mit Mistral API Key |
|---|---|---|
| Textverlust auf gescannten Seiten | 12,8 – 13,8 % | 0,0 – 0,9 % |
| gesuchte Werte gefunden (Testkorpus) | 52 von 53 | 53 von 53 |

In einem Testdokument ging ohne Mistral ein Prio-Wert **vollständig** verloren — und zwar
so, dass das Ergebnis trotzdem plausibel und korrekt belegt aussah. Genau solche Fehler
soll dieses Werkzeug finden, nicht selbst erzeugen.

Kosten: **0,004 $ je gescannter Seite.** Nur Seiten ohne Text-Layer werden abgerechnet,
und jedes Dokument wird nur einmal gelesen — ein zweiter Lauf desselben PDFs kostet
nichts.

---

## Ein Durchlauf

1. **„Anfrage auswerten"** wählen.
2. PDF aussuchen — über den gewohnten Datei-Dialog, aus der Liste der zuletzt genutzten,
   oder durch Hineinziehen der Datei ins Terminal.
3. Das Werkzeug meldet Seitenzahl und erkannte Scan-Seiten, dann läuft die Extraktion mit
   Fortschrittsanzeige. Ein Dokument dauert je nach Umfang **ein bis mehrere Minuten**.
4. Die Zusammenfassung zeigt, was zu tun ist: fehlende Prio-Werte, unklare Felder und die
   Punkte, zu denen der Kunde ausdrücklich keine Vorgabe macht. Darunter eine **Übersicht
   nach Bereich** — sie beantwortet die Frage, die die Feldlisten offenlassen: Sind die
   Lücken über das Dokument verstreut, oder fehlt ein ganzer Block?

   ```
   Übersicht nach Bereich
                                           gefunden  unklar    leer
     Projekt- und Grunddaten                      8       -       -
     Anlagen- und Kesseldaten                    24       2       1  *
     Steuerung / Elektrotechnik / Pneumatik       7       1       -
     ...
     Gesamt                                      64       3       4

     * Bereich enthält offene Prio-Felder
   ```

   Die vollständige Werteliste steht dahinter als eigener Menüpunkt.
5. Die CSV liegt im Ergebnisverzeichnis, mit Datum und Uhrzeit im Namen — **es wird nie
   etwas überschrieben**, zwei Läufe desselben Dokuments bleiben vergleichbar.

## Die CSV

Eine Zeile je Zielfeld, in der Reihenfolge der Anfragemaske. Trennzeichen `;`, UTF-8 mit
BOM, CRLF — deutsches Excel öffnet sie per Doppelklick korrekt.

```
Zeile;Feld-ID;Bezeichnung;Wert;Dimension;Status;Grund;Prio;Korrektur;Wortlaut;Seite;Abschnitt;Beleg
56;kessel-kessellaenge;Kessellänge;3200;mm;gefunden;;ja;;;4;C.4 Kesselabmessungen;| Kessellänge | 3.200 mm |
```

Für den Import zählen die Spalten **3 bis 5** (`Bezeichnung`, `Wert`, `Dimension`) — sie
stehen deshalb nebeneinander. Der Rest dient der Nachvollziehbarkeit: `Status` und `Grund`
sagen, warum ein Feld leer ist; `Seite`, `Abschnitt` und `Beleg` sagen, woher ein Wert
stammt.

### Die vier Status

| Status | Bedeutung |
|---|---|
| `gefunden` | Der Kunde nennt eine Angabe |
| `nicht_im_dokument` | Dazu steht nichts — **nachfragen** |
| `ausdruecklich_keine_vorgabe` | Der Kunde sagt ausdrücklich, dass er nichts vorschreibt — **frei wählbar** |
| `unklar` | Etwas steht da, ist aber nicht zweifelsfrei eintragbar — `Grund` sagt, was zu klären ist |

Alle drei letzten lassen `Wert` und `Dimension` **leer**. Das ist Absicht: Ein Platzhalter
in der Wertspalte würde beim Import in die Zielzelle wandern.

**Das Modell überträgt, es entscheidet nicht.** Wo eine Angabe fehlt oder mehrdeutig ist,
steht das im Status — es wird nichts geraten und nichts ausgelegt.

---

## Wenn etwas nicht klappt

| Meldung | Ursache |
|---|---|
| „Docling ist nicht eingerichtet" | `npm run setup:docling` ausführen |
| „Kein API Key hinterlegt" | Menüpunkt „Einstellungen", oder die Umgebungsvariable setzen |
| Datei-Dialog öffnet nicht | Kommt bei Fernzugriff oder gesperrter Richtlinie vor — das Werkzeug bietet dann die Pfadeingabe an |
| „Das PDF ist zu groß" | Die Texterkennung nimmt höchstens 50 MB bzw. 1000 Seiten |

---

## Was dieses Werkzeug nicht tut

- **Keine Stapelverarbeitung.** Ein Dokument je Lauf.
- **Kein Zurückschreiben in die Excel-Maske.** Die CSV ist die Schnittstelle.
- **Keine Auswertung von Zeichnungen.** Ein gescanntes Maßbild bleibt ein Bild;
  Texterkennung liest Beschriftungen, keine Geometrie.
- **Keine Handschrift.**

## Datenschutz

Das Dokument wird an zwei Dienste übertragen: an den eingestellten KI-Anbieter (für die
Extraktion) und, sofern gescannte Seiten enthalten sind, an Mistral in der EU (für die
Texterkennung). Es wird **nichts** an sonstige Dienste gesendet; das Werkzeug hat keine
Telemetrie und keine Protokollierung nach außen.
