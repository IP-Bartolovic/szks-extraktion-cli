@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Alle Argumente unveraendert weiterreichen. Beim Ziehen einer Datei auf dieses
rem Symbol steht der Pfad in %1, bei Bedarf mit Anfuehrungszeichen -- die entfernt
rem das Werkzeug selbst (anfuehrungszeichenStrippen in src/dateiauswahl.ts).
node "%~dp0bin\szks.mjs" %*
rem Nur im Fehlerfall anhalten. Bei einem gelungenen Lauf haelt ohnehin das
rem Ergebnismenue das Fenster offen; ein Pause danach waere eine Taste zuviel.
if errorlevel 1 pause
