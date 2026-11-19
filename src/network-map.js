// Interaktive Netzkarte aus dem GTFS-Fahrplan. Das Modul bringt sein CSS mit
// und wird vom Dashboard (/stats) und von /embed/map geladen:
//
//   createNetworkMap({ container, meta, apiBase, mode, fill })
//
// Bedienung: Mausrad oder +/− zoomt, Ziehen verschiebt, ein Klick auf eine
// Haltestelle zeigt die nächsten Abfahrten, ein Klick auf eine Linie oder die
// Legende hebt deren Verlauf hervor.

const TILE_SIZE = 256;
const DESIGN_WIDTH = 1100;
const DESIGN_HEIGHT = 560;
const PADDING = 40;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 40;
const DEPARTURE_LIMIT = 6;
const DEPARTURE_MINUTES = 180;

const STYLE_ID = "swu-map-style";
const MAP_CSS = `
.swu-map {
  --swu-bg: #0b0b0d;
  --swu-card: #141417;
  --swu-border: #2a2a31;
  --swu-text: #f4f4f5;
  --swu-muted: #a1a1aa;
  display: grid;
  gap: 10px;
  color: var(--swu-text);
  font-family: "Outfit", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.swu-map.is-fill { height: 100%; grid-template-rows: minmax(0, 1fr) auto auto; }
.swu-map .swu-stage {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--swu-border);
  border-radius: 8px;
  background: var(--swu-card);
}
.swu-map .swu-canvas { height: 100%; }
.swu-map svg {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}
.swu-map svg.is-dragging { cursor: grabbing; }
.swu-map .swu-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.9) saturate(0.6); }
.swu-map .swu-lines polyline { fill: none; stroke-linecap: round; stroke-linejoin: round; opacity: 0.9; }
.swu-map .swu-lines polyline.is-dim { opacity: 0.12; }
.swu-map .swu-stops circle { fill: var(--swu-text); opacity: 0.6; }
.swu-map .swu-stops circle.is-line { opacity: 0.9; }
.swu-map .swu-stops circle.is-selected { fill: #fbbf24; opacity: 1; }
.swu-map .swu-controls { position: absolute; top: 10px; right: 10px; display: grid; gap: 4px; }
.swu-map .swu-controls button {
  width: 30px;
  height: 30px;
  border: 1px solid var(--swu-border);
  border-radius: 6px;
  background: #1b1b20dd;
  color: var(--swu-text);
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(6px);
}
.swu-map .swu-controls button:hover { background: #26262cf0; }
.swu-map .swu-legend { display: flex; flex-wrap: wrap; gap: 6px; }
.swu-map .swu-legend button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--swu-border);
  border-radius: 999px;
  background: transparent;
  color: var(--swu-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.swu-map .swu-legend button[aria-pressed="true"] { border-color: currentColor; color: var(--swu-text); background: #ffffff14; }
.swu-map .swu-legend .swu-chip { width: 10px; height: 10px; border-radius: 3px; background: currentColor; }
.swu-map .swu-detail { border: 1px solid var(--swu-border); border-radius: 8px; background: var(--swu-card); padding: 10px 12px; }
.swu-map .swu-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.swu-map .swu-detail-head strong { font-size: 13px; }
.swu-map .swu-detail-head button {
  border: 0;
  background: transparent;
  color: var(--swu-muted);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.swu-map .swu-departures { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.swu-map .swu-departures li {
  display: grid;
  grid-template-columns: 42px 50px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.swu-map .swu-departures .swu-line {
  padding: 1px 0;
  border-radius: 4px;
  color: #ffffff;
  font-weight: 700;
  text-align: center;
}
.swu-map .swu-departures .swu-time { color: var(--swu-muted); font-variant-numeric: tabular-nums; }
.swu-map .swu-departures .swu-headsign { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swu-map .swu-departures .swu-in { color: var(--swu-muted); font-variant-numeric: tabular-nums; }
.swu-map .swu-empty { margin: 0; color: var(--swu-muted); font-size: 12px; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = MAP_CSS;
  document.head.append(style);
}

// Web-Mercator in normierten Weltkoordinaten (0..1).
const worldX = (lon) => (lon + 180) / 360;
const worldY = (lat) => {
  const radians = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
};

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}

function timeLabel(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function createNetworkMap({ container, meta = null, apiBase = "", mode = "all", fill = false } = {}) {
  ensureStyles();
  const root = document.createElement("div");
  root.className = "swu-map" + (fill ? " is-fill" : "");
  root.innerHTML =
    '<div class="swu-stage">' +
      '<div class="swu-canvas"></div>' +
      '<div class="swu-controls">' +
        '<button type="button" data-zoom="in" aria-label="Hineinzoomen" title="Hineinzoomen">+</button>' +
        '<button type="button" data-zoom="out" aria-label="Herauszoomen" title="Herauszoomen">−</button>' +
        '<button type="button" data-zoom="fit" aria-label="Netz einpassen" title="Netz einpassen">⌂</button>' +
      "</div>" +
    "</div>" +
    '<div class="swu-legend" role="group" aria-label="Linien"></div>' +
    '<div class="swu-detail" hidden></div>';
  container.replaceChildren(root);

  const stage = root.querySelector(".swu-stage");
  const canvas = root.querySelector(".swu-canvas");
  const legend = root.querySelector(".swu-legend");
  const detail = root.querySelector(".swu-detail");

  const state = {
    data: null,
    mode,
    width: 0,
    height: 0,
    fitScale: 0,
    view: null,
    selectedRouteId: null,
    selectedStopId: null
  };

  function measure() {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || container.clientWidth || DESIGN_WIDTH));
    const height = fill
      ? Math.max(220, Math.round(rect.height || window.innerHeight * 0.6))
      : Math.round(width * (DESIGN_HEIGHT / DESIGN_WIDTH));
    const changed = width !== state.width || height !== state.height;
    state.width = width;
    state.height = height;
    if (!fill) stage.style.height = height + "px";
    return changed;
  }

  function visibleLines() {
    if (!state.data) return [];
    return state.data.lines.filter((line) => state.mode === "all" || line.mode === state.mode);
  }

  function fit() {
    if (!state.data) return;
    const lines = visibleLines();
    if (!lines.length) {
      state.view = null;
      canvas.innerHTML = '<p class="swu-empty">Keine Linien für diesen Filter im Fahrplan.</p>';
      return;
    }
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const line of lines) {
      for (const [lat, lon] of line.points) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
    const spanX = worldX(maxLon) - worldX(minLon);
    const spanY = worldY(minLat) - worldY(maxLat);
    state.fitScale = Math.min(
      (state.width - PADDING * 2) / spanX,
      (state.height - PADDING * 2) / spanY
    );
    state.view = {
      scale: state.fitScale,
      centerX: (worldX(minLon) + worldX(maxLon)) / 2,
      centerY: (worldY(minLat) + worldY(maxLat)) / 2
    };
    render();
  }

  function project(lat, lon) {
    const { scale, centerX, centerY } = state.view;
    return [
      worldX(lon) * scale - (centerX * scale - state.width / 2),
      worldY(lat) * scale - (centerY * scale - state.height / 2)
    ];
  }

  const stopKey = (lat, lon) => lat + "," + lon;

  function colorOf(line) {
    return line.color || (line.mode === "tram" ? "#60a5fa" : "#34d399");
  }

  function render() {
    if (!state.view || !state.data) return;
    const { scale, centerX, centerY } = state.view;
    const originX = centerX * scale - state.width / 2;
    const originY = centerY * scale - state.height / 2;
    const lines = visibleLines();
    const selected = state.selectedRouteId;

    // Hintergrundkacheln: ganzzahlige Zoomstufe, auf den Kartenmaßstab skaliert.
    const tileZoom = Math.max(1, Math.min(19, Math.floor(Math.log(scale / TILE_SIZE) / Math.LN2)));
    const tilePixels = scale / Math.pow(2, tileZoom);
    const maxTile = Math.pow(2, tileZoom) - 1;
    let tiles = "";
    for (let x = Math.floor(originX / tilePixels); x <= Math.floor((originX + state.width) / tilePixels); x++) {
      for (let y = Math.floor(originY / tilePixels); y <= Math.floor((originY + state.height) / tilePixels); y++) {
        if (x < 0 || y < 0 || x > maxTile || y > maxTile) continue;
        tiles += '<image href="https://tile.openstreetmap.org/' + tileZoom + "/" + x + "/" + y + '.png" x="' +
          (x * tilePixels - originX).toFixed(1) + '" y="' + (y * tilePixels - originY).toFixed(1) +
          '" width="' + tilePixels.toFixed(1) + '" height="' + tilePixels.toFixed(1) + '"/>';
      }
    }

    const strokes = lines.map((line) => {
      const points = line.points.map(([lat, lon]) => {
        const [x, y] = project(lat, lon);
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      const dim = selected !== null && line.routeId !== selected;
      const width = selected === line.routeId ? 3.4 : line.mode === "tram" ? 2.4 : 1.8;
      const title = "Linie " + line.line + (line.headsign ? " Richtung " + line.headsign : "");
      return '<polyline points="' + points + '" stroke="' + escapeHtml(colorOf(line)) + '" stroke-width="' + width + '"' +
        (dim ? ' class="is-dim"' : "") + ' data-route-id="' + escapeHtml(line.routeId) + '"><title>' +
        escapeHtml(title) + "</title></polyline>";
    }).join("");

    // Haltestellen: bei ausgewählter Linie nur deren Halte.
    const visibleStops = new Set();
    for (const line of lines) {
      if (selected !== null && line.routeId !== selected) continue;
      for (const point of line.points) visibleStops.add(stopKey(point[0], point[1]));
    }
    let dots = "";
    let drawnStops = 0;
    for (const stop of state.data.stops) {
      if (!visibleStops.has(stopKey(stop.lat, stop.lon))) continue;
      const [x, y] = project(stop.lat, stop.lon);
      if (x < -8 || y < -8 || x > state.width + 8 || y > state.height + 8) continue;
      const isSelected = stop.stopId === state.selectedStopId;
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (isSelected ? 5.5 : 2.4) + '"' +
        (isSelected ? ' class="is-selected"' : selected === null ? "" : ' class="is-line"') +
        ' data-stop-id="' + escapeHtml(stop.stopId) + '"><title>' + escapeHtml(stop.name) + "</title></circle>";
      drawnStops++;
    }

    canvas.innerHTML = '<svg viewBox="0 0 ' + state.width + " " + state.height + '" role="img" aria-label="Netzkarte aus dem GTFS-Fahrplan">' +
      '<g class="swu-tiles">' + tiles + "</g>" +
      '<g class="swu-lines">' + strokes + "</g>" +
      '<g class="swu-stops">' + dots + "</g></svg>";
    if (meta) {
      meta.textContent = lines.length + " Linienverläufe · " + drawnStops + " Haltestellen · Stand " +
        timeLabel(state.data.loadedAt) + " Uhr";
    }
  }

  function renderLegend() {
    if (!state.data) {
      legend.innerHTML = "";
      return;
    }
    const routes = new Map();
    for (const line of visibleLines()) {
      if (!routes.has(line.routeId)) routes.set(line.routeId, line);
    }
    legend.innerHTML = [...routes.values()]
      .sort((a, b) => String(a.line).localeCompare(String(b.line), "de", { numeric: true }))
      .map((line) => '<button type="button" data-route-id="' + escapeHtml(line.routeId) +
        '" aria-pressed="' + (state.selectedRouteId === line.routeId) + '">' +
        '<span class="swu-chip" style="color:' + escapeHtml(colorOf(line)) + '"></span>Linie ' +
        escapeHtml(line.line) + "</button>")
      .join("");
  }

  let frame = null;
  function scheduleRender() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      render();
    });
  }

  function clampScale(value) {
    return Math.min(state.fitScale * MAX_ZOOM, Math.max(state.fitScale * MIN_ZOOM, value));
  }

  // Zoomt um einen Punkt der Karte, sodass dieser Punkt stehen bleibt.
  function zoomAt(x, y, factor) {
    if (!state.view) return;
    const next = clampScale(state.view.scale * factor);
    if (next === state.view.scale) return;
    const originX = state.view.centerX * state.view.scale - state.width / 2;
    const originY = state.view.centerY * state.view.scale - state.height / 2;
    const worldCursorX = (originX + x) / state.view.scale;
    const worldCursorY = (originY + y) / state.view.scale;
    state.view.scale = next;
    state.view.centerX = worldCursorX - (x - state.width / 2) / next;
    state.view.centerY = worldCursorY - (y - state.height / 2) / next;
    scheduleRender();
  }

  function toggleRoute(routeId) {
    state.selectedRouteId = state.selectedRouteId === routeId ? null : routeId;
    renderLegend();
    render();
  }

  function detailHead(name) {
    return '<div class="swu-detail-head"><strong>' + escapeHtml(name) + "</strong>" +
      '<button type="button" data-close-detail aria-label="Details schließen">×</button></div>';
  }

  function lineFor(routeId) {
    return state.data?.lines.find((line) => line.routeId === routeId) ?? null;
  }

  function departureRow(departure) {
    const line = lineFor(departure.routeId);
    const minutesAhead = Math.max(0, Math.round((departure.inSeconds ?? 0) / 60));
    return "<li>" +
      '<span class="swu-line" style="background:' + escapeHtml(colorOf(line ?? { mode: "bus" })) + '">' +
      escapeHtml(departure.line ?? "?") + "</span>" +
      '<span class="swu-time">' + escapeHtml(String(departure.departureTime ?? "").slice(0, 5)) + "</span>" +
      '<span class="swu-headsign">' + escapeHtml(departure.headsign ?? "") + "</span>" +
      '<span class="swu-in">' + (minutesAhead <= 0 ? "jetzt" : "in " + minutesAhead + " Min") + "</span>" +
      "</li>";
  }

  async function selectStop(stop) {
    state.selectedStopId = stop.stopId;
    render();
    detail.hidden = false;
    detail.innerHTML = detailHead(stop.name) + '<p class="swu-empty">Lade Abfahrten …</p>';
    try {
      const response = await fetch(
        apiBase + "/api/gtfs/departures?stopId=" + encodeURIComponent(stop.stopId) +
          "&minutes=" + DEPARTURE_MINUTES + "&limit=" + DEPARTURE_LIMIT,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      if (state.selectedStopId !== stop.stopId) return;
      detail.innerHTML = detailHead(stop.name) + (payload.departures.length
        ? '<ul class="swu-departures">' + payload.departures.map(departureRow).join("") + "</ul>"
        : '<p class="swu-empty">Keine Abfahrten in den nächsten drei Stunden.</p>');
    } catch (error) {
      if (state.selectedStopId !== stop.stopId) return;
      detail.innerHTML = detailHead(stop.name) +
        '<p class="swu-empty">Abfahrten nicht verfügbar (' + escapeHtml(error.message) + ").</p>";
    }
  }

  async function load() {
    try {
      const response = await fetch(apiBase + "/api/gtfs/map", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      state.data = await response.json();
      renderLegend();
      fit();
    } catch (error) {
      canvas.innerHTML = '<p class="swu-empty">Netzkarte nicht verfügbar (' + escapeHtml(error.message) + ").</p>";
    }
  }

  // --- Bedienung -----------------------------------------------------------

  let drag = null;

  function cursorToMap(event) {
    const rect = stage.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  function handleClick(event) {
    const stopElement = event.target.closest("[data-stop-id]");
    if (stopElement && state.data) {
      const stop = state.data.stops.find((entry) => entry.stopId === stopElement.dataset.stopId);
      if (stop) selectStop(stop);
      return;
    }
    const routeElement = event.target.closest("[data-route-id]");
    if (routeElement) toggleRoute(routeElement.dataset.routeId);
  }

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    measure();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!state.view) return;
    state.view.centerX -= dx / state.view.scale;
    state.view.centerY -= dy / state.view.scale;
    canvas.querySelector("svg")?.classList.add("is-dragging");
    scheduleRender();
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    canvas.querySelector("svg")?.classList.remove("is-dragging");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (event.type === "pointerup" && !moved) handleClick(event);
  }
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("wheel", (event) => {
    if (!state.view) return;
    event.preventDefault();
    const [x, y] = cursorToMap(event);
    zoomAt(x, y, event.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  root.querySelector(".swu-controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-zoom]");
    if (!button) return;
    if (button.dataset.zoom === "fit") {
      fit();
      return;
    }
    zoomAt(state.width / 2, state.height / 2, button.dataset.zoom === "in" ? 1.4 : 1 / 1.4);
  });

  legend.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-route-id]");
    if (button) toggleRoute(button.dataset.routeId);
  });

  root.addEventListener("click", (event) => {
    if (!event.target.closest("[data-close-detail]")) return;
    state.selectedStopId = null;
    detail.hidden = true;
    detail.innerHTML = "";
    render();
  });

  // Größenänderungen (Fenster, geöffnetes Detail-Panel) behalten Zoom und
  // Ausschnitt bei; nur ohne Ansicht wird neu eingepasst.
  const observer = new ResizeObserver(() => {
    if (!measure()) return;
    if (state.view) render();
    else fit();
  });
  observer.observe(stage);

  measure();
  load();

  return {
    setMode(nextMode) {
      if (nextMode === state.mode) return;
      state.mode = nextMode;
      if (state.selectedRouteId !== null) {
        const stillVisible = state.data?.lines.some((line) =>
          line.routeId === state.selectedRouteId && (nextMode === "all" || line.mode === nextMode));
        if (!stillVisible) state.selectedRouteId = null;
      }
      renderLegend();
      fit();
    },
    reload: load,
    destroy() {
      observer.disconnect();
      root.remove();
    }
  };
}
