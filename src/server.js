import { createServer } from "node:http";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
const SNAPSHOT_FILE = join(DATA_DIR, "latest.json");
const HISTORY_FILE = join(DATA_DIR, "delay-history.jsonl");
const PACKAGE_FILE = join(ROOT, "package.json");
const PORT = Number(process.env.PORT || 3000);
const SWU_BASE_URL = process.env.SWU_BASE_URL || "https://api.swu.de/mobility/v1";
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

// Lookup tables and serialized response bodies derived from the snapshot.
// Rebuilt once per sync instead of being recomputed per request.
const snapshotIndex = {
  vehiclesByNumber: new Map(),
  routesByNumber: new Map(),
  tripsByVehicle: new Map(),
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
  { method: "GET", path: "/api/sync", description: "Startet sofort eine Synchronisierung mit der SWU API." }
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
  for (const vehicle of snapshot.vehicles) snapshotIndex.vehiclesByNumber.set(vehicle.VehicleNumber, vehicle);
  for (const route of snapshot.routes) snapshotIndex.routesByNumber.set(route.RouteNumber, route);
  for (const trip of snapshot.trips) {
    const bucket = snapshotIndex.tripsByVehicle.get(trip.VehicleNumber);
    if (bucket) bucket.push(trip);
    else snapshotIndex.tripsByVehicle.set(trip.VehicleNumber, [trip]);
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

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
};

function sendBuffer(response, status, body) {
  response.writeHead(status, { ...JSON_HEADERS, "content-length": body.length });
  response.end(body);
}

function jsonResponse(response, status, value) {
  sendBuffer(response, status, Buffer.from(JSON.stringify(value)));
}

function numberParam(url, name) {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? null : Number(value);
}

async function handleRequest(request, response) {
  if (request.method !== "GET") return jsonResponse(response, 405, { error: "Nur GET wird unterstützt." });
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const vehicleNumber = numberParam(url, "vehicleNumber");
  const routeNumber = numberParam(url, "routeNumber");

  if (path === "/") {
    const version = await getPackageVersion();
    return jsonResponse(response, 200, {
      name: "SWU ÖPNV-Datenserver",
      version,
      syncedAt: snapshot.syncedAt,
      routes: apiRoutes.map((route) => ({
        ...route,
        url: new URL(route.path, url.origin).toString()
      }))
    });
  }
  if (path === "/api/health") {
    return jsonResponse(response, 200, { ok: true, syncedAt: snapshot.syncedAt, syncInProgress, partial: snapshot.partial });
  }
  if (path === "/api/sync") {
    const result = await syncData();
    return jsonResponse(response, 200, result);
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
      const deviation = Number(record.deviation);
      if (!Number.isFinite(deviation)) continue;
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
  if (process.argv.includes("--sync-only")) {
    await syncData();
    return;
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(error);
      jsonResponse(response, 500, { error: "Interner Serverfehler." });
    });
  });
  server.listen(PORT, () => console.log(`SWU-Datenserver läuft auf http://localhost:${PORT}`));
  setInterval(() => syncData().catch((error) => console.error(`sync failed: ${error.message}`)), SYNC_INTERVAL_MS);
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
