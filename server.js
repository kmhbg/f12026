const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3000;
const SEASON_YEAR = 2026;

const dataDir = path.join(__dirname, "data");
const betsFile = path.join(dataDir, "bets.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

if (!fs.existsSync(betsFile)) {
  fs.writeFileSync(
    betsFile,
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

const STANDINGS_TTL_MS = 15 * 60 * 1000;
const RACE_STANDINGS_TTL_MS = 10 * 60 * 1000;
const OPENF1_MIN_INTERVAL_MS = 400;

let openF1Queue = Promise.resolve();
let lastOpenF1At = 0;

function openF1Fetch(url) {
  openF1Queue = openF1Queue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, OPENF1_MIN_INTERVAL_MS - (now - lastOpenF1At));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastOpenF1At = Date.now();
    return fetch(url);
  });
  return openF1Queue;
}

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

app.get("/api/metadata", async (req, res) => {
  try {
    const db = readBetsFile();
    const sessions = await loadSessions();
    const meetings = await loadMeetings();
    const { drivers, teams } = await loadDrivers();

    // Enrich sessions with circuit image and meeting name to simplify frontend.
    const meetingByKey = new Map(
      meetings.map((m) => [m.meeting_key, m])
    );
    const enrichedSessions = sessions.map((s) => {
      const meeting = meetingByKey.get(s.meeting_key);
      return {
        ...s,
        meeting_name: meeting?.meeting_name || s.meeting_name,
        circuit_image: meeting?.circuit_image || null
      };
    });

    const seasonLocked = isSeasonLocked(sessions);

    res.json({
      seasonYear: SEASON_YEAR,
      users: db.users,
      sessions: enrichedSessions,
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

