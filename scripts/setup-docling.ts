/**
 * Der manuelle Nachholweg: `npm run setup:docling`.
 *
 * Das Gegenstück zu `scripts/postinstall.mjs`. Dort darf nichts hart fehlschlagen, weil ein
 * abgebrochenes `npm install` schlimmer wäre als ein fehlendes Docling. Hier ist es
 * umgekehrt: Wer diesen Befehl von Hand aufruft, will wissen, ob es geklappt hat — deshalb
 * endet ein Fehlschlag mit Exit-Code 1 und ist damit auch in einem Skript erkennbar.
 */

import { doclingEinrichten } from "../src/docling.js";

const ergebnis = await doclingEinrichten((zeile) => console.log(zeile));

console.log("");
console.log(ergebnis.meldung);

if (!ergebnis.ok) process.exitCode = 1;
