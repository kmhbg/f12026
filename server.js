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
        raceBets: []
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

async function loadSessions() {
  if (cachedSessions) return cachedSessions;
  // Hämta alla races för säsongen
  const url = `https://api.openf1.org/v1/sessions?year=${SEASON_YEAR}&session_name=Race`;
  const res = await fetch(url);
  const data = await res.json();

  // Säkerställ att vi alltid får en array
  if (!Array.isArray(data)) {
    console.error("Unexpected sessions response from OpenF1:", data);
    cachedSessions = [];
  } else {
    cachedSessions = data;
  }

  return cachedSessions;
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

  const url = `https://api.openf1.org/v1/meetings?year=${SEASON_YEAR}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!Array.isArray(data)) {
    console.error("Unexpected meetings response from OpenF1:", data);
    cachedMeetings = [];
  } else {
    cachedMeetings = data;
  }

  return cachedMeetings;
}

async function loadDrivers() {
  if (cachedDrivers && cachedTeams) return { drivers: cachedDrivers, teams: cachedTeams };

  // Hämta aktuell gridd via senaste tillgängliga sessionen.
  // OpenF1 har ännu inga förare knutna till 2026-racen, men "latest"
  // ger oss senaste kända startfält (vilket är tillräckligt för vårt spel).
  const url = `https://api.openf1.org/v1/drivers?session_key=latest`;
  const res = await fetch(url);
  const drivers = await res.json();

  if (!Array.isArray(drivers)) {
    console.error("Unexpected drivers response from OpenF1:", drivers);
    cachedDrivers = [];
    cachedTeams = [];
  } else {
    cachedDrivers = drivers;

    const teamSet = new Set();
    drivers.forEach((d) => {
      if (d.team_name) teamSet.add(d.team_name);
    });
    cachedTeams = Array.from(teamSet);
  }

  return { drivers: cachedDrivers, teams: cachedTeams };
}

function readBetsFile() {
  const raw = fs.readFileSync(betsFile, "utf-8");
  return JSON.parse(raw);
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
      seasonLocked
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load metadata" });
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

  try {
    const sessions = await loadSessions();
    if (isSeasonLocked(sessions)) {
      return res.status(400).json({
        error: "Season bets are locked because the season has started.",
        seasonLocked: true
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

