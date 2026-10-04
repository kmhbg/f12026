#!/usr/bin/env node
// Flyttar data från den gamla bets.json till SQLite.
//   DATA_DIR=/data node scripts/migrate-json-to-sqlite.js /väg/till/bets.json --admin seb[,annan]
// Användarna får inget lösenord; skapa inbjudningslänkar efteråt med
//   node scripts/admin.js invite <användare>

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/db");
const { createStore } = require("../lib/store");

function main(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  const adminArg = argv.find((a) => a.startsWith("--admin="))?.split("=")[1] ||
    (argv.includes("--admin") ? argv[argv.indexOf("--admin") + 1] : "");
  const admins = new Set(adminArg.split(",").map((s) => s.trim()).filter(Boolean));
  if (!file) {
    console.error("Användning: node scripts/migrate-json-to-sqlite.js <bets.json> --admin <id>[,<id>]");
    process.exit(1);
  }

  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const store = createStore(openDatabase(dataDir));
  if (store.countUsers() > 0) {
    console.error(`Databasen i ${dataDir} innehåller redan användare – avbryter.`);
    process.exit(1);
  }

  const settings = json.settings || {};
  const counts = store.transaction(() => {
    for (const u of json.users || []) {
      store.createUser({ id: u.id, name: u.name, role: admins.has(u.id) ? "admin" : "member" });
    }
    for (const b of json.seasonBets || []) {
      store.saveSeasonBet(b.userId, b.seasonYear, b.driverPredictions, b.teamPredictions);
    }
    for (const b of json.raceBets || []) {
      store.saveRaceBet({
        userId: b.userId,
        seasonYear: b.seasonYear,
        sessionKey: b.session_key,
        raceName: b.raceName,
        p1: b.p1_driver_number,
        p2: b.p2_driver_number,
        p3: b.p3_driver_number,
        source: b.source || "app",
        sourceMessageId: b.sourceMessageId,
        placedAt: b.placedAt || b.updatedAt || b.createdAt,
        lateOverride: b.lateOverride === true
      });
    }
    // Gamla avräkningar fryses; potOffset gör att potten blir exakt densamma
    // som i den gamla filen även om den manipulerats för hand.
    const legacy = Object.entries(settings.raceSettlements || {});
    let deltaSum = 0;
    for (const [key, s] of legacy) {
      store.putLegacySettlement(key, s);
      deltaSum += Number(s.potDelta) || 0;
    }
    store.putSetting("pot_offset", (Number(settings.racePot) || 0) - deltaSum);
    store.putSetting("season_override_open", Boolean(settings.seasonOverrideOpen));
    store.audit(null, "migrated-from-json", { file: path.basename(file) });
    return {
      users: (json.users || []).length,
      seasonBets: (json.seasonBets || []).length,
      raceBets: (json.raceBets || []).length,
      legacySettlements: legacy.length,
      pot: Number(settings.racePot) || 0
    };
  });

  const missingAdmins = [...admins].filter((id) => !store.getUser(id));
  console.log("Migrerat:", counts);
  if (missingAdmins.length) console.warn("Varning: admin-id som inte finns:", missingAdmins.join(", "));
  if (admins.size === 0) console.warn("Varning: ingen admin angiven (--admin <id>).");
}

main(process.argv.slice(2));
