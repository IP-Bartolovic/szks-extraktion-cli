/**
 * Eine nummerierte Auswahlliste mit Zifferntasten und Abbruch über Esc.
 *
 * ## Warum nicht `@inquirer/select`
 *
 * Die fertige Auswahlliste kann beides nicht: Sie reagiert weder auf Zifferntasten noch auf
 * Esc — geprüft im Quelltext von `@inquirer/select@7`, dort gibt es keine Behandlung für
 * `escape` und keine für Zifferntasten. Für ein Menü, das man mehrmals am Tag durchläuft,
 * ist beides der Unterschied zwischen „zweimal tippen" und „viermal Pfeiltaste".
 *
 * `@inquirer/rawlist` bringt zwar Ziffern mit, dafür keine Pfeiltasten und kein Esc, und es
 * zeigt keine Zusatzspalte. Deshalb dieser eigene Baustein — rund 60 Zeilen auf Basis
 * derselben Bibliothek (`@inquirer/core`), die auch hinter den fertigen Prompts steht.
 *
 * ## Drei Wege zum selben Ziel
 *
 * Ziffer wählt **sofort** (kein Enter nötig), Pfeiltasten bewegen und Enter bestätigt, Esc
 * bricht ab. Der Abbruch liefert `null` — der Aufrufer entscheidet, was das bedeutet;
 * im Einstellungsmenü ist es „zurück".
 *
 * Absichtlich nur **einstellige** Ziffern: Ab zwei Stellen bräuchte es eine Eingabepuffer-
 * Logik samt Zeitfenster („war die 1 schon die Auswahl oder der Anfang von 12?"). Kein Menü
 * dieses Werkzeugs hat mehr als neun Einträge, und falls doch eines dazukäme, ist der
 * fehlende Kurzweg besser als eine Auswahl, die je nach Tipptempo etwas anderes tut.
 */

import { createPrompt, isEnterKey, isUpKey, isDownKey, useKeypress, useState } from "@inquirer/core";
import { kuerzen, terminalBreite, ZEIGER } from "./ansicht.js";

export interface MenuePunkt<T> {
  /** Was der Aufrufer zurückbekommt. */
  wert: T;
  name: string;
  /** Rechts danebenstehende Zusatzangabe — der aktuelle Wert einer Einstellung etwa. */
  hinweis?: string;
  /**
   * Statt einer laufenden Nummer diese Taste anzeigen. Gedacht für „0 Zurück", das
   * unabhängig von der Länge der Liste immer dieselbe Taste behalten soll.
   */
  taste?: string;
}

interface MenueConfig<T> {
  message: string;
  punkte: MenuePunkt<T>[];
}

const menuePrompt = createPrompt<unknown, MenueConfig<unknown>>((config, fertig) => {
  const [index, setIndex] = useState(0);
  const [beendet, setBeendet] = useState(false);
  const punkte = config.punkte;

  const taste = (i: number) => punkte[i].taste ?? String(i + 1);

  useKeypress((key) => {
    if (beendet) return;

    if (isEnterKey(key)) {
      setBeendet(true);
      fertig(punkte[index].wert);
      return;
    }
    if (key.name === "escape") {
      setBeendet(true);
      fertig(null);
      return;
    }
    if (isUpKey(key)) return setIndex((index - 1 + punkte.length) % punkte.length);
    if (isDownKey(key)) return setIndex((index + 1) % punkte.length);

    const treffer = punkte.findIndex((_, i) => taste(i) === key.name);
    if (treffer >= 0) {
      setIndex(treffer);
      setBeendet(true);
      fertig(punkte[treffer].wert);
    }
  });

  if (beendet) {
    // Nach der Auswahl bleibt nur eine Zeile stehen. Das ganze Menü im Verlauf zu belassen
    // schiebt bei jedem Durchgang einen Block nach oben, und nach dem dritten Mal sieht man
    // vor lauter Menüs die Ausgabe nicht mehr.
    return `${config.message}: ${punkte[index].name}`;
  }

  const breite = terminalBreite();
  const namensBreite = Math.min(24, Math.max(...punkte.map((p) => p.name.length)));

  const zeilen = punkte.map((p, i) => {
    const zeiger = i === index ? ZEIGER : " ";
    const links = `${zeiger} ${taste(i)}  ${p.name.padEnd(namensBreite)}`;
    if (!p.hinweis) return `  ${links.trimEnd()}`;
    return `  ${links}  ${kuerzen(p.hinweis, Math.max(10, breite - namensBreite - 10))}`;
  });

  return [
    `${config.message}\n\n${zeilen.join("\n")}`,
    "\n(Ziffer wählt direkt, Pfeiltasten bewegen, Esc zurück)",
  ];
});

/**
 * Typisierte Hülle — `createPrompt` kennt den Wertetyp nicht.
 *
 * `kontext` reicht eigene Ein-/Ausgabeströme durch, wie es alle `@inquirer`-Prompts tun.
 * Ohne diesen Weg wäre die Tastenbehandlung nur an einem echten Terminal prüfbar, also
 * praktisch gar nicht — und gerade sie ist der Grund, warum es diesen Baustein gibt.
 */
export function menue<T>(
  config: MenueConfig<T>,
  kontext?: Parameters<typeof menuePrompt>[1],
): Promise<T | null> {
  return menuePrompt(config as MenueConfig<unknown>, kontext) as Promise<T | null>;
}
