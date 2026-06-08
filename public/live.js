//update
const API_BASE = "/api";
const POLL_MS = 3000;
const LIVE_POLL_MS = 1500;
const ANALYSIS_POLL_MS = 8000;
const LIVE_ANALYSIS_POLL_MS = 4000;
const REPLAY_ANALYSIS_MS = 500;
const REPLAY_PREFETCH_AHEAD = 9;
const REPLAY_PREFETCH_INITIAL = 10;
const REPLAY_PREFETCH_MAX_CONCURRENT = 4;
const CACHE_POLL_MS = 1000;
const REPLAY_SCRUB_THROTTLE_MS = 200;

const SESSION_TYPE_ORDER = {
  "Practice 1": 1,
  "Practice 2": 2,
  "Practice 3": 3,
  "Sprint Qualifying": 4,
  Qualifying: 5,
  Sprint: 6,
  Race: 7
};

const state = {
  timer: null,
  analysisTimer: null,
  sessionKey: "latest",
  resolvedSessionKey: null,
  sessionTypeFilter: "all",
  allSessions: [],
  sessionStatus: null,
  intervalsByDriver: new Map(),
  lastPositions: [],
  lastTrackFrame: null,
  sessionTrackOutline: null,
  sessionLoadToken: 0,
  replayFrameToken: 0,
  scrubFetchTimer: null,
  cachePollTimer: null,
  replay: {
    active: false,
    playing: false,
    animRafId: null,
    lastAnimTime: null,
    lastAnalysisAt: 0,
    timeline: null,
    atMs: null,
    speed: 1,
    scrubbing: false,
    frameInFlight: false,
    locationIndex: null,
    prefetchCache: new Map(),
    prefetchInflight: new Set(),
    prefetchPending: [],
    prefetchGeneration: 0
  },
  teamRadioSeenCount: 0,
  teamRadioLastCount: 0,
  teamRadioModalOpen: false,
  teamRadioFullList: [],
  teamRadioLastNotifiedIndex: -1,
  teamRadioAudio: null,
  teamRadioCurrentId: null,
  teamRadioToastTimer: null
};

function $(id) {
  return document.getElementById(id);
}

function statusLabel(status) {
  switch (status) {
    case "live":
      return "Pågår";
    case "upcoming":
      return "Kommande";
    case "finished":
      return "Avslutad";
    case "cancelled":
      return "Inställd";
    default:
      return "Okänd";
  }
}

function driverLabel(row) {
  const driver = row?.driver;
  if (driver) {
    return driver.name_acronym || driver.broadcast_name || driver.full_name;
  }
  return `Förare ${row?.driver_number ?? "?"}`;
}

function driverFullLabel(row) {
  const driver = row?.driver;
  if (driver) {
    return driver.full_name || driver.broadcast_name || driver.name_acronym;
  }
  return driverLabel(row);
}

function teamLabel(row) {
  return row?.driver?.team_name || "";
}

function formatSessionInfo(session) {
  if (!session) return "Ingen session hittades.";
  const name = session.session_name || session.session_type || "Session";
  const circuit = session.circuit_short_name || session.location || "";
  const country = session.country_name ? `, ${session.country_name}` : "";
  const start = session.date_start ? new Date(session.date_start).toLocaleString("sv-SE") : "";
  return `${name} – ${circuit}${country}${start ? ` (${start})` : ""}`;
}

function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "–";
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sessionTypeLabel(name) {
  return name || "Session";
}

function matchesSessionTypeFilter(session, filter) {
  const name = session.session_name || session.session_type || "";
  switch (filter) {
    case "practice":
      return /^Practice\s*[123]?$/i.test(name) || name === "Practice 1" || name === "Practice 2" || name === "Practice 3";
    case "qualifying":
      return name === "Qualifying" || name === "Sprint Qualifying";
    case "sprint":
      return name === "Sprint";
    case "race":
      return name === "Race";
    default:
      return name !== "Day 1" && name !== "Day 2" && name !== "Day 3";
  }
}

function formatSessionOptionLabel(session) {
  const type = sessionTypeLabel(session.session_name || session.session_type);
  const meeting = session.meeting_name || session.circuit_short_name || "Grand Prix";
  const date = session.date_start
    ? new Date(session.date_start).toLocaleDateString("sv-SE")
    : "";
  return `${type} – ${meeting} (${date})`;
}

function formatGap(value) {
  if (value === null || value === undefined || value === "") return "–";
  if (Number(value) === 0) return "LEADER";
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3);
}

function formatLapTime(seconds) {
  if (seconds === null || seconds === undefined) return "–";
  const n = Number(seconds);
  if (Number.isNaN(n)) return String(seconds);
  const mins = Math.floor(n / 60);
  const secs = (n % 60).toFixed(3).padStart(6, "0");
  return mins > 0 ? `${mins}:${secs}` : secs;
}

function formatTime(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString("sv-SE");
}

function setTableMessage(tbody, colspan, message) {
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="info">${message}</td></tr>`;
}

function projectTrackPoint(point, bounds, pad, w, h) {
  const rangeX = bounds.maxX - bounds.minX || 1;
  const rangeY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);
  return {
    x: pad + (point.x - bounds.minX) * scale,
    y: h - pad - (point.y - bounds.minY) * scale,
    scale
  };
}

function trackBounds(locations, trackOutline) {
  const points = [...(trackOutline || []), ...(locations || [])];
  if (!points.length) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function effectiveTrackOutline(incoming, previous = null) {
  if (Array.isArray(incoming) && incoming.length > 0) return incoming;
  if (Array.isArray(previous) && previous.length > 0) return previous;
  if (state.sessionTrackOutline?.length) return state.sessionTrackOutline;
  return [];
}

function buildTrackFrameData(data, previousFrame = null) {
  const trackOutline = effectiveTrackOutline(data.trackOutline, previousFrame?.trackOutline);
  if (trackOutline.length) {
    state.sessionTrackOutline = trackOutline;
  }
  const trackMapAvailable =
    data.trackMapAvailable !== false &&
    (Boolean(data.locations?.length) || trackOutline.length > 0);
  return {
    locations: data.locations || [],
    positions: data.positions || [],
    trackOutline,
    trackMapAvailable
  };
}

function lerpValue(a, b, t) {
  return a + (b - a) * t;
}

function replayAnalysisSnapMs(atMs) {
  return Math.floor(atMs / REPLAY_ANALYSIS_MS) * REPLAY_ANALYSIS_MS;
}

function replayAdvanceMs() {
  return REPLAY_ANALYSIS_MS * state.replay.speed;
}

function interpolateDriverFromIndex(points, atMs, sessionStartMs, driverNumber) {
  if (!points?.length || atMs == null || sessionStartMs == null) return null;
  const t = atMs - sessionStartMs;
  const first = points[0];
  if (t < first.t) {
    if (t >= first.t - 2000) {
      return { driver_number: driverNumber, x: first.x, y: first.y, z: first.z };
    }
    return null;
  }
  const last = points[points.length - 1];
  if (t >= last.t) {
    return { driver_number: driverNumber, x: last.x, y: last.y, z: last.z };
  }

  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.t - a.t;
  const p = span > 0 ? (t - a.t) / span : 0;
  return {
    driver_number: driverNumber,
    x: lerpValue(a.x, b.x, p),
    y: lerpValue(a.y, b.y, p),
    z: lerpValue(a.z ?? 0, b.z ?? 0, p)
  };
}

function locationsAtReplayTime(atMs) {
  const index = state.replay.locationIndex;
  if (!index?.byDriver || atMs == null) return [];
  const sessionStartMs = index.sessionStartMs;
  const locations = [];
  Object.entries(index.byDriver).forEach(([driverKey, points]) => {
    const loc = interpolateDriverFromIndex(
      points,
      atMs,
      sessionStartMs,
      Number(driverKey)
    );
    if (loc) locations.push(loc);
  });
  return locations;
}

function firstReplayLocationMs(index) {
  if (!index?.byDriver) return null;
  let minT = Infinity;
  Object.values(index.byDriver).forEach((points) => {
    if (points[0]?.t != null) minT = Math.min(minT, points[0].t);
  });
  if (!Number.isFinite(minT)) return null;
  return index.sessionStartMs + minT;
}

function updateReplayMapFromIndex() {
  if (!state.replay.active || state.replay.atMs == null) return;
  const locations = locationsAtReplayTime(state.replay.atMs);
  if (!state.lastTrackFrame) {
    state.lastTrackFrame = {
      locations: [],
      positions: [],
      trackOutline: state.sessionTrackOutline || [],
      trackMapAvailable: Boolean(locations.length || state.sessionTrackOutline?.length)
    };
  }
  state.lastTrackFrame.locations = locations;
  state.lastTrackFrame.trackMapAvailable =
    locations.length > 0 || Boolean(state.lastTrackFrame.trackOutline?.length);
  drawCurrentTrackFrame();
}

function getTrackDrawFrame() {
  return state.lastTrackFrame;
}

function drawCurrentTrackFrame() {
  const frame = getTrackDrawFrame();
  if (!frame) return;
  drawTrack(
    $("live-track"),
    frame.locations,
    frame.positions,
    frame.trackOutline,
    { trackMapAvailable: frame.trackMapAvailable }
  );
}

function drawTrackLoading(canvas, message = "Laddar bana…") {
  if (!canvas) return;
  const { cssWidth: w, cssHeight: h, dpr } = setupTrackCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d0d0f";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#9a9a9a";
  ctx.font = "15px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, w / 2, h / 2);
}

const trackCanvasState = {
  cssWidth: 0,
  cssHeight: 0,
  dpr: 1
};

function isTrackCanvasFullscreen(canvas) {
  if (!canvas) return false;
  return Boolean(
    canvas.closest(".live-panel-fullscreen-active, .live-panel-fullscreen-fallback")
  );
}

function setupTrackCanvas(canvas) {
  if (!canvas) return trackCanvasState;
  const wrap = canvas.closest(".live-track-wrap");
  const fullscreen = isTrackCanvasFullscreen(canvas);
  const maxWidth = wrap ? wrap.clientWidth : fullscreen ? window.innerWidth - 48 : 900;
  const cssWidth = fullscreen
    ? Math.max(280, maxWidth || window.innerWidth - 48)
    : Math.max(280, Math.min(maxWidth || 900, 900));
  const cssHeight = Math.round(cssWidth * (420 / 900));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const pixelW = Math.round(cssWidth * dpr);
  const pixelH = Math.round(cssHeight * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  trackCanvasState.cssWidth = cssWidth;
  trackCanvasState.cssHeight = cssHeight;
  trackCanvasState.dpr = dpr;
  return trackCanvasState;
}

function drawTrack(canvas, locations, positions, trackOutline = [], options = {}) {
  if (!canvas) return;
  const { cssWidth: w, cssHeight: h, dpr } = setupTrackCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d0d0f";
  ctx.fillRect(0, 0, w, h);

  const bounds = trackBounds(locations, trackOutline);
  if (!bounds) {
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "15px system-ui, sans-serif";
    ctx.textAlign = "center";
    let msg = "Kartan visas när positionsdata finns";
    if (options.trackMapAvailable === false) {
      msg = "OpenF1 saknar location-data för denna sessionstyp";
    } else if (state.replay.active) {
      msg = replayEmptyPositionsMessage();
    } else if (state.sessionStatus === "upcoming") {
      msg = "Kartan visas när sessionen startar";
    }
    ctx.fillText(msg, w / 2, h / 2);
    return;
  }

  const pad = 36;
  const posByDriver = new Map(
    (positions || []).map((p) => [Number(p.driver_number), p.position])
  );
  const driverByNumber = new Map(
    (positions || []).map((p) => [Number(p.driver_number), p.driver])
  );

  if (trackOutline.length === 1) {
    const { x, y } = projectTrackPoint(trackOutline[0], bounds, pad, w, h);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (trackOutline.length > 1) {
    ctx.beginPath();
    trackOutline.forEach((point, index) => {
      const { x, y } = projectTrackPoint(point, bounds, pad, w, h);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  if (!locations.length) {
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      state.replay.active
        ? replayEmptyPositionsMessage()
        : "Ingen bilpositionsdata vid denna tidpunkt",
      w / 2,
      h / 2
    );
    return;
  }

  locations.forEach((loc) => {
    const { x, y } = projectTrackPoint(loc, bounds, pad, w, h);
    const driverNum = Number(loc.driver_number);
    const pos = posByDriver.get(driverNum) || "?";
    const isPodium = Number(pos) <= 3;
    const acronym =
      driverByNumber.get(driverNum)?.name_acronym || String(driverNum);

    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = isPodium ? "#e10600" : "#f5f5f5";
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = isPodium ? "#fff" : "#111";
    ctx.font = "bold 8px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(acronym, x, y);
  });
}

function renderPositions(positions) {
  const tbody = $("live-positions-table").querySelector("tbody");
  tbody.innerHTML = "";
  state.lastPositions = positions || [];

  if (!positions.length) {
    setTableMessage(tbody, 5, replayEmptyPositionsMessage());
    return;
  }

  positions.forEach((row) => {
    const interval = state.intervalsByDriver.get(Number(row.driver_number));
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.position}</td>
      <td>${row.driver_number}</td>
      <td title="${driverFullLabel(row)}">${driverLabel(row)}</td>
      <td>${teamLabel(row)}</td>
      <td>${formatGap(interval?.gap_to_leader)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderIntervals(intervals) {
  const tbody = $("live-intervals-table").querySelector("tbody");
  tbody.innerHTML = "";
  if (!intervals.length) {
    setTableMessage(tbody, 4, "Intervalldata saknas för denna session.");
    return;
  }
  intervals.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.position ?? "–"}</td>
      <td>${driverLabel(row)}</td>
      <td>${formatGap(row.gap_to_leader)}</td>
      <td>${formatGap(row.interval)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderStints(stints) {
  const tbody = $("live-stints-table").querySelector("tbody");
  tbody.innerHTML = "";
  if (!stints.length) {
    setTableMessage(tbody, 6, "Ingen stint-data.");
    return;
  }
  stints
    .slice()
    .sort((a, b) => Number(a.driver_number) - Number(b.driver_number))
    .forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.driver_number}</td>
        <td>${driverLabel(row)}</td>
        <td>${row.stint_number ?? "–"}</td>
        <td><span class="tyre-badge tyre-${(row.compound || "unknown").toLowerCase()}">${row.compound || "–"}</span></td>
        <td>${row.lap_start ?? "–"}${row.lap_end ? `–${row.lap_end}` : "+"}</td>
        <td>${formatTime(row.date_start || row.date)}</td>
      `;
      tbody.appendChild(tr);
    });
}

function renderPitStops(pitStops) {
  const tbody = $("live-pits-table").querySelector("tbody");
  tbody.innerHTML = "";
  if (!pitStops.length) {
    setTableMessage(tbody, 4, "Inga pit stops registrerade.");
    return;
  }
  pitStops.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${driverLabel(row)}</td>
      <td>${row.lap_number ?? "–"}</td>
      <td>${row.pit_duration != null ? `${Number(row.pit_duration).toFixed(2)} s` : "–"}</td>
      <td>${formatTime(row.date)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderLaps(fastestLaps, recentLaps) {
  const fastestBody = $("live-fastest-laps-table").querySelector("tbody");
  const recentBody = $("live-recent-laps-table").querySelector("tbody");
  fastestBody.innerHTML = "";
  recentBody.innerHTML = "";

  if (!fastestLaps.length) {
    setTableMessage(fastestBody, 3, "Inga varvtider.");
  } else {
    fastestLaps.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${driverLabel(row)}</td>
        <td>${row.lap_number ?? "–"}</td>
        <td>${formatLapTime(row.lap_duration)}</td>
      `;
      fastestBody.appendChild(tr);
    });
  }

  if (!recentLaps.length) {
    setTableMessage(recentBody, 6, "Inga senaste varv.");
  } else {
    recentLaps.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${driverLabel(row)}</td>
        <td>${row.lap_number ?? "–"}</td>
        <td>${formatLapTime(row.lap_duration)}</td>
        <td>${row.duration_sector_1 != null ? Number(row.duration_sector_1).toFixed(3) : "–"}</td>
        <td>${row.duration_sector_2 != null ? Number(row.duration_sector_2).toFixed(3) : "–"}</td>
        <td>${row.duration_sector_3 != null ? Number(row.duration_sector_3).toFixed(3) : "–"}</td>
      `;
      recentBody.appendChild(tr);
    });
  }
}

function renderRaceControl(messages) {
  const list = $("live-race-control-list");
  list.innerHTML = "";
  if (!messages.length) {
    list.innerHTML = '<li class="info">Inga race control-meddelanden.</li>';
    return;
  }
  messages.forEach((msg) => {
    const li = document.createElement("li");
    li.className = "live-feed-item";
    const category = msg.category ? `<span class="feed-tag">${msg.category}</span>` : "";
    li.innerHTML = `
      <span class="feed-time">${formatTime(msg.date)}</span>
      ${category}
      <span class="feed-message">${msg.message || msg.flag || "–"}</span>
    `;
    list.appendChild(li);
  });
}

function renderOvertakes(overtakes) {
  const tbody = $("live-overtakes-table").querySelector("tbody");
  tbody.innerHTML = "";
  if (!overtakes.length) {
    setTableMessage(tbody, 4, "Inga omkörningar registrerade.");
    return;
  }
  overtakes.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.lap_number ?? "–"}</td>
      <td>${driverLabel({ driver_number: row.overtaking_driver_number, driver: row.driver })}</td>
      <td>#${row.overtaken_driver_number ?? "?"}</td>
      <td>${row.position ?? "–"}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderWeather(weather) {
  const el = $("live-weather");
  if (!weather) {
    el.innerHTML = '<p class="info">Ingen väderdata för sessionen.</p>';
    return;
  }
  const items = [
    ["Luft", weather.air_temperature != null ? `${weather.air_temperature} °C` : "–"],
    ["Bana", weather.track_temperature != null ? `${weather.track_temperature} °C` : "–"],
    ["Fuktighet", weather.humidity != null ? `${weather.humidity} %` : "–"],
    ["Lufttryck", weather.pressure != null ? `${weather.pressure} mbar` : "–"],
    ["Vind", weather.wind_speed != null ? `${weather.wind_speed} m/s` : "–"],
    ["Riktning", weather.wind_direction != null ? `${weather.wind_direction}°` : "–"],
    ["Regn", weather.rainfall != null ? `${weather.rainfall}` : "–"],
    ["Uppdaterad", formatTime(weather.date)]
  ];
  el.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="live-weather-item"><span class="live-weather-label">${label}</span><span class="live-weather-value">${value}</span></div>`
    )
    .join("");
}

const TEAM_RADIO_TOAST_MS = 8000;

function isTeamRadioModalOpen() {
  return state.teamRadioModalOpen;
}

function teamRadioRowId(row) {
  return `${row?.date || ""}|${row?.driver_number ?? ""}|${row?.recording_url || ""}`;
}

function teamRadioDateMs(row) {
  return row?.date ? new Date(row.date).getTime() : 0;
}

function teamRadioPlayUrl(recordingUrl) {
  if (!recordingUrl) return null;
  // Direkt från F1 CDN – server-proxyn får 403 från livetiming.formula1.com (Azure-IP blockeras).
  return recordingUrl;
}

function stopTeamRadioPlayback() {
  if (state.teamRadioAudio) {
    state.teamRadioAudio.pause();
    state.teamRadioAudio.currentTime = 0;
    state.teamRadioAudio = null;
  }
  state.teamRadioCurrentId = null;
  updateTeamRadioPlayingUi();
}

function updateTeamRadioPlayingUi() {
  const playingId = state.teamRadioCurrentId;
  const isPlaying = Boolean(state.teamRadioAudio && !state.teamRadioAudio.paused);
  document.querySelectorAll("[data-team-radio-id]").forEach((btn) => {
    const active = btn.dataset.teamRadioId === playingId && isPlaying;
    btn.classList.toggle("is-playing", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.textContent = active ? "⏸" : "▶";
    btn.setAttribute("aria-label", active ? "Pausa" : "Lyssna");
  });
  document.querySelectorAll(".team-radio-toast").forEach((toast) => {
    const btn = toast.querySelector("[data-team-radio-play]");
    if (!btn) return;
    const active = btn.dataset.teamRadioId === playingId && isPlaying;
    btn.classList.toggle("is-playing", active);
    btn.textContent = active ? "⏸" : "▶";
    btn.setAttribute("aria-label", active ? "Pausa team radio" : "Spela team radio");
  });
}

function playTeamRadioRow(row) {
  const id = teamRadioRowId(row);
  const src = teamRadioPlayUrl(row?.recording_url);
  if (!src) return;

  if (
    state.teamRadioCurrentId === id &&
    state.teamRadioAudio &&
    !state.teamRadioAudio.paused
  ) {
    state.teamRadioAudio.pause();
    updateTeamRadioPlayingUi();
    ensureReplayAnimationRunning();
    return;
  }

  stopTeamRadioPlayback();
  const audio = new Audio(src);
  state.teamRadioAudio = audio;
  state.teamRadioCurrentId = id;
  audio.addEventListener("ended", () => {
    if (state.teamRadioCurrentId === id) stopTeamRadioPlayback();
  });
  audio.addEventListener("error", () => {
    console.error("[team-radio] playback error:", audio.error?.code, audio.error?.message, src);
    if (state.teamRadioCurrentId === id) stopTeamRadioPlayback();
  });
  audio.addEventListener("pause", () => {
    updateTeamRadioPlayingUi();
    ensureReplayAnimationRunning();
  });
  audio.addEventListener("play", () => {
    updateTeamRadioPlayingUi();
    ensureReplayAnimationRunning();
  });
  audio.play().catch((err) => {
    console.error("[team-radio] play() rejected:", err?.message, src);
    if (state.teamRadioCurrentId === id) stopTeamRadioPlayback();
  });
  updateTeamRadioPlayingUi();
  ensureReplayAnimationRunning();
}

function teamRadioIndexAtOrBefore(atMs) {
  const list = state.teamRadioFullList;
  if (!list.length || atMs == null) return -1;
  let lo = 0;
  let hi = list.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (teamRadioDateMs(list[mid]) <= atMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function initTeamRadioNotifyCursor(atMs) {
  state.teamRadioLastNotifiedIndex = teamRadioIndexAtOrBefore(atMs);
}

function dismissTeamRadioToast() {
  if (state.teamRadioToastTimer) {
    clearTimeout(state.teamRadioToastTimer);
    state.teamRadioToastTimer = null;
  }
  $("team-radio-toast-host")?.replaceChildren();
}

function showTeamRadioToast(row) {
  const host = $("team-radio-toast-host");
  if (!host || !row?.recording_url) return;

  dismissTeamRadioToast();
  const id = teamRadioRowId(row);
  const toast = document.createElement("div");
  toast.className = "team-radio-toast";
  toast.setAttribute("role", "status");
  const message = row.message ? `: ${row.message}` : "";
  toast.innerHTML = `
    <span class="team-radio-toast-icon" aria-hidden="true">📻</span>
    <span class="team-radio-toast-text">
      <strong>${driverLabel(row)}</strong>${message}
    </span>
    <button
      type="button"
      class="team-radio-toast-play"
      data-team-radio-play
      data-team-radio-id="${id}"
      aria-label="Spela team radio"
    >▶</button>
    <button type="button" class="team-radio-toast-close" aria-label="Stäng">✕</button>
  `;

  toast.querySelector("[data-team-radio-play]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    playTeamRadioRow(row);
  });
  toast.querySelector(".team-radio-toast-close")?.addEventListener("click", () => {
    dismissTeamRadioToast();
  });

  host.appendChild(toast);
  state.teamRadioToastTimer = setTimeout(dismissTeamRadioToast, TEAM_RADIO_TOAST_MS);
}

function checkTeamRadioNotifications(atMs) {
  if (!state.teamRadioFullList.length || atMs == null) return;
  const idx = teamRadioIndexAtOrBefore(atMs);
  if (idx < state.teamRadioLastNotifiedIndex) {
    state.teamRadioLastNotifiedIndex = idx;
    dismissTeamRadioToast();
    return;
  }
  if (idx <= state.teamRadioLastNotifiedIndex) return;

  const row = state.teamRadioFullList[idx];
  showTeamRadioToast(row);
  state.teamRadioLastNotifiedIndex = idx;
}

async function loadTeamRadioFullList(sessionKey) {
  const key = sessionKey || state.resolvedSessionKey;
  if (!key || key === "latest") {
    state.teamRadioFullList = [];
    return [];
  }
  try {
    const res = await fetch(
      `${API_BASE}/live/team-radio/list?session_key=${encodeURIComponent(key)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.teamRadioFullList = data.messages || [];
    return state.teamRadioFullList;
  } catch {
    state.teamRadioFullList = [];
    return [];
  }
}

async function ensureTeamRadioSessionList(atMs) {
  if (!state.teamRadioFullList.length && state.resolvedSessionKey) {
    await loadTeamRadioFullList(state.resolvedSessionKey);
  }
  initTeamRadioNotifyCursor(atMs);
}

function updateTeamRadioBadge(messages) {
  const badge = $("team-radio-badge");
  if (!badge) return;
  if (state.teamRadioModalOpen || state.sessionStatus !== "live") {
    badge.classList.add("hidden");
    badge.textContent = "";
    return;
  }
  const unseen = Math.max(0, messages.length - state.teamRadioSeenCount);
  if (unseen > 0) {
    badge.textContent = unseen > 9 ? "9+" : String(unseen);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
    badge.textContent = "";
  }
}

function openTeamRadioModal() {
  const modal = $("team-radio-modal");
  if (!modal || state.teamRadioModalOpen) return;
  state.teamRadioModalOpen = true;
  state.teamRadioSeenCount = state.teamRadioLastCount;
  modal.hidden = false;
  modal.classList.remove("hidden");
  document.body.classList.add("team-radio-modal-open");
  $("team-radio-open-btn")?.setAttribute("aria-expanded", "true");
  updateTeamRadioBadge(new Array(state.teamRadioLastCount));
  $("team-radio-close-btn")?.focus();
}

function closeTeamRadioModal() {
  const modal = $("team-radio-modal");
  if (!modal || !state.teamRadioModalOpen) return;
  state.teamRadioModalOpen = false;
  modal.hidden = true;
  modal.classList.add("hidden");
  document.body.classList.remove("team-radio-modal-open");
  $("team-radio-open-btn")?.setAttribute("aria-expanded", "false");
  $("team-radio-open-btn")?.focus();
}

function resetTeamRadioModal() {
  stopTeamRadioPlayback();
  dismissTeamRadioToast();
  state.teamRadioSeenCount = 0;
  state.teamRadioLastCount = 0;
  state.teamRadioFullList = [];
  state.teamRadioLastNotifiedIndex = -1;
  closeTeamRadioModal();
  const badge = $("team-radio-badge");
  if (badge) {
    badge.classList.add("hidden");
    badge.textContent = "";
  }
}

function setupTeamRadioModal() {
  $("team-radio-open-btn")?.addEventListener("click", openTeamRadioModal);
  $("team-radio-close-btn")?.addEventListener("click", closeTeamRadioModal);
  $("team-radio-modal")?.querySelector("[data-dismiss='team-radio']")?.addEventListener("click", closeTeamRadioModal);

  $("live-radio-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-team-radio-play]");
    if (!btn) return;
    e.preventDefault();
    const li = btn.closest("[data-team-radio-row]");
    if (!li) return;
    const row = {
      date: li.dataset.teamRadioDate,
      driver_number: Number(li.dataset.teamRadioDriver),
      recording_url: li.dataset.teamRadioUrl,
      message: li.dataset.teamRadioMessage || "",
      driver: li.dataset.teamRadioAcronym
        ? { name_acronym: li.dataset.teamRadioAcronym }
        : undefined
    };
    playTeamRadioRow(row);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.teamRadioModalOpen) return;
    e.preventDefault();
    e.stopPropagation();
    closeTeamRadioModal();
  });
}

function renderTeamRadio(messages) {
  const list = $("live-radio-list");
  if (!list) return;
  list.innerHTML = "";
  if (!messages.length) {
    list.innerHTML = '<li class="info">Ingen team radio tillgänglig.</li>';
    updateTeamRadioBadge(messages);
    return;
  }
  messages.forEach((row) => {
    const li = document.createElement("li");
    const id = teamRadioRowId(row);
    const playing =
      id === state.teamRadioCurrentId &&
      state.teamRadioAudio &&
      !state.teamRadioAudio.paused;
    li.className = "live-feed-item team-radio-item";
    li.dataset.teamRadioRow = "";
    li.dataset.teamRadioDate = row.date || "";
    li.dataset.teamRadioDriver = String(row.driver_number ?? "");
    li.dataset.teamRadioUrl = row.recording_url || "";
    li.dataset.teamRadioMessage = row.message || "";
    if (row.driver?.name_acronym) {
      li.dataset.teamRadioAcronym = row.driver.name_acronym;
    }
    const playBtn = row.recording_url
      ? `<button
          type="button"
          class="team-radio-play-btn${playing ? " is-playing" : ""}"
          data-team-radio-play
          data-team-radio-id="${id}"
          aria-label="${playing ? "Pausa" : "Lyssna"}"
          aria-pressed="${playing ? "true" : "false"}"
        >${playing ? "⏸" : "▶"}</button>`
      : "";
    li.innerHTML = `
      <span class="feed-time">${formatTime(row.date)}</span>
      <span class="feed-message">${driverLabel(row)}${row.message ? `: ${row.message}` : ""}</span>
      ${playBtn}
    `;
    list.appendChild(li);
  });
  state.teamRadioLastCount = messages.length;
  if (state.teamRadioModalOpen) {
    state.teamRadioSeenCount = messages.length;
  } else if (state.teamRadioSeenCount === 0 && messages.length > 0) {
    state.teamRadioSeenCount = messages.length;
  }
  updateTeamRadioBadge(messages);
}

function renderTelemetry(carData) {
  const tbody = $("live-telemetry-table").querySelector("tbody");
  tbody.innerHTML = "";
  if (!carData.length) {
    const msg = state.replay.active
      ? "Ingen telemetri vid denna tidpunkt"
      : "Telemetri visas endast under live session";
    setTableMessage(tbody, 6, msg);
    return;
  }
  carData
    .slice()
    .sort((a, b) => Number(b.speed || 0) - Number(a.speed || 0))
    .forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${driverLabel(row)}</td>
        <td>${row.speed ?? "–"}</td>
        <td>${row.n_gear ?? "–"}</td>
        <td>${row.throttle != null ? `${row.throttle}%` : "–"}</td>
        <td>${row.brake != null ? `${row.brake}%` : "–"}</td>
        <td>${row.drs != null ? (row.drs ? "ON" : "OFF") : "–"}</td>
      `;
      tbody.appendChild(tr);
    });
}

function renderGridAndResult(startingGrid, sessionResult) {
  const gridBody = $("live-grid-table").querySelector("tbody");
  const resultBody = $("live-result-table").querySelector("tbody");
  gridBody.innerHTML = "";
  resultBody.innerHTML = "";

  if (!startingGrid.length) {
    setTableMessage(gridBody, 3, "Startgrid saknas.");
  } else {
    startingGrid.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.position}</td>
        <td>${driverLabel(row)}</td>
        <td>${teamLabel(row)}</td>
      `;
      gridBody.appendChild(tr);
    });
  }

  if (!sessionResult.length) {
    setTableMessage(resultBody, 4, "Resultat saknas (session kanske inte avslutats).");
  } else {
    sessionResult.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.position}</td>
        <td>${driverLabel(row)}</td>
        <td>${teamLabel(row)}</td>
        <td>${row.points ?? "–"}</td>
      `;
      resultBody.appendChild(tr);
    });
  }
}

function renderAnalysis(analysis) {
  if (!analysis) return;

  state.intervalsByDriver = new Map(
    (analysis.intervals || []).map((row) => [Number(row.driver_number), row])
  );

  renderIntervals(analysis.intervals || []);
  renderStints(analysis.stints || []);
  renderPitStops(analysis.pitStops || []);
  renderLaps(analysis.fastestLaps || [], analysis.recentLaps || []);
  renderRaceControl(analysis.raceControl || []);
  renderOvertakes(analysis.overtakes || []);
  renderWeather(analysis.weather);
  renderTeamRadio(analysis.teamRadio || []);
  renderTelemetry(analysis.carData || []);
  renderGridAndResult(analysis.startingGrid || [], analysis.sessionResult || []);
}

async function loadSessionOptions() {
  const select = $("live-session-select");
  try {
    const res = await fetch(`${API_BASE}/metadata`);
    if (!res.ok) return;
    const data = await res.json();
    state.allSessions = (data.allSessions || data.sessions || [])
      .slice()
      .sort((a, b) => {
        const da = new Date(a.date_start || 0).getTime();
        const db = new Date(b.date_start || 0).getTime();
        if (db !== da) return db - da;
        const oa = SESSION_TYPE_ORDER[a.session_name] || 99;
        const ob = SESSION_TYPE_ORDER[b.session_name] || 99;
        return oa - ob;
      });
    renderSessionSelect();
  } catch {
    /* behåll default */
  }
}

function renderSessionSelect() {
  const select = $("live-session-select");
  const current = select.value;
  select.innerHTML = '<option value="latest">Senaste / live</option>';

  state.allSessions
    .filter((s) => matchesSessionTypeFilter(s, state.sessionTypeFilter))
    .forEach((session) => {
      const opt = document.createElement("option");
      opt.value = String(session.session_key);
      opt.textContent = formatSessionOptionLabel(session);
      select.appendChild(opt);
    });

  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

function sessionQuery() {
  return state.sessionKey === "latest"
    ? ""
    : `?session_key=${encodeURIComponent(state.sessionKey)}`;
}

function replayQuery(atIso) {
  const params = new URLSearchParams();
  const key = state.resolvedSessionKey || state.sessionKey;
  if (key && key !== "latest") {
    params.set("session_key", String(key));
  }
  params.set("at", atIso);
  return `?${params.toString()}`;
}

function stopLivePolling() {
  if (state.timer) clearInterval(state.timer);
  if (state.analysisTimer) clearInterval(state.analysisTimer);
  state.timer = null;
  state.analysisTimer = null;
}

function stopReplayAnimation() {
  if (state.replay.animRafId) {
    cancelAnimationFrame(state.replay.animRafId);
    state.replay.animRafId = null;
  }
  state.replay.lastAnimTime = null;
}

function isTeamRadioPlaying() {
  return Boolean(state.teamRadioAudio && !state.teamRadioAudio.paused);
}

function ensureReplayAnimationRunning() {
  if (!state.replay.active || !state.replay.playing || state.replay.atMs == null) return;
  if (state.replay.animRafId != null) return;
  state.replay.lastAnimTime = null;
  state.replay.animRafId = requestAnimationFrame(replayAnimationStep);
}

function stopReplayPlayback() {
  stopReplayAnimation();
  state.replay.playing = false;
  updatePlayButton();
}

function updatePlayButton() {
  const btn = $("live-replay-play");
  if (!btn) return;
  btn.textContent = state.replay.playing ? "⏸" : "▶";
  btn.classList.toggle("is-playing", state.replay.playing);
  btn.disabled = !state.replay.timeline || state.replay.atMs == null;
}

function setReplayControlsEnabled(enabled) {
  const playBtn = $("live-replay-play");
  const scrubber = $("live-replay-scrubber");
  const speed = $("live-replay-speed");
  if (playBtn) playBtn.disabled = !enabled;
  if (scrubber) scrubber.disabled = !enabled;
  if (speed) speed.disabled = !enabled;
}

function showCacheLoading(show, label = "Bygger cache för replay…", percent = 0) {
  const wrap = $("live-cache-loading");
  const progress = $("live-cache-progress");
  const text = $("live-cache-loading-label");
  if (!wrap) return;
  wrap.classList.toggle("hidden", !show);
  if (text) text.textContent = label;
  if (progress) progress.value = String(Math.min(100, Math.max(0, percent)));
}

function stopCachePolling() {
  if (state.cachePollTimer) clearInterval(state.cachePollTimer);
  state.cachePollTimer = null;
}

function cacheStageLabel(stage) {
  switch (stage) {
    case "starting":
      return "Startar cache…";
    case "metadata":
      return "Hämtar sessiondata…";
    case "locations":
      return "Hämtar positionsdata…";
    case "writing":
      return "Sparar cache…";
    case "complete":
      return "Cache klar";
    default:
      return "Bygger cache för replay…";
  }
}

async function fetchCacheStatus(sessionKey) {
  const res = await fetch(
    `${API_BASE}/live/replay/cache/build/progress?session_key=${encodeURIComponent(sessionKey)}`
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function ensureSessionCacheReady(sessionKey, loadToken) {
  if (!sessionKey || sessionKey === "latest") return;

  let status = await fetchCacheStatus(sessionKey);
  if (loadToken !== state.sessionLoadToken) return;
  if (status.cached) {
    showCacheLoading(false);
    return;
  }

  showCacheLoading(true, cacheStageLabel(status.stage), status.percent || 0);
  setReplayControlsEnabled(false);

  await fetch(`${API_BASE}/live/replay/cache/build?session_key=${encodeURIComponent(sessionKey)}`, {
    method: "POST"
  }).catch(() => {});

  await new Promise((resolve, reject) => {
    stopCachePolling();
    state.cachePollTimer = setInterval(async () => {
      if (loadToken !== state.sessionLoadToken) {
        stopCachePolling();
        resolve();
        return;
      }
      try {
        status = await fetchCacheStatus(sessionKey);
        showCacheLoading(
          true,
          cacheStageLabel(status.stage),
          status.percent || (status.building ? 5 : 0)
        );
        if (status.cached) {
          stopCachePolling();
          showCacheLoading(false);
          resolve();
        }
      } catch (err) {
        stopCachePolling();
        reject(err);
      }
    }, CACHE_POLL_MS);
  });
}

function replayCacheKey(atMs) {
  return String(atMs);
}

function invalidateReplayPrefetchCache() {
  state.replay.prefetchGeneration += 1;
  state.replay.prefetchCache.clear();
  state.replay.prefetchInflight.clear();
  state.replay.prefetchPending = [];
}

function resetReplayState() {
  stopReplayAnimation();
  state.replay.timeline = null;
  state.replay.atMs = null;
  state.replay.scrubbing = false;
  state.replay.frameInFlight = false;
  state.replay.locationIndex = null;
  state.replay.lastAnalysisAt = 0;
  state.replayFrameToken += 1;
  invalidateReplayPrefetchCache();
  if (state.scrubFetchTimer) clearTimeout(state.scrubFetchTimer);
  state.scrubFetchTimer = null;
}

function hideReplayControls() {
  state.replay.active = false;
  $("live-replay-controls")?.classList.add("hidden");
  stopReplayPlayback();
  stopCachePolling();
  showCacheLoading(false);
  resetReplayState();
  setReplayControlsEnabled(false);
}

function showReplayControls() {
  state.replay.active = true;
  $("live-replay-controls")?.classList.remove("hidden");
}

function updateReplayTimeDisplay() {
  const el = $("live-replay-time");
  const tl = state.replay.timeline;
  if (!el || !tl?.dateStart || !tl?.dateEnd || state.replay.atMs == null) {
    if (el) el.textContent = "";
    return;
  }
  const startMs = new Date(tl.dateStart).getTime();
  const endMs = new Date(tl.dateEnd).getTime();
  const elapsed = state.replay.atMs - startMs;
  const total = endMs - startMs;
  const atIso = new Date(state.replay.atMs).toLocaleTimeString("sv-SE");
  el.textContent = `Replay: ${formatDurationMs(elapsed)} / ${formatDurationMs(total)} (${atIso})`;
}

function syncScrubberFromAt() {
  const scrubber = $("live-replay-scrubber");
  const tl = state.replay.timeline;
  if (!scrubber || !tl?.dateStart || !tl?.dateEnd || state.replay.atMs == null) return;
  const startMs = new Date(tl.dateStart).getTime();
  const endMs = new Date(tl.dateEnd).getTime();
  const total = endMs - startMs;
  if (total <= 0) return;
  const pct = ((state.replay.atMs - startMs) / total) * 100;
  scrubber.value = String(Math.min(100, Math.max(0, pct)));
}

function atFromScrubberValue(value) {
  const tl = state.replay.timeline;
  if (!tl?.dateStart || !tl?.dateEnd) return null;
  const startMs = new Date(tl.dateStart).getTime();
  const endMs = new Date(tl.dateEnd).getTime();
  const total = endMs - startMs;
  const pct = Number(value) / 100;
  return startMs + total * pct;
}

function sessionFromAllSessions(sessionKey) {
  if (!sessionKey) return null;
  return state.allSessions.find((s) => String(s.session_key) === String(sessionKey)) || null;
}

function defaultReplayStartMs(timeline) {
  return timeline.dateStart ? new Date(timeline.dateStart).getTime() : Date.now();
}

function replayEmptyPositionsMessage() {
  if (!state.replay.active) return "Ingen positionsdata tillgänglig.";
  const firstMs = firstReplayLocationMs(state.replay.locationIndex);
  if (firstMs != null && state.replay.atMs != null && state.replay.atMs < firstMs) {
    return "Väntar på första positionsdata…";
  }
  return "Ingen positionsdata vid denna tidpunkt";
}

function replayEndMs() {
  const tl = state.replay.timeline;
  return tl?.dateEnd ? new Date(tl.dateEnd).getTime() : null;
}

function applyReplayFrameData(data, options = {}) {
  const session =
    data.session ||
    sessionFromAllSessions(data.sessionKey || state.resolvedSessionKey) ||
    state.replay.timeline?.session ||
    null;

  state.sessionStatus = data.status || state.replay.timeline?.status || null;
  $("live-session-info").textContent = formatSessionInfo(session);
  $("live-status").textContent = `Status: ${statusLabel(state.sessionStatus)} · Replay`;
  $("live-updated").textContent = data.at
    ? `Visar: ${new Date(data.at).toLocaleTimeString("sv-SE")}`
    : "";

  const previousFrame = state.lastTrackFrame;
  const frameData = buildTrackFrameData(data, previousFrame);
  frameData.positions = data.positions || frameData.positions || [];
  state.lastTrackFrame = frameData;
  renderPositions(frameData.positions);
  renderAnalysis(data);
  updateReplayMapFromIndex();
  updateReplayTimeDisplay();
  syncScrubberFromAt();

  if (!options.skipPrefetch) {
    prefetchAheadFrames(replayAnalysisSnapMs(state.replay.atMs));
  }
}

async function fetchReplayFrameData(atMs) {
  const atIso = new Date(atMs).toISOString();
  const res = await fetch(`${API_BASE}/live/replay/frame${replayQuery(atIso)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function storeReplayPrefetchFrame(atMs, data, generation, sessionKey) {
  if (
    generation !== state.replay.prefetchGeneration ||
    sessionKey !== state.resolvedSessionKey
  ) {
    return;
  }
  state.replay.prefetchCache.set(replayCacheKey(atMs), data);
}

function drainReplayPrefetchQueue() {
  while (
    state.replay.prefetchPending.length > 0 &&
    state.replay.prefetchInflight.size < REPLAY_PREFETCH_MAX_CONCURRENT
  ) {
    const atMs = state.replay.prefetchPending.shift();
    if (atMs == null) continue;
    const key = replayCacheKey(atMs);
    if (state.replay.prefetchCache.has(key) || state.replay.prefetchInflight.has(key)) {
      continue;
    }
    startReplayPrefetch(atMs);
  }
}

function startReplayPrefetch(atMs) {
  const key = replayCacheKey(atMs);
  if (state.replay.prefetchCache.has(key) || state.replay.prefetchInflight.has(key)) {
    return;
  }
  if (state.replay.prefetchInflight.size >= REPLAY_PREFETCH_MAX_CONCURRENT) {
    if (!state.replay.prefetchPending.includes(atMs)) {
      state.replay.prefetchPending.push(atMs);
    }
    return;
  }

  const generation = state.replay.prefetchGeneration;
  const sessionKey = state.resolvedSessionKey;
  state.replay.prefetchInflight.add(key);

  fetchReplayFrameData(atMs)
    .then((data) => {
      storeReplayPrefetchFrame(atMs, data, generation, sessionKey);
    })
    .catch(() => {})
    .finally(() => {
      state.replay.prefetchInflight.delete(key);
      drainReplayPrefetchQueue();
    });
}

function prefetchAheadFrames(fromAtMs) {
  if (state.replay.atMs == null || !state.replay.active) return;
  const endMs = replayEndMs();
  if (endMs == null) return;

  const advance = replayAdvanceMs();
  for (let i = 1; i <= REPLAY_PREFETCH_AHEAD; i++) {
    const atMs = fromAtMs + advance * i;
    if (atMs > endMs) break;
    startReplayPrefetch(atMs);
  }
}

function prefetchInitialFrames(fromAtMs) {
  if (state.replay.atMs == null || !state.replay.active) return;
  const endMs = replayEndMs();
  if (endMs == null) return;

  const advance = replayAdvanceMs();
  for (let i = 1; i <= REPLAY_PREFETCH_INITIAL; i++) {
    const atMs = fromAtMs + advance * i;
    if (atMs > endMs) break;
    startReplayPrefetch(atMs);
  }
}

async function refreshReplayFrame(options = {}) {
  if (state.replay.atMs == null) return false;
  const frameToken = ++state.replayFrameToken;
  const sessionKeyAtRequest = state.resolvedSessionKey;
  const atMsAtRequest = options.atMs ?? replayAnalysisSnapMs(state.replay.atMs);
  const cacheKey = replayCacheKey(atMsAtRequest);
  const cached = state.replay.prefetchCache.get(cacheKey);

  state.replay.frameInFlight = true;
  try {
    let data = cached;
    if (!data) {
      data = await fetchReplayFrameData(atMsAtRequest);
      storeReplayPrefetchFrame(
        atMsAtRequest,
        data,
        state.replay.prefetchGeneration,
        sessionKeyAtRequest
      );
    } else {
      state.replay.prefetchCache.delete(cacheKey);
    }

    if (
      !options.force &&
      (frameToken !== state.replayFrameToken ||
        sessionKeyAtRequest !== state.resolvedSessionKey)
    ) {
      return false;
    }

    applyReplayFrameData(data, { skipPrefetch: options.skipPrefetch });
    return true;
  } catch (err) {
    if (frameToken === state.replayFrameToken) {
      $("live-status").textContent = err.message || "Fel vid replay";
    }
    return false;
  } finally {
    if (frameToken === state.replayFrameToken) {
      state.replay.frameInFlight = false;
    }
  }
}

function replayAnimationStep(now) {
  if (!state.replay.playing || state.replay.atMs == null) return;

  const tl = state.replay.timeline;
  const endMs = tl?.dateEnd ? new Date(tl.dateEnd).getTime() : null;
  if (endMs == null) {
    stopReplayPlayback();
    return;
  }

  if (state.replay.lastAnimTime == null) {
    state.replay.lastAnimTime = now;
  }
  const delta = now - state.replay.lastAnimTime;
  state.replay.lastAnimTime = now;
  state.replay.atMs = Math.min(endMs, state.replay.atMs + delta * state.replay.speed);

  updateReplayMapFromIndex();
  updateReplayTimeDisplay();
  syncScrubberFromAt();
  checkTeamRadioNotifications(state.replay.atMs);

  if (now - state.replay.lastAnalysisAt >= REPLAY_ANALYSIS_MS) {
    state.replay.lastAnalysisAt = now;
    if (!state.replay.frameInFlight) {
      refreshReplayFrame({ skipPrefetch: false });
    }
    prefetchAheadFrames(replayAnalysisSnapMs(state.replay.atMs));
  }

  if (state.replay.atMs >= endMs) {
    stopReplayPlayback();
    refreshReplayFrame({ force: true });
    return;
  }

  state.replay.animRafId = requestAnimationFrame(replayAnimationStep);
}

function startReplayPlayback() {
  if (!state.replay.timeline || state.replay.atMs == null) return;
  stopReplayPlayback();
  state.replay.playing = true;
  state.replay.lastAnalysisAt = 0;
  updatePlayButton();
  prefetchAheadFrames(replayAnalysisSnapMs(state.replay.atMs));
  prefetchInitialFrames(replayAnalysisSnapMs(state.replay.atMs));
  refreshReplayFrame({ force: true });
  state.replay.animRafId = requestAnimationFrame(replayAnimationStep);
}

async function loadReplayLocationIndex(sessionKey) {
  const res = await fetch(
    `${API_BASE}/live/replay/locations-index?session_key=${encodeURIComponent(sessionKey)}`
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function initReplayMode(timeline) {
  stopLivePolling();
  resetReplayState();
  showReplayControls();
  setReplayControlsEnabled(false);
  state.replay.timeline = timeline;
  state.resolvedSessionKey = String(timeline.sessionKey || state.sessionKey);
  state.sessionTrackOutline = null;
  state.replay.speed = Number($("live-replay-speed").value) || 1;
  state.lastTrackFrame = null;
  drawTrackLoading($("live-track"));
  $("live-session-info").textContent = formatSessionInfo(
    timeline.session || sessionFromAllSessions(state.resolvedSessionKey)
  );
  $("live-status").textContent = `Status: ${statusLabel(timeline.status)} · Replay`;
  updatePlayButton();

  try {
    state.replay.locationIndex = await loadReplayLocationIndex(state.resolvedSessionKey);
  } catch {
    state.replay.locationIndex = null;
  }

  await loadTeamRadioFullList(state.resolvedSessionKey);

  const firstLocMs = firstReplayLocationMs(state.replay.locationIndex);
  state.replay.atMs = firstLocMs ?? defaultReplayStartMs(timeline);
  initTeamRadioNotifyCursor(state.replay.atMs);
  syncScrubberFromAt();
  updateReplayTimeDisplay();

  let loaded = await refreshReplayFrame({ force: true });
  if (!loaded) {
    loaded = await refreshReplayFrame({ force: true });
  }
  if (loaded) {
    updateReplayMapFromIndex();
    prefetchInitialFrames(replayAnalysisSnapMs(state.replay.atMs));
  }

  setReplayControlsEnabled(true);
  updatePlayButton();
}

function clearLivePanels(message) {
  setTableMessage($("live-positions-table").querySelector("tbody"), 5, message);
  drawTrackLoading($("live-track"));
  renderAnalysis({
    intervals: [],
    stints: [],
    pitStops: [],
    fastestLaps: [],
    recentLaps: [],
    raceControl: [],
    overtakes: [],
    weather: null,
    teamRadio: [],
    carData: [],
    startingGrid: [],
    sessionResult: []
  });
}

async function resolveSessionMode() {
  const loadToken = ++state.sessionLoadToken;
  resetTeamRadioModal();
  stopLivePolling();
  stopReplayPlayback();
  hideReplayControls();
  state.resolvedSessionKey = state.sessionKey === "latest" ? null : String(state.sessionKey);
  state.lastTrackFrame = null;
  state.sessionTrackOutline = null;
  clearLivePanels("Laddar session…");
  $("live-status").textContent = "Laddar session…";
  $("live-updated").textContent = "";

  try {
    const res = await fetch(`${API_BASE}/live/replay/timeline${sessionQuery()}`);
    const timeline = await res.json();
    if (loadToken !== state.sessionLoadToken) return;
    if (!res.ok) {
      throw new Error(timeline.error || `HTTP ${res.status}`);
    }

    state.resolvedSessionKey = String(timeline.sessionKey || state.resolvedSessionKey || "");
    state.sessionStatus = timeline.status;

    const session =
      timeline.session || sessionFromAllSessions(state.resolvedSessionKey);
    $("live-session-info").textContent = formatSessionInfo(session);

    if (!session && !timeline.dateStart) {
      $("live-status").textContent = "Ingen session hittades för valet.";
      $("live-updated").textContent = "";
      clearLivePanels("Ingen session hittades.");
      return;
    }

    if (timeline.status === "upcoming") {
      $("live-status").textContent = "Status: Kommande – replay blir tillgänglig efter sessionen";
      $("live-updated").textContent = "";
      clearLivePanels("Sessionen har inte startat än.");
      return;
    }

    if (
      timeline.status === "finished" &&
      timeline.replayAvailable &&
      timeline.dateStart &&
      timeline.dateEnd
    ) {
      if (!timeline.cacheReady) {
        showReplayControls();
        await ensureSessionCacheReady(state.resolvedSessionKey, loadToken);
        if (loadToken !== state.sessionLoadToken) return;
      }
      await initReplayMode({ ...timeline, session: session || timeline.session });
      return;
    }

    startLivePolling();
  } catch (err) {
    if (loadToken !== state.sessionLoadToken) return;
    $("live-status").textContent = err.message || "Fel vid hämtning";
    startLivePolling();
  }
}

async function refreshLive() {
  if (state.replay.active) return;
  try {
    const res = await fetch(`${API_BASE}/live${sessionQuery()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.sessionStatus = data.status;
    state.liveSource = data.source || "rest";
    $("live-session-info").textContent = formatSessionInfo(data.session);
    const sourceLabel = data.source === "mqtt" ? " · MQTT" : "";
    $("live-status").textContent = `Status: ${statusLabel(data.status)}${sourceLabel}`;
    $("live-updated").textContent = data.updatedAt
      ? `Senast uppdaterad: ${new Date(data.updatedAt).toLocaleTimeString("sv-SE")}`
      : "";

    renderPositions(data.positions || []);
    state.lastTrackFrame = buildTrackFrameData(data);
    drawCurrentTrackFrame();
  } catch (err) {
    $("live-session-info").textContent = "Kunde inte hämta live-data.";
    $("live-status").textContent = err.message || "Fel vid hämtning";
  }
}

async function refreshAnalysis() {
  if (state.replay.active) return;
  try {
    const res = await fetch(`${API_BASE}/live/analysis${sessionQuery()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.sessionKey) {
      state.resolvedSessionKey = String(data.sessionKey);
    }
    renderAnalysis(data);
    if (state.lastPositions.length) {
      renderPositions(state.lastPositions);
    }
    if (state.resolvedSessionKey) {
      const prevLen = state.teamRadioFullList.length;
      await loadTeamRadioFullList(state.resolvedSessionKey);
      if (!prevLen && state.teamRadioFullList.length) {
        initTeamRadioNotifyCursor(Date.now());
      }
      checkTeamRadioNotifications(Date.now());
    }
  } catch {
    /* tyst – översikt kan fortfarande fungera */
  }
}

const fullscreenState = {
  activePanel: null,
  replayControlsParent: null,
  replayControlsNext: null
};

function panelTabId(panel) {
  return panel?.id?.replace(/^tab-/, "") || "";
}

function activateTab(tabId) {
  const buttons = document.querySelectorAll(".live-tab-nav .tab-btn");
  buttons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".live-tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabId}`);
  });
  if (tabId === "overview") {
    requestAnimationFrame(() => {
      if (state.replay.active) {
        refreshReplayFrame();
      } else {
        refreshLive();
      }
    });
  }
}

function redrawTrackIfNeeded() {
  drawCurrentTrackFrame();
}

function relocateReplayControls(panel) {
  const replayEl = $("live-replay-controls");
  const slot = panel?.querySelector(".live-panel-replay-slot");
  if (!replayEl || !slot || replayEl.classList.contains("hidden")) return;
  if (!fullscreenState.replayControlsParent) {
    fullscreenState.replayControlsParent = replayEl.parentElement;
    fullscreenState.replayControlsNext = replayEl.nextElementSibling;
  }
  slot.appendChild(replayEl);
  replayEl.classList.add("live-replay-controls--in-fullscreen");
}

function restoreReplayControls() {
  const replayEl = $("live-replay-controls");
  if (!replayEl || !fullscreenState.replayControlsParent) return;
  const parent = fullscreenState.replayControlsParent;
  const next = fullscreenState.replayControlsNext;
  if (next && next.parentElement === parent) {
    parent.insertBefore(replayEl, next);
  } else {
    parent.appendChild(replayEl);
  }
  replayEl.classList.remove("live-replay-controls--in-fullscreen");
}

function updateFullscreenUi(panel) {
  document.querySelectorAll(".live-panel-fullscreen-target").forEach((p) => {
    const inFs = p === panel;
    const enterBtn = p.querySelector(".live-panel-fullscreen-btn");
    const exitBtn = p.querySelector(".live-panel-exit-btn");
    if (enterBtn) enterBtn.classList.toggle("hidden", inFs);
    if (exitBtn) exitBtn.classList.toggle("hidden", !inFs);
  });
}

function setFullscreenHash(tabId) {
  if (!tabId) {
    if (location.hash.startsWith("#fullscreen=")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    return;
  }
  const next = `#fullscreen=${encodeURIComponent(tabId)}`;
  if (location.hash !== next) {
    history.replaceState(null, "", location.pathname + location.search + next);
  }
}

function parseFullscreenHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  return params.get("fullscreen");
}

function isNativeFullscreenActive() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function exitPanelFullscreen() {
  const panel = fullscreenState.activePanel;
  if (!panel) return;

  if (panel.classList.contains("live-panel-fullscreen-fallback")) {
    panel.classList.remove("live-panel-fullscreen-fallback", "live-panel-fullscreen-active");
    document.body.classList.remove("live-panel-fullscreen-open");
  } else if (isNativeFullscreenActive()) {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.msExitFullscreen;
    if (exit) exit.call(document);
  }

  restoreReplayControls();
  fullscreenState.activePanel = null;
  updateFullscreenUi(null);
  sessionStorage.removeItem("pitwall-fullscreen-panel");
  setFullscreenHash(null);
  requestAnimationFrame(redrawTrackIfNeeded);
}

async function enterPanelFullscreen(panel) {
  if (!panel || fullscreenState.activePanel === panel) return;

  if (fullscreenState.activePanel) {
    exitPanelFullscreen();
  }

  const tabId = panelTabId(panel);
  activateTab(tabId);
  fullscreenState.activePanel = panel;
  panel.classList.add("live-panel-fullscreen-active");
  updateFullscreenUi(panel);
  relocateReplayControls(panel);

  const canNative =
    panel.requestFullscreen ||
    panel.webkitRequestFullscreen ||
    panel.msRequestFullscreen;

  if (canNative && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
    try {
      const req = panel.requestFullscreen || panel.webkitRequestFullscreen || panel.msRequestFullscreen;
      await req.call(panel);
    } catch {
      panel.classList.add("live-panel-fullscreen-fallback");
      document.body.classList.add("live-panel-fullscreen-open");
    }
  } else {
    panel.classList.add("live-panel-fullscreen-fallback");
    document.body.classList.add("live-panel-fullscreen-open");
  }

  if (tabId) {
    sessionStorage.setItem("pitwall-fullscreen-panel", tabId);
    setFullscreenHash(tabId);
  }
  requestAnimationFrame(redrawTrackIfNeeded);
}

function togglePanelFullscreen(panel) {
  if (!panel) return;
  if (fullscreenState.activePanel === panel) {
    exitPanelFullscreen();
  } else {
    enterPanelFullscreen(panel);
  }
}

function enhancePanelForFullscreen(panel) {
  if (panel.dataset.fullscreenEnhanced) return;
  panel.dataset.fullscreenEnhanced = "1";
  panel.classList.add("live-panel-fullscreen-target");

  const tabId = panelTabId(panel);
  const titleBtn = document.querySelector(`.live-tab-nav .tab-btn[data-tab="${tabId}"]`);
  const title = titleBtn ? titleBtn.textContent.trim() : tabId;

  const header = document.createElement("div");
  header.className = "live-panel-header";
  header.innerHTML = `
    <h2 class="live-panel-title">${title}</h2>
    <div class="live-panel-header-actions">
      <button type="button" class="live-panel-fullscreen-btn" aria-label="Helskärm" title="Helskärm">⛶</button>
      <button type="button" class="live-panel-exit-btn hidden" aria-label="Avsluta helskärm" title="Avsluta helskärm">✕</button>
    </div>
  `;

  const body = document.createElement("div");
  body.className = "live-panel-body";
  while (panel.firstChild) {
    body.appendChild(panel.firstChild);
  }

  const replaySlot = document.createElement("div");
  replaySlot.className = "live-panel-replay-slot";

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(replaySlot);

  header.querySelector(".live-panel-fullscreen-btn").addEventListener("click", () => {
    enterPanelFullscreen(panel);
  });
  header.querySelector(".live-panel-exit-btn").addEventListener("click", () => {
    exitPanelFullscreen();
  });
}

function setupFullscreenPanels() {
  document.querySelectorAll(".live-tab-panel").forEach(enhancePanelForFullscreen);

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || state.teamRadioModalOpen) return;
    if (fullscreenState.activePanel) {
      exitPanelFullscreen();
    }
  });
}

function onFullscreenChange() {
  if (!fullscreenState.activePanel) return;
  if (!isNativeFullscreenActive() && !fullscreenState.activePanel.classList.contains("live-panel-fullscreen-fallback")) {
    fullscreenState.activePanel.classList.remove("live-panel-fullscreen-active");
    restoreReplayControls();
    fullscreenState.activePanel = null;
    updateFullscreenUi(null);
    sessionStorage.removeItem("pitwall-fullscreen-panel");
    setFullscreenHash(null);
    requestAnimationFrame(redrawTrackIfNeeded);
  }
}

async function openFullscreenFromPreference() {
  const tabId = parseFullscreenHash() || sessionStorage.getItem("pitwall-fullscreen-panel");
  if (!tabId) return;
  const panel = document.getElementById(`tab-${tabId}`);
  if (!panel) return;
  activateTab(tabId);
  await enterPanelFullscreen(panel);
}

function setupTabs() {
  const buttons = document.querySelectorAll(".live-tab-nav .tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      activateTab(tab);
      if (fullscreenState.activePanel && panelTabId(fullscreenState.activePanel) !== tab) {
        exitPanelFullscreen();
      }
    });
  });
}

function startLivePolling() {
  refreshLive();
  refreshAnalysis();
  if (state.resolvedSessionKey) {
    loadTeamRadioFullList(state.resolvedSessionKey).then(() => {
      initTeamRadioNotifyCursor(Date.now());
    });
  }
  if (state.timer) clearInterval(state.timer);
  if (state.analysisTimer) clearInterval(state.analysisTimer);
  const pollMs = state.sessionStatus === "live" ? LIVE_POLL_MS : POLL_MS;
  const analysisMs = state.sessionStatus === "live" ? LIVE_ANALYSIS_POLL_MS : ANALYSIS_POLL_MS;
  state.timer = setInterval(refreshLive, pollMs);
  state.analysisTimer = setInterval(refreshAnalysis, analysisMs);
}

function setupReplayControls() {
  $("live-replay-play").addEventListener("click", () => {
    if (state.replay.playing) {
      stopReplayPlayback();
    } else {
      startReplayPlayback();
    }
  });

  $("live-replay-speed").addEventListener("change", (e) => {
    state.replay.speed = Number(e.target.value) || 1;
    invalidateReplayPrefetchCache();
    if (state.replay.atMs != null) {
      prefetchAheadFrames(replayAnalysisSnapMs(state.replay.atMs));
      prefetchInitialFrames(replayAnalysisSnapMs(state.replay.atMs));
    }
  });

  const scrubber = $("live-replay-scrubber");
  scrubber.addEventListener("input", () => {
    state.replay.scrubbing = true;
    stopReplayPlayback();
    invalidateReplayPrefetchCache();
    const atMs = atFromScrubberValue(scrubber.value);
    if (atMs != null) {
      state.replay.atMs = atMs;
      updateReplayTimeDisplay();
      updateReplayMapFromIndex();
      checkTeamRadioNotifications(atMs);
    }
    if (state.scrubFetchTimer) clearTimeout(state.scrubFetchTimer);
    state.scrubFetchTimer = setTimeout(() => {
      refreshReplayFrame();
    }, REPLAY_SCRUB_THROTTLE_MS);
  });

  scrubber.addEventListener("change", async () => {
    state.replay.scrubbing = false;
    if (state.scrubFetchTimer) clearTimeout(state.scrubFetchTimer);
    state.scrubFetchTimer = null;
    await refreshReplayFrame();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.replay.playing && !isTeamRadioPlaying()) {
      stopReplayPlayback();
    }
  });
}

async function preloadLatestRaceTimeline() {
  try {
    const res = await fetch(`${API_BASE}/live/replay/timeline`);
    if (!res.ok) return;
    await res.json();
  } catch {
    /* valfri preload */
  }
}

window.addEventListener("load", async () => {
  setupFullscreenPanels();
  setupTeamRadioModal();
  setupTabs();
  setupReplayControls();
  await loadSessionOptions();
  preloadLatestRaceTimeline();

  $("live-session-type-filter").addEventListener("change", (e) => {
    state.sessionTypeFilter = e.target.value;
    renderSessionSelect();
  });

  $("live-session-select").addEventListener("change", (e) => {
    state.sessionKey = e.target.value;
    state.resolvedSessionKey = state.sessionKey === "latest" ? null : String(state.sessionKey);
    resolveSessionMode();
  });

  window.addEventListener("resize", () => {
    drawCurrentTrackFrame();
  });

  resolveSessionMode();
  await openFullscreenFromPreference();
});

window.addEventListener("beforeunload", () => {
  stopLivePolling();
  stopReplayPlayback();
  stopCachePolling();
});
