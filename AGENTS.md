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

- **Modell-ID** (`openai/gpt-5.6-luna`) — Konstante in `src/modell.ts`
- **Prompts**, **Chunk-Größe**, **Zielschema** — in `vendor/`

Eine versehentlich verstellte Modell-ID erzeugte Befunde, die auf die Pipeline nicht
zutreffen. Das ist derselbe Gedanke wie die Vendor-Sperre, eine Ebene höher.

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
npm start              # das Werkzeug
npm run typecheck      # check:vendor + tsc
npm run check:vendor   # nur der Prüfsummenabgleich
npm run setup:docling  # Docling nachträglich einrichten
```

**Bewusst kein `bin`-Eintrag.** Ein globaler `szks`-Befehl müsste auf eine `.ts`-Datei
zeigen; npm erzeugt daraus einen Shim, der die Datei direkt an Node übergibt — ohne `tsx`
scheitert das auf beiden Systemen, und ein Shebang mit `npx tsx` ist unter Windows
unzuverlässig. `npm start` ist der eine dokumentierte Weg und funktioniert überall gleich.
`tsx` steht deshalb unter `dependencies`, nicht `devDependencies`: Ben braucht es zur
Laufzeit.

## Externe Voraussetzungen

**Node ≥ 20 — sonst nichts.** Kein Python, kein poppler, kein Compiler. Docling bringt
`npm install` selbst mit (über ein gepinntes `uv`-Release samt geprüfter Prüfsumme, das
sein eigenes CPython lädt).

Der Verzicht auf poppler ist die Voraussetzung dafür: Es hat unter Windows keinen
Paketmanager-Weg. Der native PDF-Layer kommt seit dem 2026-08-10 aus `pdfjs-dist`
(`vendor/pdf-native.ts`) — Begründung und Messungen im Pipeline-Repo unter „Kein poppler
mehr".
