# SWU ÖPNV-Datenserver

Der Server lädt die SWU-Daten beim Start und danach automatisch jede Minute.
Der aktuelle Snapshot wird in `data/latest.json` gespeichert. Verspätungen aus
den letzten 24 Stunden werden in `data/delay-history.jsonl` gesammelt.

> [!CAUTION]
> Momentan wird zum Testen in JSON gespeichert.

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
- `GET /stats` – HTML-Dashboard mit Diagrammen zum Netz, zu Linien und zu Fahrzeugen
- `GET /api/stats?minutes=180` – Statistiken für das gesamte Netz
- `GET /api/stats?routeNumber=201&minutes=180` – Statistiken einer Linie
- `GET /api/stats?vehicleNumber=13&minutes=180` – Statistiken eines Fahrzeugs
- `GET /api/stats?minutes=all` – gesamter gespeicherter Verlauf (die Historie wird nach 24 Stunden bereinigt)
- `GET /api/stats?mode=bus` – nur Busse, `mode=tram` nur Straßenbahnen
- `GET /api/stats/search?q=13` – Linien und Fahrzeuge für das Dashboard suchen
- `GET /api/stats/export?dataset=routes` – CSV-Export der Linien; `dataset=vehicles` für Fahrzeuge, `dataset=delays` für die Messwerte

## Dashboard

Unter `http://localhost:3000/stats` liegt ein Dashboard mit Kennzahlen und
Diagrammen zur Verspätung im gesamten Netz. Über das Suchfeld lassen sich
Linien und Fahrzeuge auswählen, für die dieselben Statistiken separat
angezeigt werden. Der Zeitraum ist zwischen einer Stunde und 24 Stunden
wählbar, mit „Allzeit“ wird der gesamte gespeicherte Verlauf ausgewertet.
Straßenbahnen und Busse lassen sich getrennt filtern und werden zusätzlich
direkt gegenübergestellt. Eine Karte „Busse unterwegs“ zeigt für jeden Bus die
nächsten Halte als Linienvorschau und eine Verspätungsprognose – aus den
SWU-Livewerten je Haltestelle, sonst aus dem Trend der letzten 45 Minuten.
Statistik und Messwerte stehen als CSV-Export zur Verfügung
(Semikolon-getrennt, UTF-8 mit BOM für Excel).

Die SWU-URL kann für Tests überschrieben werden:

```powershell
$env:SWU_BASE_URL = "https://api.swu.de/mobility/v1"
$env:PORT = "3000"
npm start
```

## Cloudflare Tunnel

Der Server läuft unverändert hinter `cloudflared`. `X-Forwarded-Proto` und
`X-Forwarded-Host` werden ausgewertet, damit die URLs in `GET /` die öffentliche
`https`-Adresse des Tunnels enthalten statt `http://localhost:3000`.

```bash
# Schnelltunnel mit zufälliger trycloudflare.com-Adresse
cloudflared tunnel --url http://localhost:3000

# benannter Tunnel mit eigener Domain
cloudflared tunnel run swu
```

Beispiel für `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /etc/cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: swu.example.com
    service: http://localhost:3000
  - service: http_status:404
```

Optionen:

```powershell
# nur lokal erreichbar (empfohlen, wenn cloudflared auf demselben Host läuft)
$env:HOST = "127.0.0.1"
# öffentliche Adresse fest vorgeben, statt sie aus den Headern abzuleiten
$env:PUBLIC_BASE_URL = "https://swu.example.com"
npm start
```

Hinweise:

- `HEAD` wird für Health-Checks unterstützt; der Body entfällt, die Header sind
  identisch zu `GET`.
- Cloudflare bricht Anfragen an den Ursprung nach 100 Sekunden ab. `GET /api/sync`
  kann bei vielen Fahrzeugen länger dauern und antwortet dann mit `524`; die
  Synchronisierung läuft weiter und ein erneuter Aufruf liefert
  `{"skipped": true}`.
- Das Verzeichnis `data/` muss auf einem beschreibbaren Volume liegen, damit
  Snapshot und Verspätungshistorie geschrieben werden können.
