# SWU ÖPNV-Datenserver

Der Server lädt die SWU-Daten beim Start und danach automatisch jede Minute.
Der aktuelle Snapshot wird in `data/latest.json` gespeichert. Verspätungen aus
den letzten 24 Stunden werden in `data/delay-history.jsonl` gesammelt.

## Start

Voraussetzung: Node.js 18 oder neuer.

```powershell
npm start
```

Der Server ist anschließend unter `http://localhost:3000` erreichbar.
Eine einmalige Synchronisierung ist mit `npm run sync` möglich.

## API

- `GET /` – API-Übersicht mit Version aus `package.json`, URLs und Beschreibungen
- `GET /api/health` – Synchronisierungsstatus
- `GET /api/snapshot` – alle gespeicherten Daten
- `GET /api/routes` oder `GET /api/routes?routeNumber=201` – Linien
- `GET /api/vehicles` – Fahrzeuge
- `GET /api/vehicles/13` – Fahrzeug, aktuelle Fahrt, gefahrene Linien und Verspätungshistorie
- `GET /api/search?q=13` – Suche nach Fahrzeugnummer/-name inklusive Linien und Verzögerungen
- `GET /api/delays?vehicleNumber=13&minutes=60` – Verspätungen des Zeitraums
- `GET /api/delays/average?minutes=60` – durchschnittliche Verspätung im ganzen Netz
- `GET /api/delays/average?routeNumber=201&minutes=60` – durchschnittliche Verspätung einer Linie
- `GET /api/delays/average?vehicleNumber=13&minutes=60` – durchschnittliche Verspätung eines Fahrzeugs
- `GET /api/sync` – sofortige Synchronisierung auslösen

Die SWU-URL kann für Tests überschrieben werden:

```powershell
$env:SWU_BASE_URL = "https://api.swu.de/mobility/v1"
$env:PORT = "3000"
npm start
```
