const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openDatabase } = require("../lib/db");
const { createStore } = require("../lib/store");

test("migrering från bets.json behåller bets, potten och gamla avräkningar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f1-migrate-"));
  const file = path.join(dir, "bets.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      users: [
        { id: "seb", name: "Sebastian" },
        { id: "filip", name: "Filip" }
      ],
      seasonBets: [{ userId: "seb", seasonYear: 2026, driverPredictions: [1, 2], teamPredictions: ["A"] }],
      raceBets: [
        { userId: "filip", seasonYear: 2026, session_key: 11731, raceName: "KL", p1_driver_number: 3, p2_driver_number: 12, p3_driver_number: 44, lateOverride: true, source: "whatsapp", placedAt: "2026-10-04T07:44:31.000Z" }
      ],
      settings: {
        seasonOverrideOpen: false,
        racePot: 1650,
        raceSettlements: { 11731: { result: [3, 12, 44], winners: ["filip"], totalBets: 1, payoutTotal: 50, potDelta: 0 } }
      }
    })
  );
  const dataDir = path.join(dir, "data");
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate-json-to-sqlite.js"), file, "--admin", "seb"], {
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: "pipe"
  });

  const db = openDatabase(dataDir);
  const store = createStore(db);
  assert.equal(store.getUser("seb").role, "admin");
  assert.equal(store.getUser("filip").role, "member");
  assert.equal(store.listRaceBets(2026)[0].lateOverride, true);
  assert.deepEqual(store.getSeasonBet("seb", 2026).driverPredictions, [1, 2]);
  assert.equal(store.getSetting("pot_offset"), 1650);
  assert.deepEqual(store.listLegacySettlements().get("11731").winners, ["filip"]);
  db.close();

  assert.throws(() =>
    execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate-json-to-sqlite.js"), file], {
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: "pipe"
    })
  , "andra körningen avbryts");
  fs.rmSync(dir, { recursive: true, force: true });
});
