# SZKS-Extraktion — CLI

Interaktives Werkzeug für **Ben**: PDF-Anfrage einlesen, 71 Zielfelder extrahieren, CSV und
Zusammenfassung ausgeben. Läuft auf macOS und Windows.

**Das ist ein Testinstrument, kein Produkt.** Produktiv läuft die Pipeline später als
Hintergrundprozess auf einem Cloud-Server ohne Oberfläche. Daraus folgt die wichtigste
Regel dieses Repos:

> **Was Ben hier misst, muss das sein, was produktiv läuft.**

Ein Werkzeug mit eigener Logik wäre wertlos — findet er einen Fehler, wüsste niemand, ob es
ihn in Produktion gibt; findet er keinen, sagt das nichts.

## `vendor/` ist eine Kopie und wird nie von Hand geändert

Der gesamte Laufzeitpfad — Parsing, Chunking, Extraktion, Merge, Fundortableitung,
CSV-Export — liegt als **byte-genaue Kopie** aus
[`szks-extraktionspipeline`](https://github.com/IP-Bartolovic/szks-extraktionspipeline)
unter `vendor/`.

```
Änderung nötig?  →  im Pipeline-Repo ändern
                 →  dort:  npx tsx scripts/sync-cli.ts
                 →  hier:  npm run check:vendor
```

`vendor/MANIFEST.json` trägt sha256 je Datei. `npm run check:vendor` läuft in `typecheck`
mit und schlägt fehl, sobald eine Datei abweicht. **Eine hier reparierte Zeile ist kein
Fix, sondern ein stiller Bruch der Aussagekraft** — genau der Fehlermodus, gegen den das
Schwesterprojekt durchgängig gebaut ist.

Warum Kopie statt Paket: Ein geteiltes Paket käme aus GitHub Packages und bräuchte einen
`NODE_AUTH_TOKEN` — genau die Hürde, die dieses Werkzeug nicht haben darf. Ein Submodul
brächte Eval, Registry und LangSmith mit, die hier nichts verloren haben.

### Die eine erzeugte Datei

`vendor/model.ts` wird von `sync-cli.ts` **geschrieben**, nicht kopiert: ein
Weiterleitungs-Shim auf `src/modell.ts`. Dadurch bleiben `vendor/nodes/extract.ts` und
`vendor/nodes/merge.ts` byte-gleich zum Original — sie importieren unverändert
`../model.js`. Die Alternative wäre gewesen, beim Kopieren Quelltext umzuschreiben, und
eine Kopie, die sich beim Kopieren ändert, taugt nicht als Referenz.

## Was gegenüber der Pipeline gekappt ist

| | Pipeline | hier |
|---|---|---|
| Prompts | Registry (`agents.prompts`) mit Code-Fallback | **hartkodiert** in `vendor/prompts.ts` |
| Modell | `createModel` aus `@ip-bartolovic/langchain-kit` | `new ChatOpenAI(...)` in `src/modell.ts` |
| Providerdaten | Supabase-Registry | Konfigurationsdatei im Benutzerprofil |
| Tracing | LangSmith (EU) | **aus** — `LANGSMITH_TRACING=false` wird gesetzt |
| Eval, Grader, Datensätze | vorhanden | nicht enthalten |
| Pakete | 269 | **41** |

Die Registry war im Pipeline-Repo bereits toter Code (leere Supabase-Zugangsdaten →
Code-Fallback); es geht also **keine** Funktionalität verloren.

**`LANGSMITH_TRACING=false` ist kein Detail.** Das CLI importiert `langsmith` nirgends, aber
`@langchain/core` bringt es transitiv mit und schaltet Tracing allein anhand dieser
Variablen ein. Ohne die Zeile würde eine geerbte Shell-Variable Kundendokumente an
LangSmith schicken, ohne dass es jemand bemerkt. Gesetzt in `umgebungSetzen()`
(`src/config.ts`).

## Was hier konfigurierbar ist — und was nicht

Konfigurierbar ist alles, was von der **Umgebung** abhängt: Endpunkt, Schlüssel,
Ergebnisverzeichnis. Nicht konfigurierbar ist alles, was das **Ergebnis** bestimmt:

Eine Ausnahme gibt es, und sie ist begründet: den **PDF-Leser**. Er bestimmt das Ergebnis
und ist trotzdem einstellbar, weil die Alternative auf manchen Rechnern „gar kein Ergebnis"
heißt.

| | `Docling` (Vorgabe) | `Mistral OCR` |
|---|---|---|
| Textseiten | nativer Text-Layer | Vision-OCR |
| Docling nötig | ja (1,7 GB) | **nein** |
| Kosten | keine | ~0,4 ct/Seite |
| evaluiert | **ja** | nein |

Umgeschaltet wird unter „Einstellungen → PDF-Leser"; das CLI übersetzt die Wahl nach
`SZKS_PARSER`, die Verzweigung steckt im Vendor-Code. **Kein automatischer Rückfall** —
scheitert Docling, bricht der Lauf ab und nennt den Schalter, statt selbsttätig auf einen
anderen Leser zu wechseln. Und jeder Lauf mit OCR schreibt „vollständig per Mistral OCR
gelesen (nicht der geprüfte Weg)" in die Kopfzeile, weil die CSV das nicht trägt.

- **Modell-ID** (`gpt-5.6-luna`) — Konstante in `src/modell.ts`
- **Prompts**, **Chunk-Größe**, **Zielschema** — in `vendor/`
- **Denkaufwand des Modells** (`high`) — Konstante `REASONING_EFFORT` in `src/modell.ts`

Der **Denkaufwand** ist der wackeligste Punkt dieser Liste, weil er an zwei Orten steht.
Verbindlich festgelegt wurde `high` am 2026-08-10; im Pipeline-Repo trägt ihn die Konstante
gleichen Namens in `src/model.ts`, und `SZKS_EXTRAKTION_REASONING_EFFORT` überschreibt sie
dort nur für Messreihen.

> **Ändert sich die Stufe drüben, muss sie hier nachgezogen werden.**

Sonst testet Ben mit einem anderen Denkaufwand als dem evaluierten — dieselbe Art von
Abweichung, gegen die die Vendor-Sperre gebaut ist, nur ohne Prüfsumme, die sie meldet. Der
Unterschied wäre nirgends sichtbar: Beide Seiten lieferten plausible Ergebnisse, nur eben
nicht dieselben.

Eine versehentlich verstellte Modell-ID erzeugte Befunde, die auf die Pipeline nicht
zutreffen. Das ist derselbe Gedanke wie die Vendor-Sperre, eine Ebene höher.

## `reasoning` fällt bei präfigierten Modellnamen ersatzlos aus

Gemessen am 2026-08-10 über `invocationParams()`, ohne einen einzigen Netzaufruf:

| Modellname | im Anfragekörper |
|---|---|
| `gpt-5.6-luna` | `reasoning_effort: "high"` |
| `openai/gpt-5.6-luna` | **nichts** |

`ChatOpenAI._getReasoningParams` beginnt mit `if (!isReasoningModel(this.model)) return;`,
und `isReasoningModel` ist eine **Namensheuristik** — `model.startsWith("gpt-5")`. Das
OpenRouter-Präfix lässt den Vergleich scheitern; das Konstruktor-Feld `reasoning` wird
still verworfen. Kein Fehler, keine Warnung: Die Anfrage geht durch, das Modell denkt auf
Anbieter-Default.

`src/modell.ts` schickt den Denkaufwand deshalb über **`modelKwargs`**, das verbatim in den
Körper gemischt wird — je Endpunkt in dessen Form (`reasoning_effort` bei OpenAI,
`reasoning: { effort }` bei OpenRouter). Wer das später auf das „saubere" Konstruktor-Feld
zurückdreht, stellt den Ausfall wieder her, und zwar unsichtbar.

> **Die Pipeline hat denselben Fehler und ist noch nicht repariert.** Dort läuft der Weg
> über `createModel` aus `@ip-bartolovic/langchain-kit`, das `reasoning_effort` auf genau
> dieses Konstruktor-Feld abbildet (`HANDLED_PARAM_KEYS` sperrt außerdem den generischen
> Passthrough). Mit `SZKS_EXTRAKTION_MODEL=openai/gpt-5.6-luna` ist der Denkaufwand dort
> **nie** gesendet worden — auch nicht im Vergleichslauf, der ihn zu belegen schien.
> Solange das so ist, laufen CLI und Pipeline auf **verschiedenen** Stufen.

## `temperature` ist kein Detail, sondern ein Abbruch

Hier stand `temperature: 0`, und das war an beiden Endpunkten falsch — nur unterschiedlich
sichtbar:

| Endpunkt | Wirkung |
|---|---|
| OpenAI direkt | **HTTP 400** — „Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported." |
| OpenRouter | stillschweigend verworfen (weder `temperature` noch `top_p` unter `supported_parameters`) |

Ein Denkmodell hat keine Temperatur, die sich stellen ließe. Der Wert war also nie wirksam
und hat nur den Endpunkt zum Absturz gebracht, der ehrlich genug ist, das zu melden — und
zwar erst, als das CLI seine Vorgabe von OpenRouter auf OpenAI umstellte. `temperature` ist
deshalb ersatzlos entfallen; weggelassen fällt das Feld ganz aus dem Anfragekörper.

**In der Pipeline steht es weiterhin** (`SZKS_EXTRAKTION_TEMPERATURE=0`), weil sie über
OpenRouter geht und ein Eingriff in die Modellparameter die laufende Messreihe veränderte.
Wer sie auf OpenAI direkt umstellt, muss die Variable vorher leeren.

## Zwei Details, die sonst still brechen

1. **Provider-Routing ist OpenRouter-spezifisch.**
   `{ provider: { only: ["openai"], allow_fallbacks: false } }` reist im Anfragekörper mit;
   ein anderer OpenAI-kompatibler Endpunkt kennt das Feld nicht und lehnt ab. Es wird
   deshalb nur gesetzt, wenn die Basis-URL `openrouter.ai` enthält (`src/modell.ts`).
2. **Cache und Werkzeuge dürfen nicht neben dem Code liegen.** `vendor/pdf-markdown.ts`
   leitet sein Standard-Cache-Verzeichnis aus `import.meta.url` ab. Unter Windows ist das
   Installationsverzeichnis nicht verlässlich beschreibbar. `umgebungSetzen()` setzt
   `DOCLING_CACHE_DIR` und `DOCLING_BIN` deshalb **explizit**, bevor irgendetwas parst; die
   Vendor-Vorgabe kommt nie zum Zug. Auflösung in `src/pfade.ts`.

## `GET /models` prüft bei OpenRouter den Schlüssel nicht

Gemessen am 2026-08-10, nicht vermutet:

| Aufruf | ohne Schlüssel | mit ungültigem Schlüssel |
|---|---|---|
| `GET https://openrouter.ai/api/v1/models` | **HTTP 200** | **HTTP 200** |
| `GET https://openrouter.ai/api/v1/key` | HTTP 401 | HTTP 401 |

Die naheliegende Verbindungsprüfung — „hole die Modellliste, das beweist Erreichbarkeit und
Schlüssel" — beweist bei OpenRouter also nur die Erreichbarkeit. Und OpenRouter ist der
**Vorgabe-Anbieter**: Ein Tippfehler im Schlüssel, der wahrscheinlichste
Einrichtungsfehler überhaupt, wäre als „alles gut" durchgegangen und erst mitten im ersten
Lauf als HTTP 401 aufgeschlagen.

`pruefeAnbieter` hängt deshalb bei OpenRouter einen zweiten, ebenfalls kostenlosen Aufruf
auf `/key` an (`src/pruefungen.ts`). Ein Netzfehler dort **verschlechtert das Ergebnis
nicht** — die Zusatzprüfung kann nur strenger machen, nie flatterhafter.

> Das ist dasselbe Muster wie an mehreren Stellen im Pipeline-Repo: ein Prüfinstrument,
> das etwas anderes meldet, als es gemessen hat. Wer die Prüfung später „vereinfacht",
> stellt genau diese Lücke wieder her.

## Struktur

```
src/
  main.ts          Menüschleife, Slash-Befehle
  run.ts           ein Durchlauf: PDF → Pipeline (streamend) → CSV
  ansicht.ts       Zusammenfassung im Terminal
  dateiauswahl.ts  Datei-Dialog des Systems, mit Rückfallebenen
  setup.ts         Einrichtungs- und Einstellungsdialog
  pruefungen.ts    Verbindungsprüfungen (kostenlos)
  docling.ts       uv + venv + Docling automatisch einrichten
  config.ts        Einstellungen laden/speichern/auflösen
  pfade.ts         wo was liegt — die eine Stelle, an der macOS und Windows abweichen
  modell.ts        ChatOpenAI direkt, ohne Registry
scripts/
  check-vendor.ts  Prüfsummenabgleich gegen das Manifest
  setup-docling.ts manueller Nachholweg
  postinstall.mjs  läuft bei `npm install`, schlägt nie hart fehl
vendor/            KOPIE — nicht anfassen
```

## Befehle

```bash
szks                   # das Werkzeug, von überall (nach einmaligem `npm link`)
szks <datei.pdf>       # dieses Dokument sofort auswerten, ohne Menü
npm start              # dasselbe, aus dem Projektordner
npm run typecheck      # check:vendor + tsc
npm run check:vendor   # nur der Prüfsummenabgleich
npm run setup:docling  # Docling nachträglich einrichten
npm run paket:windows  # Windows-ZIP bauen (Node + uv + node_modules inklusive)
```

### `npm run paket:windows` — Auslieferung ohne GitHub-Konto

Für einen Windows-Rechner, an dem sich niemand bei GitHub anmelden kann oder darf.
`scripts/paket-windows.ts` legt `paket/szks-windows.zip` an (rund 110 MB): Quelltext aus
`git archive HEAD`, ein portables Node für Windows x64, das uv-Binary und ein
`node_modules`, das mit `--os=win32 --cpu=x64` für das **Zielsystem** aufgelöst wurde.
Dazu `EINRICHTEN.cmd`, `STARTEN.cmd`, `KONSOLE.cmd` und eine Anleitung.

Drei Punkte, an denen es sonst still schiefginge:

1. **`--os=win32 --cpu=x64`.** Genau zwei Pakete sind plattformabhängig — `@esbuild/*`
   (über tsx) und `@napi-rs/canvas-*` (über pdfjs-dist). Ein hier gebautes `node_modules`
   trüge die Darwin-Fassungen, und der Fehlschlag träte erst auf dem fremden Rechner auf.
   Der Packer bricht deshalb ab, wenn eine Darwin-Fassung im Baum liegt.
2. **`--ignore-scripts`.** Ohne das liefe `postinstall.mjs` auf **diesem** Rechner: `npm
   link` und eine Docling-Einrichtung für macOS, beides in einem Baum für Windows. Dass
   der Baum trotzdem lädt, ist geprüft — esbuilds ausgelassenes `postinstall` ist bloß
   eine Startoptimierung, der Auflösungspfad zur `.exe` liegt in `lib/main.js`.
3. **Docling ist nicht im ZIP.** Es ist Python mit kompilierten Rädern; eine
   Windows-venv lässt sich auf einem Mac nicht bauen. Die rund 1,7 GB lädt `EINRICHTEN.cmd`
   von PyPI und HuggingFace — beides ohne Konto, aber mit Leitung. Das vorgelegte
   `.werkzeuge/uv.exe` erspart wenigstens den Griff nach github.com.

Die Batchdateien sind **rein ASCII** und CRLF; `batch()` prüft das und wirft sonst.
`cmd.exe` liest seine Datei beim Abarbeiten häppchenweise mit der gerade gültigen Codepage
— ein `chcp 65001` in Zeile zwei ändert die Regeln also mitten im Lesen. Die Umlaute gehören
deshalb ins Werkzeug, das sie als UTF-8 schreibt, und nicht in den Starter.

### `szks <datei.pdf>` — dieselbe Bahn, nur ohne die erste Frage

Der Aufruf mit Pfad geht durch **denselben** Code wie das Menü (`auswerten` aus `run.ts`);
übersprungen wird nur die Dateiauswahl. Ein zweiter Weg mit eigener Logik wäre genau der
Bruch, gegen den dieses Repo gebaut ist.

Drei Entscheidungen darin:

1. **Kein TTY nötig.** Die Menüschleife verlangt eines, weil sie fragt; ein Aufruf mit
   fertigem Pfad fragt nichts. Ohne Terminal entfällt am Ende nur die Auswahlliste,
   Zusammenfassung und CSV-Pfad gehen auf die Ausgabe. Damit ist derselbe Code skriptfähig
   — die Richtung, in die die Pipeline produktiv ohnehin geht.
   Ausnahme ist die Ersteinrichtung: Ohne Schlüssel gelingt kein Lauf, und ohne Terminal
   lässt sich keiner erfragen. Dann Abbruch mit Exit-Code 1.
2. **Ein unbekannter Schalter wird abgelehnt**, nicht als Dateiname gedeutet. Sonst
   antwortete `szks --hlep` mit „Nicht gefunden: /…/--hlep" — richtig, aber an der falschen
   Stelle erklärt.
3. **Ein Dokument je Aufruf.** Mehrere anzunehmen wäre Stapelverarbeitung durch die
   Hintertür; stillschweigend nur die erste zu nehmen wäre schlimmer als die Absage.

Das Etikett des letzten Menüpunkts ist deshalb ein Parameter von `ergebnisMenue`: Dort steht
„Beenden" statt „Zurück zum Menü", weil es in dieser Aufrufform kein Menü gibt, in das man
zurückkehren könnte.

### Der globale Befehl: `bin/szks.mjs`

Der `bin`-Eintrag zeigt auf **JavaScript**, nicht auf `src/main.ts` — npm übergibt die Datei
direkt an Node, und Node kennt kein TypeScript. `bin/szks.mjs` überbrückt das in acht
Zeilen. Drei Entscheidungen darin sind nicht beliebig:

1. **Loader statt Kindprozess.** `tsx` als Unterprozess zu starten wäre der naheliegende
   Weg und schöbe eine Prozessebene zwischen Terminal und Werkzeug — dort geht **Strg+C**
   verloren oder kommt verzögert an, und der Exit-Code muss von Hand durchgereicht werden.
   `tsx/esm/api` registriert den Loader im laufenden Prozess; `src/main.ts` ist danach ein
   gewöhnlicher Import, mit einer einzigen Prozess-Identität. Gemessener Startaufschlag:
   0,22 s.
2. **Kein vorkompiliertes `dist/`.** Wäre schneller, kostet aber einen Build-Schritt, der
   nach einem `git pull` vergessen werden kann — und dann misst Ben einen Stand, der nicht
   mehr dem Quelltext entspricht. Für ein Testinstrument ist das der schlechtere Tausch.
3. **`fileURLToPath(import.meta.url)`, nicht `new URL(...).pathname`.** Letzteres liefert
   unter Windows `/C:/Users/...` — führender Schrägstrich, prozentkodierte Leerzeichen,
   kein gültiger Pfad.

`tsx` steht deshalb unter `dependencies`, nicht `devDependencies`: Es wird zur Laufzeit
gebraucht.

**`npm link` statt `npm install -g .`** — gemessen: Node löst den Symlink auf den echten
Ordner auf, `import.meta.url` zeigt also in den Klon. Damit bleiben `.werkzeuge/`,
`.cache/` und `ergebnisse/` dort, wo Ben sie erwartet, und ein `git pull` wirkt sofort. Ein
globales `install` kopierte die Dateien stattdessen ins globale `node_modules`, und die
Ergebnis-CSVs landeten dort — praktisch unauffindbar.

**Das Verlinken macht `postinstall` selbst**, es ist kein zweiter Schritt für Ben. Zwei
Details daran sind bewusst:

- **Vor** der Docling-Einrichtung. Verlinken dauert eine Drittelsekunde, Docling Minuten und
  kann an Netz oder Platte scheitern. Andersherum hätte Ben nach einem gescheiterten
  Download auch keinen Befehl, mit dem er sich die Lage ansehen könnte — obwohl das Werkzeug
  startbar ist und den Fehlschlag im Einrichtungsdialog erklärt.
- Aufgerufen über `npm_execpath` mit dem laufenden Node, nicht über den Namen `npm`: Unter
  Windows ist das eine `.cmd`, die ohne Shell nicht startet — und eine Shell will diese
  Datei nirgends (Repo-Pfade mit Leerzeichen).

Gemessen mit npm 10: `npm link` löst `postinstall` **nicht** erneut aus. Der Wächter
`SZKS_IN_LINK` steht trotzdem da; die Lebenszyklus-Regeln haben sich zwischen
npm-Hauptversionen schon geändert, und eine Endlosschleife im Installationsschritt wäre ein
teurer Weg, das herauszufinden. Abschalter: `SZKS_SKIP_LINK=1`. Als Abhängigkeit eines
anderen Projekts installiert (`INIT_CWD` ≠ Repo) wird ohnehin nicht verlinkt.

## Externe Voraussetzungen

**Node ≥ 20 — sonst nichts.** Kein Python, kein poppler, kein Compiler. Docling bringt
`npm install` selbst mit (über ein gepinntes `uv`-Release samt geprüfter Prüfsumme, das
sein eigenes CPython lädt).

Der Verzicht auf poppler ist die Voraussetzung dafür: Es hat unter Windows keinen
Paketmanager-Weg. Der native PDF-Layer kommt seit dem 2026-08-10 aus `pdfjs-dist`
(`vendor/pdf-native.ts`) — Begründung und Messungen im Pipeline-Repo unter „Kein poppler
mehr".
