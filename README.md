# SZKS Extraktion — Werkzeug zum Testen

Liest eine PDF-Anfrage ein, extrahiert die 71 Felder der SZKS-Anfragemaske und schreibt
eine CSV plus eine Zusammenfassung im Terminal.

Läuft auf **macOS und Windows**.

---

## Installation

Es gibt genau eine Voraussetzung: **Node.js 20 oder neuer**
([nodejs.org](https://nodejs.org) — der Standard-Installer genügt, auf beiden Systemen).

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

### Unter Windows

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
| Schlüssel als Variable setzen | `set OPENROUTER_API_KEY=sk-...` | `$env:OPENROUTER_API_KEY="sk-..."` |

Die Konsole wird beim Start selbsttätig auf UTF-8 gestellt (`chcp 65001`), damit Umlaute in
Feldnamen wie „Kessellänge" richtig erscheinen.

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
    Docling einrichten
    Beenden
```

---

## Was man einstellen muss

| Einstellung | Wozu |
|---|---|
| **Basis-URL** | Der Endpunkt des KI-Anbieters. Vorgabe: OpenRouter. Jeder OpenAI-kompatible Anbieter geht. |
| **Schlüsselname** | Name der Umgebungsvariablen, unter der der Schlüssel liegt (Vorgabe `OPENROUTER_API_KEY`). |
| **Schlüssel** | Der API-Schlüssel. Leer lassen, wenn er als Umgebungsvariable gesetzt ist. |
| **Mistral-Schlüssel** | Für **gescannte** Seiten. Optional, aber empfohlen — siehe unten. |
| **Ergebnisverzeichnis** | Wohin die CSV geschrieben wird. Vorgabe: `ergebnisse/` im Projektordner. |

Änderbar über den Menüpunkt „Einstellungen" oder durch Eingabe von `/config` an jeder
Stelle. Dort steht jeder Wert mit seinem aktuellen Stand; geändert wird nur, was man
auswählt — per Zifferntaste, mit den Pfeiltasten, und **Esc** führt zurück.

```
Einstellungen

  › 1  Basis-URL            https://openrouter.ai/api/v1
    2  Schlüsselname        OPENROUTER_API_KEY
    3  API-Schlüssel        hinterlegt
    4  Mistral-Schlüssel    nicht hinterlegt
    5  Ergebnisverzeichnis  /Users/ben/szks/ergebnisse
    6  Verbindung prüfen    kostenlos
    7  Docling              eingerichtet
```

> **Die Schlüssel werden im Klartext gespeichert**, in der Konfigurationsdatei im
> Benutzerprofil (der Dialog nennt den genauen Pfad). Auf macOS ist die Datei auf den
> eigenen Benutzer beschränkt. Kein Schlüssel gehört ins Repo.

### Warum der Mistral-Schlüssel wichtig ist

Seiten **ohne** Text-Layer — eingescannte Anhänge, unterschriebene Formblätter,
weitergeleitete Fax-PDFs — müssen per Texterkennung gelesen werden. Dafür gibt es zwei
Wege, und der Unterschied ist gemessen:

| | ohne Mistral-Schlüssel | mit Mistral-Schlüssel |
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
3. Das Werkzeug meldet Seitenzahl, erkannte Scan-Seiten und die zu erwartenden OCR-Kosten,
   dann läuft die Extraktion. Ein Dokument dauert je nach Umfang **ein bis mehrere
   Minuten**.
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
| „Kein API-Schlüssel hinterlegt" | Menüpunkt „Einstellungen", oder die Umgebungsvariable setzen |
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
