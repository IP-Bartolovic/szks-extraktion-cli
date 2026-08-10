/**
 * Prüft `vendor/` gegen `vendor/MANIFEST.json`.
 *
 * `vendor/` ist eine Kopie des Laufzeitpfads aus dem Pipeline-Repo. Kopien laufen
 * auseinander, und der teure Fall ist nicht der offensichtliche, sondern der stille: Wer
 * hier eine Zeile ändert, um einen Fehler zu beheben, hat ein Werkzeug, das etwas anderes
 * tut als die evaluierte Pipeline — und niemand kann später sagen, ob ein Befund aus Bens
 * Test in Produktion überhaupt existiert.
 *
 * Deshalb ist eine geänderte Vendor-Datei hier ein **Fehler mit Meldung**. Die Prüfung
 * läuft in `npm run typecheck` mit, kostet nichts und kann nicht vergessen werden.
 *
 * Korrekturweg: im Pipeline-Repo ändern, dort `npx tsx scripts/sync-cli.ts` laufen lassen.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR = path.join(REPO, "vendor");
const MANIFEST = path.join(VENDOR, "MANIFEST.json");

if (!existsSync(MANIFEST)) {
  console.error(
    `vendor/MANIFEST.json fehlt.\n` +
      `Im Pipeline-Repo ausführen:  npx tsx scripts/sync-cli.ts`,
  );
  process.exit(1);
}

const { dateien } = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  dateien: Record<string, string>;
};

const fehlend: string[] = [];
const abweichend: string[] = [];

for (const [rel, soll] of Object.entries(dateien)) {
  const datei = path.join(VENDOR, rel);
  if (!existsSync(datei)) {
    fehlend.push(rel);
    continue;
  }
  const ist = createHash("sha256").update(readFileSync(datei, "utf8")).digest("hex");
  if (ist !== soll) abweichend.push(rel);
}

if (fehlend.length === 0 && abweichend.length === 0) {
  console.log(`vendor/ unverändert — ${Object.keys(dateien).length} Dateien geprüft.`);
  process.exit(0);
}

console.error("vendor/ weicht vom Pipeline-Repo ab.\n");
for (const f of fehlend) console.error(`  FEHLT      ${f}`);
for (const f of abweichend) console.error(`  GEÄNDERT   ${f}`);
console.error(
  `\nDiese Dateien sind Kopien und dürfen hier nicht bearbeitet werden — sonst misst das\n` +
    `Werkzeug etwas anderes als die evaluierte Pipeline.\n\n` +
    `Änderung gehört ins Pipeline-Repo. Danach dort:  npx tsx scripts/sync-cli.ts`,
);
process.exit(1);
