const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { openDatabase } = require("../lib/db");
const { createStore } = require("../lib/store");
const { createAuth } = require("../lib/auth");
const { registerApiRoutes } = require("../routes/api");

const HOUR = 3600e3;

// Startar API:et med en tillfällig databas och en fejkad racekalender:
// 100 = körd (resultat 3-12-44), 200 = kommande, 300 = inställt.
async function startTestApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "f1-test-"));
  const db = openDatabase(dataDir);
  const store = createStore(db);
  const auth = createAuth(store);
  const now = Date.now();
  const sessions = [
    { session_key: 100, date_start: new Date(now - 2 * HOUR).toISOString(), meeting_name: "Past GP", is_cancelled: false },
    { session_key: 200, date_start: new Date(now + 48 * HOUR).toISOString(), meeting_name: "Next GP", is_cancelled: false },
    { session_key: 300, date_start: new Date(now + 96 * HOUR).toISOString(), meeting_name: "Off GP", is_cancelled: true }
  ];
  const drivers = [1, 3, 4, 6, 12, 16, 44, 63].map((n) => ({ driver_number: n }));

  const app = express();
  app.use(express.json());
  app.use(auth.loadUser);
  app.use("/api", auth.requireJsonForWrites);
  registerApiRoutes(app, {
    store,
    auth,
    appName: "Test",
    seasonYear: 2026,
    stake: 50,
    publicUrl: "http://test",
    loadSessions: async () => sessions,
    loadAllSessions: async () => sessions,
    loadMeetings: async () => [],
    loadDrivers: async () => ({ drivers, teams: [] }),
    loadSessionResult: async (key) =>
      String(key) === "100" ? [3, 12, 44].map((n, i) => ({ driver_number: n, position: i + 1 })) : [],
    isSeasonLocked: () => true
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Minimal klient med egen cookie per "webbläsare".
  function client() {
    let cookie = "";
    return async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };
  }

  return {
    base,
    store,
    client,
    close: () => {
      server.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

module.exports = { startTestApp };
