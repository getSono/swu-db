import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inflateRawSync } from "node:zlib";

// Der SWU-Fahrplan gilt in der Zeitzone Europe/Berlin. GTFS-Zeiten sind
// Ortszeiten, teils über 24:00:00 hinaus, wenn eine Fahrt nach Mitternacht endet.
const TIME_ZONE = "Europe/Berlin";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

function localParts(ms) {
  const parts = timeFormat.formatToParts(new Date(ms));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

// Lokale Wanduhrzeit eines Zeitstempels, als UTC-Millisekunden kodiert.
function wallClockOf(ms) {
  const parts = localParts(ms);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

// Ost-Offset der Zeitzone zum Zeitpunkt ms in Millisekunden.
function offsetMsAt(ms) {
  return wallClockOf(ms) - Math.trunc(ms / 1000) * 1000;
}

// Wandelt eine lokale Wanduhrzeit in einen Zeitstempel (UTC-Millisekunden) um.
// Der Offset wird am Zielzeitpunkt bestimmt: an den Umstellungstagen gilt um
// Mitternacht ein anderer Offset als mittags, deshalb werden die Offsets rund
// um den Zielzeitpunkt geprüft und der Kandidat gewählt, der wieder die
// gewünschte Wanduhrzeit ergibt.
const DAY_MS = 24 * 60 * 60 * 1000;

function wallClockToMs(wallClock) {
  const target = Math.trunc(wallClock / 1000) * 1000;
  const offsets = [offsetMsAt(target - DAY_MS), offsetMsAt(target), offsetMsAt(target + DAY_MS)];
  for (const offset of new Set(offsets)) {
    const candidate = target - offset;
    if (wallClockOf(candidate) === target) return candidate;
  }
  // Wanduhrzeit existiert nicht (Frühjahrslücke): iterativ annähern.
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt++) guess = target - offsetMsAt(guess);
  return guess;
}

// Beginn des lokalen Kalendertags als Zeitstempel (UTC-Millisekunden).
function localDayStart(ms) {
  const parts = localParts(ms);
  return wallClockToMs(Date.UTC(parts.year, parts.month - 1, parts.day));
}

// Lokale Wanduhrzeit eines Betriebstags (Sekunden seit 00:00, teils über
// 24:00:00 hinaus) als Zeitstempel.
function localSecondsToMs(dayStart, seconds) {
  const parts = localParts(dayStart);
  return wallClockToMs(Date.UTC(parts.year, parts.month - 1, parts.day) + seconds * 1000);
}

// GTFS-Datum (YYYYMMDD) des lokalen Kalendertags.
function dateKey(ms) {
  const parts = localParts(ms);
  return `${parts.year}${String(parts.month).padStart(2, "0")}${String(parts.day).padStart(2, "0")}`;
}

function formatLocalIso(ms) {
  const parts = localParts(ms);
  const offsetMinutes = Math.round(offsetMsAt(ms) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (value) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

// "HH:MM:SS" aus dem GTFS-Feed als Sekunden seit Betriebstagsbeginn.
function timeToSeconds(value) {
  if (!value) return null;
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

// The feed is small enough to parse in memory, so no dependency on an unzip
// binary: read the ZIP central directory and inflate the needed entries with
// node:zlib.
function readZipDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("GTFS-ZIP: Zentralverzeichnis nicht gefunden.");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("GTFS-ZIP: Eintrag im Zentralverzeichnis ist beschädigt.");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error("GTFS-ZIP: Lokaler Dateikopf ist beschädigt.");
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`GTFS-ZIP: Kompressionsverfahren ${entry.method} wird nicht unterstützt.`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((name) => name.replace(/^\uFEFF/, "").trim());
  const records = [];
  for (let index = 1; index < rows.length; index++) {
    const values = rows[index];
    if (values.length === 1 && values[0] === "") continue;
    const record = {};
    for (let column = 0; column < header.length; column++) {
      record[header[column]] = values[column] ?? "";
    }
    records.push(record);
  }
  return records;
}

function feedText(entries, buffer, name) {
  const entry = entries.get(name);
  return entry ? readZipEntry(buffer, entry).toString("utf8") : "";
}

async function downloadFeed(url, file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`GTFS-Download ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new Error("GTFS-Download ist keine ZIP-Datei.");
    }
    const temporary = `${file}.tmp`;
    await writeFile(temporary, buffer);
    await rename(temporary, file);
  } finally {
    clearTimeout(timer);
  }
}

async function feedIsStale(file, maxAgeMs) {
  if (!existsSync(file)) return true;
  const info = await stat(file);
  return Date.now() - info.mtimeMs > maxAgeMs;
}

function buildStopTimes(records, tripsById) {
  const stopTimesByTrip = new Map();
  const departuresByStop = new Map();
  for (const record of records) {
    const trip = tripsById.get(record.trip_id);
    if (!trip) continue;
    const departure = record.departure_time || record.arrival_time;
    const stopTime = {
      stopId: record.stop_id,
      stopSequence: Number(record.stop_sequence),
      arrivalTime: stringOrNull(record.arrival_time),
      departureTime: stringOrNull(record.departure_time),
      pickupType: numberOrNull(record.pickup_type),
      dropOffType: numberOrNull(record.drop_off_type)
    };
    const bucket = stopTimesByTrip.get(trip.tripId);
    if (bucket) bucket.push(stopTime);
    else stopTimesByTrip.set(trip.tripId, [stopTime]);

    const seconds = timeToSeconds(departure);
    // pickup_type 1 bedeutet: an dieser Haltestelle wird nicht eingestiegen.
    if (seconds === null || record.pickup_type === "1") continue;
    const departureEntry = {
      tripId: trip.tripId,
      routeId: trip.routeId,
      serviceId: trip.serviceId,
      directionId: trip.directionId,
      headsign: trip.headsign,
      departureTime: departure,
      seconds,
      stopSequence: stopTime.stopSequence
    };
    const departures = departuresByStop.get(record.stop_id);
    if (departures) departures.push(departureEntry);
    else departuresByStop.set(record.stop_id, [departureEntry]);
  }
  for (const stopTimes of stopTimesByTrip.values()) {
    stopTimes.sort((a, b) => a.stopSequence - b.stopSequence);
  }
  for (const departures of departuresByStop.values()) {
    departures.sort((a, b) => a.seconds - b.seconds || a.tripId.localeCompare(b.tripId));
  }
  return { stopTimesByTrip, departuresByStop };
}

export class GtfsFeed {
  constructor({ sourceUrl, loadedAt, feedInfo, agencies, routes, stops, trips, calendar, calendarDates, stopTimesByTrip, departuresByStop, stopTimeCount }) {
    this.sourceUrl = sourceUrl;
    this.loadedAt = loadedAt;
    this.feedInfo = feedInfo;
    this.agencies = agencies;
    this.routes = routes;
    this.stops = stops;
    this.trips = trips;
    this.calendar = calendar;
    this.calendarDates = calendarDates;
    this.stopTimesByTrip = stopTimesByTrip;
    this.departuresByStop = departuresByStop;
    this.stopTimeCount = stopTimeCount;

    this.stopsById = new Map(stops.map((stop) => [stop.stopId, stop]));
    this.routesById = new Map(routes.map((route) => [route.routeId, route]));
    this.tripsById = new Map(trips.map((trip) => [trip.tripId, trip]));
    this.calendarDatesByDate = new Map();
    for (const exception of calendarDates) {
      const bucket = this.calendarDatesByDate.get(exception.date);
      if (bucket) bucket.push(exception);
      else this.calendarDatesByDate.set(exception.date, [exception]);
    }
    this.tripsByRoute = new Map();
    for (const trip of trips) {
      const bucket = this.tripsByRoute.get(trip.routeId);
      if (bucket) bucket.push(trip);
      else this.tripsByRoute.set(trip.routeId, [trip]);
    }
    // Haltestellen (location_type 1) bündeln ihre Steige als parent_station.
    this.childStopsByParent = new Map();
    for (const stop of stops) {
      if (!stop.parentStation) continue;
      const bucket = this.childStopsByParent.get(stop.parentStation);
      if (bucket) bucket.push(stop.stopId);
      else this.childStopsByParent.set(stop.parentStation, [stop.stopId]);
    }
    this.routeVariantsCache = new Map();
  }

  overview() {
    return {
      loadedAt: this.loadedAt,
      source: this.sourceUrl,
      feedInfo: this.feedInfo,
      agencies: this.agencies,
      counts: {
        routes: this.routes.length,
        trips: this.trips.length,
        stops: this.stops.length,
        stopTimes: this.stopTimeCount,
        services: this.calendar.length
      }
    };
  }

  stop(stopId) {
    return this.stopsById.get(stopId) ?? null;
  }

  searchStops(query, limit) {
    const needle = query.toLowerCase();
    const matches = this.stops.filter((stop) =>
      needle === "" || stop.name.toLowerCase().includes(needle) || stop.stopId.toLowerCase().includes(needle)
    );
    return limit === null ? matches : matches.slice(0, limit);
  }

  route(routeId) {
    return this.routesById.get(routeId) ?? null;
  }

  searchRoutes(query) {
    const needle = query.toLowerCase();
    return this.routes.filter((route) =>
      needle === "" ||
      route.routeId.toLowerCase().includes(needle) ||
      String(route.shortName ?? "").toLowerCase().includes(needle) ||
      String(route.longName ?? "").toLowerCase().includes(needle)
    );
  }

  // Eine Haltestelle und, falls es eine Station ist, ihre Steige.
  stopIds(stopId) {
    return [stopId, ...(this.childStopsByParent.get(stopId) ?? [])];
  }

  // Linien, die eine Haltestelle bedienen - abgeleitet aus den Abfahrten.
  routesAtStop(stopId) {
    const routeIds = new Set();
    for (const id of this.stopIds(stopId)) {
      for (const departure of this.departuresByStop.get(id) ?? []) routeIds.add(departure.routeId);
    }
    return [...routeIds]
      .map((routeId) => this.routesById.get(routeId) ?? { routeId })
      .sort((a, b) => String(a.shortName ?? "").localeCompare(String(b.shortName ?? ""), "de", { numeric: true }));
  }

  // Haltestellenfolge je Fahrtrichtung: die längste Fahrt der Richtung dient
  // als repräsentativer Verlauf.
  routeVariants(routeId) {
    let cached = this.routeVariantsCache.get(routeId);
    if (cached) return cached;
    const byDirection = new Map();
    for (const trip of this.tripsByRoute.get(routeId) ?? []) {
      const bucket = byDirection.get(trip.directionId);
      if (bucket) bucket.push(trip);
      else byDirection.set(trip.directionId, [trip]);
    }
    cached = [];
    for (const [directionId, trips] of [...byDirection.entries()].sort((a, b) => a[0] - b[0])) {
      let best = null;
      for (const trip of trips) {
        const stopTimes = this.stopTimesByTrip.get(trip.tripId);
        if (stopTimes && (!best || stopTimes.length > best.stopTimes.length)) best = { trip, stopTimes };
      }
      cached.push({
        directionId,
        headsigns: [...new Set(trips.map((trip) => trip.headsign).filter(Boolean))],
        trips: trips.length,
        referenceTripId: best?.trip.tripId ?? null,
        stops: (best?.stopTimes ?? []).map((stopTime) => {
          const stop = this.stopsById.get(stopTime.stopId);
          return {
            stopId: stopTime.stopId,
            name: stop?.name ?? null,
            stopSequence: stopTime.stopSequence,
            arrivalTime: stopTime.arrivalTime,
            departureTime: stopTime.departureTime
          };
        })
      });
    }
    this.routeVariantsCache.set(routeId, cached);
    return cached;
  }

  trip(tripId) {
    const trip = this.tripsById.get(tripId);
    if (!trip) return null;
    return {
      ...trip,
      route: this.routesById.get(trip.routeId) ?? null,
      stopTimes: (this.stopTimesByTrip.get(trip.tripId) ?? []).map((stopTime) => ({
        ...stopTime,
        name: this.stopsById.get(stopTime.stopId)?.name ?? null
      }))
    };
  }

  activeServiceIds(day) {
    const key = dateKey(day);
    const parts = localParts(day);
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const active = new Set();
    for (const service of this.calendar) {
      if (key < service.startDate || key > service.endDate) continue;
      if (service.days[weekday]) active.add(service.serviceId);
    }
    for (const exception of this.calendarDatesByDate.get(key) ?? []) {
      if (exception.exceptionType === 1) active.add(exception.serviceId);
      else if (exception.exceptionType === 2) active.delete(exception.serviceId);
    }
    return active;
  }

  // Nächste Abfahrten ab "now". Neben dem heutigen Betriebstag werden
  // Fahrten des Vortags berücksichtigt, deren Zeiten über 24:00:00 liegen.
  departures(stopId, { now = Date.now(), minutes = 120, limit = 30 } = {}) {
    const entries = this.stopIds(stopId)
      .flatMap((id) => this.departuresByStop.get(id) ?? [])
      .sort((a, b) => a.seconds - b.seconds);
    const until = now + minutes * 60_000;
    const todayStart = localDayStart(now);
    const days = [localDayStart(todayStart - 12 * 3600_000), todayStart];
    const serviceCache = new Map();
    const result = [];
    for (const dayStart of days) {
      const key = dateKey(dayStart);
      if (!serviceCache.has(key)) serviceCache.set(key, this.activeServiceIds(dayStart));
      const services = serviceCache.get(key);
      if (!services.size) continue;
      for (const entry of entries) {
        if (!services.has(entry.serviceId)) continue;
        const departureMs = localSecondsToMs(dayStart, entry.seconds);
        if (departureMs < now || departureMs > until) continue;
        result.push({
          tripId: entry.tripId,
          routeId: entry.routeId,
          line: this.routesById.get(entry.routeId)?.shortName ?? null,
          headsign: entry.headsign,
          directionId: entry.directionId,
          departureTime: entry.departureTime,
          departure: formatLocalIso(departureMs),
          inSeconds: Math.round((departureMs - now) / 1000),
          stopSequence: entry.stopSequence
        });
      }
    }
    result.sort((a, b) => a.departure.localeCompare(b.departure) || a.tripId.localeCompare(b.tripId));
    return result.slice(0, limit);
  }
}

// Lädt den GTFS-Feed aus data/gtfs und lädt ihn nur neu herunter, wenn die
// Datei fehlt oder älter als maxAgeMs ist.
export async function loadGtfs({ sourceUrl, file, maxAgeMs = 24 * 60 * 60 * 1000 }) {
  await mkdir(dirname(file), { recursive: true });
  if (await feedIsStale(file, maxAgeMs)) {
    await downloadFeed(sourceUrl, file);
    console.log(`GTFS-Feed geladen: ${sourceUrl}`);
  }
  const buffer = await readFile(file);
  const entries = readZipDirectory(buffer);
  const text = (name) => feedText(entries, buffer, name);
  if (!entries.has("stops.txt") || !entries.has("stop_times.txt") || !entries.has("trips.txt") || !entries.has("routes.txt")) {
    throw new Error("GTFS-ZIP enthält keine vollständigen Plandaten (stops, stop_times, trips, routes).");
  }

  const agencies = parseCsv(text("agency.txt")).map((record) => ({
    agencyId: stringOrNull(record.agency_id),
    name: stringOrNull(record.agency_name),
    url: stringOrNull(record.agency_url),
    timezone: stringOrNull(record.agency_timezone),
    language: stringOrNull(record.agency_lang),
    phone: stringOrNull(record.agency_phone),
    email: stringOrNull(record.agency_email)
  }));

  const feedInfoRecords = parseCsv(text("feed_info.txt"));
  const info = feedInfoRecords[0] ?? {};
  const feedInfo = {
    publisherName: stringOrNull(info.feed_publisher_name),
    publisherUrl: stringOrNull(info.feed_publisher_url),
    contactEmail: stringOrNull(info.feed_contact_email),
    language: stringOrNull(info.feed_lang),
    version: stringOrNull(info.feed_version),
    startDate: stringOrNull(info.feed_start_date),
    endDate: stringOrNull(info.feed_end_date)
  };

  const routes = parseCsv(text("routes.txt")).map((record) => ({
    routeId: record.route_id,
    agencyId: stringOrNull(record.agency_id),
    shortName: stringOrNull(record.route_short_name),
    longName: stringOrNull(record.route_long_name),
    type: numberOrNull(record.route_type),
    color: stringOrNull(record.route_color),
    textColor: stringOrNull(record.route_text_color),
    url: stringOrNull(record.route_url)
  }));

  const stops = parseCsv(text("stops.txt")).map((record) => ({
    stopId: record.stop_id,
    code: stringOrNull(record.stop_code),
    name: record.stop_name,
    lat: numberOrNull(record.stop_lat),
    lon: numberOrNull(record.stop_lon),
    description: stringOrNull(record.stop_desc),
    wheelchairBoarding: numberOrNull(record.wheelchair_boarding),
    platformCode: stringOrNull(record.platform_code),
    locationType: numberOrNull(record.location_type),
    parentStation: stringOrNull(record.parent_station),
    zoneId: stringOrNull(record.zone_id)
  }));

  const trips = parseCsv(text("trips.txt")).map((record) => ({
    tripId: record.trip_id,
    routeId: record.route_id,
    serviceId: record.service_id,
    directionId: numberOrNull(record.direction_id),
    shapeId: stringOrNull(record.shape_id),
    headsign: stringOrNull(record.trip_headsign),
    shortName: stringOrNull(record.trip_short_name),
    wheelchairAccessible: numberOrNull(record.wheelchair_accessible),
    bikesAllowed: numberOrNull(record.bikes_allowed),
    blockId: stringOrNull(record.block_id)
  }));

  const calendar = parseCsv(text("calendar.txt")).map((record) => ({
    serviceId: record.service_id,
    startDate: record.start_date,
    endDate: record.end_date,
    days: WEEKDAYS.map((day) => record[day] === "1")
  }));

  const calendarDates = parseCsv(text("calendar_dates.txt")).map((record) => ({
    serviceId: record.service_id,
    date: record.date,
    exceptionType: numberOrNull(record.exception_type)
  }));

  const tripsById = new Map(trips.map((trip) => [trip.tripId, trip]));
  const stopTimeRecords = parseCsv(text("stop_times.txt"));
  const { stopTimesByTrip, departuresByStop } = buildStopTimes(stopTimeRecords, tripsById);

  return new GtfsFeed({
    sourceUrl,
    loadedAt: new Date().toISOString(),
    feedInfo,
    agencies,
    routes,
    stops,
    trips,
    calendar,
    calendarDates,
    stopTimesByTrip,
    departuresByStop,
    stopTimeCount: stopTimeRecords.length
  });
}
