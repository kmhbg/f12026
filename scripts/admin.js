#!/usr/bin/env node
// Administration från kommandoraden (t.ex. när ingen admin kan logga in).
//   node scripts/admin.js list
//   node scripts/admin.js invite <användare>      skapar engångslänk för att sätta lösenord
//   node scripts/admin.js role <användare> admin|member
//   node scripts/admin.js create-admin <användarnamn> "<Namn>"   ny admin + länk för att sätta lösenord

const path = require("path");
const crypto = require("crypto");
const { openDatabase } = require("../lib/db");
const { createStore } = require("../lib/store");
const { hashToken, slugifyUsername } = require("../lib/auth");

const [cmd, userId, arg] = process.argv.slice(2);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const store = createStore(openDatabase(dataDir));
const publicUrl = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");

function printInvite(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  store.createInvite(hashToken(token), user.id, "cli", new Date(Date.now() + 7 * 86400e3).toISOString());
  store.audit(null, "invite-created-cli", { id: user.id });
  console.log(`${publicUrl}/invite.html#${token}`);
}

function requireUser(id) {
  const user = id && store.getUser(id);
  if (!user) {
    console.error(`Okänd användare: ${id || "(saknas)"}`);
    process.exit(1);
  }
  return user;
}

if (cmd === "list") {
  for (const u of store.listUsers()) {
    console.log(`${u.id}\t${u.role}\t${u.hasPassword ? "lösenord satt" : "inget lösenord"}\t${u.name}`);
  }
} else if (cmd === "invite") {
  printInvite(requireUser(userId));
} else if (cmd === "create-admin") {
  const id = slugifyUsername(userId);
  if (!id) {
    console.error("Användning: admin.js create-admin <användarnamn> \"<Namn>\"");
    process.exit(1);
  }
  if (store.getUser(id)) {
    console.error(`${id} finns redan – använd: admin.js role ${id} admin`);
    process.exit(1);
  }
  store.createUser({ id, name: String(arg || userId).trim(), role: "admin" });
  store.audit(null, "admin-created-cli", { id });
  console.log(`Admin ${id} skapad. Sätt lösenord via länken (giltig 7 dagar):`);
  printInvite(store.getUser(id));
} else if (cmd === "role" && ["admin", "member"].includes(arg)) {
  requireUser(userId);
  store.setRole(userId, arg);
  store.audit(null, "role-changed-cli", { id: userId, role: arg });
  console.log(`${userId} är nu ${arg}`);
} else {
  console.error(
    "Användning: admin.js list | invite <användare> | role <användare> admin|member | create-admin <användarnamn> <namn>"
  );
  process.exit(1);
}
