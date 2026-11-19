import { createServer } from "node:http";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGtfs } from "./gtfs.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
const SNAPSHOT_FILE = join(DATA_DIR, "latest.json");
const HISTORY_FILE = join(DATA_DIR, "delay-history.jsonl");
const PACKAGE_FILE = join(ROOT, "package.json");
const STATS_PAGE_FILE = join(ROOT, "src", "stats.html");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_BASE_URL = configuredBaseUrl(process.env.PUBLIC_BASE_URL);
const SWU_BASE_URL = process.env.SWU_BASE_URL || "https://api.swu.de/mobility/v1";
const GTFS_URL = process.env.GTFS_URL || "https://gtfs.swu.de/daten/SWU.zip";
const GTFS_FILE = join(DATA_DIR, "gtfs", "SWU.zip");
const GTFS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GTFS_REFRESH_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_HISTORY_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 8;
const HISTORY_REWRITE_MIN_INTERVAL_MS = 5 * 60_000;

const EMPTY_SNAPSHOT = {
  syncedAt: null,
  partial: false,
  errors: [],
  routes: [],
  stops: [],
  stopPoints: [],
  vehicles: [],
  trips: [],
  passages: []
};

let snapshot = EMPTY_SNAPSHOT;
let syncInProgress = false;
let packageVersion = null;
let statsPage = null;
// Fahrplandaten aus dem GTFS-Feed; null, solange sie noch nicht geladen sind.
let gtfs = null;
let gtfsLoading = null;

// Lookup tables and serialized response bodies derived from the snapshot.
// Rebuilt once per sync instead of being recomputed per request.
const snapshotIndex = {
  vehiclesByNumber: new Map(),
  routesByNumber: new Map(),
  tripsByVehicle: new Map(),
  passagesByVehicle: new Map(),
  busRouteByVehicle: new Map(),
  bodies: new Map()
};

// Delay history is kept in memory as a timestamp-ascending array, so time
// windows are a binary search instead of a full file read plus scan.
const history = {
  loaded: false,
  loadedPromise: null,
  records: [],
  byVehicle: new Map(),
  lastRewriteAt: 0
};

const apiRoutes = [
  { method: "GET", path: "/", description: "API-Übersicht mit Version und allen Endpunkten." },
  { method: "GET", path: "/api/health", description: "Zeigt Server-, Synchronisierungs- und Datenstatus." },
  { method: "GET", path: "/api/snapshot", description: "Liefert den vollständigen aktuell gespeicherten Datensatz." },
  { method: "GET", path: "/api/routes", description: "Liefert alle SWU-Linien; optional filterbar mit routeNumber." },
  { method: "GET", path: "/api/routes?routeNumber=201", description: "Liefert eine einzelne Linie anhand ihrer Nummer." },
  { method: "GET", path: "/api/vehicles", description: "Liefert alle Fahrzeuge; optional filterbar mit vehicleNumber." },
  { method: "GET", path: "/api/vehicles/13", description: "Liefert Fahrzeugdaten, aktuelle Fahrten, Linien und Verspätungshistorie." },
  { method: "GET", path: "/api/search?q=13", description: "Sucht nach Fahrzeugnummer oder Fahrzeugname und liefert zugehörige Linien und Verzögerungen." },
  { method: "GET", path: "/api/delays?vehicleNumber=13&minutes=60", description: "Liefert Verspätungsmessungen aus dem gewählten Zeitraum." },
  { method: "GET", path: "/api/delays/average?minutes=60", description: "Berechnet die durchschnittliche Verspätung für das gesamte Netz oder optional für routeNumber bzw. vehicleNumber." },
  { method: "GET", path: "/api/sync", description: "Startet sofort eine Synchronisierung mit der SWU API." },
  { method: "GET", path: "/api/gtfs", description: "Übersicht über den GTFS-Fahrplan: Betreiber, Feed-Version und Anzahl der Datensätze." },
  { method: "GET", path: "/api/gtfs/stops?q=ZUP", description: "Liefert alle Haltestellen aus dem GTFS-Fahrplan; optional filterbar mit q." },
  { method: "GET", path: "/api/gtfs/stops/ZUP", description: "Liefert eine Haltestelle mit den Linien, die sie bedienen." },
  { method: "GET", path: "/api/gtfs/routes", description: "Liefert alle GTFS-Linien; optional filterbar mit routeId oder q." },
  { method: "GET", path: "/api/gtfs/routes/L01", description: "Liefert eine Linie mit Haltestellenfolge je Fahrtrichtung." },
  { method: "GET", path: "/api/gtfs/trips/L01-A-IB", description: "Liefert eine Fahrt mit allen Haltestellen und Zeiten." },
  { method: "GET", path: "/api/gtfs/departures?stopId=ZUP&minutes=60", description: "Liefert die nächsten Abfahrten einer Haltestelle aus dem Fahrplan." },
  { method: "GET", path: "/api/gtfs/map", description: "Liefert Haltestellen mit Koordinaten und Linienverläufe für die Netzkarte im Dashboard." },
  { method: "GET", path: "/api/gtfs/sync", description: "Lädt den GTFS-Fahrplan neu herunter." },
  { method: "GET", path: "/api/stats", description: "Liefert Netzstatistiken mit Verteilung, Zeitverlauf sowie Bussen inklusive Linienvorschau und Prognose; optional für routeNumber, vehicleNumber, mode und minutes=all." },
  { method: "GET", path: "/api/stats/search?q=13", description: "Sucht Linien und Fahrzeuge für das Statistik-Dashboard." },
  { method: "GET", path: "/api/stats/export?dataset=routes", description: "Exportiert Linien-, Fahrzeug- oder Messwertstatistiken als CSV." },
  { method: "GET", path: "/stats", description: "HTML-Dashboard mit Diagrammen zum gesamten Netz sowie zu einzelnen Linien und Fahrzeugen." }
];

async function getPackageVersion() {
  if (packageVersion === null) {
    packageVersion = JSON.parse(await readFile(PACKAGE_FILE, "utf8")).version;
  }
  return packageVersion;
}

function installSnapshot(next) {
  snapshot = {
    syncedAt: next.syncedAt ?? null,
    partial: next.partial ?? false,
    errors: next.errors ?? [],
    routes: next.routes ?? [],
    stops: next.stops ?? [],
    stopPoints: next.stopPoints ?? [],
    vehicles: next.vehicles ?? [],
    trips: next.trips ?? [],
    passages: next.passages ?? []
  };
  snapshotIndex.bodies.clear();
  snapshotIndex.vehiclesByNumber.clear();
  snapshotIndex.routesByNumber.clear();
  snapshotIndex.tripsByVehicle.clear();
  snapshotIndex.passagesByVehicle.clear();
  snapshotIndex.busRouteByVehicle.clear();
  for (const vehicle of snapshot.vehicles) snapshotIndex.vehiclesByNumber.set(vehicle.VehicleNumber, vehicle);
  for (const route of snapshot.routes) snapshotIndex.routesByNumber.set(route.RouteNumber, route);
  for (const trip of snapshot.trips) {
    const bucket = snapshotIndex.tripsByVehicle.get(trip.VehicleNumber);
    if (bucket) bucket.push(trip);
    else snapshotIndex.tripsByVehicle.set(trip.VehicleNumber, [trip]);
  }
  for (const passage of snapshot.passages) {
    const bucket = snapshotIndex.passagesByVehicle.get(passage.VehicleNumber);
    if (bucket) bucket.push(passage);
    else snapshotIndex.passagesByVehicle.set(passage.VehicleNumber, [passage]);
  }
}

function cachedBody(key, build) {
  let body = snapshotIndex.bodies.get(key);
  if (body === undefined) {
    body = Buffer.from(JSON.stringify(build()));
    snapshotIndex.bodies.set(key, body);
  }
  return body;
}

async function fetchJson(path, params = {}) {
  const url = new URL(`${SWU_BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`SWU API ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function firstArray(value, preferredKeys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of preferredKeys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = firstArray(child);
    if (found.length) return found;
  }
  return [];
}

async function withConcurrency(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, items.length) }, run));
  return results;
}

async function syncData() {
  if (syncInProgress) return { skipped: true };
  syncInProgress = true;
  const errors = [];
  try {
    const [routeResult, stopResult, stopPointResult, vehicleResult, tripResult] =
      await Promise.allSettled([
        fetchJson("route/attributes/BaseData", { ContentScope: "extended" }),
        fetchJson("stop/attributes/BaseData", { ContentScope: "extended" }),
        fetchJson("stoppoint/attributes/BaseData", { ContentScope: "extended" }),
        fetchJson("vehicle/attributes/BaseData", { ContentScope: "extended" }),
        fetchJson("vehicle/trip/Trip")
      ]);

    const unwrap = (result, name, keys) => {
      if (result.status === "rejected") {
        errors.push(`${name}: ${result.reason.message}`);
        return [];
      }
      return firstArray(result.value, keys);
    };

    const routes = unwrap(routeResult, "routes", ["RouteData"]);
    const stops = unwrap(stopResult, "stops", ["StopData"]);
    const stopPoints = unwrap(stopPointResult, "stopPoints", ["StopPointData"]);
    const vehicles = unwrap(vehicleResult, "vehicles", ["VehicleData"]);
    const trips = unwrap(tripResult, "trips", ["VehicleTripData", "TripData"]);

    const vehicleNumbers = [...new Set(
      trips.map((trip) => trip.VehicleNumber).filter((number) => number !== undefined && number !== null)
    )];
    const passageResults = await withConcurrency(vehicleNumbers, async (vehicleNumber) => {
      try {
        const result = await fetchJson("vehicle/trip/Passage", {
          VehicleNumber: vehicleNumber,
          Range: "all"
        });
        return firstArray(result, ["PassageData"]).map((passage) => (passage.VehicleNumber === undefined || passage.VehicleNumber === null
          ? { ...passage, VehicleNumber: vehicleNumber }
          : passage));
      } catch (error) {
        errors.push(`passages/${vehicleNumber}: ${error.message}`);
        return [];
      }
    });
    const passages = passageResults.flat();
    const syncedAt = new Date().toISOString();
    installSnapshot({
      syncedAt,
      partial: errors.length > 0,
      errors,
      routes,
      stops,
      stopPoints,
      vehicles,
      trips,
      passages
    });
    await writeJsonAtomically(SNAPSHOT_FILE, snapshot);
    await appendDelayHistory(trips, passages, syncedAt);
    console.log(`[${syncedAt}] sync: ${routes.length} routes, ${vehicles.length} vehicles, ${errors.length} errors`);
    return { skipped: false, syncedAt, errors };
  } finally {
    syncInProgress = false;
  }
}

// Der GTFS-Feed ist statisch und wird nur selten veröffentlicht: neu laden,
// wenn die lokale Datei fehlt oder älter als 24 Stunden ist.
async function refreshGtfs({ force = false } = {}) {
  if (gtfsLoading) return gtfsLoading;
  gtfsLoading = (async () => {
    try {
      gtfs = await loadGtfs({
        sourceUrl: GTFS_URL,
        file: GTFS_FILE,
        maxAgeMs: force ? 0 : GTFS_MAX_AGE_MS
      });
      console.log(`[${gtfs.loadedAt}] gtfs: ${gtfs.routes.length} Linien, ${gtfs.stops.length} Haltestellen, ${gtfs.trips.length} Fahrten`);
      return { reloaded: true, loadedAt: gtfs.loadedAt };
    } finally {
      gtfsLoading = null;
    }
  })();
  return gtfsLoading;
}

async function writeJsonAtomically(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rename(temporary, file);
}

async function ensureHistoryLoaded() {
  if (history.loaded) return;
  if (!history.loadedPromise) history.loadedPromise = loadHistory();
  await history.loadedPromise;
}

async function loadHistory() {
  if (existsSync(HISTORY_FILE)) {
    const text = await readFile(HISTORY_FILE, "utf8");
    const records = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.timestamp) records.push(record);
      } catch {}
    }
    records.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    history.records = records;
    indexHistoryByVehicle(records);
  }
  history.loaded = true;
}

function indexHistoryByVehicle(records) {
  history.byVehicle.clear();
  for (const record of records) {
    const bucket = history.byVehicle.get(record.vehicleNumber);
    if (bucket) bucket.push(record);
    else history.byVehicle.set(record.vehicleNumber, [record]);
  }
}

function appendHistoryRecords(records) {
  for (const record of records) {
    history.records.push(record);
    const bucket = history.byVehicle.get(record.vehicleNumber);
    if (bucket) bucket.push(record);
    else history.byVehicle.set(record.vehicleNumber, [record]);
  }
}

// Records are appended chronologically and every timestamp is written as an
// ISO-8601 UTC string of fixed width, so plain string order is time order.
function firstIndexAtOrAfter(records, cutoffIso) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (records[mid].timestamp < cutoffIso) low = mid + 1;
    else high = mid;
  }
  return low;
}

function delayWindow(minutes) {
  const cutoff = Date.now() - minutes * 60_000;
  return { cutoff, start: firstIndexAtOrAfter(history.records, new Date(cutoff).toISOString()) };
}

async function appendDelayHistory(trips, passages, timestamp) {
  const records = [];
  for (const trip of trips) {
    if (trip.VehicleNumber === undefined) continue;
    records.push({
      timestamp,
      vehicleNumber: trip.VehicleNumber,
      routeNumber: trip.RouteNumber ?? trip.JourneyData?.RouteNumber ?? null,
      deviation: trip.TimeData?.Deviation ?? trip.Deviation ?? null,
      referenceTime: trip.TimeData?.ReferenceTime ?? null,
      source: "trip"
    });
  }
  for (const passage of passages) {
    if (passage.VehicleNumber === undefined) continue;
    const deviation = passage.DepartureDeviation ?? passage.ArrivalDeviation;
    if (deviation === undefined || deviation === null) continue;
    records.push({
      timestamp,
      vehicleNumber: passage.VehicleNumber,
      routeNumber: passage.RouteNumber ?? null,
      deviation,
      referenceTime: passage.DepartureTimeActual ?? passage.ArrivalTimeActual ?? null,
      stopNumber: passage.StopNumber ?? null,
      source: "passage"
    });
  }
  await ensureHistoryLoaded();
  if (records.length) {
    appendHistoryRecords(records);
    await appendFile(HISTORY_FILE, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  }
  await pruneHistory();
}

// Drops expired records from memory on every sync, but only rewrites the file
// occasionally: rewriting a day of history every minute was pure disk churn.
async function pruneHistory() {
  const cutoffIso = new Date(Date.now() - MAX_HISTORY_AGE_MS).toISOString();
  const expired = firstIndexAtOrAfter(history.records, cutoffIso);
  if (expired > 0) {
    for (const record of history.records.slice(0, expired)) {
      const bucket = history.byVehicle.get(record.vehicleNumber);
      if (!bucket) continue;
      const bucketExpired = firstIndexAtOrAfter(bucket, cutoffIso);
      bucket.splice(0, bucketExpired);
      if (!bucket.length) history.byVehicle.delete(record.vehicleNumber);
    }
    history.records = history.records.slice(expired);
    if (Date.now() - history.lastRewriteAt >= HISTORY_REWRITE_MIN_INTERVAL_MS) {
      await rewriteHistoryFile();
      history.lastRewriteAt = Date.now();
    }
  }
}

async function rewriteHistoryFile() {
  const temporary = `${HISTORY_FILE}.tmp`;
  const records = history.records;
  try {
    await pipeline(
      async function* () {
        let chunk = "";
        for (const record of records) {
          chunk += JSON.stringify(record) + "\n";
          if (chunk.length >= 1 << 20) {
            yield chunk;
            chunk = "";
          }
        }
        if (chunk) yield chunk;
      },
      createWriteStream(temporary, { encoding: "utf8" })
    );
    await rename(temporary, HISTORY_FILE);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Statistics for the /stats dashboard
// ---------------------------------------------------------------------------

// Deviation buckets in seconds; "from" is inclusive, "to" is exclusive.
const STATS_BUCKETS = [
  { label: "über 5 Min zu früh", from: -Infinity, to: -300 },
  { label: "2–5 Min zu früh", from: -300, to: -120 },
  { label: "0–2 Min zu früh", from: -120, to: 0 },
  { label: "0–2 Min zu spät", from: 0, to: 120 },
  { label: "2–5 Min zu spät", from: 120, to: 300 },
  { label: "über 5 Min zu spät", from: 300, to: Infinity }
];
const TIMELINE_BUCKET_MS = 5 * 60_000;
const PUNCTUAL_MIN_SECONDS = -60;
const PUNCTUAL_MAX_SECONDS = 180;
const MAX_STATS_ROWS = 20;
const MODE_LABELS = { tram: "Straßenbahn", bus: "Bus", other: "Unbekannt" };

// SWU marks trams with VehicleCategory/RouteCategory 1 and buses with 5;
// missing or other values stay unknown.
function modeFromCategory(category) {
  if (category === 1) return "tram";
  if (category === 5) return "bus";
  return "other";
}

function modeOfRecord(record) {
  const vehicle = snapshotIndex.vehiclesByNumber.get(record.vehicleNumber);
  return modeFromCategory(vehicle?.VehicleCategory ?? null);
}

// Number(null) is 0, so a missing deviation must be filtered explicitly
// instead of being counted as an on-time measurement.
function deviationOf(record) {
  const value = record.deviation;
  if (value === null || value === undefined || value === "") return null;
  const deviation = Number(value);
  return Number.isFinite(deviation) ? deviation : null;
}

function dominantMode(counts) {
  if (counts.tram > 0 && counts.tram >= counts.bus) return "tram";
  if (counts.bus > 0) return "bus";
  return "other";
}

function countByMode(items, categoryOf) {
  const counts = { tram: 0, bus: 0, other: 0 };
  for (const item of items) counts[modeFromCategory(categoryOf(item))]++;
  return counts;
}

function summarizeByMode(records) {
  const buckets = new Map();
  for (const record of records) {
    const deviation = deviationOf(record);
    if (deviation === null) continue;
    const mode = modeOfRecord(record);
    let bucket = buckets.get(mode);
    if (!bucket) {
      bucket = { deviations: [], vehicles: new Set(), routes: new Set() };
      buckets.set(mode, bucket);
    }
    bucket.deviations.push(deviation);
    if (record.vehicleNumber !== null && record.vehicleNumber !== undefined) bucket.vehicles.add(record.vehicleNumber);
    if (record.routeNumber !== null && record.routeNumber !== undefined) bucket.routes.add(record.routeNumber);
  }
  return ["tram", "bus", "other"]
    .filter((mode) => buckets.has(mode))
    .map((mode) => {
      const bucket = buckets.get(mode);
      return {
        mode,
        label: MODE_LABELS[mode],
        vehicles: bucket.vehicles.size,
        routes: bucket.routes.size,
        ...summarizeDeviations(bucket.deviations)
      };
    });
}

function roundValue(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function medianOf(sorted) {
  if (!sorted.length) return null;
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function summarizeDeviations(deviations) {
  if (!deviations.length) {
    return {
      samples: 0,
      averageDelaySeconds: null,
      averageDelayMinutes: null,
      medianDelaySeconds: null,
      punctualPercent: null,
      earlyPercent: null,
      latePercent: null,
      minDelaySeconds: null,
      maxDelaySeconds: null
    };
  }
  let sum = 0;
  let punctual = 0;
  let early = 0;
  let late = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const deviation of deviations) {
    sum += deviation;
    if (deviation < min) min = deviation;
    if (deviation > max) max = deviation;
    if (deviation < PUNCTUAL_MIN_SECONDS) early++;
    else if (deviation > PUNCTUAL_MAX_SECONDS) late++;
    else punctual++;
  }
  const average = sum / deviations.length;
  const sorted = deviations.slice().sort((a, b) => a - b);
  return {
    samples: deviations.length,
    averageDelaySeconds: roundValue(average),
    averageDelayMinutes: roundValue(average / 60, 2),
    medianDelaySeconds: roundValue(medianOf(sorted)),
    punctualPercent: roundValue((punctual / deviations.length) * 100),
    earlyPercent: roundValue((early / deviations.length) * 100),
    latePercent: roundValue((late / deviations.length) * 100),
    minDelaySeconds: min,
    maxDelaySeconds: max
  };
}

function delayHistogram(deviations) {
  const histogram = STATS_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
  for (const deviation of deviations) {
    const index = STATS_BUCKETS.findIndex((bucket) => deviation >= bucket.from && deviation < bucket.to);
    if (index !== -1) histogram[index].count++;
  }
  return histogram;
}

// Buckets without measurements keep a null average so the chart shows a gap
// instead of pretending the delay was zero.
function buildTimeline(records) {
  const buckets = new Map();
  for (const record of records) {
    const deviation = deviationOf(record);
    if (deviation === null) continue;
    const time = Date.parse(record.timestamp);
    if (!Number.isFinite(time)) continue;
    const bucketStart = Math.floor(time / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS;
    const bucket = buckets.get(bucketStart);
    if (bucket) {
      bucket.sum += deviation;
      bucket.count++;
    } else {
      buckets.set(bucketStart, { sum: deviation, count: 1 });
    }
  }
  if (!buckets.size) return [];
  const starts = [...buckets.keys()].sort((a, b) => a - b);
  const points = [];
  for (let start = starts[0]; start <= starts[starts.length - 1]; start += TIMELINE_BUCKET_MS) {
    const bucket = buckets.get(start);
    points.push({
      timestamp: new Date(start).toISOString(),
      averageDelaySeconds: bucket ? roundValue(bucket.sum / bucket.count) : null,
      samples: bucket ? bucket.count : 0
    });
  }
  return points;
}

function groupDeviations(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (key === null || key === undefined) continue;
    const deviation = deviationOf(record);
    if (deviation === null) continue;
    let group = groups.get(key);
    if (!group) {
      group = { deviations: [], modes: { tram: 0, bus: 0, other: 0 } };
      groups.set(key, group);
    }
    group.deviations.push(deviation);
    group.modes[modeOfRecord(record)]++;
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    modes: group.modes,
    ...summarizeDeviations(group.deviations)
  }));
}

function routeNameFor(routeNumber) {
  return snapshotIndex.routesByNumber.get(routeNumber)?.RouteName ?? String(routeNumber);
}

function vehicleNameFor(vehicleNumber) {
  return snapshotIndex.vehiclesByNumber.get(vehicleNumber)?.VehicleName ?? null;
}

function routeDetails(routeNumber) {
  const route = snapshotIndex.routesByNumber.get(routeNumber);
  if (!route) return null;
  const stopNumbers = new Set();
  const stopPointCodes = new Set();
  for (const pattern of route.RoutePattern ?? []) {
    for (const stopPoint of pattern.StopPoints ?? []) {
      if (stopPoint.StopNumber !== undefined) stopNumbers.add(stopPoint.StopNumber);
      if (stopPoint.StopPointCode) stopPointCodes.add(stopPoint.StopPointCode);
    }
  }
  return {
    type: "route",
    routeNumber: route.RouteNumber,
    routeName: routeNameFor(route.RouteNumber),
    category: route.RouteCategory ?? null,
    mode: modeFromCategory(route.RouteCategory ?? null),
    directions: (route.RouteDirections ?? []).map((direction) => direction.DirectionName ?? String(direction.Direction)),
    patterns: (route.RoutePattern ?? []).length,
    stopCount: stopNumbers.size,
    stopPointCount: stopPointCodes.size
  };
}

function vehicleDetails(vehicleNumber, records) {
  const vehicle = snapshotIndex.vehiclesByNumber.get(vehicleNumber) ?? null;
  const trip = (snapshotIndex.tripsByVehicle.get(vehicleNumber) ?? [])[0] ?? null;
  const routeNumbers = [...new Set(records.map((record) => record.routeNumber).filter((number) => number !== null))];
  return {
    type: "vehicle",
    vehicleNumber,
    vehicleName: vehicle?.VehicleName ?? null,
    category: vehicle?.VehicleCategory ?? null,
    mode: modeFromCategory(vehicle?.VehicleCategory ?? null),
    make: vehicle?.ModelData?.Make ?? null,
    model: vehicle?.ModelData?.Model ?? null,
    seats: vehicle?.CapacityData?.Seats ?? null,
    standingSpaces: vehicle?.CapacityData?.StandingSpaces ?? null,
    wheelchairSpaces: vehicle?.CapacityData?.WheelChairSpaces ?? null,
    lengthMm: vehicle?.TechnicalData?.["Length(mm)"] ?? null,
    isActive: trip?.IsActive ?? false,
    known: vehicle !== null,
    routes: routeNumbers.map((number) => ({ routeNumber: number, routeName: routeNameFor(number) }))
  };
}

// ---------------------------------------------------------------------------
// Buses with route preview and delay forecast for the /stats card
// ---------------------------------------------------------------------------

const MAX_BUSES = 40;
const BUS_PREVIEW_STOPS = 6;
const BUS_FORECAST_MINUTES = 10;
const BUS_TREND_WINDOW_MINUTES = 45;
const BUS_TREND_MIN_SAMPLES = 4;
const BUS_TREND_MIN_SPAN_MINUTES = 5;
const BUS_MAX_TREND_SECONDS_PER_MINUTE = 10;
const BUS_UPCOMING_MAX_MINUTES = 180;
const BUS_CURRENT_GRACE_SECONDS = 120;

function passageDeviation(passage) {
  const value = passage.DepartureDeviation ?? passage.ArrivalDeviation;
  if (value === null || value === undefined || value === "") return null;
  const deviation = Number(value);
  return Number.isFinite(deviation) ? deviation : null;
}

function passageScheduledTime(passage) {
  const time = Date.parse(passage.DepartureTimeScheduled ?? passage.ArrivalTimeScheduled ?? "");
  return Number.isFinite(time) ? time : null;
}

// Passages carry no RouteNumber, so the route is derived from the stop points
// of the vehicle's trip: the bus route whose pattern contains the most of them.
function busRouteForVehicle(vehicleNumber, passages) {
  const cached = snapshotIndex.busRouteByVehicle.get(vehicleNumber);
  if (cached !== undefined) return cached;
  const codes = new Set();
  for (const passage of passages) {
    if (passage.StopPointCode) codes.add(passage.StopPointCode);
  }
  let best = null;
  for (const route of snapshot.routes) {
    if (route.RouteCategory !== 5 || !route.RouteNumber) continue;
    let score = 0;
    for (const pattern of route.RoutePattern ?? []) {
      let hits = 0;
      for (const stopPoint of pattern.StopPoints ?? []) {
        if (codes.has(stopPoint.StopPointCode)) hits++;
      }
      if (hits > score) score = hits;
    }
    if (!best || score > best.score) {
      best = { routeNumber: route.RouteNumber, score };
    }
  }
  const match = best && best.score >= 3 ? best.routeNumber : null;
  snapshotIndex.busRouteByVehicle.set(vehicleNumber, match);
  return match;
}

// Least-squares trend of the vehicle's recent measurements in seconds per
// minute. Few or very new samples yield no trend instead of a noisy one.
function vehicleDelayTrend(vehicleNumber, referenceTime) {
  const records = history.byVehicle.get(vehicleNumber) ?? [];
  if (!records.length) return { slope: null, samples: 0 };
  const cutoffIso = new Date(referenceTime - BUS_TREND_WINDOW_MINUTES * 60_000).toISOString();
  const start = firstIndexAtOrAfter(records, cutoffIso);
  const points = [];
  for (let i = start; i < records.length; i++) {
    const time = Date.parse(records[i].timestamp);
    if (!Number.isFinite(time) || time > referenceTime) continue;
    const deviation = deviationOf(records[i]);
    if (deviation === null) continue;
    points.push({ minutes: (time - referenceTime) / 60_000, deviation });
  }
  if (points.length < BUS_TREND_MIN_SAMPLES) return { slope: null, samples: points.length };
  const first = points[0];
  const last = points[points.length - 1];
  if (last.minutes - first.minutes < BUS_TREND_MIN_SPAN_MINUTES) {
    return { slope: null, samples: points.length };
  }
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of points) {
    sumX += point.minutes;
    sumY += point.deviation;
    sumXY += point.minutes * point.deviation;
    sumXX += point.minutes * point.minutes;
  }
  const count = points.length;
  const denominator = count * sumXX - sumX * sumX;
  if (!Number.isFinite(denominator) || denominator === 0) {
    return { slope: null, samples: count };
  }
  const slope = (count * sumXY - sumX * sumY) / denominator;
  return {
    slope: roundValue(Math.max(-BUS_MAX_TREND_SECONDS_PER_MINUTE, Math.min(BUS_MAX_TREND_SECONDS_PER_MINUTE, slope)), 2),
    samples: count
  };
}

function computeBuses({ routeNumber, vehicleNumber, mode }) {
  const referenceIso = snapshot.syncedAt;
  const referenceTime = referenceIso ? Date.parse(referenceIso) : NaN;
  if (mode === "tram" || !Number.isFinite(referenceTime)) {
    return { referenceTime: referenceIso ?? null, total: 0, items: [] };
  }
  const items = [];
  for (const vehicle of snapshot.vehicles) {
    if (vehicle.VehicleCategory !== 5) continue;
    if (vehicleNumber !== null && vehicle.VehicleNumber !== vehicleNumber) continue;
    const passages = (snapshotIndex.passagesByVehicle.get(vehicle.VehicleNumber) ?? [])
      .filter((passage) => passageScheduledTime(passage) !== null)
      .sort((a, b) => passageScheduledTime(a) - passageScheduledTime(b));
    if (!passages.length) continue;
    const startIndex = passages.findIndex((passage) =>
      passageScheduledTime(passage) >= referenceTime - BUS_CURRENT_GRACE_SECONDS * 1000);
    if (startIndex === -1) continue;
    if (passageScheduledTime(passages[startIndex]) > referenceTime + BUS_UPCOMING_MAX_MINUTES * 60_000) continue;

    const matchedRouteNumber = busRouteForVehicle(vehicle.VehicleNumber, passages);
    if (routeNumber !== null && matchedRouteNumber !== routeNumber) continue;

    const current = passages[startIndex];
    const currentDelay = passageDeviation(current);
    const trend = vehicleDelayTrend(vehicle.VehicleNumber, referenceTime);
    const direction = current.DepartureDirectionText ?? current.ArrivalDirectionText ?? null;
    const stops = passages.slice(startIndex, startIndex + BUS_PREVIEW_STOPS).map((passage) => {
      const scheduled = passageScheduledTime(passage);
      const live = passageDeviation(passage);
      const minutesAhead = (scheduled - referenceTime) / 60_000;
      const projected = live === null && currentDelay !== null && trend.slope !== null
        ? Math.round(currentDelay + trend.slope * Math.max(minutesAhead, 0))
        : null;
      return {
        stopName: passage.StopName ?? null,
        platformName: passage.PlatformName ?? null,
        scheduledTime: new Date(scheduled).toISOString(),
        minutesAhead: roundValue(minutesAhead, 1),
        delaySeconds: live ?? projected,
        live: live !== null
      };
    });

    // Prefer the operator's live prediction for a stop around ten minutes out,
    // otherwise extrapolate the measured trend from the current delay.
    const target = stops.find((stop) => stop.live && stop.minutesAhead >= BUS_FORECAST_MINUTES * 0.8 && stop.minutesAhead <= BUS_FORECAST_MINUTES * 2.5);
    let forecastDelaySeconds = null;
    let forecastBasis = "none";
    if (target) {
      forecastDelaySeconds = target.delaySeconds;
      forecastBasis = "live";
    } else if (currentDelay !== null && trend.slope !== null) {
      forecastDelaySeconds = Math.round(currentDelay + trend.slope * BUS_FORECAST_MINUTES);
      forecastBasis = "trend";
    } else if (currentDelay !== null) {
      forecastDelaySeconds = currentDelay;
      forecastBasis = "current";
    }

    items.push({
      vehicleNumber: vehicle.VehicleNumber,
      vehicleName: vehicle.VehicleName ?? null,
      routeNumber: matchedRouteNumber,
      routeName: matchedRouteNumber !== null ? routeNameFor(matchedRouteNumber) : null,
      direction,
      currentStop: current.StopName ?? null,
      scheduledTime: stops[0].scheduledTime,
      currentDelaySeconds: currentDelay,
      trendSecondsPerMinute: trend.slope,
      trendSamples: trend.samples,
      forecast: {
        minutesAhead: BUS_FORECAST_MINUTES,
        delaySeconds: forecastDelaySeconds,
        basis: forecastBasis
      },
      stops
    });
  }
  items.sort((a, b) => {
    const routeA = a.routeNumber ?? Number.MAX_SAFE_INTEGER;
    const routeB = b.routeNumber ?? Number.MAX_SAFE_INTEGER;
    if (routeA !== routeB) return routeA - routeB;
    return Date.parse(a.scheduledTime) - Date.parse(b.scheduledTime);
  });
  return {
    referenceTime: referenceIso,
    total: items.length,
    items: items.slice(0, MAX_BUSES)
  };
}

function statsWindow(allTime, minutes) {
  if (allTime) return { start: 0, cutoff: null };
  return delayWindow(minutes);
}

function statsRecords({ start, routeNumber, vehicleNumber, mode }) {
  const scoped = [];
  const all = history.records;
  for (let i = start; i < all.length; i++) {
    const record = all[i];
    if (routeNumber !== null && record.routeNumber !== routeNumber) continue;
    if (vehicleNumber !== null && record.vehicleNumber !== vehicleNumber) continue;
    scoped.push(record);
  }
  return {
    scoped,
    records: mode === "all" ? scoped : scoped.filter((record) => modeOfRecord(record) === mode)
  };
}

function computeStats({ allTime, minutes, routeNumber, vehicleNumber, mode }) {
  const { start, cutoff } = statsWindow(allTime, minutes);
  const { scoped, records } = statsRecords({ start, routeNumber, vehicleNumber, mode });
  const deviations = [];
  for (const record of records) {
    const deviation = deviationOf(record);
    if (deviation !== null) deviations.push(deviation);
  }

  const byDelay = (a, b) => (b.averageDelaySeconds ?? 0) - (a.averageDelaySeconds ?? 0);
  const routes = groupDeviations(records, (record) => record.routeNumber)
    .map(({ key, modes, ...group }) => ({
      routeNumber: key,
      routeName: routeNameFor(key),
      mode: dominantMode(modes),
      ...group
    }))
    .sort(byDelay)
    .slice(0, MAX_STATS_ROWS);
  const vehicles = groupDeviations(records, (record) => record.vehicleNumber)
    .map(({ key, modes, ...group }) => ({
      vehicleNumber: key,
      vehicleName: vehicleNameFor(key),
      mode: modeFromCategory(snapshotIndex.vehiclesByNumber.get(key)?.VehicleCategory ?? null),
      ...group
    }))
    .sort(byDelay)
    .slice(0, MAX_STATS_ROWS);

  const scope = vehicleNumber !== null
    ? { type: "vehicle", vehicleNumber, mode }
    : routeNumber !== null
      ? { type: "route", routeNumber, mode }
      : { type: "network", mode };

  return {
    syncedAt: snapshot.syncedAt,
    generatedAt: new Date().toISOString(),
    window: {
      minutes: allTime ? null : minutes,
      allTime,
      since: allTime ? history.records[0]?.timestamp ?? null : new Date(cutoff).toISOString(),
      until: new Date().toISOString()
    },
    scope,
    network: {
      routes: snapshot.routes.length,
      vehicles: snapshot.vehicles.length,
      activeVehicles: snapshot.trips.filter((trip) => trip.IsActive === true).length,
      stops: snapshot.stops.length,
      stopPoints: snapshot.stopPoints.length,
      passages: snapshot.passages.length,
      vehiclesByMode: countByMode(snapshot.vehicles, (vehicle) => vehicle.VehicleCategory),
      routesByMode: countByMode(snapshot.routes, (route) => route.RouteCategory)
    },
    summary: summarizeDeviations(deviations),
    histogram: delayHistogram(deviations),
    timeline: buildTimeline(records),
    modeBreakdown: summarizeByMode(scoped),
    routes,
    vehicles,
    buses: computeBuses({ routeNumber, vehicleNumber, mode }),
    details: vehicleNumber !== null
      ? vehicleDetails(vehicleNumber, records)
      : routeNumber !== null
        ? routeDetails(routeNumber)
        : null
  };
}

function statsOptions(url) {
  const rawMinutes = url.searchParams.get("minutes") || "180";
  const allTime = rawMinutes === "all";
  const modeParam = url.searchParams.get("mode");
  return {
    allTime,
    minutes: allTime ? null : Math.min(Math.max(Number(rawMinutes), 1), 1440),
    routeNumber: numberParam(url, "routeNumber"),
    vehicleNumber: numberParam(url, "vehicleNumber"),
    mode: modeParam === "tram" || modeParam === "bus" ? modeParam : "all"
  };
}

function statsOptionsError(options) {
  if (options.routeNumber !== null && !Number.isFinite(options.routeNumber)) return "Ungültige Liniennummer.";
  if (options.vehicleNumber !== null && !Number.isFinite(options.vehicleNumber)) return "Ungültige Fahrzeugnummer.";
  if (!options.allTime && !Number.isFinite(options.minutes)) return "Ungültige Zeitangabe.";
  return null;
}

const EXPORT_DATASETS = ["delays", "routes", "vehicles"];
const DELAY_CSV_HEADER = ["Zeitstempel", "Fahrzeug", "Linie", "Verkehrsmittel", "Abweichung_Sekunden", "Quelle"];
const STATS_CSV_HEADER = ["Messungen", "Durchschnitt_Sekunden", "Durchschnitt_Minuten", "Median_Sekunden", "Puenktlich_Prozent", "ZuFrueh_Prozent", "ZuSpaet_Prozent", "Maximum_Sekunden"];

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvNumber(value) {
  return Number.isFinite(value) ? String(value).replace(".", ",") : "";
}

// German Excel reads UTF-8 CSV with BOM and semicolon separators correctly.
function sendCsv(response, filename, header, rows) {
  const body = Buffer.from("\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n") + "\r\n", "utf8");
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store"
  });
  response.end(response.req?.method === "HEAD" ? undefined : body);
}

function statsCsvNumbers(row) {
  return [
    row.samples,
    csvNumber(row.averageDelaySeconds),
    csvNumber(row.averageDelayMinutes),
    csvNumber(row.medianDelaySeconds),
    csvNumber(row.punctualPercent),
    csvNumber(row.earlyPercent),
    csvNumber(row.latePercent),
    csvNumber(row.maxDelaySeconds)
  ];
}

async function getStatsPage() {
  if (statsPage === null) statsPage = await readFile(STATS_PAGE_FILE, "utf8");
  return statsPage;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
};

// Behind Cloudflare Tunnel (or any reverse proxy) the public hostname arrives in
// X-Forwarded-Host and the client scheme in X-Forwarded-Proto, while Host carries
// the origin hostname. Prefer the forwarded values so generated URLs stay public.
function headerValue(request, name) {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function configuredBaseUrl(value) {
  if (!value) return "";
  try {
    return new URL(value.trim()).origin;
  } catch {
    console.error(`PUBLIC_BASE_URL ist ungültig und wird ignoriert: ${value}`);
    return "";
  }
}

function requestOrigin(request, requestUrl) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = headerValue(request, "x-forwarded-host") || headerValue(request, "host") || requestUrl.host || "localhost";
  const forwardedProto = headerValue(request, "x-forwarded-proto").toLowerCase();
  const scheme = forwardedProto === "https" || forwardedProto === "http"
    ? forwardedProto
    : requestUrl.protocol.replace(":", "") || "http";
  return `${scheme}://${host}`;
}

function sendBuffer(response, status, body) {
  response.writeHead(status, { ...JSON_HEADERS, "content-length": body.length });
  // HEAD is answered like GET but without a payload, so health checks work.
  response.end(response.req?.method === "HEAD" ? undefined : body);
}

function jsonResponse(response, status, value) {
  sendBuffer(response, status, Buffer.from(JSON.stringify(value)));
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache"
};

function sendHtml(response, status, html) {
  response.writeHead(status, { ...HTML_HEADERS, "content-length": Buffer.byteLength(html) });
  response.end(response.req?.method === "HEAD" ? undefined : html);
}

function numberParam(url, name) {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? null : Number(value);
}

function boundedNumber(url, name, fallback, min, max) {
  const value = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

async function handleRequest(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    return jsonResponse(response, 405, { error: "Nur GET und HEAD werden unterstützt." });
  }
  // request.url is origin-form behind a tunnel, so it never needs the Host header.
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const vehicleNumber = numberParam(url, "vehicleNumber");
  const routeNumber = numberParam(url, "routeNumber");

  if (path === "/") {
    const version = await getPackageVersion();
    const origin = requestOrigin(request, url);
    return jsonResponse(response, 200, {
      name: "SWU ÖPNV-Datenserver",
      version,
      syncedAt: snapshot.syncedAt,
      origin,
      routes: apiRoutes.map((route) => ({
        ...route,
        url: new URL(route.path, origin).toString()
      }))
    });
  }
  if (path === "/api/health") {
    return jsonResponse(response, 200, {
      ok: true,
      syncedAt: snapshot.syncedAt,
      syncInProgress,
      partial: snapshot.partial,
      gtfs: gtfs
        ? { loadedAt: gtfs.loadedAt, routes: gtfs.routes.length, stops: gtfs.stops.length, trips: gtfs.trips.length }
        : null
    });
  }
  if (path === "/api/sync") {
    const result = await syncData();
    return jsonResponse(response, 200, result);
  }
  if (path.startsWith("/api/gtfs")) {
    return handleGtfsRequest(response, url, path);
  }
  if (path === "/stats") {
    return sendHtml(response, 200, await getStatsPage());
  }
  if (path === "/api/stats/search") {
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const matches = (value) => query === "" || String(value ?? "").toLowerCase().includes(query);
    return jsonResponse(response, 200, {
      routes: snapshot.routes
        .filter((route) => matches(route.RouteNumber) || matches(route.RouteName))
        .slice(0, 8)
        .map((route) => ({
          routeNumber: route.RouteNumber,
          routeName: routeNameFor(route.RouteNumber),
          mode: modeFromCategory(route.RouteCategory ?? null)
        })),
      vehicles: snapshot.vehicles
        .filter((vehicle) => matches(vehicle.VehicleNumber) || matches(vehicle.VehicleName))
        .slice(0, 8)
        .map((vehicle) => ({
          vehicleNumber: vehicle.VehicleNumber,
          vehicleName: vehicle.VehicleName ?? null,
          mode: modeFromCategory(vehicle.VehicleCategory ?? null)
        }))
    });
  }
  if (path === "/api/stats/export") {
    const options = statsOptions(url);
    const optionsError = statsOptionsError(options);
    if (optionsError) return jsonResponse(response, 400, { error: optionsError });
    const dataset = url.searchParams.get("dataset") || "routes";
    if (!EXPORT_DATASETS.includes(dataset)) {
      return jsonResponse(response, 400, { error: "Unbekannter Export-Datensatz." });
    }
    if (dataset === "delays") {
      const { start } = statsWindow(options.allTime, options.minutes);
      const { records } = statsRecords({ ...options, start });
      const rows = records
        .filter((record) => deviationOf(record) !== null)
        .map((record) => [
          record.timestamp,
          record.vehicleNumber,
          record.routeNumber ?? "",
          MODE_LABELS[modeOfRecord(record)],
          record.deviation,
          record.source ?? ""
        ]);
      return sendCsv(response, "swu-statistik-messwerte.csv", DELAY_CSV_HEADER, rows);
    }
    const stats = computeStats(options);
    if (dataset === "routes") {
      const rows = stats.routes.map((route) => [
        route.routeName,
        MODE_LABELS[route.mode] ?? "",
        ...statsCsvNumbers(route)
      ]);
      return sendCsv(response, "swu-statistik-linien.csv", ["Linie", "Verkehrsmittel", ...STATS_CSV_HEADER], rows);
    }
    const rows = stats.vehicles.map((vehicle) => [
      vehicle.vehicleNumber,
      vehicle.vehicleName ?? "",
      MODE_LABELS[vehicle.mode] ?? "",
      ...statsCsvNumbers(vehicle)
    ]);
    return sendCsv(response, "swu-statistik-fahrzeuge.csv", ["Fahrzeug", "Name", "Verkehrsmittel", ...STATS_CSV_HEADER], rows);
  }
  if (path === "/api/stats") {
    const options = statsOptions(url);
    const optionsError = statsOptionsError(options);
    if (optionsError) return jsonResponse(response, 400, { error: optionsError });
    return jsonResponse(response, 200, computeStats(options));
  }
  if (path === "/api/snapshot") {
    return sendBuffer(response, 200, cachedBody("snapshot", () => snapshot));
  }
  if (path === "/api/routes") {
    if (routeNumber === null) {
      return sendBuffer(response, 200, cachedBody("routes", () => ({ syncedAt: snapshot.syncedAt, data: snapshot.routes })));
    }
    const routes = snapshot.routes.filter((route) => route.RouteNumber === routeNumber);
    return jsonResponse(response, 200, { syncedAt: snapshot.syncedAt, data: routes });
  }
  if (path === "/api/vehicles") {
    if (vehicleNumber === null) {
      return sendBuffer(response, 200, cachedBody("vehicles", () => ({ syncedAt: snapshot.syncedAt, data: snapshot.vehicles })));
    }
    const vehicles = snapshot.vehicles.filter((vehicle) => vehicle.VehicleNumber === vehicleNumber);
    return jsonResponse(response, 200, { syncedAt: snapshot.syncedAt, data: vehicles });
  }
  const vehicleMatch = path.match(/^\/api\/vehicles\/([^/]+)$/);
  if (vehicleMatch) {
    const requestedNumber = Number(vehicleMatch[1]);
    if (!Number.isInteger(requestedNumber)) return jsonResponse(response, 400, { error: "Ungültige Fahrzeugnummer." });
    const delays = history.byVehicle.get(requestedNumber) ?? [];
    const routeNumbers = [...new Set(delays.map((record) => record.routeNumber).filter((number) => number !== null))];
    return jsonResponse(response, 200, {
      syncedAt: snapshot.syncedAt,
      vehicle: snapshotIndex.vehiclesByNumber.get(requestedNumber) ?? null,
      currentTrips: snapshotIndex.tripsByVehicle.get(requestedNumber) ?? [],
      routes: routeNumbers.map((number) => snapshotIndex.routesByNumber.get(number) ?? { RouteNumber: number }),
      delays
    });
  }
  if (path === "/api/search") {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const vehicles = snapshot.vehicles.filter((vehicle) =>
      query === "" || String(vehicle.VehicleNumber).toLowerCase().includes(query) ||
      String(vehicle.VehicleName || "").toLowerCase().includes(query)
    );
    const trips = snapshot.trips.filter((trip) =>
      query === "" || String(trip.VehicleNumber).toLowerCase().includes(query)
    );
    const delays = query === ""
      ? history.records
      : history.records.filter((record) => String(record.vehicleNumber).toLowerCase().includes(query));
    const routeNumbers = [...new Set(delays.map((record) => record.routeNumber).filter((number) => number !== null))];
    return jsonResponse(response, 200, {
      syncedAt: snapshot.syncedAt,
      vehicles,
      trips,
      routes: routeNumbers.map((number) => snapshotIndex.routesByNumber.get(number) ?? { RouteNumber: number }),
      delays
    });
  }
  if (path === "/api/delays") {
    const minutes = Math.min(Math.max(Number(url.searchParams.get("minutes") || 60), 1), 1440);
    const { cutoff, start } = delayWindow(minutes);
    const records = history.records;
    const data = [];
    for (let i = start; i < records.length; i++) {
      const record = records[i];
      if (vehicleNumber !== null && record.vehicleNumber !== vehicleNumber) continue;
      if (routeNumber !== null && record.routeNumber !== routeNumber) continue;
      data.push(record);
    }
    return jsonResponse(response, 200, { since: new Date(cutoff).toISOString(), data });
  }
  if (path === "/api/delays/average") {
    const minutes = Math.min(Math.max(Number(url.searchParams.get("minutes") || 60), 1), 1440);
    const { cutoff, start } = delayWindow(minutes);
    const records = history.records;
    let sum = 0;
    let samples = 0;
    for (let i = start; i < records.length; i++) {
      const record = records[i];
      if (vehicleNumber !== null && record.vehicleNumber !== vehicleNumber) continue;
      if (routeNumber !== null && record.routeNumber !== routeNumber) continue;
      const deviation = deviationOf(record);
      if (deviation === null) continue;
      sum += deviation;
      samples++;
    }
    const averageSeconds = samples ? sum / samples : null;
    return jsonResponse(response, 200, {
      since: new Date(cutoff).toISOString(),
      until: new Date().toISOString(),
      scope: vehicleNumber !== null
        ? { type: "vehicle", vehicleNumber }
        : routeNumber !== null
          ? { type: "route", routeNumber }
          : { type: "network" },
      samples,
      averageDelaySeconds: averageSeconds,
      averageDelayMinutes: averageSeconds === null ? null : averageSeconds / 60
    });
  }
  return jsonResponse(response, 404, { error: "Endpunkt nicht gefunden." });
}

function gtfsUnavailable(response) {
  return jsonResponse(response, 503, { error: "GTFS-Daten sind noch nicht geladen." });
}
function handleGtfsRequest(response, url, path) {
  if (path === "/api/gtfs") {
    if (!gtfs) return gtfsUnavailable(response);
    return jsonResponse(response, 200, gtfs.overview());
  }
  if (path === "/api/gtfs/sync") {
    return refreshGtfs({ force: true })
      .then((result) => jsonResponse(response, 200, result))
      .catch((error) => jsonResponse(response, 502, { error: error.message }));
  }
  if (!gtfs) return gtfsUnavailable(response);

  if (path === "/api/gtfs/stops") {
    const query = (url.searchParams.get("q") || "").trim();
    const limit = url.searchParams.has("limit") ? boundedNumber(url, "limit", 1000, 1, 1000) : null;
    const data = gtfs.searchStops(query, limit).map((stop) => ({
      ...stop,
      routes: gtfs.routesAtStop(stop.stopId).map((route) => route.shortName ?? route.routeId)
    }));
    return jsonResponse(response, 200, { loadedAt: gtfs.loadedAt, data });
  }
  const stopMatch = path.match(/^\/api\/gtfs\/stops\/([^/]+)$/);
  if (stopMatch) {
    const stop = gtfs.stop(decodeURIComponent(stopMatch[1]));
    if (!stop) return jsonResponse(response, 404, { error: "Haltestelle nicht gefunden." });
    return jsonResponse(response, 200, { loadedAt: gtfs.loadedAt, stop, routes: gtfs.routesAtStop(stop.stopId) });
  }
  if (path === "/api/gtfs/routes") {
    const routeId = url.searchParams.get("routeId");
    const query = (url.searchParams.get("q") || "").trim();
    const data = routeId
      ? gtfs.searchRoutes("").filter((route) => route.routeId === routeId)
      : gtfs.searchRoutes(query);
    return jsonResponse(response, 200, { loadedAt: gtfs.loadedAt, data });
  }
  const routeMatch = path.match(/^\/api\/gtfs\/routes\/([^/]+)$/);
  if (routeMatch) {
    const route = gtfs.route(decodeURIComponent(routeMatch[1]));
    if (!route) return jsonResponse(response, 404, { error: "Linie nicht gefunden." });
    return jsonResponse(response, 200, {
      loadedAt: gtfs.loadedAt,
      route,
      directions: gtfs.routeVariants(route.routeId)
    });
  }
  const tripMatch = path.match(/^\/api\/gtfs\/trips\/([^/]+)$/);
  if (tripMatch) {
    const trip = gtfs.trip(decodeURIComponent(tripMatch[1]));
    if (!trip) return jsonResponse(response, 404, { error: "Fahrt nicht gefunden." });
    return jsonResponse(response, 200, { loadedAt: gtfs.loadedAt, trip });
  }
  if (path === "/api/gtfs/departures") {
    const stopId = url.searchParams.get("stopId") ?? url.searchParams.get("stop");
    if (!stopId) return jsonResponse(response, 400, { error: "Parameter stopId fehlt." });
    const stop = gtfs.stop(stopId);
    if (!stop) return jsonResponse(response, 404, { error: "Haltestelle nicht gefunden." });
    const minutes = boundedNumber(url, "minutes", 120, 1, 1440);
    const limit = boundedNumber(url, "limit", 30, 1, 500);
    const now = Date.now();
    return jsonResponse(response, 200, {
      loadedAt: gtfs.loadedAt,
      stop: { stopId: stop.stopId, name: stop.name },
      generatedAt: new Date(now).toISOString(),
      minutes,
      departures: gtfs.departures(stop.stopId, { now, minutes, limit })
    });
  }
  if (path === "/api/gtfs/map") {
    return jsonResponse(response, 200, gtfsMap());
  }
  return jsonResponse(response, 404, { error: "Endpunkt nicht gefunden." });
}

function roundCoordinate(value) {
  return Math.round(value * 100_000) / 100_000;
}

// Netzkarte für das Dashboard: Haltestellen mit Koordinaten und die
// Linienverläufe aus dem Fahrplan (längste Fahrt je Richtung).
function gtfsMap() {
  const stops = [];
  const seen = new Set();
  for (const stop of gtfs.stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    // Gegenüberliegende Steige liegen teils auf denselben Koordinaten und
    // würden sich auf der Karte nur überdecken.
    const key = `${stop.lat.toFixed(5)}:${stop.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stops.push({
      stopId: stop.stopId,
      name: stop.name,
      lat: roundCoordinate(stop.lat),
      lon: roundCoordinate(stop.lon)
    });
  }
  const lines = [];
  for (const route of gtfs.routes) {
    const mode = route.type === 0 ? "tram" : route.type === 3 ? "bus" : "other";
    for (const variant of gtfs.routeVariants(route.routeId)) {
      const points = [];
      for (const entry of variant.stops) {
        const stop = gtfs.stop(entry.stopId);
        if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
        const point = [roundCoordinate(stop.lat), roundCoordinate(stop.lon)];
        const last = points[points.length - 1];
        if (last && last[0] === point[0] && last[1] === point[1]) continue;
        points.push(point);
      }
      if (points.length < 2) continue;
      lines.push({
        routeId: route.routeId,
        line: route.shortName ?? route.routeId,
        longName: route.longName ?? null,
        mode,
        color: route.color ? `#${route.color}` : null,
        directionId: variant.directionId,
        headsign: variant.headsigns[0] ?? null,
        points
      });
    }
  }
  return { loadedAt: gtfs.loadedAt, stops, lines };
}

async function start() {
  await mkdir(DATA_DIR, { recursive: true });
  await getPackageVersion();
  let warmStart = false;
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      installSnapshot(JSON.parse(await readFile(SNAPSHOT_FILE, "utf8")));
      warmStart = true;
    } catch (error) {
      console.error(`Snapshot konnte nicht geladen werden: ${error.message}`);
    }
  }
  await ensureHistoryLoaded();
  if (process.argv.includes("--gtfs-only")) {
    await refreshGtfs({ force: true });
    return;
  }
  if (process.argv.includes("--sync-only")) {
    await syncData();
    return;
  }
  // Der Fahrplan ist auch ohne Live-Daten nutzbar; ein Fehler beim GTFS-Laden
  // darf den Serverstart deshalb nicht verhindern.
  try {
    await refreshGtfs();
  } catch (error) {
    console.error(`GTFS-Daten konnten nicht geladen werden: ${error.message}`);
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(error);
      jsonResponse(response, 500, { error: "Interner Serverfehler." });
    });
  });
  // Cloudflare Tunnel reuses origin connections, so keep them open longer than
  // the proxy's idle timeout instead of letting Node drop them after 5 seconds.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 66_000;
  const syncTimer = setInterval(() => syncData().catch((error) => console.error(`sync failed: ${error.message}`)), SYNC_INTERVAL_MS);
  const gtfsTimer = setInterval(() => refreshGtfs().catch((error) => console.error(`gtfs failed: ${error.message}`)), GTFS_REFRESH_MS);
  gtfsTimer.unref();
  // Service managers and containers stop the process with SIGTERM: finish
  // in-flight requests and history writes before exiting.
  const shutdown = (signal) => {
    console.log(`${signal} empfangen, Server wird beendet.`);
    clearInterval(syncTimer);
    clearInterval(gtfsTimer);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  server.listen(PORT, HOST, () => console.log(`SWU-Datenserver läuft auf http://${HOST}:${PORT}`));
  if (warmStart) {
    // Cached snapshot is already served; refresh it in the background.
    syncData().catch((error) => console.error(`sync failed: ${error.message}`));
  } else {
    // Cold start: block until there is data to serve.
    await syncData();
  }
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
