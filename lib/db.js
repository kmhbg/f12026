const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const BACKUPS_TO_KEEP = 30;

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "f1-betting.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").pluck().all());
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString()
      );
    })();
    console.log(`[db] Migrering ${file} körd`);
  }
}

// Daglig backup med SQLite:s online-backup (säker även medan appen skriver).
async function backupDatabase(db, dataDir) {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(dir, `f1-betting-${stamp}.db`);
  await db.backup(target);
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^f1-betting-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -BACKUPS_TO_KEEP);
  old.forEach((f) => fs.unlinkSync(path.join(dir, f)));
  return target;
}

function scheduleBackups(db, dataDir) {
  const run = () =>
    backupDatabase(db, dataDir)
      .then((file) => console.log(`[db] Backup sparad: ${path.basename(file)}`))
      .catch((err) => console.error("[db] Backup misslyckades:", err.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

module.exports = { openDatabase, migrate, backupDatabase, scheduleBackups };
