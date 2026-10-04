// API för inloggning, användare, bets, avräkning och ställning.
// Live/replay-delarna finns kvar i server.js.

const crypto = require("crypto");
const {
  createRateLimiter,
  hashPassword,
  verifyPassword,
  validatePassword,
  hashToken,
  slugifyUsername
} = require("../lib/auth");
const { computeSettlements } = require("../lib/settlement");

function registerApiRoutes(app, deps) {
  const {
    store,
    auth,
    seasonYear,
    stake,
    publicUrl,
    loadSessions,
    loadAllSessions,
    loadMeetings,
    loadDrivers,
    loadSessionResult,
    isSeasonLocked
  } = deps;
  const loginLimiter = createRateLimiter();
  const { requireUser, requireAdmin } = auth;

  const raceStart = (s) => new Date(s.date_start || s.session_start_utc).getTime();
  const findSession = async (sessionKey) =>
    (await loadSessions()).find((s) => String(s.session_key) === String(sessionKey)) || null;
  const publicUser = (u) => u && { id: u.id, name: u.name, role: u.role };
  const inviteUrl = (req, token) => `${publicUrl || `${req.protocol}://${req.get("host")}`}/invite.html#${token}`;

  // Topp 3 för körda race. Resultat som en gång hämtats ändras inte och
  // sparas i databasen, så OpenF1 frågas bara om nya race.
  async function loadSeasonRaces() {
    const sessions = await loadSessions();
    const now = Date.now();
    const races = [];
    for (const s of sessions) {
      if (s.is_cancelled || !(raceStart(s) <= now)) continue;
      let top3 = store.getResult(s.session_key);
      if (!top3) {
        const results = await loadSessionResult(s.session_key);
        if (results && results.length >= 3) {
          top3 = results.slice(0, 3).map((r) => Number(r.driver_number));
          store.putResult(s.session_key, top3);
        }
      }
      races.push({
        sessionKey: String(s.session_key),
        raceName: s.meeting_name || s.circuit_short_name || "Race",
        date: s.date_start || s.session_start_utc || null,
        start: raceStart(s),
        top3
      });
    }
    return races;
  }

  async function computeSeason() {
    const races = await loadSeasonRaces();
    const { settlements, pot } = computeSettlements({
      races,
      bets: store.listRaceBets(seasonYear),
      stake,
      legacy: store.listLegacySettlements(),
      potOffset: store.getSetting("pot_offset", 0)
    });
    return { races, settlements, pot };
  }

  // ---------- Inloggning ----------

  app.get("/api/auth/me", (req, res) => {
    const needsSetup = store.countUsers() === 0;
    if (!req.user) return res.status(401).json({ user: null, needsSetup });
    res.json({ user: publicUser(req.user), needsSetup: false });
  });

  // Första start: finns inga användare skapas den första som admin.
  app.post("/api/auth/setup", (req, res) => {
    const { username, name, password } = req.body || {};
    const id = slugifyUsername(username || name);
    const pwError = validatePassword(password);
    if (!id || !name) return res.status(400).json({ error: "Namn och användarnamn krävs" });
    if (pwError) return res.status(400).json({ error: pwError });

    try {
      store.transaction(() => {
        if (store.countUsers() > 0) throw Object.assign(new Error("setup-done"), { status: 409 });
        store.createUser({ id, name: String(name).trim(), role: "admin", passwordHash: hashPassword(password) });
        store.audit(id, "setup", { id });
      });
    } catch (err) {
      if (err.status === 409) return res.status(409).json({ error: "Appen är redan konfigurerad" });
      throw err;
    }
    auth.startSession(req, res, id);
    res.status(201).json({ user: publicUser(store.getUser(id)) });
  });

  app.post("/api/auth/login", (req, res) => {
    const login = String(req.body?.username || "");
    const id = slugifyUsername(login);
    const password = String(req.body?.password || "");
    const key = `${req.ip}|${id}`;
    if (loginLimiter.tooMany(key)) {
      return res.status(429).json({ error: "För många försök, vänta en stund" });
    }
    // Användarnamnet i första hand; visningsnamnet ("Sebastian") fungerar också.
    const user = (id && store.getUser(id)) || store.findUserByName(login);
    if (!user || !verifyPassword(password, user.password_hash)) {
      loginLimiter.fail(key);
      return res.status(401).json({ error: "Fel användarnamn eller lösenord" });
    }
    loginLimiter.reset(key);
    store.purgeSessions();
    auth.startSession(req, res, user.id);
    store.audit(user.id, "login");
    res.json({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  app.post("/api/auth/password", requireUser, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const user = store.getUser(req.user.id);
    if (!verifyPassword(String(currentPassword || ""), user.password_hash)) {
      return res.status(401).json({ error: "Nuvarande lösenord stämmer inte" });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });
    store.transaction(() => {
      store.setPassword(user.id, hashPassword(newPassword));
      store.deleteUserSessions(user.id);
      store.audit(user.id, "password-changed");
    });
    auth.startSession(req, res, user.id);
    res.json({ ok: true });
  });

  // Engångslänk från admin: sätt lösenord och logga in.
  app.get("/api/auth/invite/:token", (req, res) => {
    const user = store.inviteUser(hashToken(req.params.token));
    if (!user) return res.status(404).json({ error: "Länken är ogiltig eller har gått ut" });
    res.json({ user: publicUser(user) });
  });

  app.post("/api/auth/invite/:token", (req, res) => {
    const tokenHash = hashToken(req.params.token);
    const user = store.inviteUser(tokenHash);
    if (!user) return res.status(404).json({ error: "Länken är ogiltig eller har gått ut" });
    const pwError = validatePassword(req.body?.password);
    if (pwError) return res.status(400).json({ error: pwError });
    store.transaction(() => {
      store.setPassword(user.id, hashPassword(req.body.password));
      store.deleteInvite(tokenHash);
      store.deleteUserSessions(user.id);
      store.audit(user.id, "invite-accepted");
    });
    auth.startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  });

  // ---------- Användare (admin) ----------

  app.get("/api/users", requireAdmin, (req, res) => {
    res.json(store.listUsers());
  });

  app.post("/api/users", requireAdmin, (req, res) => {
    const name = String(req.body?.name || "").trim();
    const id = slugifyUsername(req.body?.username || name);
    const role = req.body?.role === "admin" ? "admin" : "member";
    if (!name || !id) return res.status(400).json({ error: "Namn krävs" });
    if (store.getUser(id)) return res.status(409).json({ error: "Användarnamnet finns redan" });

    let token;
    store.transaction(() => {
      store.createUser({ id, name, role });
      token = auth.createInvite(id, req.user.id);
      store.audit(req.user.id, "user-created", { id, role });
    });
    res.status(201).json({ id, name, role, inviteUrl: inviteUrl(req, token) });
  });

  // Ny engångslänk, t.ex. när någon glömt sitt lösenord.
  app.post("/api/users/:userId/invite", requireAdmin, (req, res) => {
    const user = store.getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const token = auth.createInvite(user.id, req.user.id);
    store.audit(req.user.id, "invite-created", { id: user.id });
    res.json({ inviteUrl: inviteUrl(req, token) });
  });

  app.delete("/api/users/:userId", requireAdmin, (req, res) => {
    const { userId } = req.params;
    if (userId === req.user.id) return res.status(400).json({ error: "Du kan inte ta bort dig själv" });
    const deleted = store.transaction(() => {
      const ok = store.deleteUser(userId);
      if (ok) store.audit(req.user.id, "user-deleted", { id: userId });
      return ok;
    });
    if (!deleted) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
  });

  app.get("/api/audit", requireAdmin, (req, res) => {
    res.json(store.listAudit(Math.min(Number(req.query.limit) || 100, 500)));
  });

  // ---------- Metadata och inställningar ----------

  app.get("/api/metadata", requireUser, async (req, res) => {
    try {
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

      res.json({
        seasonYear,
        appName: deps.appName,
        currentUser: publicUser(req.user),
        users: store.listUsers().map(({ id, name }) => ({ id, name })),
        sessions: sessions.map(enrichSession),
        allSessions: allSessionsRaw.map(enrichSession),
        drivers,
        teams,
        seasonLocked: isSeasonLocked(sessions),
        seasonOverrideOpen: Boolean(store.getSetting("season_override_open", false))
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load metadata" });
    }
  });

  app.post("/api/settings/season-override", requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    store.transaction(() => {
      store.putSetting("season_override_open", enabled);
      store.audit(req.user.id, "season-override", { enabled });
    });
    res.json({ seasonOverrideOpen: enabled });
  });

  // ---------- Säsongsbets ----------

  // Bara egna bets, utom för admin.
  const canActFor = (req, userId) => req.user.id === userId || req.user.role === "admin";

  app.get("/api/bets/season/:userId", requireUser, async (req, res) => {
    const { userId } = req.params;
    if (!canActFor(req, userId)) {
      const sessions = await loadSessions();
      if (!isSeasonLocked(sessions)) return res.status(403).json({ error: "Andras säsongsbets är dolda före start" });
    }
    res.json(store.getSeasonBet(userId, seasonYear));
  });

  app.post("/api/bets/season/:userId", requireUser, async (req, res) => {
    const { userId } = req.params;
    if (!canActFor(req, userId)) return res.status(403).json({ error: "Du kan bara ändra dina egna bets" });
    if (!store.getUser(userId)) return res.status(404).json({ error: "Okänd användare" });

    const seasonOverrideOpen = Boolean(store.getSetting("season_override_open", false));
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
      return res.status(503).json({ error: "Kunde inte hämta racekalendern, försök igen" });
    }

    const body = req.body || {};
    const bet = store.transaction(() => {
      const saved = store.saveSeasonBet(userId, seasonYear, body.driverPredictions, body.teamPredictions);
      store.audit(req.user.id, "season-bet", { userId });
      return saved;
    });
    res.json(bet);
  });

  // ---------- Racebets ----------

  app.get("/api/bets/summary", requireUser, async (req, res) => {
    try {
      const sessions = await loadSessions();
      const startByKey = new Map(sessions.map((s) => [String(s.session_key), raceStart(s)]));
      const now = Date.now();

      // Andras racebets visas först när racet startat.
      const raceBets = store.listRaceBets(seasonYear).map((bet) => {
        const started = (startByKey.get(String(bet.session_key)) ?? Infinity) <= now;
        if (bet.userId === req.user.id || started) return { ...bet, hidden: false };
        return { ...bet, p1_driver_number: null, p2_driver_number: null, p3_driver_number: null, hidden: true };
      });
      const seasonStarted = isSeasonLocked(sessions);
      const seasonBets = store
        .listSeasonBets(seasonYear)
        .filter((b) => seasonStarted || b.userId === req.user.id);

      res.json({
        seasonYear,
        users: store.listUsers().map(({ id, name }) => ({ id, name })),
        seasonBets,
        raceBets
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to build summary" });
    }
  });

  app.get("/api/bets/race/:sessionKey/:userId", requireUser, async (req, res) => {
    const { sessionKey, userId } = req.params;
    const bet = store.getRaceBet(userId, seasonYear, sessionKey);
    if (bet && !canActFor(req, userId)) {
      const session = await findSession(sessionKey);
      if (!session || raceStart(session) > Date.now()) {
        return res.json({ ...bet, p1_driver_number: null, p2_driver_number: null, p3_driver_number: null, hidden: true });
      }
    }
    res.json(bet);
  });

  async function validateRaceBet(sessionKey, body, drivers) {
    const session = await findSession(sessionKey);
    if (!session || session.is_cancelled) return { error: [404, "Okänt eller inställt race"] };
    const picks = [body.p1_driver_number, body.p2_driver_number, body.p3_driver_number].map(Number);
    if (picks.some((n) => !Number.isInteger(n) || n <= 0) || new Set(picks).size !== 3) {
      return { error: [400, "Tre olika förarnummer krävs"] };
    }
    if (drivers && drivers.length) {
      const known = new Set(drivers.map((d) => Number(d.driver_number)));
      if (picks.some((n) => !known.has(n))) return { error: [400, "Okänd förare"] };
    }
    return { session, picks };
  }

  app.post("/api/bets/race/:sessionKey/:userId", requireUser, async (req, res) => {
    const { sessionKey, userId } = req.params;
    if (!canActFor(req, userId)) return res.status(403).json({ error: "Du kan bara lägga dina egna bets" });
    if (!store.getUser(userId)) return res.status(404).json({ error: "Okänd användare" });

    let checked;
    try {
      const { drivers } = await loadDrivers();
      checked = await validateRaceBet(sessionKey, req.body || {}, drivers);
    } catch (err) {
      console.error(err);
      return res.status(503).json({ error: "Kunde inte hämta racekalendern, försök igen" });
    }
    if (checked.error) return res.status(checked.error[0]).json({ error: checked.error[1] });
    if (!(Date.now() < raceStart(checked.session))) {
      return res.status(403).json({ error: "Racet har redan startat – bettet är låst" });
    }

    const { bet } = store.transaction(() => {
      const result = store.saveRaceBet({
        userId,
        seasonYear,
        sessionKey,
        raceName: checked.session.meeting_name || checked.session.circuit_short_name || "",
        p1: checked.picks[0],
        p2: checked.picks[1],
        p3: checked.picks[2],
        source: "app"
      });
      store.audit(req.user.id, "race-bet", { userId, sessionKey: Number(sessionKey) });
      return result;
    });
    res.json(bet);
  });

  // Import av bets lagda någon annanstans (t.ex. WhatsApp via n8n). Kräver
  // F1_IMPORT_TOKEN, skriver aldrig över befintliga bets. Sena bets kräver
  // allowLate: true och markeras då med lateOverride.
  function hasValidImportToken(req) {
    const expected = process.env.F1_IMPORT_TOKEN || "";
    const given = String(req.get("X-Import-Token") || "");
    if (!expected || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  app.post("/api/bets/race/:sessionKey/:userId/import", async (req, res) => {
    if (!process.env.F1_IMPORT_TOKEN) return res.status(503).json({ error: "Import är inte aktiverad" });
    if (!hasValidImportToken(req)) return res.status(401).json({ error: "Ogiltig import-token" });

    const { sessionKey, userId } = req.params;
    const body = req.body || {};
    if (!store.getUser(userId)) return res.status(404).json({ error: "Okänd användare" });

    let checked;
    try {
      checked = await validateRaceBet(sessionKey, body, null);
    } catch (err) {
      console.error(err);
      return res.status(503).json({ error: "Kunde inte hämta racekalendern, försök igen" });
    }
    if (checked.error) return res.status(checked.error[0]).json({ error: checked.error[1] });

    const placedAt = new Date(body.placedAt);
    if (Number.isNaN(placedAt.getTime())) return res.status(400).json({ error: "placedAt saknas eller är ogiltig" });
    const late = !(placedAt.getTime() < raceStart(checked.session));
    if (late && body.allowLate !== true) return res.status(403).json({ error: "Bettet lades efter planerad start" });

    const result = store.transaction(() => {
      const saved = store.saveRaceBet(
        {
          userId,
          seasonYear,
          sessionKey,
          raceName: checked.session.meeting_name || checked.session.circuit_short_name || "",
          p1: checked.picks[0],
          p2: checked.picks[1],
          p3: checked.picks[2],
          source: String(body.source || "import"),
          sourceMessageId: body.sourceMessageId ? String(body.sourceMessageId) : null,
          placedAt: placedAt.toISOString(),
          lateOverride: late
        },
        { overwrite: false }
      );
      if (saved.created) store.audit(null, "race-bet-import", { userId, sessionKey: Number(sessionKey), late });
      return saved;
    });
    if (!result.created) return res.status(200).json({ status: "exists", bet: result.bet });
    res.status(201).json({ status: "created", bet: result.bet });
  });

  // ---------- Avräkning och ställning ----------

  app.get("/api/race/settlement/:sessionKey", requireUser, async (req, res) => {
    try {
      const { settlements, pot } = await computeSeason();
      const settlement = settlements.get(String(req.params.sessionKey));
      if (!settlement) return res.json({ status: "pending", sessionKey: req.params.sessionKey, pot });
      res.json({ status: "settled", sessionKey: req.params.sessionKey, pot, settlement });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to settle race bets" });
    }
  });

  app.get("/api/race/standings", requireUser, async (req, res) => {
    try {
      const { races, settlements, pot } = await computeSeason();
      const users = store.listUsers();
      const done = races
        .filter((r) => r.top3)
        .map((r) => {
          const s = settlements.get(r.sessionKey);
          return {
            sessionKey: r.sessionKey,
            raceName: r.raceName,
            date: r.date,
            resultTop3: r.top3,
            winners: s?.winners || [],
            totalBets: s?.totalBets || 0
          };
        });

      const leaderboard = users
        .map((u) => {
          const wins = done
            .filter((r) => r.winners.includes(u.id))
            .map((r) => ({ sessionKey: r.sessionKey, raceName: r.raceName, date: r.date }));
          return { userId: u.id, name: u.name, points: wins.length, wins };
        })
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

      res.json({ seasonYear, updatedAt: Date.now(), races: done, leaderboard, pot });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load race standings" });
    }
  });
}

module.exports = { registerApiRoutes };
