const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createOpenF1MqttIngestor } = require("./lib/openf1-mqtt");
const { loadOpenF1MqttEnv } = require("./lib/openf1-mqtt-config");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const SEASON_YEAR = 2026;

const dataDir = path.join(__dirname, "data");
const cacheRoot = path.resolve(process.env.CACHE_DIR || path.join(dataDir, "cache"));
const sessionCacheDir = path.join(cacheRoot, "sessions");
const betsFileName = process.env.BETS_FILE || "bets.json";
const betsFile = path.join(dataDir, betsFileName);
const defaultBetsFile = path.join(dataDir, "bets.json");

function ensureCacheDirs() {
  fs.mkdirSync(sessionCacheDir, { recursive: true });
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}
try {
  ensureCacheDirs();
} catch (err) {
  console.error(`[cache] Kunde inte skapa cache-katalog ${sessionCacheDir}:`, err.message);
}

if (!fs.existsSync(defaultBetsFile)) {
  fs.writeFileSync(
    defaultBetsFile,
    JSON.stringify(
      {
        users: [
          { id: "seb", name: "Sebastian" },
          { id: "olle", name: "Olle" },
          { id: "anna", name: "Anna" }
        ],
        seasonBets: [],
        raceBets: [],
        settings: {
          seasonOverrideOpen: false,
          racePot: 0,
          raceSettlements: {}
        }
      },
      null,
      2
    )
  );
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let cachedSessions = null;
let cachedMeetings = null;
let cachedDrivers = null;
let cachedTeams = null;
let cachedDriverStandings = null;
let cachedConstructorStandings = null;
let cachedStandingsAt = 0;
let sessionsInFlight = null;
let meetingsInFlight = null;
let driversInFlight = null;
let cachedRaceStandings = null;
let cachedRaceStandingsAt = 0;
let cachedLiveBundle = null;
let cachedLiveBundleAt = 0;
let cachedLiveSessionKey = null;
let cachedLiveAnalysis = null;
let cachedLiveAnalysisAt = 0;
let cachedLiveAnalysisKey = null;
let cachedAllSessions = null;
let allSessionsInFlight = null;
const replayFrameCache = new Map();
const replaySessionDataCache = new Map();
const replayLocationsIndexCache = new Map();
const replayTeamRadioListCache = new Map();
const sessionCacheBuildsInFlight = new Map();

const TEAM_RADIO_PROXY_HOSTS = new Set([
  "livetiming.formula1.com",
  "api.openf1.org"
]);

const TEAM_RADIO_UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "audio/mpeg,audio/*,*/*;q=0.8",
  Referer: "https://www.formula1.com/"
};

const SESSION_CACHE_VERSION = 2;
const SESSION_LOCATION_SAMPLE_MS = 1000;
const SESSION_LOCATION_CHUNK_MS = 10 * 60 * 1000;
const SESSION_CAR_DATA_SAMPLE_MS = 1000;
const SESSION_CAR_DATA_CHUNK_MS = 2 * 60 * 1000;

const STANDINGS_TTL_MS = 15 * 60 * 1000;
const RACE_STANDINGS_TTL_MS = 10 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 3000;
const LIVE_ANALYSIS_TTL_MS = 8000;
const REPLAY_FRAME_CACHE_TTL_MS = 2500;
const REPLAY_SESSION_DATA_TTL_MS = 30 * 60 * 1000;
const OPENF1_MIN_INTERVAL_MS = 400;
const CACHE_SYNC_INTERVAL_MS = Number(process.env.CACHE_SYNC_INTERVAL_MS) || 6 * 60 * 60 * 1000;
const CACHE_SYNC_MAX_SESSIONS = Number(process.env.CACHE_SYNC_MAX_SESSIONS) || 0;
const CACHE_PREWARM_RACE_COUNT = Number(process.env.CACHE_PREWARM_RACE_COUNT) || 3;
const openF1MqttEnv = loadOpenF1MqttEnv(process.env);
const OPENF1_USERNAME = openF1MqttEnv.accountUsername;
const OPENF1_PASSWORD = openF1MqttEnv.accountPassword;

let cacheSyncInFlight = null;
let lastCacheSyncResult = null;
const sessionCacheBuildProgress = new Map();

let openF1Queue = Promise.resolve();
let lastOpenF1At = 0;

let openF1AccessToken = openF1MqttEnv.password || null;
let openF1TokenExpiresAt = openF1AccessToken ? Date.now() + 50 * 60 * 1000 : 0;

async function fetchOpenF1AccessToken() {
  if (!OPENF1_USERNAME || !OPENF1_PASSWORD) {
    return openF1AccessToken;
  }
  if (openF1AccessToken && Date.now() < openF1TokenExpiresAt - 60_000) {
    return openF1AccessToken;
  }
  const res = await fetch("https://api.openf1.org/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: OPENF1_USERNAME,
      password: OPENF1_PASSWORD
    })
  });
  if (!res.ok) {
    console.error(`[openf1-auth] Token-hämtning misslyckades: HTTP ${res.status}`);
    return openF1AccessToken;
  }
  const data = await res.json();
  if (data?.access_token) {
    openF1AccessToken = data.access_token;
    openF1TokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  }
  return openF1AccessToken;
}

function openF1Fetch(url, options = {}) {
  openF1Queue = openF1Queue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, OPENF1_MIN_INTERVAL_MS - (now - lastOpenF1At));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastOpenF1At = Date.now();
    const headers = { ...(options.headers || {}) };
    if (options.auth) {
      const token = await fetchOpenF1AccessToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    return fetch(url, { ...options, headers });
  });
  return openF1Queue;
}

const openF1Mqtt = createOpenF1MqttIngestor({
  ...openF1MqttEnv,
  accountUsername: OPENF1_USERNAME,
  getAccessToken: fetchOpenF1AccessToken,
  detectLiveSession: async () => {
    const { session, status } = await loadLiveSession("latest");
    return {
      sessionKey: session?.session_key ?? null,
      status,
      session
    };
  }
});

function pickLatestSessionKey(sessions, latestAt = null) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const latestAtMs = latestAt ? new Date(latestAt).getTime() : null;
  const sorted = sessions
    .filter((s) => {
      if (!s.session_key) return false;
      const rawDate = s.date_start || s.session_start_utc;
      if (!rawDate) return false;
      if (latestAtMs === null) return true;
      return new Date(rawDate).getTime() <= latestAtMs;
    })
    .slice()
    .sort((a, b) => {
      const da = new Date(a.date_start || a.session_start_utc).getTime();
      const db = new Date(b.date_start || b.session_start_utc).getTime();
      return db - da;
    });
  return sorted[0] ? sorted[0].session_key : null;
}

async function getLatestRaceSessionKey() {
  const nowIso = new Date().toISOString();
  const sessions = await loadSessions();
  const fromSeason = pickLatestSessionKey(sessions, nowIso);
  if (fromSeason) return fromSeason;

  const url = `https://api.openf1.org/v1/sessions?session_name=Race&date_start<=${encodeURIComponent(
    nowIso
  )}`;
  const res = await openF1Fetch(url);
  const data = await res.json();
  return pickLatestSessionKey(data, nowIso);
}

async function loadSessions() {
  if (cachedSessions) return cachedSessions;
  if (sessionsInFlight) return sessionsInFlight;
  // Hämta alla races för säsongen
  const url = `https://api.openf1.org/v1/sessions?year=${SEASON_YEAR}&session_name=Race`;
  sessionsInFlight = (async () => {
  const res = await openF1Fetch(url);
    const data = await res.json();

    // Säkerställ att vi alltid får en array
    if (!Array.isArray(data)) {
      console.error("Unexpected sessions response from OpenF1:", data);
      return cachedSessions || [];
    }

    cachedSessions = data;
    return cachedSessions;
  })().finally(() => {
    sessionsInFlight = null;
  });

  return sessionsInFlight;
}

async function loadAllSessions() {
  if (cachedAllSessions) return cachedAllSessions;
  if (allSessionsInFlight) return allSessionsInFlight;

  const url = `https://api.openf1.org/v1/sessions?year=${SEASON_YEAR}`;
  allSessionsInFlight = (async () => {
    const res = await openF1Fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.error("Unexpected all-sessions response from OpenF1:", data);
      return cachedAllSessions || [];
    }
    cachedAllSessions = data;
    return cachedAllSessions;
  })().finally(() => {
    allSessionsInFlight = null;
  });

  return allSessionsInFlight;
}

function isSeasonLocked(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return false;

  const now = new Date();
  let firstStart = null;

  sessions.forEach((s) => {
    const rawDate = s.date_start || s.session_start_utc;
    if (!rawDate) return;
    const d = new Date(rawDate);
    if (!firstStart || d < firstStart) {
      firstStart = d;
    }
  });

  if (!firstStart) return false;
  return now >= firstStart;
}

async function loadMeetings() {
  if (cachedMeetings) return cachedMeetings;
  if (meetingsInFlight) return meetingsInFlight;

  const url = `https://api.openf1.org/v1/meetings?year=${SEASON_YEAR}`;
  meetingsInFlight = (async () => {
  const res = await openF1Fetch(url);
    const data = await res.json();

    if (!Array.isArray(data)) {
      console.error("Unexpected meetings response from OpenF1:", data);
      return cachedMeetings || [];
    }

    cachedMeetings = data;
    return cachedMeetings;
  })().finally(() => {
    meetingsInFlight = null;
  });

  return meetingsInFlight;
}

async function loadDrivers() {
  if (cachedDrivers && cachedTeams) return { drivers: cachedDrivers, teams: cachedTeams };
  if (driversInFlight) return driversInFlight;

  // Hämta aktuell gridd via senaste tillgängliga sessionen.
  // OpenF1 har ännu inga förare knutna till 2026-racen, men "latest"
  // ger oss senaste kända startfält (vilket är tillräckligt för vårt spel).
  const url = `https://api.openf1.org/v1/drivers?session_key=latest`;
  driversInFlight = (async () => {
  const res = await openF1Fetch(url);
    const drivers = await res.json();

    if (!Array.isArray(drivers)) {
      console.error("Unexpected drivers response from OpenF1:", drivers);
      return { drivers: cachedDrivers || [], teams: cachedTeams || [] };
    }

    cachedDrivers = drivers;

    const teamSet = new Set();
    drivers.forEach((d) => {
      if (d.team_name) teamSet.add(d.team_name);
    });
    cachedTeams = Array.from(teamSet);

    return { drivers: cachedDrivers, teams: cachedTeams };
  })().finally(() => {
    driversInFlight = null;
  });

  return driversInFlight;
}

async function loadStandings() {
  const now = Date.now();
  if (
    Array.isArray(cachedDriverStandings) &&
    cachedDriverStandings.length > 0 &&
    Array.isArray(cachedConstructorStandings) &&
    cachedConstructorStandings.length > 0 &&
    now - cachedStandingsAt < STANDINGS_TTL_MS
  ) {
    return {
      drivers: cachedDriverStandings,
      constructors: cachedConstructorStandings,
      updatedAt: cachedStandingsAt
    };
  }

  const sessionKey = await getLatestRaceSessionKey();
  const driverChampionshipUrl = sessionKey
    ? `https://api.openf1.org/v1/championship_drivers?session_key=${sessionKey}`
    : null;
  const teamChampionshipUrl = sessionKey
    ? `https://api.openf1.org/v1/championship_teams?session_key=${sessionKey}`
    : null;
  const driverUrl = `https://api.openf1.org/v1/driver_standings?year=${SEASON_YEAR}`;
  const constructorUrl = `https://api.openf1.org/v1/constructor_standings?year=${SEASON_YEAR}`;

  try {
    if (driverChampionshipUrl && teamChampionshipUrl) {
      const [driverRes, teamRes] = await Promise.all([
        openF1Fetch(driverChampionshipUrl),
        openF1Fetch(teamChampionshipUrl)
      ]);
      const driverData = await driverRes.json();
      const teamData = await teamRes.json();

      cachedDriverStandings = Array.isArray(driverData)
        ? driverData.map((d) => ({
            driver_number: d.driver_number,
            position: d.position_current
          }))
        : [];

      cachedConstructorStandings = Array.isArray(teamData)
        ? teamData.map((t) => ({
            team_name: t.team_name,
            position: t.position_current
          }))
        : [];
    } else {
      cachedDriverStandings = [];
      cachedConstructorStandings = [];
    }

    if (cachedDriverStandings.length === 0 || cachedConstructorStandings.length === 0) {
      const [driverRes, constructorRes] = await Promise.all([
        openF1Fetch(driverUrl),
        openF1Fetch(constructorUrl)
      ]);

      const driverData = await driverRes.json();
      const constructorData = await constructorRes.json();

      if (cachedDriverStandings.length === 0) {
        cachedDriverStandings = Array.isArray(driverData) ? driverData : [];
      }
      if (cachedConstructorStandings.length === 0) {
        cachedConstructorStandings = Array.isArray(constructorData) ? constructorData : [];
      }
    }

    if (cachedDriverStandings.length === 0) {
      const fallbackDriverRes = await openF1Fetch(
        "https://api.openf1.org/v1/driver_standings?session_key=latest"
      );
      const fallbackDrivers = await fallbackDriverRes.json();
      cachedDriverStandings = Array.isArray(fallbackDrivers) ? fallbackDrivers : [];
    }

    if (cachedConstructorStandings.length === 0) {
      const fallbackConstructorRes = await openF1Fetch(
        "https://api.openf1.org/v1/constructor_standings?session_key=latest"
      );
      const fallbackConstructors = await fallbackConstructorRes.json();
      cachedConstructorStandings = Array.isArray(fallbackConstructors)
        ? fallbackConstructors
        : [];
    }
    if (cachedDriverStandings.length > 0 || cachedConstructorStandings.length > 0) {
      cachedStandingsAt = Date.now();
    }
  } catch (err) {
    console.error("Failed to load standings from OpenF1:", err);
    cachedDriverStandings = cachedDriverStandings || [];
    cachedConstructorStandings = cachedConstructorStandings || [];
  }

  return {
    drivers: cachedDriverStandings,
    constructors: cachedConstructorStandings,
    updatedAt: cachedStandingsAt
  };
}

async function loadSessionResult(sessionKey) {
  if (!sessionKey) return [];
  const url = `https://api.openf1.org/v1/session_result?session_key=${sessionKey}&position<=3`;
  try {
    const res = await openF1Fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position));
  } catch (err) {
    console.error("Failed to load session_result from OpenF1:", err);
    return [];
  }
}

async function loadRaceStandings(db) {
  const now = Date.now();
  if (cachedRaceStandings && now - cachedRaceStandingsAt < RACE_STANDINGS_TTL_MS) {
    return cachedRaceStandings;
  }

  const sessions = await loadSessions();
  const nowDate = new Date();
  const pastSessions = sessions.filter((s) => {
    const rawDate = s.date_start || s.session_start_utc;
    if (!rawDate) return false;
    return new Date(rawDate) <= nowDate;
  });

  const sessionByKey = new Map(
    pastSessions.map((s) => [String(s.session_key), s])
  );

  const raceResults = [];
  for (const session of pastSessions) {
    const sessionKey = session.session_key;
    if (!sessionKey) continue;
    const results = await loadSessionResult(sessionKey);
    if (!results || results.length < 3) continue;
    const top3 = results.slice(0, 3).map((r) => Number(r.driver_number));
    raceResults.push({
      sessionKey: String(sessionKey),
      raceName: session.meeting_name || session.circuit_short_name || "Race",
      date: session.date_start || session.session_start_utc || null,
      resultTop3: top3
    });
  }

  const pointsByUser = new Map();
  const winsByUser = new Map();

  raceResults.forEach((race) => {
    const bets = db.raceBets.filter(
      (b) =>
        b.seasonYear === SEASON_YEAR &&
        String(b.session_key) === String(race.sessionKey)
    );
    const winners = bets.filter(
      (b) =>
        Number(b.p1_driver_number) === race.resultTop3[0] &&
        Number(b.p2_driver_number) === race.resultTop3[1] &&
        Number(b.p3_driver_number) === race.resultTop3[2]
    );

    const winnerIds = winners.map((w) => w.userId);
    winnerIds.forEach((userId) => {
      pointsByUser.set(userId, (pointsByUser.get(userId) || 0) + 1);
      if (!winsByUser.has(userId)) winsByUser.set(userId, []);
      winsByUser.get(userId).push({
        sessionKey: race.sessionKey,
        raceName: race.raceName,
        date: race.date
      });
    });

    race.winners = winnerIds;
    race.totalBets = bets.length;
  });

  const leaderboard = db.users
    .map((u) => ({
      userId: u.id,
      name: u.name,
      points: pointsByUser.get(u.id) || 0,
      wins: winsByUser.get(u.id) || []
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  cachedRaceStandings = {
    updatedAt: Date.now(),
    races: raceResults,
    leaderboard
  };
  cachedRaceStandingsAt = Date.now();
  return cachedRaceStandings;
}

function readBetsFile() {
  const raw = fs.readFileSync(betsFile, "utf-8");
  const data = JSON.parse(raw);
  if (!data.settings) {
    data.settings = { seasonOverrideOpen: false, racePot: 0, raceSettlements: {} };
  }
  if (typeof data.settings.seasonOverrideOpen !== "boolean") {
    data.settings.seasonOverrideOpen = false;
  }
  if (typeof data.settings.racePot !== "number") {
    data.settings.racePot = 0;
  }
  if (!data.settings.raceSettlements || typeof data.settings.raceSettlements !== "object") {
    data.settings.raceSettlements = {};
  }
  return data;
}

function writeBetsFile(data) {
  fs.writeFileSync(betsFile, JSON.stringify(data, null, 2), "utf-8");
}

function resolveSessionKeyParam(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "latest") {
    return "latest";
  }
  return String(raw);
}

async function fetchOpenF1Json(path, attempt = 0) {
  const res = await openF1Fetch(`https://api.openf1.org/v1${path}`);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 429 && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    return fetchOpenF1Json(path, attempt + 1);
  }

  if (res.status === 404) {
    return [];
  }

  if (!res.ok) {
    console.error(`OpenF1 ${path} failed: HTTP ${res.status}`, data);
    return [];
  }

  return Array.isArray(data) ? data : [];
}

async function findSessionByKey(sessionKey) {
  if (sessionKey === undefined || sessionKey === null || sessionKey === "" || sessionKey === "latest") {
    return null;
  }

  const sessions = await fetchOpenF1Json(
    `/sessions?session_key=${encodeURIComponent(sessionKey)}`
  );
  if (sessions[0]) return sessions[0];

  const all = await loadAllSessions();
  return all.find((s) => String(s.session_key) === String(sessionKey)) || null;
}

function deriveSessionStatus(session) {
  if (!session) return "unknown";
  if (session.is_cancelled) return "cancelled";
  const start = new Date(session.date_start || session.session_start_utc || 0);
  const end = new Date(
    session.date_end ||
      session.session_end_utc ||
      start.getTime() + 2 * 60 * 60 * 1000
  );
  const now = new Date();
  if (now < start) return "upcoming";
  if (now <= end) return "live";
  return "finished";
}

function latestPerDriver(rows, key = "driver_number") {
  const map = new Map();
  rows.forEach((row) => {
    const driverNumber = row[key];
    if (driverNumber === undefined || driverNumber === null) return;
    const existing = map.get(driverNumber);
    const rowDate = new Date(row.date || row.date_start || 0).getTime();
    if (!existing || rowDate >= new Date(existing.date || existing.date_start || 0).getTime()) {
      map.set(driverNumber, row);
    }
  });
  return Array.from(map.values());
}

function rowsAtOrBefore(rows, atIso) {
  const atMs = new Date(atIso).getTime();
  return rows.filter((row) => {
    const rowMs = new Date(row.date || row.date_start || 0).getTime();
    return rowMs <= atMs;
  });
}

function latestPerDriverAt(rows, atIso, key = "driver_number") {
  return latestPerDriver(rowsAtOrBefore(rows, atIso), key);
}

function stintsAtTime(stints, atIso) {
  const atMs = new Date(atIso).getTime();
  const byDriver = new Map();
  stints.forEach((row) => {
    const startMs = new Date(row.date_start || row.date || 0).getTime();
    if (startMs > atMs) return;
    const endRaw = row.date_end || row.date;
    const endMs = endRaw ? new Date(endRaw).getTime() : null;
    if (endMs !== null && endMs < atMs) return;
    const driverNumber = row.driver_number;
    const existing = byDriver.get(driverNumber);
    const stintNumber = Number(row.stint_number) || 0;
    const existingStint = existing ? Number(existing.stint_number) || 0 : -1;
    if (!existing || stintNumber >= existingStint) {
      byDriver.set(driverNumber, row);
    }
  });
  return Array.from(byDriver.values());
}

function parseReplayAt(atIso) {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) {
    throw new Error("Invalid at query parameter (ISO8601 timestamp)");
  }
  return at;
}

function replayCacheKey(sessionKey, atIso) {
  const rounded = parseReplayAt(atIso);
  rounded.setMilliseconds(0);
  return `${sessionKey}:${rounded.toISOString()}`;
}

function sessionCachePath(sessionKey) {
  return path.join(sessionCacheDir, String(sessionKey));
}

function readSessionCacheMeta(sessionKey) {
  const metaPath = path.join(sessionCachePath(sessionKey), "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function isSessionCacheComplete(sessionKey) {
  const meta = readSessionCacheMeta(sessionKey);
  return !!(meta && meta.complete && meta.version === SESSION_CACHE_VERSION);
}

function readSessionCacheResource(sessionKey, resource) {
  const filePath = path.join(sessionCachePath(sessionKey), `${resource}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadSessionCacheData(sessionKey) {
  const key = String(sessionKey);
  if (!isSessionCacheComplete(key)) return null;
  return {
    meta: readSessionCacheMeta(key),
    drivers: readSessionCacheResource(key, "drivers") || [],
    positions: readSessionCacheResource(key, "positions") || [],
    locations: readSessionCacheResource(key, "locations") || [],
    intervals: readSessionCacheResource(key, "intervals") || [],
    stints: readSessionCacheResource(key, "stints") || [],
    pit: readSessionCacheResource(key, "pit") || [],
    laps: readSessionCacheResource(key, "laps") || [],
    race_control: readSessionCacheResource(key, "race_control") || [],
    overtakes: readSessionCacheResource(key, "overtakes") || [],
    weather: readSessionCacheResource(key, "weather") || [],
    starting_grid: readSessionCacheResource(key, "starting_grid") || [],
    session_result: readSessionCacheResource(key, "session_result") || [],
    team_radio: readSessionCacheResource(key, "team_radio") || [],
    track_outline: readSessionCacheResource(key, "track_outline") || [],
    car_data: readSessionCacheResource(key, "car_data") || []
  };
}

function getSessionCacheBuildProgress(sessionKey) {
  return sessionCacheBuildProgress.get(String(sessionKey)) || null;
}

function setSessionCacheBuildProgress(sessionKey, patch) {
  const key = String(sessionKey);
  const prev = sessionCacheBuildProgress.get(key) || {
    stage: "starting",
    percent: 0,
    startedAt: new Date().toISOString()
  };
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  sessionCacheBuildProgress.set(key, next);
  return next;
}

function clearSessionCacheBuildProgress(sessionKey) {
  sessionCacheBuildProgress.delete(String(sessionKey));
}

function sessionHintFromCacheMeta(sessionKey) {
  const meta = readSessionCacheMeta(sessionKey);
  if (!meta?.dateStart) return null;
  return {
    session_key: meta.sessionKey ?? Number(sessionKey),
    date_start: meta.dateStart,
    date_end: meta.dateEnd
  };
}

function getSessionCacheStatus(sessionKey) {
  const key = String(sessionKey);
  const meta = readSessionCacheMeta(key);
  const complete = isSessionCacheComplete(key);
  const progress = getSessionCacheBuildProgress(key);
  const building = !!progress && !complete;
  return {
    sessionKey: Number(key) || key,
    cached: complete,
    building,
    stage: building ? progress.stage : complete ? "complete" : null,
    percent: building ? progress.percent : complete ? 100 : 0,
    version: meta?.version ?? null,
    builtAt: meta?.builtAt ?? null,
    dateStart: meta?.dateStart ?? null,
    dateEnd: meta?.dateEnd ?? null,
    counts: meta?.counts ?? null,
    immutable: complete,
    note: complete
      ? "Avslutade sessioner ändras inte – cachen är permanent tills den raderas manuellt."
      : building
        ? "Bygger cache i bakgrunden…"
        : null,
    updatedAt: new Date().toISOString()
  };
}

function buildDriverMap(drivers) {
  const map = new Map();
  (drivers || []).forEach((driver) => {
    const num = Number(driver.driver_number);
    if (!Number.isNaN(num)) {
      map.set(num, driver);
    }
  });
  return map;
}

function driverLookup(driverByNumber, driverNumber) {
  if (driverNumber === undefined || driverNumber === null) return null;
  return driverByNumber.get(Number(driverNumber)) || null;
}

function mergeLocationSamples(bucketMaps, rows, sampleIntervalMs = SESSION_LOCATION_SAMPLE_MS) {
  rows.forEach((row) => {
    const num = Number(row.driver_number);
    if (Number.isNaN(num)) return;
    const ts = new Date(row.date || 0).getTime();
    if (Number.isNaN(ts)) return;
    const bucket = Math.floor(ts / sampleIntervalMs);
    let driverBuckets = bucketMaps.get(num);
    if (!driverBuckets) {
      driverBuckets = new Map();
      bucketMaps.set(num, driverBuckets);
    }
    const existing = driverBuckets.get(bucket);
    if (!existing || ts >= new Date(existing.date || 0).getTime()) {
      driverBuckets.set(bucket, {
        driver_number: num,
        x: row.x,
        y: row.y,
        z: row.z,
        date: row.date
      });
    }
  });
}

function flattenLocationSamples(bucketMaps) {
  const result = [];
  bucketMaps.forEach((buckets) => {
    buckets.forEach((point) => result.push(point));
  });
  result.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return result;
}

function mergeCarDataSamples(bucketMaps, rows, sampleIntervalMs = SESSION_CAR_DATA_SAMPLE_MS) {
  rows.forEach((row) => {
    const num = Number(row.driver_number);
    if (Number.isNaN(num)) return;
    const ts = new Date(row.date || 0).getTime();
    if (Number.isNaN(ts)) return;
    const bucket = Math.floor(ts / sampleIntervalMs);
    let driverBuckets = bucketMaps.get(num);
    if (!driverBuckets) {
      driverBuckets = new Map();
      bucketMaps.set(num, driverBuckets);
    }
    const existing = driverBuckets.get(bucket);
    if (!existing || ts >= new Date(existing.date || 0).getTime()) {
      driverBuckets.set(bucket, {
        driver_number: num,
        date: row.date,
        speed: row.speed,
        throttle: row.throttle,
        brake: row.brake,
        n_gear: row.n_gear,
        drs: row.drs,
        rpm: row.rpm
      });
    }
  });
}

function flattenCarDataSamples(bucketMaps) {
  const result = [];
  bucketMaps.forEach((buckets) => {
    buckets.forEach((point) => result.push(point));
  });
  result.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return result;
}

function buildTrackOutline(sampledLocations) {
  const byDriver = new Map();
  sampledLocations.forEach((row) => {
    const num = Number(row.driver_number);
    if (!byDriver.has(num)) byDriver.set(num, []);
    byDriver.get(num).push(row);
  });
  let best = [];
  byDriver.forEach((points) => {
    if (points.length > best.length) best = points;
  });
  return best
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    .map((p) => ({ x: p.x, y: p.y }));
}

async function fetchSampledLocations(sessionKey, dateStart, dateEnd, onProgress = null) {
  const sk = encodeURIComponent(sessionKey);
  const startMs = new Date(dateStart || 0).getTime();
  const endMs = new Date(dateEnd || dateStart || 0).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return [];
  }

  const bucketMaps = new Map();
  const totalChunks = Math.max(1, Math.ceil((endMs - startMs) / SESSION_LOCATION_CHUNK_MS));
  let chunkIndex = 0;
  for (let t = startMs; t < endMs; t += SESSION_LOCATION_CHUNK_MS) {
    const chunkStart = new Date(t).toISOString();
    const chunkEnd = new Date(Math.min(t + SESSION_LOCATION_CHUNK_MS, endMs)).toISOString();
    const rows = await fetchOpenF1Json(
      `/location?session_key=${sk}&date>=${encodeURIComponent(chunkStart)}&date<=${encodeURIComponent(chunkEnd)}`
    );
    mergeLocationSamples(bucketMaps, rows);
    chunkIndex += 1;
    if (onProgress) {
      const chunkPct = Math.round((chunkIndex / totalChunks) * 100);
      onProgress({
        stage: "locations",
        percent: 15 + Math.round(chunkPct * 0.35)
      });
    }
  }
  return flattenLocationSamples(bucketMaps);
}

async function fetchSampledCarData(sessionKey, dateStart, dateEnd, onProgress = null) {
  const sk = encodeURIComponent(sessionKey);
  const startMs = new Date(dateStart || 0).getTime();
  const endMs = new Date(dateEnd || dateStart || 0).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return [];
  }

  const bucketMaps = new Map();
  const totalChunks = Math.max(1, Math.ceil((endMs - startMs) / SESSION_CAR_DATA_CHUNK_MS));
  let chunkIndex = 0;
  for (let t = startMs; t < endMs; t += SESSION_CAR_DATA_CHUNK_MS) {
    const chunkStart = new Date(t).toISOString();
    const chunkEnd = new Date(Math.min(t + SESSION_CAR_DATA_CHUNK_MS, endMs)).toISOString();
    const rows = await fetchOpenF1Json(
      `/car_data?session_key=${sk}&date>=${encodeURIComponent(chunkStart)}&date<=${encodeURIComponent(chunkEnd)}`
    );
    mergeCarDataSamples(bucketMaps, rows);
    chunkIndex += 1;
    if (onProgress) {
      const chunkPct = Math.round((chunkIndex / totalChunks) * 100);
      onProgress({
        stage: "car_data",
        percent: 50 + Math.round(chunkPct * 0.45)
      });
    }
  }
  return flattenCarDataSamples(bucketMaps);
}

function writeSessionCache(sessionKey, payload) {
  const dir = sessionCachePath(sessionKey);
  fs.mkdirSync(dir, { recursive: true });
  const resources = {
    drivers: payload.drivers,
    positions: payload.positions,
    locations: payload.locations,
    intervals: payload.intervals,
    stints: payload.stints,
    pit: payload.pit,
    laps: payload.laps,
    race_control: payload.race_control,
    overtakes: payload.overtakes,
    weather: payload.weather,
    starting_grid: payload.starting_grid,
    session_result: payload.session_result,
    team_radio: payload.team_radio,
    track_outline: payload.track_outline,
    car_data: payload.car_data
  };
  Object.entries(resources).forEach(([name, data]) => {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data));
  });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        version: SESSION_CACHE_VERSION,
        complete: true,
        sessionKey: Number(sessionKey),
        builtAt: new Date().toISOString(),
        dateStart: payload.dateStart,
        dateEnd: payload.dateEnd,
        counts: {
          drivers: payload.drivers.length,
          positions: payload.positions.length,
          locations: payload.locations.length,
          intervals: payload.intervals.length,
          stints: payload.stints.length,
          pit: payload.pit.length,
          laps: payload.laps.length,
          race_control: payload.race_control.length,
          overtakes: payload.overtakes.length,
          weather: payload.weather.length,
          starting_grid: payload.starting_grid.length,
          session_result: payload.session_result.length,
          team_radio: payload.team_radio.length,
          track_outline: payload.track_outline.length,
          car_data: payload.car_data.length
        }
      },
      null,
      2
    )
  );
}

async function buildSessionCache(sessionKey, sessionHint = null) {
  const key = String(sessionKey);
  if (isSessionCacheComplete(key)) {
    clearSessionCacheBuildProgress(key);
    return getSessionCacheStatus(key);
  }

  const existing = sessionCacheBuildsInFlight.get(key);
  if (existing) return existing;

  const buildPromise = (async () => {
    setSessionCacheBuildProgress(key, { stage: "starting", percent: 0 });
    try {
    const { session } = sessionHint
      ? { session: sessionHint }
      : await loadLiveSession(sessionKey);
    const effectiveKey = session?.session_key || sessionKey;
    const sk = encodeURIComponent(effectiveKey);
    const dateStart = session?.date_start || session?.session_start_utc || null;
    const dateEnd =
      session?.date_end ||
      session?.session_end_utc ||
      (dateStart
        ? new Date(new Date(dateStart).getTime() + 2 * 60 * 60 * 1000).toISOString()
        : null);

    setSessionCacheBuildProgress(String(effectiveKey), { stage: "metadata", percent: 10 });

    const [
      drivers,
      positions,
      intervals,
      stints,
      pit,
      laps,
      raceControl,
      overtakes,
      weather,
      startingGrid,
      sessionResult,
      teamRadio
    ] = await Promise.all([
      fetchOpenF1Json(`/drivers?session_key=${sk}`),
      fetchOpenF1Json(`/position?session_key=${sk}`),
      fetchOpenF1Json(`/intervals?session_key=${sk}`),
      fetchOpenF1Json(`/stints?session_key=${sk}`),
      fetchOpenF1Json(`/pit?session_key=${sk}`),
      fetchOpenF1Json(`/laps?session_key=${sk}`),
      fetchOpenF1Json(`/race_control?session_key=${sk}`),
      fetchOpenF1Json(`/overtakes?session_key=${sk}`),
      fetchOpenF1Json(`/weather?session_key=${sk}`),
      fetchOpenF1Json(`/starting_grid?session_key=${sk}`),
      fetchOpenF1Json(`/session_result?session_key=${sk}`),
      fetchOpenF1Json(`/team_radio?session_key=${sk}`)
    ]);

    setSessionCacheBuildProgress(String(effectiveKey), { stage: "locations", percent: 15 });

    const locations = await fetchSampledLocations(
      effectiveKey,
      dateStart,
      dateEnd,
      (progress) => setSessionCacheBuildProgress(String(effectiveKey), progress)
    );
    const trackOutline = buildTrackOutline(locations);

    setSessionCacheBuildProgress(String(effectiveKey), { stage: "car_data", percent: 50 });

    const carData = await fetchSampledCarData(
      effectiveKey,
      dateStart,
      dateEnd,
      (progress) => setSessionCacheBuildProgress(String(effectiveKey), progress)
    );

    setSessionCacheBuildProgress(String(effectiveKey), { stage: "writing", percent: 98 });

    writeSessionCache(effectiveKey, {
      dateStart,
      dateEnd,
      drivers,
      positions,
      locations,
      intervals,
      stints,
      pit,
      laps,
      race_control: raceControl,
      overtakes,
      weather,
      starting_grid: startingGrid,
      session_result: sessionResult,
      team_radio: teamRadio,
      track_outline: trackOutline,
      car_data: carData
    });

    replaySessionDataCache.delete(String(effectiveKey));
    clearSessionCacheBuildProgress(String(effectiveKey));
    return getSessionCacheStatus(effectiveKey);
    } catch (err) {
      setSessionCacheBuildProgress(key, {
        stage: "failed",
        percent: 0,
        error: err.message
      });
      throw err;
    }
  })().finally(() => {
    sessionCacheBuildsInFlight.delete(key);
  });

  sessionCacheBuildsInFlight.set(key, buildPromise);
  return buildPromise;
}

function ensureSessionCacheBuilding(sessionKey, sessionHint = null) {
  const key = String(sessionKey);
  if (isSessionCacheComplete(key)) return;
  if (sessionCacheBuildsInFlight.has(key)) return;
  buildSessionCache(key, sessionHint).catch((err) => {
    clearSessionCacheBuildProgress(key);
    console.error(`[cache] Bakgrundsbygge misslyckades för ${key}:`, err.message);
  });
}

function isPrewarmableSession(session, racesOnly) {
  if (!session || session.is_cancelled) return false;
  if (Number(session.year) !== SEASON_YEAR) return false;
  if (deriveSessionStatus(session) !== "finished") return false;
  const name = session.session_name || session.session_type || "";
  if (racesOnly) return name === "Race";
  if (name === "Race" || name === "Qualifying" || name === "Sprint Qualifying" || name === "Sprint") {
    return true;
  }
  return /^Practice\s*[123]?$/i.test(name) || name === "Practice" || name.startsWith("Practice");
}

async function listFinishedSessionsForPrewarm(options = {}) {
  const racesOnly = options.racesOnly !== false;
  const limit = options.limit;
  const sessions = await loadAllSessions();
  let filtered = sessions
    .filter((session) => isPrewarmableSession(session, racesOnly))
    .sort((a, b) => {
      const da = new Date(a.date_start || a.session_start_utc || 0).getTime();
      const db = new Date(b.date_start || b.session_start_utc || 0).getTime();
      return db - da;
    });
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
}

async function listLatestFinishedRaces(limit = CACHE_PREWARM_RACE_COUNT) {
  return listFinishedSessionsForPrewarm({ racesOnly: true, limit });
}

async function prewarmSessionCaches(options = {}) {
  const startedAt = new Date().toISOString();
  const racesOnly = options.racesOnly !== false;
  const explicitLimit =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Number(options.limit)
      : null;
  const unlimited = (options.all === true || options.unlimited === true) && !explicitLimit;
  const limit = explicitLimit ?? (unlimited ? null : options.limit ?? CACHE_PREWARM_RACE_COUNT);
  const result = {
    startedAt,
    finishedAt: null,
    manual: !!options.manual,
    all: unlimited,
    racesOnly,
    prewarmLimit: limit,
    cacheDir: cacheRoot,
    cached: [],
    skipped: [],
    failed: [],
    totalCandidates: 0
  };

  let sessions;
  try {
    sessions = await listFinishedSessionsForPrewarm({ racesOnly, limit });
  } catch (err) {
    result.finishedAt = new Date().toISOString();
    result.error = err.message;
    lastCacheSyncResult = result;
    throw err;
  }

  result.totalCandidates = sessions.length;

  for (const session of sessions) {
    const key = String(session.session_key);
    const label = `${session.session_name || session.session_type || "Session"} (${session.date_start || "?"})`;

    if (isSessionCacheComplete(key)) {
      result.skipped.push({ sessionKey: Number(key) || key, reason: "complete", label });
      continue;
    }

    try {
      console.log(`[cache-prewarm] Bygger cache för session ${key} – ${label}`);
      await buildSessionCache(key, session);
      result.cached.push({ sessionKey: Number(key) || key, label });
      console.log(`[cache-prewarm] Klar: session ${key}`);
    } catch (err) {
      console.error(`[cache-prewarm] Misslyckades session ${key}:`, err.message);
      result.failed.push({ sessionKey: Number(key) || key, label, error: err.message });
    }
  }

  result.finishedAt = new Date().toISOString();
  lastCacheSyncResult = result;
  console.log(
    `[cache-prewarm] Klar – cachade: ${result.cached.length}, hoppade: ${result.skipped.length}, fel: ${result.failed.length}`
  );
  return result;
}

async function prewarmRaceCaches(options = {}) {
  return prewarmSessionCaches({ ...options, racesOnly: true });
}

async function listFinishedSessionsForCacheSync() {
  const sessions = await loadAllSessions();
  return sessions
    .filter((session) => {
      if (session.is_cancelled) return false;
      if (Number(session.year) !== SEASON_YEAR) return false;
      return deriveSessionStatus(session) === "finished";
    })
    .sort((a, b) => {
      const da = new Date(a.date_start || a.session_start_utc || 0).getTime();
      const db = new Date(b.date_start || b.session_start_utc || 0).getTime();
      return db - da;
    });
}

async function syncSessionCaches(options = {}) {
  const unlimited = options.all === true || options.unlimited === true;

  if (unlimited || options.racesOnly === false) {
    return prewarmSessionCaches({
      ...options,
      all: unlimited,
      unlimited
    });
  }

  const prewarmResult = await prewarmSessionCaches({
    ...options,
    racesOnly: true,
    limit: options.limit ?? CACHE_PREWARM_RACE_COUNT
  });

  if (CACHE_SYNC_MAX_SESSIONS <= CACHE_PREWARM_RACE_COUNT) {
    return prewarmResult;
  }

  const result = {
    ...prewarmResult,
    extraCached: [],
    extraSkipped: [],
    extraFailed: []
  };

  let sessions;
  try {
    sessions = await listFinishedSessionsForCacheSync();
  } catch (err) {
    result.error = err.message;
    return result;
  }

  const prewarmedKeys = new Set(
    (prewarmResult.cached || [])
      .concat(prewarmResult.skipped || [])
      .map((row) => String(row.sessionKey))
  );
  const extraLimit = CACHE_SYNC_MAX_SESSIONS - CACHE_PREWARM_RACE_COUNT;

  for (const session of sessions) {
    if (result.extraCached.length + result.extraSkipped.length >= extraLimit) break;
    const key = String(session.session_key);
    if (prewarmedKeys.has(key)) continue;

    const label = `${session.session_name || session.session_type || "Session"} (${session.date_start || "?"})`;
    if (isSessionCacheComplete(key)) {
      result.extraSkipped.push({ sessionKey: Number(key) || key, reason: "complete", label });
      continue;
    }

    try {
      console.log(`[cache-sync] Bygger extra cache för session ${key} – ${label}`);
      await buildSessionCache(key, session);
      result.extraCached.push({ sessionKey: Number(key) || key, label });
    } catch (err) {
      console.error(`[cache-sync] Misslyckades session ${key}:`, err.message);
      result.extraFailed.push({ sessionKey: Number(key) || key, label, error: err.message });
    }
  }

  result.finishedAt = new Date().toISOString();
  lastCacheSyncResult = result;
  return result;
}

function startCacheSyncScheduler() {
  const run = () => {
    prewarmRaceCaches().catch((err) => {
      console.error("[cache-prewarm] Bakgrundsjobb misslyckades:", err.message);
    });
  };
  run();
  setInterval(run, CACHE_SYNC_INTERVAL_MS);
  console.log(
    `[cache-prewarm] Schemalagt var ${Math.round(CACHE_SYNC_INTERVAL_MS / 60000)} min – senaste ${CACHE_PREWARM_RACE_COUNT} race`
  );
}

function replaySessionDataFromCache(cache) {
  const driverByNumber = buildDriverMap(cache.drivers);
  return {
    loadedAt: Date.now(),
    fromDiskCache: true,
    pitRaw: cache.pit,
    raceControlRaw: cache.race_control,
    lapsRaw: cache.laps,
    overtakesRaw: cache.overtakes,
    teamRadioRaw: cache.team_radio,
    stintsRaw: cache.stints,
    startingGridRaw: cache.starting_grid,
    sessionResultRaw: cache.session_result,
    weatherRaw: cache.weather,
    intervalsRaw: cache.intervals,
    positionsRaw: cache.positions,
    locationsRaw: cache.locations,
    carDataRaw: cache.car_data,
    trackOutline: cache.track_outline,
    drivers: cache.drivers,
    driverByNumber
  };
}

function mapPositionsWithDrivers(rows, atIso, driverByNumber) {
  return latestPerDriverAt(rows, atIso)
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((p) => ({
      driver_number: p.driver_number,
      position: p.position,
      date: p.date,
      driver: driverLookup(driverByNumber, p.driver_number)
    }));
}

function locationPointMs(point) {
  return new Date(point.date).getTime();
}

function interpolateLocationPoints(points, atMs) {
  if (!points?.length) return null;
  const sorted = points
    .slice()
    .sort((a, b) => locationPointMs(a) - locationPointMs(b));
  const firstMs = locationPointMs(sorted[0]);
  if (atMs < firstMs) {
    if (atMs >= firstMs - 2000) {
      return {
        x: sorted[0].x,
        y: sorted[0].y,
        z: sorted[0].z ?? 0,
        date: sorted[0].date
      };
    }
    return null;
  }
  const last = sorted[sorted.length - 1];
  const lastMs = locationPointMs(last);
  if (atMs >= lastMs) {
    return { x: last.x, y: last.y, z: last.z ?? 0, date: last.date };
  }

  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (locationPointMs(sorted[mid]) <= atMs) lo = mid;
    else hi = mid;
  }
  const a = sorted[lo];
  const b = sorted[hi];
  const t0 = locationPointMs(a);
  const t1 = locationPointMs(b);
  const span = t1 - t0;
  const p = span > 0 ? (atMs - t0) / span : 0;
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * p,
    date: new Date(atMs).toISOString()
  };
}

function mapLocationsAtTime(rows, atIso) {
  const atMs = new Date(atIso).getTime();
  const byDriver = new Map();
  rows.forEach((row) => {
    const driverNumber = row.driver_number;
    if (driverNumber === undefined || driverNumber === null) return;
    if (!byDriver.has(driverNumber)) byDriver.set(driverNumber, []);
    byDriver.get(driverNumber).push(row);
  });

  const result = [];
  byDriver.forEach((points, driverNumber) => {
    const loc = interpolateLocationPoints(points, atMs);
    if (loc) {
      result.push({
        driver_number: Number(driverNumber),
        x: loc.x,
        y: loc.y,
        z: loc.z,
        date: loc.date
      });
    }
  });
  return result;
}

function buildLocationsIndex(sessionKey) {
  const key = String(sessionKey);
  const cached = replayLocationsIndexCache.get(key);
  if (cached) return cached;

  const locations = readSessionCacheResource(key, "locations");
  if (!Array.isArray(locations) || !locations.length) return null;

  const meta = readSessionCacheMeta(key);
  const sessionStartMs = new Date(meta?.dateStart || locations[0].date).getTime();
  const byDriver = {};

  locations.forEach((loc) => {
    const driverKey = String(loc.driver_number);
    if (!byDriver[driverKey]) byDriver[driverKey] = [];
    byDriver[driverKey].push({
      t: locationPointMs(loc) - sessionStartMs,
      x: loc.x,
      y: loc.y,
      z: loc.z ?? 0
    });
  });

  Object.values(byDriver).forEach((points) => {
    points.sort((a, b) => a.t - b.t);
  });

  const index = {
    sessionKey: Number(key) || key,
    sessionStartMs,
    dateStart: meta?.dateStart || new Date(sessionStartMs).toISOString(),
    byDriver
  };
  replayLocationsIndexCache.set(key, index);
  return index;
}

async function buildTeamRadioList(sessionKey) {
  const key = String(sessionKey);
  const cached = replayTeamRadioListCache.get(key);
  if (cached) return cached;

  let rows = [];
  let drivers = [];

  if (isSessionCacheComplete(key)) {
    rows = readSessionCacheResource(key, "team_radio") || [];
    drivers = readSessionCacheResource(key, "drivers") || [];
  } else {
    const sk = encodeURIComponent(key);
    [rows, drivers] = await Promise.all([
      fetchOpenF1Json(`/team_radio?session_key=${sk}`).catch(() => []),
      fetchOpenF1Json(`/drivers?session_key=${sk}`).catch(() => [])
    ]);
  }

  const driverByNumber = buildDriverMap(drivers);
  const messages = enrichWithDrivers(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.recording_url)
      .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)),
    driverByNumber
  );

  const result = {
    sessionKey: Number(key) || key,
    messages
  };
  if (isSessionCacheComplete(key)) {
    replayTeamRadioListCache.set(key, result);
  }
  return result;
}

function resolveTrackOutline(trackOutline, sessionData) {
  if (Array.isArray(trackOutline) && trackOutline.length > 0) return trackOutline;
  if (sessionData?.trackOutline?.length) return sessionData.trackOutline;
  return [];
}

function buildReplayFramePayload({
  sessionKey,
  atIso,
  session,
  status,
  sessionData,
  positions,
  locations,
  trackOutline,
  cacheHit = false
}) {
  const { driverByNumber } = sessionData;
  const atMs = new Date(atIso).getTime();

  const intervals = enrichWithDrivers(
    latestPerDriverAt(sessionData.intervalsRaw || [], atIso).sort(
      (a, b) => Number(a.position) - Number(b.position)
    ),
    driverByNumber
  );

  const analysis = buildReplayAnalysis(sessionData, atIso);
  analysis.intervals = intervals;

  const sessionEndMs = session?.date_end ? new Date(session.date_end).getTime() : null;
  if (sessionEndMs && atMs < sessionEndMs - 60000) {
    analysis.sessionResult = [];
  }

  const resolvedOutline = resolveTrackOutline(trackOutline, sessionData);

  return {
    updatedAt: new Date().toISOString(),
    at: atIso,
    sessionKey,
    session,
    status,
    positions,
    locations,
    trackOutline: resolvedOutline,
    trackMapAvailable: locations.length > 0 || resolvedOutline.length > 0,
    cacheHit,
    ...analysis
  };
}

async function loadReplaySessionData(sessionKey) {
  const key = String(sessionKey);
  const cached = replaySessionDataCache.get(key);
  if (cached && Date.now() - cached.loadedAt < REPLAY_SESSION_DATA_TTL_MS) {
    return cached;
  }

  const diskCache = loadSessionCacheData(key);
  if (diskCache) {
    const data = replaySessionDataFromCache(diskCache);
    replaySessionDataCache.set(key, data);
    return data;
  }

  const sk = encodeURIComponent(sessionKey);
  const [
    pitRaw,
    raceControlRaw,
    lapsRaw,
    overtakesRaw,
    teamRadioRaw,
    stintsRaw,
    startingGridRaw,
    sessionResultRaw,
    weatherRaw,
    drivers
  ] = await Promise.all([
    fetchOpenF1Json(`/pit?session_key=${sk}`),
    fetchOpenF1Json(`/race_control?session_key=${sk}`),
    fetchOpenF1Json(`/laps?session_key=${sk}`),
    fetchOpenF1Json(`/overtakes?session_key=${sk}`),
    fetchOpenF1Json(`/team_radio?session_key=${sk}`),
    fetchOpenF1Json(`/stints?session_key=${sk}`),
    fetchOpenF1Json(`/starting_grid?session_key=${sk}`),
    fetchOpenF1Json(`/session_result?session_key=${sk}`),
    fetchOpenF1Json(`/weather?session_key=${sk}`),
    fetchOpenF1Json(`/drivers?session_key=${sk}`)
  ]);

  const data = {
    loadedAt: Date.now(),
    pitRaw,
    raceControlRaw,
    lapsRaw,
    overtakesRaw,
    teamRadioRaw,
    stintsRaw,
    startingGridRaw,
    sessionResultRaw,
    weatherRaw,
    drivers,
    driverByNumber: buildDriverMap(drivers)
  };
  replaySessionDataCache.set(key, data);
  return data;
}

function buildReplayAnalysis(sessionData, atIso) {
  const { driverByNumber } = sessionData;
  const pitStops = enrichWithDrivers(
    rowsAtOrBefore(sessionData.pitRaw, atIso)
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 25),
    driverByNumber
  );

  const raceControl = rowsAtOrBefore(sessionData.raceControlRaw, atIso)
    .slice()
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 30);

  const stints = enrichWithDrivers(stintsAtTime(sessionData.stintsRaw, atIso), driverByNumber);

  const weatherRows = rowsAtOrBefore(sessionData.weatherRaw, atIso);
  const weather =
    weatherRows.length > 0
      ? weatherRows
          .slice()
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0]
      : null;

  const overtakes = enrichWithDrivers(
    rowsAtOrBefore(sessionData.overtakesRaw, atIso)
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 20),
    driverByNumber,
    "overtaking_driver_number"
  );

  const startingGrid = enrichWithDrivers(
    sessionData.startingGridRaw
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position)),
    driverByNumber
  );

  const sessionResult = enrichWithDrivers(
    sessionData.sessionResultRaw
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position)),
    driverByNumber
  );

  const lapsUpTo = rowsAtOrBefore(sessionData.lapsRaw, atIso);
  const fastestByDriver = new Map();
  lapsUpTo.forEach((lap) => {
    if (!lap.lap_duration || lap.is_pit_out_lap) return;
    const existing = fastestByDriver.get(lap.driver_number);
    if (!existing || lap.lap_duration < existing.lap_duration) {
      fastestByDriver.set(lap.driver_number, lap);
    }
  });

  const fastestLaps = enrichWithDrivers(
    Array.from(fastestByDriver.values()).sort(
      (a, b) => Number(a.lap_duration) - Number(b.lap_duration)
    ),
    driverByNumber
  );

  const recentLaps = enrichWithDrivers(
    lapsUpTo
      .slice()
      .sort(
        (a, b) =>
          new Date(b.date_start || b.date || 0) - new Date(a.date_start || a.date || 0)
      )
      .slice(0, 25),
    driverByNumber
  );

  const teamRadio = enrichWithDrivers(
    rowsAtOrBefore(sessionData.teamRadioRaw, atIso)
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 15),
    driverByNumber
  );

  const carData = enrichWithDrivers(
    latestPerDriverAt(sessionData.carDataRaw || [], atIso),
    driverByNumber
  );

  return {
    intervals: [],
    raceControl,
    pitStops,
    stints,
    weather,
    overtakes,
    startingGrid,
    sessionResult,
    fastestLaps,
    recentLaps,
    teamRadio,
    carData
  };
}

async function loadReplayFrame(sessionKey, atIso) {
  const cacheKey = replayCacheKey(sessionKey, atIso);
  const cached = replayFrameCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < REPLAY_FRAME_CACHE_TTL_MS) {
    return cached.frame;
  }

  const effectiveKey = String(sessionKey);
  let session = isSessionCacheComplete(effectiveKey)
    ? sessionHintFromCacheMeta(effectiveKey)
    : null;
  let status = session ? "finished" : null;

  if (!session) {
    const loaded = await loadLiveSession(sessionKey);
    session = loaded.session;
    status = loaded.status;
  }

  const resolvedKey = String(session?.session_key || effectiveKey);
  const sk = encodeURIComponent(resolvedKey);
  const atMs = new Date(atIso).getTime();

  if (status === "finished" && !isSessionCacheComplete(resolvedKey)) {
    ensureSessionCacheBuilding(resolvedKey, session);
  }

  const sessionData = await loadReplaySessionData(resolvedKey);
  let positions;
  let locations;
  const cachedOutline = readSessionCacheResource(resolvedKey, "track_outline");
  let trackOutline =
    sessionData.trackOutline ||
    (Array.isArray(cachedOutline) ? cachedOutline : []);
  let cacheHit = !!sessionData.fromDiskCache;

  if (sessionData.fromDiskCache) {
    positions = mapPositionsWithDrivers(sessionData.positionsRaw, atIso, sessionData.driverByNumber);
    locations = mapLocationsAtTime(sessionData.locationsRaw, atIso);
  } else {
    const posSince = new Date(atMs - 5 * 60 * 1000).toISOString();
    const locSince = new Date(atMs - 5 * 60 * 1000).toISOString();
    const [positionsRaw, locationsRaw, carDataRaw] = await Promise.all([
      fetchOpenF1Json(
        `/position?session_key=${sk}&date>=${encodeURIComponent(posSince)}&date<=${encodeURIComponent(atIso)}`
      ),
      fetchOpenF1Json(
        `/location?session_key=${sk}&date>=${encodeURIComponent(locSince)}&date<=${encodeURIComponent(atIso)}`
      ),
      fetchOpenF1Json(
        `/car_data?session_key=${sk}&date>=${encodeURIComponent(locSince)}&date<=${encodeURIComponent(atIso)}`
      )
    ]);
    positions = mapPositionsWithDrivers(positionsRaw, atIso, sessionData.driverByNumber);
    locations = mapLocationsAtTime(locationsRaw, atIso);
    if (!trackOutline.length && locationsRaw.length) {
      trackOutline = buildTrackOutline(locationsRaw);
    }
    sessionData.intervalsRaw = sessionData.intervalsRaw || [];
    const intervalsRaw = await fetchOpenF1Json(
      `/intervals?session_key=${sk}&date>=${encodeURIComponent(posSince)}&date<=${encodeURIComponent(atIso)}`
    );
    if (intervalsRaw.length) {
      sessionData.intervalsRaw = intervalsRaw;
    }
    const analysisExtras = buildReplayAnalysis(sessionData, atIso);
    analysisExtras.carData = enrichWithDrivers(
      latestPerDriverAt(carDataRaw, atIso),
      sessionData.driverByNumber
    );
    const frame = buildReplayFramePayload({
      sessionKey: resolvedKey,
      atIso,
      session,
      status,
      sessionData,
      positions,
      locations,
      trackOutline,
      cacheHit
    });
    frame.carData = analysisExtras.carData;
    replayFrameCache.set(cacheKey, { cachedAt: Date.now(), frame });
    if (replayFrameCache.size > 120) {
      replayFrameCache.delete(replayFrameCache.keys().next().value);
    }
    return frame;
  }

  const frame = buildReplayFramePayload({
    sessionKey: resolvedKey,
    atIso,
    session,
    status,
    sessionData,
    positions,
    locations,
    trackOutline,
    cacheHit
  });

  replayFrameCache.set(cacheKey, { cachedAt: Date.now(), frame });
  if (replayFrameCache.size > 120) {
    replayFrameCache.delete(replayFrameCache.keys().next().value);
  }

  return frame;
}

async function getReplayTimeline(sessionKey) {
  if (!sessionKey) {
    return {
      sessionKey: null,
      session: null,
      status: "unknown",
      dateStart: null,
      dateEnd: null,
      replayAvailable: false,
      updatedAt: new Date().toISOString()
    };
  }

  const { session, status } = await loadLiveSession(sessionKey);
  const effectiveKey = session?.session_key ?? sessionKey;
  const dateStart = session?.date_start || session?.session_start_utc || null;
  const dateEnd =
    session?.date_end ||
    session?.session_end_utc ||
    (dateStart ? new Date(new Date(dateStart).getTime() + 2 * 60 * 60 * 1000).toISOString() : null);

  return {
    sessionKey: effectiveKey,
    session,
    status,
    dateStart,
    dateEnd,
    replayAvailable: status === "finished" || status === "live",
    cacheReady: isSessionCacheComplete(String(effectiveKey)),
    cacheBuilding: !!getSessionCacheBuildProgress(String(effectiveKey)),
    updatedAt: new Date().toISOString()
  };
}

async function loadLiveSession(sessionKey) {
  if (sessionKey === "latest") {
    const sessions = await fetchOpenF1Json("/sessions?session_key=latest");
    const session = sessions[0] || null;
    return { session, status: deriveSessionStatus(session) };
  }

  const session = await findSessionByKey(sessionKey);
  return { session, status: deriveSessionStatus(session) };
}

async function loadLivePositions(sessionKey) {
  const rows = await fetchOpenF1Json(
    `/position?session_key=${encodeURIComponent(sessionKey)}`
  );
  return latestPerDriver(rows)
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position));
}

async function loadLiveLocations(sessionKey, sessionStatus) {
  if (sessionStatus !== "live") return [];
  const since = new Date(Date.now() - 15000).toISOString();
  const rows = await fetchOpenF1Json(
    `/location?session_key=${encodeURIComponent(sessionKey)}&date>${encodeURIComponent(since)}`
  );
  return latestPerDriver(rows);
}

async function loadLiveBundle(sessionKey = "latest") {
  const { session, status } = await loadLiveSession(sessionKey);
  const effectiveKey = session?.session_key || sessionKey;

  if (status === "live" && openF1Mqtt.isFresh(effectiveKey)) {
    const drivers = await fetchOpenF1Json(
      `/drivers?session_key=${encodeURIComponent(effectiveKey)}`
    );
    const driverByNumber = buildDriverMap(drivers);
    const mqttBundle = openF1Mqtt.buildBundle(
      effectiveKey,
      session,
      status,
      driverByNumber,
      enrichWithDrivers,
      driverLookup
    );
    if (mqttBundle) {
      cachedLiveBundle = mqttBundle;
      cachedLiveBundleAt = Date.now();
      cachedLiveSessionKey = sessionKey;
      return mqttBundle;
    }
  }

  const now = Date.now();
  if (
    cachedLiveBundle &&
    cachedLiveSessionKey === sessionKey &&
    now - cachedLiveBundleAt < LIVE_CACHE_TTL_MS
  ) {
    return cachedLiveBundle;
  }

  const [positions, locations, drivers] = await Promise.all([
    loadLivePositions(effectiveKey),
    loadLiveLocations(effectiveKey, status),
    fetchOpenF1Json(`/drivers?session_key=${encodeURIComponent(effectiveKey)}`)
  ]);

  const driverByNumber = buildDriverMap(drivers);
  const bundle = {
    updatedAt: new Date().toISOString(),
    sessionKey: effectiveKey,
    session,
    status,
    source: "rest",
    positions: positions.map((p) => ({
      driver_number: p.driver_number,
      position: p.position,
      date: p.date,
      driver: driverLookup(driverByNumber, p.driver_number)
    })),
    locations: locations.map((l) => ({
      driver_number: l.driver_number,
      x: l.x,
      y: l.y,
      z: l.z,
      date: l.date
    })),
    trackMapAvailable: status === "live" && locations.length > 0
  };

  cachedLiveBundle = bundle;
  cachedLiveBundleAt = now;
  cachedLiveSessionKey = sessionKey;
  return bundle;
}

function latestStintPerDriver(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const driverNumber = row.driver_number;
    if (driverNumber === undefined || driverNumber === null) return;
    const existing = map.get(driverNumber);
    const stintNumber = Number(row.stint_number) || 0;
    const existingStint = existing ? Number(existing.stint_number) || 0 : -1;
    if (!existing || stintNumber >= existingStint) {
      map.set(driverNumber, row);
    }
  });
  return Array.from(map.values());
}

function enrichWithDrivers(rows, driverByNumber, key = "driver_number") {
  return rows.map((row) => ({
    ...row,
    driver: driverLookup(driverByNumber, row[key])
  }));
}

async function loadLiveAnalysis(sessionKey = "latest") {
  const { session, status } = await loadLiveSession(sessionKey);
  const effectiveKey = session?.session_key || sessionKey;

  if (status === "live" && openF1Mqtt.isFresh(effectiveKey)) {
    const drivers = await fetchOpenF1Json(
      `/drivers?session_key=${encodeURIComponent(effectiveKey)}`
    );
    const driverByNumber = buildDriverMap(drivers);
    const mqttAnalysis = openF1Mqtt.buildAnalysis(
      effectiveKey,
      session,
      status,
      driverByNumber,
      enrichWithDrivers
    );
    if (mqttAnalysis) {
      cachedLiveAnalysis = mqttAnalysis;
      cachedLiveAnalysisAt = Date.now();
      cachedLiveAnalysisKey = sessionKey;
      return mqttAnalysis;
    }
  }

  const now = Date.now();
  if (
    cachedLiveAnalysis &&
    cachedLiveAnalysisKey === sessionKey &&
    now - cachedLiveAnalysisAt < LIVE_ANALYSIS_TTL_MS
  ) {
    return cachedLiveAnalysis;
  }

  const sk = encodeURIComponent(effectiveKey);
  const isLive = status === "live";
  const carDataSince = new Date(Date.now() - 5000).toISOString();

  const [
    intervalsRaw,
    raceControlRaw,
    pitRaw,
    stintsRaw,
    weatherRaw,
    overtakesRaw,
    startingGridRaw,
    sessionResultRaw,
    lapsRaw,
    teamRadioRaw,
    carDataRaw,
    drivers
  ] = await Promise.all([
    fetchOpenF1Json(`/intervals?session_key=${sk}`),
    fetchOpenF1Json(`/race_control?session_key=${sk}`),
    fetchOpenF1Json(`/pit?session_key=${sk}`),
    fetchOpenF1Json(`/stints?session_key=${sk}`),
    fetchOpenF1Json(`/weather?session_key=${sk}`),
    fetchOpenF1Json(`/overtakes?session_key=${sk}`),
    fetchOpenF1Json(`/starting_grid?session_key=${sk}`),
    fetchOpenF1Json(`/session_result?session_key=${sk}`),
    fetchOpenF1Json(`/laps?session_key=${sk}`),
    fetchOpenF1Json(`/team_radio?session_key=${sk}`),
    isLive
      ? fetchOpenF1Json(
          `/car_data?session_key=${sk}&date>${encodeURIComponent(carDataSince)}`
        )
      : Promise.resolve([]),
    fetchOpenF1Json(`/drivers?session_key=${sk}`)
  ]);

  const driverByNumber = buildDriverMap(drivers);

  const intervals = enrichWithDrivers(
    latestPerDriver(intervalsRaw).sort(
      (a, b) => Number(a.position) - Number(b.position)
    ),
    driverByNumber
  );

  const raceControl = raceControlRaw
    .slice()
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 30);

  const pitStops = enrichWithDrivers(
    pitRaw
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 25),
    driverByNumber
  );

  const stints = enrichWithDrivers(latestStintPerDriver(stintsRaw), driverByNumber);

  const weather =
    weatherRaw.length > 0
      ? weatherRaw
          .slice()
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0]
      : null;

  const overtakes = enrichWithDrivers(
    overtakesRaw
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 20),
    driverByNumber,
    "overtaking_driver_number"
  );

  const startingGrid = enrichWithDrivers(
    startingGridRaw
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position)),
    driverByNumber
  );

  const sessionResult = enrichWithDrivers(
    sessionResultRaw
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position)),
    driverByNumber
  );

  const fastestByDriver = new Map();
  lapsRaw.forEach((lap) => {
    if (!lap.lap_duration || lap.is_pit_out_lap) return;
    const existing = fastestByDriver.get(lap.driver_number);
    if (!existing || lap.lap_duration < existing.lap_duration) {
      fastestByDriver.set(lap.driver_number, lap);
    }
  });

  const fastestLaps = enrichWithDrivers(
    Array.from(fastestByDriver.values()).sort(
      (a, b) => Number(a.lap_duration) - Number(b.lap_duration)
    ),
    driverByNumber
  );

  const recentLaps = enrichWithDrivers(
    lapsRaw
      .slice()
      .sort(
        (a, b) =>
          new Date(b.date_start || b.date || 0) -
          new Date(a.date_start || a.date || 0)
      )
      .slice(0, 25),
    driverByNumber
  );

  const teamRadio = enrichWithDrivers(
    teamRadioRaw
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 15),
    driverByNumber
  );

  const carData = enrichWithDrivers(latestPerDriver(carDataRaw), driverByNumber);

  const analysis = {
    updatedAt: new Date().toISOString(),
    sessionKey: effectiveKey,
    session,
    status,
    source: "rest",
    intervals,
    raceControl,
    pitStops,
    stints,
    weather,
    overtakes,
    startingGrid,
    sessionResult,
    fastestLaps,
    recentLaps,
    teamRadio,
    carData,
    available: {
      intervals: intervals.length > 0,
      raceControl: raceControl.length > 0,
      pitStops: pitStops.length > 0,
      stints: stints.length > 0,
      weather: !!weather,
      overtakes: overtakes.length > 0,
      startingGrid: startingGrid.length > 0,
      sessionResult: sessionResult.length > 0,
      laps: fastestLaps.length > 0 || recentLaps.length > 0,
      teamRadio: teamRadio.length > 0,
      carData: carData.length > 0
    }
  };

  cachedLiveAnalysis = analysis;
  cachedLiveAnalysisAt = now;
  cachedLiveAnalysisKey = sessionKey;
  return analysis;
}

const LIVE_OPENF1_RESOURCES = {
  intervals: "/intervals",
  laps: "/laps",
  pit: "/pit",
  stints: "/stints",
  race_control: "/race_control",
  weather: "/weather",
  overtakes: "/overtakes",
  starting_grid: "/starting_grid",
  session_result: "/session_result",
  team_radio: "/team_radio",
  car_data: "/car_data",
  position: "/position",
  location: "/location"
};

async function loadLiveOpenF1Resource(resource, sessionKey, query = {}) {
  const basePath = LIVE_OPENF1_RESOURCES[resource];
  if (!basePath) {
    throw new Error(`Unknown live resource: ${resource}`);
  }

  const { session, status } = await loadLiveSession(sessionKey);
  const effectiveKey = session?.session_key || sessionKey;
  const params = new URLSearchParams({
    session_key: String(effectiveKey),
    ...query
  });

  if (resource === "location" && status !== "live") {
    return { sessionKey: effectiveKey, status, rows: [] };
  }

  if (resource === "car_data" && status === "live" && !query.date) {
    params.set("date>", new Date(Date.now() - 5000).toISOString());
  }

  const rows = await fetchOpenF1Json(`${basePath}?${params.toString()}`);
  return { sessionKey: effectiveKey, status, rows };
}

app.get("/api/metadata", async (req, res) => {
  try {
    const db = readBetsFile();
    const [sessions, allSessionsRaw, meetings] = await Promise.all([
      loadSessions(),
      loadAllSessions(),
      loadMeetings()
    ]);
    const { drivers, teams } = await loadDrivers();

    const meetingByKey = new Map(meetings.map((m) => [m.meeting_key, m]));
    const enrichSession = (s) => {
      const meeting = meetingByKey.get(s.meeting_key);
      return {
        ...s,
        meeting_name: meeting?.meeting_name || s.meeting_name,
        circuit_image: meeting?.circuit_image || null
      };
    };

    const enrichedSessions = sessions.map(enrichSession);
    const allSessions = allSessionsRaw.map(enrichSession);

    const seasonLocked = isSeasonLocked(sessions);

    res.json({
      seasonYear: SEASON_YEAR,
      users: db.users,
      sessions: enrichedSessions,
      allSessions,
      drivers,
      teams,
      seasonLocked,
      seasonOverrideOpen: !!db.settings?.seasonOverrideOpen
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load metadata" });
  }
});

app.post("/api/settings/season-override", (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }

  const db = readBetsFile();
  db.settings = db.settings || { seasonOverrideOpen: false };
  db.settings.seasonOverrideOpen = enabled;
  writeBetsFile(db);

  res.json({ seasonOverrideOpen: db.settings.seasonOverrideOpen });
});

app.get("/api/standings", async (req, res) => {
  try {
    const standings = await loadStandings();
    res.json({
      seasonYear: SEASON_YEAR,
      ...standings
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load standings" });
  }
});

app.get("/api/race/standings", async (req, res) => {
  try {
    const db = readBetsFile();
    const standings = await loadRaceStandings(db);
    res.json({
      seasonYear: SEASON_YEAR,
      updatedAt: standings.updatedAt,
      races: standings.races,
      leaderboard: standings.leaderboard
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load race standings" });
  }
});

app.get("/api/race/settlement/:sessionKey", async (req, res) => {
  const { sessionKey } = req.params;
  const db = readBetsFile();
  const pot = Number(db.settings?.racePot) || 0;
  const settlements = db.settings?.raceSettlements || {};

  try {
    const results = await loadSessionResult(sessionKey);
    if (!results || results.length < 3) {
      return res.json({
        status: "pending",
        sessionKey,
        pot
      });
    }

    const top3 = results.slice(0, 3).map((r) => Number(r.driver_number));
    const raceBets = db.raceBets.filter(
      (b) =>
        b.seasonYear === SEASON_YEAR &&
        String(b.session_key) === String(sessionKey)
    );

    const winners = raceBets.filter(
      (b) =>
        Number(b.p1_driver_number) === top3[0] &&
        Number(b.p2_driver_number) === top3[1] &&
        Number(b.p3_driver_number) === top3[2]
    );

    const totalBets = raceBets.length;
    const basePayoutTotal = totalBets * 50;
    const payoutTotal =
      winners.length > 0 ? basePayoutTotal + pot : basePayoutTotal;
    const payoutPerWinner =
      winners.length > 0 ? payoutTotal / winners.length : 0;

    if (!settlements[sessionKey]) {
      const potDelta = winners.length === 0 ? payoutTotal : -pot;
      db.settings.racePot = Math.max(
        0,
        (Number(db.settings.racePot) || 0) + potDelta
      );
      db.settings.raceSettlements[sessionKey] = {
        sessionKey,
        result: top3,
        winners: winners.map((w) => w.userId),
        totalBets,
        payoutTotal,
        payoutPerWinner,
        potUsed: winners.length > 0 ? pot : 0,
        potDelta,
        settledAt: new Date().toISOString()
      };
      writeBetsFile(db);
    }

    const settlement = db.settings.raceSettlements[sessionKey];
    return res.json({
      status: "settled",
      sessionKey,
      pot: db.settings.racePot,
      settlement
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to settle race bets" });
  }
});

app.get("/api/bets/season/:userId", (req, res) => {
  const { userId } = req.params;
  const db = readBetsFile();
  const bet = db.seasonBets.find(
    (b) => b.userId === userId && b.seasonYear === SEASON_YEAR
  );
  res.json(bet || null);
});

app.post("/api/bets/season/:userId", async (req, res) => {
  const { userId } = req.params;
  const body = req.body;
  const db = readBetsFile();
  const now = new Date().toISOString();
  const seasonOverrideOpen = !!db.settings?.seasonOverrideOpen;

  try {
    const sessions = await loadSessions();
    if (isSeasonLocked(sessions) && !seasonOverrideOpen) {
      return res.status(400).json({
        error: "Season bets are locked because the season has started.",
        seasonLocked: true,
        seasonOverrideOpen
      });
    }
  } catch (err) {
    console.error("Failed to evaluate season lock state:", err);
  }

  let bet = db.seasonBets.find(
    (b) => b.userId === userId && b.seasonYear === SEASON_YEAR
  );

  if (!bet) {
    bet = {
      userId,
      seasonYear: SEASON_YEAR,
      driverPredictions: body.driverPredictions || [],
      teamPredictions: body.teamPredictions || [],
      createdAt: now,
      updatedAt: now
    };
    db.seasonBets.push(bet);
  } else {
    bet.driverPredictions = body.driverPredictions || [];
    bet.teamPredictions = body.teamPredictions || [];
    bet.updatedAt = now;
  }

  writeBetsFile(db);
  res.json(bet);
});

// Hantera användare (lägga till/ta bort bettare)
app.post("/api/users", (req, res) => {
  const { id, name } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  const db = readBetsFile();

  let userId = (id || name).trim().toLowerCase();
  userId = userId
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

  if (!userId) {
    return res.status(400).json({ error: "Could not derive a valid id" });
  }

  if (db.users.some((u) => u.id === userId)) {
    return res.status(409).json({ error: "User with this id already exists" });
  }

  const user = { id: userId, name: name.trim() };
  db.users.push(user);
  writeBetsFile(db);

  res.status(201).json(user);
});

app.delete("/api/users/:userId", (req, res) => {
  const { userId } = req.params;
  const db = readBetsFile();

  const existing = db.users.find((u) => u.id === userId);
  if (!existing) {
    return res.status(404).json({ error: "User not found" });
  }

  db.users = db.users.filter((u) => u.id !== userId);
  db.seasonBets = db.seasonBets.filter((b) => b.userId !== userId);
  db.raceBets = db.raceBets.filter((b) => b.userId !== userId);

  writeBetsFile(db);
  res.json({ ok: true });
});

// Sammanställning av alla bets (med dolda racebett före racestart)
app.get("/api/bets/summary", async (req, res) => {
  const viewerId = req.query.userId;

  try {
    const db = readBetsFile();
    const sessions = await loadSessions();

    const sessionsByKey = new Map(
      sessions.map((s) => [String(s.session_key), s])
    );

    const now = new Date();

    const raceBets = db.raceBets.map((bet) => {
      const session = sessionsByKey.get(String(bet.session_key));
      const rawDate = session?.date_start || session?.session_start_utc;
      const raceStart = rawDate ? new Date(rawDate) : null;
      const raceStarted = raceStart ? now >= raceStart : false;

      if (!viewerId || viewerId === bet.userId || raceStarted) {
        return { ...bet, hidden: false };
      }

      return {
        ...bet,
        p1_driver_number: null,
        p2_driver_number: null,
        p3_driver_number: null,
        hidden: true
      };
    });

    res.json({
      seasonYear: SEASON_YEAR,
      users: db.users,
      seasonBets: db.seasonBets,
      raceBets
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build summary" });
  }
});

app.get("/api/bets/race/:sessionKey/:userId", (req, res) => {
  const { sessionKey, userId } = req.params;
  const db = readBetsFile();
  const bet = db.raceBets.find(
    (b) =>
      b.userId === userId &&
      b.seasonYear === SEASON_YEAR &&
      String(b.session_key) === String(sessionKey)
  );
  res.json(bet || null);
});

app.post("/api/bets/race/:sessionKey/:userId", (req, res) => {
  const { sessionKey, userId } = req.params;
  const body = req.body;
  const db = readBetsFile();
  const now = new Date().toISOString();

  let bet = db.raceBets.find(
    (b) =>
      b.userId === userId &&
      b.seasonYear === SEASON_YEAR &&
      String(b.session_key) === String(sessionKey)
  );

  if (!bet) {
    bet = {
      userId,
      seasonYear: SEASON_YEAR,
      session_key: Number(sessionKey),
      raceName: body.raceName || "",
      p1_driver_number: body.p1_driver_number || null,
      p2_driver_number: body.p2_driver_number || null,
      p3_driver_number: body.p3_driver_number || null,
      createdAt: now,
      updatedAt: now
    };
    db.raceBets.push(bet);
  } else {
    bet.p1_driver_number = body.p1_driver_number || null;
    bet.p2_driver_number = body.p2_driver_number || null;
    bet.p3_driver_number = body.p3_driver_number || null;
    bet.raceName = body.raceName || bet.raceName;
    bet.updatedAt = now;
  }

  writeBetsFile(db);
  res.json(bet);
});

app.get("/api/live", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const bundle = await loadLiveBundle(sessionKey);
    res.json(bundle);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load live data" });
  }
});

app.get("/api/live/session", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const { session, status } = await loadLiveSession(sessionKey);
    res.json({
      sessionKey: session?.session_key || sessionKey,
      session,
      status,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load live session" });
  }
});

app.get("/api/live/positions", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const { session } = await loadLiveSession(sessionKey);
    const effectiveKey = session?.session_key || sessionKey;
    const positions = await loadLivePositions(effectiveKey);
    const drivers = await fetchOpenF1Json(
      `/drivers?session_key=${encodeURIComponent(effectiveKey)}`
    );
    const driverByNumber = buildDriverMap(drivers);
    res.json({
      sessionKey: effectiveKey,
      updatedAt: new Date().toISOString(),
      positions: positions.map((p) => ({
        driver_number: p.driver_number,
        position: p.position,
        date: p.date,
        driver: driverLookup(driverByNumber, p.driver_number)
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load live positions" });
  }
});

app.get("/api/live/locations", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const { session, status } = await loadLiveSession(sessionKey);
    const effectiveKey = session?.session_key || sessionKey;
    const locations = await loadLiveLocations(effectiveKey, status);
    res.json({
      sessionKey: effectiveKey,
      status,
      updatedAt: new Date().toISOString(),
      trackMapAvailable: status === "live" && locations.length > 0,
      locations
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load live locations" });
  }
});

app.get("/api/live/analysis", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const analysis = await loadLiveAnalysis(sessionKey);
    res.json(analysis);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load live analysis" });
  }
});

app.get("/api/live/mqtt/status", (req, res) => {
  res.json({
    updatedAt: new Date().toISOString(),
    ...openF1Mqtt.getStatus()
  });
});

app.get("/api/live/replay/timeline", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    let resolvedKey = sessionKey;
    if (sessionKey === "latest") {
      const latestSession = await loadLiveSession("latest");
      if (latestSession.session) {
        resolvedKey = latestSession.session.session_key;
      } else {
        resolvedKey = await getLatestRaceSessionKey();
      }
    }
    const timeline = await getReplayTimeline(resolvedKey);
    res.json(timeline);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load replay timeline" });
  }
});

app.get("/api/live/replay/cache/status", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    if (!sessionKey || sessionKey === "latest") {
      return res.status(400).json({ error: "session_key required" });
    }
    res.json(getSessionCacheStatus(sessionKey));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read cache status" });
  }
});

app.get("/api/live/replay/cache/build/progress", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    if (!sessionKey || sessionKey === "latest") {
      return res.status(400).json({ error: "session_key required" });
    }
    res.json(getSessionCacheStatus(sessionKey));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read cache build progress" });
  }
});

app.post("/api/live/replay/cache/build", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    if (!sessionKey || sessionKey === "latest") {
      return res.status(400).json({ error: "session_key required" });
    }
    const { session } = await loadLiveSession(sessionKey);
    if (deriveSessionStatus(session) !== "finished") {
      return res.status(400).json({ error: "Cache build only supported for finished sessions" });
    }
    const key = String(session?.session_key || sessionKey);
    if (isSessionCacheComplete(key)) {
      return res.json(getSessionCacheStatus(key));
    }
    ensureSessionCacheBuilding(key, session);
    res.status(202).json(getSessionCacheStatus(key));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to build session cache" });
  }
});

app.get("/api/live/replay/cache/sync", async (req, res) => {
  res.json({
    inProgress: !!cacheSyncInFlight,
    intervalMs: CACHE_SYNC_INTERVAL_MS,
    cacheDir: cacheRoot,
    last: lastCacheSyncResult
  });
});

app.post("/api/live/replay/cache/sync", async (req, res) => {
  try {
    if (cacheSyncInFlight) {
      return res.status(409).json({
        error: "Sync already in progress",
        last: lastCacheSyncResult
      });
    }
    const query = { ...req.query, ...(req.body || {}) };
    const all = query.all === "1" || query.all === true || query.all === "true";
    const racesOnly = !(query.races_only === "0" || query.racesOnly === false || query.races_only === false);
    const limitRaw = query.limit;
    const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
    const syncOptions = {
      manual: true,
      all: all || query.unlimited === "1" || query.unlimited === true,
      racesOnly,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
    };
    cacheSyncInFlight = syncSessionCaches(syncOptions).finally(() => {
      cacheSyncInFlight = null;
    });
    const result = await cacheSyncInFlight;
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to sync session caches" });
  }
});

app.get("/api/live/replay/locations-index", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    if (!sessionKey || sessionKey === "latest") {
      return res.status(400).json({ error: "session_key required" });
    }
    if (!isSessionCacheComplete(String(sessionKey))) {
      return res.status(404).json({ error: "Session cache not ready" });
    }
    const index = buildLocationsIndex(sessionKey);
    if (!index) {
      return res.status(404).json({ error: "No location data in cache" });
    }
    res.json(index);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to load locations index" });
  }
});

app.get("/api/live/team-radio/list", async (req, res) => {
  try {
    let sessionKey = resolveSessionKeyParam(req.query.session_key);
    if (!sessionKey || sessionKey === "latest") {
      const latestSession = await loadLiveSession("latest");
      sessionKey = latestSession.session?.session_key;
      if (!sessionKey) {
        sessionKey = await getLatestRaceSessionKey();
      }
    }
    if (!sessionKey) {
      return res.status(404).json({ error: "No session found" });
    }
    const payload = await buildTeamRadioList(sessionKey);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to load team radio list" });
  }
});

app.get("/api/live/team-radio/proxy", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl || typeof rawUrl !== "string") {
      return res.status(400).json({ error: "url query parameter required" });
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: "Invalid url" });
    }
    if (parsed.protocol !== "https:" || !TEAM_RADIO_PROXY_HOSTS.has(parsed.hostname)) {
      return res.status(403).json({ error: "Host not allowed" });
    }

    const upstream = await fetch(parsed.toString(), {
      headers: TEAM_RADIO_UPSTREAM_HEADERS,
      redirect: "follow"
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream HTTP ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") || "audio/mpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (upstream.body) {
      upstream.body.on("error", (streamErr) => {
        console.error("[team-radio/proxy] stream error:", streamErr);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream team radio audio" });
        } else {
          res.end();
        }
      });
      upstream.body.pipe(res);
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to proxy team radio audio" });
  }
});

app.get("/api/live/replay/frame", async (req, res) => {
  try {
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const at = req.query.at;
    if (!at) {
      return res.status(400).json({ error: "Missing at query parameter (ISO8601 timestamp)" });
    }
    parseReplayAt(at);

    let effectiveKey = sessionKey;
    if (sessionKey === "latest") {
      const latestSession = await loadLiveSession("latest");
      if (latestSession.session) {
        effectiveKey = latestSession.session.session_key;
      } else {
        effectiveKey = await getLatestRaceSessionKey();
      }
    }
    if (!effectiveKey) {
      return res.status(404).json({ error: "No session found for replay" });
    }
    const frame = await loadReplayFrame(effectiveKey, at);
    res.json(frame);
  } catch (err) {
    console.error(err);
    const status = err.message?.includes("Invalid at") ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to load replay frame" });
  }
});

app.get("/api/live/openf1/:resource", async (req, res) => {
  try {
    const { resource } = req.params;
    const sessionKey = resolveSessionKeyParam(req.query.session_key);
    const query = { ...req.query };
    delete query.session_key;
    const payload = await loadLiveOpenF1Resource(resource, sessionKey, query);
    res.json({
      resource,
      updatedAt: new Date().toISOString(),
      ...payload
    });
  } catch (err) {
    console.error(err);
    const status = err.message?.includes("Unknown live resource") ? 404 : 500;
    res.status(status).json({ error: err.message || "Failed to load OpenF1 data" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Cache directory: ${sessionCacheDir}`);
  if (betsFileName !== "bets.json") {
    console.log(`Using bets file: ${betsFileName}`);
  }
  startCacheSyncScheduler();
  openF1Mqtt.start();
});

