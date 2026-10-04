// Dataåtkomst för användare, bets, inställningar och revisionslogg.
// Returnerar samma objektform som den gamla bets.json-lagringen, så att
// frontend och API-svar kan vara oförändrade.

const nowIso = () => new Date().toISOString();

function createStore(db) {
  const q = {
    listUsers: db.prepare("SELECT id, name, role, password_hash IS NOT NULL AS has_password FROM users ORDER BY name COLLATE NOCASE"),
    getUser: db.prepare("SELECT id, name, role, password_hash FROM users WHERE id = ?"),
    usersByName: db.prepare("SELECT id, name, role, password_hash FROM users WHERE name = ? COLLATE NOCASE"),
    countUsers: db.prepare("SELECT COUNT(*) FROM users").pluck(),
    countAdmins: db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin'").pluck(),
    insertUser: db.prepare("INSERT INTO users (id, name, role, password_hash) VALUES (@id, @name, @role, @password_hash)"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
    setRole: db.prepare("UPDATE users SET role = ? WHERE id = ?"),

    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    sessionUser: db.prepare(
      `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    ),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),

    insertInvite: db.prepare("INSERT INTO invites (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)"),
    inviteUser: db.prepare(
      `SELECT u.id, u.name, u.role FROM invites i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = ? AND i.expires_at > ?`
    ),
    deleteInvite: db.prepare("DELETE FROM invites WHERE token_hash = ?"),
    deleteUserInvites: db.prepare("DELETE FROM invites WHERE user_id = ?"),

    getSeasonBet: db.prepare("SELECT * FROM season_bets WHERE user_id = ? AND season_year = ?"),
    listSeasonBets: db.prepare("SELECT * FROM season_bets WHERE season_year = ?"),
    upsertSeasonBet: db.prepare(
      `INSERT INTO season_bets (user_id, season_year, driver_predictions, team_predictions, created_at, updated_at)
       VALUES (@user_id, @season_year, @driver_predictions, @team_predictions, @now, @now)
       ON CONFLICT (user_id, season_year) DO UPDATE SET
         driver_predictions = excluded.driver_predictions,
         team_predictions = excluded.team_predictions,
         updated_at = excluded.updated_at`
    ),

    getRaceBet: db.prepare("SELECT * FROM race_bets WHERE user_id = ? AND season_year = ? AND session_key = ?"),
    listRaceBets: db.prepare("SELECT * FROM race_bets WHERE season_year = ? ORDER BY session_key, user_id"),
    upsertRaceBet: db.prepare(
      `INSERT INTO race_bets (user_id, season_year, session_key, race_name, p1_driver_number, p2_driver_number,
                              p3_driver_number, source, source_message_id, placed_at, late_override, created_at, updated_at)
       VALUES (@user_id, @season_year, @session_key, @race_name, @p1, @p2, @p3, @source, @source_message_id,
               @placed_at, @late_override, @now, @now)
       ON CONFLICT (user_id, season_year, session_key) DO UPDATE SET
         race_name = CASE WHEN excluded.race_name <> '' THEN excluded.race_name ELSE race_bets.race_name END,
         p1_driver_number = excluded.p1_driver_number,
         p2_driver_number = excluded.p2_driver_number,
         p3_driver_number = excluded.p3_driver_number,
         placed_at = excluded.placed_at,
         updated_at = excluded.updated_at`
    ),
    insertRaceBetIfMissing: db.prepare(
      `INSERT INTO race_bets (user_id, season_year, session_key, race_name, p1_driver_number, p2_driver_number,
                              p3_driver_number, source, source_message_id, placed_at, late_override, created_at, updated_at)
       VALUES (@user_id, @season_year, @session_key, @race_name, @p1, @p2, @p3, @source, @source_message_id,
               @placed_at, @late_override, @now, @now)
       ON CONFLICT (user_id, season_year, session_key) DO NOTHING`
    ),

    getResult: db.prepare("SELECT top3 FROM race_results WHERE session_key = ?").pluck(),
    putResult: db.prepare("INSERT OR REPLACE INTO race_results (session_key, top3) VALUES (?, ?)"),
    listLegacySettlements: db.prepare("SELECT session_key, data FROM legacy_settlements"),
    putLegacySettlement: db.prepare("INSERT OR REPLACE INTO legacy_settlements (session_key, data) VALUES (?, ?)"),

    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?").pluck(),
    putSetting: db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"),

    listCache: db.prepare("SELECT * FROM session_cache ORDER BY session_key DESC"),
    upsertCache: db.prepare(
      `INSERT INTO session_cache (session_key, built_at, size_bytes) VALUES (?, ?, ?)
       ON CONFLICT (session_key) DO UPDATE SET built_at = excluded.built_at, size_bytes = excluded.size_bytes`
    ),
    touchCache: db.prepare("UPDATE session_cache SET last_used_at = ? WHERE session_key = ?"),
    pinCache: db.prepare("UPDATE session_cache SET pinned = ? WHERE session_key = ?"),
    deleteCache: db.prepare("DELETE FROM session_cache WHERE session_key = ?"),

    audit: db.prepare("INSERT INTO audit_log (actor_id, action, details) VALUES (?, ?, ?)"),
    listAudit: db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
  };

  const toRaceBet = (r) =>
    r && {
      userId: r.user_id,
      seasonYear: r.season_year,
      session_key: r.session_key,
      raceName: r.race_name,
      p1_driver_number: r.p1_driver_number,
      p2_driver_number: r.p2_driver_number,
      p3_driver_number: r.p3_driver_number,
      source: r.source,
      sourceMessageId: r.source_message_id,
      placedAt: r.placed_at,
      lateOverride: Boolean(r.late_override),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };

  const toSeasonBet = (r) =>
    r && {
      userId: r.user_id,
      seasonYear: r.season_year,
      driverPredictions: JSON.parse(r.driver_predictions),
      teamPredictions: JSON.parse(r.team_predictions),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };

  return {
    db,
    transaction: (fn) => db.transaction(fn)(),

    listUsers: () =>
      q.listUsers.all().map((u) => ({ id: u.id, name: u.name, role: u.role, hasPassword: Boolean(u.has_password) })),
    getUser: (id) => q.getUser.get(id) || null,
    // Visningsnamnet, men bara om det är unikt.
    findUserByName: (name) => {
      const rows = q.usersByName.all(String(name || "").trim());
      return rows.length === 1 ? rows[0] : null;
    },
    countUsers: () => q.countUsers.get(),
    countAdmins: () => q.countAdmins.get(),
    createUser: ({ id, name, role = "member", passwordHash = null }) =>
      q.insertUser.run({ id, name, role, password_hash: passwordHash }),
    deleteUser: (id) => q.deleteUser.run(id).changes > 0,
    setPassword: (id, hash) => q.setPassword.run(hash, id),
    setRole: (id, role) => q.setRole.run(role, id),

    createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, expiresAt),
    sessionUser: (tokenHash) => q.sessionUser.get(tokenHash, nowIso()) || null,
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    deleteUserSessions: (userId) => q.deleteUserSessions.run(userId),
    purgeSessions: () => q.purgeSessions.run(nowIso()),

    createInvite: (tokenHash, userId, createdBy, expiresAt) => {
      q.deleteUserInvites.run(userId);
      q.insertInvite.run(tokenHash, userId, createdBy, expiresAt);
    },
    inviteUser: (tokenHash) => q.inviteUser.get(tokenHash, nowIso()) || null,
    deleteInvite: (tokenHash) => q.deleteInvite.run(tokenHash),

    getSeasonBet: (userId, year) => toSeasonBet(q.getSeasonBet.get(userId, year)) || null,
    listSeasonBets: (year) => q.listSeasonBets.all(year).map(toSeasonBet),
    saveSeasonBet: (userId, year, driverPredictions, teamPredictions) => {
      q.upsertSeasonBet.run({
        user_id: userId,
        season_year: year,
        driver_predictions: JSON.stringify(driverPredictions || []),
        team_predictions: JSON.stringify(teamPredictions || []),
        now: nowIso()
      });
      return toSeasonBet(q.getSeasonBet.get(userId, year));
    },

    getRaceBet: (userId, year, sessionKey) => toRaceBet(q.getRaceBet.get(userId, year, Number(sessionKey))) || null,
    listRaceBets: (year) => q.listRaceBets.all(year).map(toRaceBet),
    // overwrite=false: skriver aldrig över ett befintligt bet (import).
    saveRaceBet: (bet, { overwrite = true } = {}) => {
      const row = {
        user_id: bet.userId,
        season_year: bet.seasonYear,
        session_key: Number(bet.sessionKey),
        race_name: bet.raceName || "",
        p1: bet.p1 ?? null,
        p2: bet.p2 ?? null,
        p3: bet.p3 ?? null,
        source: bet.source || "app",
        source_message_id: bet.sourceMessageId || null,
        placed_at: bet.placedAt || nowIso(),
        late_override: bet.lateOverride ? 1 : 0,
        now: nowIso()
      };
      const info = (overwrite ? q.upsertRaceBet : q.insertRaceBetIfMissing).run(row);
      return { created: info.changes > 0, bet: toRaceBet(q.getRaceBet.get(row.user_id, row.season_year, row.session_key)) };
    },

    getResult: (sessionKey) => {
      const raw = q.getResult.get(Number(sessionKey));
      return raw ? JSON.parse(raw) : null;
    },
    putResult: (sessionKey, top3) => q.putResult.run(Number(sessionKey), JSON.stringify(top3)),
    listLegacySettlements: () =>
      new Map(q.listLegacySettlements.all().map((r) => [String(r.session_key), JSON.parse(r.data)])),
    putLegacySettlement: (sessionKey, data) => q.putLegacySettlement.run(Number(sessionKey), JSON.stringify(data)),

    getSetting: (key, fallback = null) => {
      const raw = q.getSetting.get(key);
      return raw === undefined ? fallback : JSON.parse(raw);
    },
    putSetting: (key, value) => q.putSetting.run(key, JSON.stringify(value)),

    listCacheEntries: () =>
      q.listCache.all().map((r) => ({
        sessionKey: r.session_key,
        builtAt: r.built_at,
        sizeBytes: r.size_bytes,
        lastUsedAt: r.last_used_at,
        pinned: Boolean(r.pinned)
      })),
    recordCache: (sessionKey, sizeBytes, builtAt = nowIso()) => q.upsertCache.run(Number(sessionKey), builtAt, sizeBytes),
    touchCache: (sessionKey) => q.touchCache.run(nowIso(), Number(sessionKey)),
    setCachePinned: (sessionKey, pinned) => q.pinCache.run(pinned ? 1 : 0, Number(sessionKey)).changes > 0,
    deleteCacheEntry: (sessionKey) => q.deleteCache.run(Number(sessionKey)),

    audit: (actorId, action, details) =>
      q.audit.run(actorId || null, action, details === undefined ? null : JSON.stringify(details)),
    listAudit: (limit = 100) => q.listAudit.all(limit)
  };
}

module.exports = { createStore };
