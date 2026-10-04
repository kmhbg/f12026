const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("./helpers");

test("inloggning, behörighet och racebets", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const admin = app.client();
  const filip = app.client();
  const anon = app.client();

  // Första start
  assert.equal((await anon("GET", "/api/auth/me")).data.needsSetup, true);
  assert.equal((await anon("GET", "/api/metadata")).status, 401);
  assert.equal((await admin("POST", "/api/auth/setup", { name: "Seb", username: "seb", password: "kort" })).status, 400);
  assert.equal((await admin("POST", "/api/auth/setup", { name: "Seb", username: "seb", password: "hemligt123" })).status, 201);
  assert.equal((await anon("POST", "/api/auth/setup", { name: "X", username: "x", password: "hemligt123" })).status, 409);

  // Inbjudan
  const created = await admin("POST", "/api/users", { name: "Filip" });
  assert.equal(created.status, 201);
  const token = created.data.inviteUrl.split("#")[1];
  assert.equal((await filip("POST", `/api/auth/invite/${token}`, { password: "filips-losen" })).status, 200);
  assert.equal((await anon("POST", `/api/auth/invite/${token}`, { password: "igen-igen-igen" })).status, 404);

  // Behörighet
  assert.equal((await filip("GET", "/api/users")).status, 403);
  assert.equal((await filip("DELETE", "/api/users/seb")).status, 403);
  assert.equal((await filip("POST", "/api/settings/season-override", { enabled: true })).status, 403);
  const picks = { p1_driver_number: 3, p2_driver_number: 12, p3_driver_number: 44 };
  assert.equal((await filip("POST", "/api/bets/race/200/seb", picks)).status, 403);

  // Racebets
  assert.equal((await filip("POST", "/api/bets/race/200/filip", picks)).status, 200);
  assert.equal((await filip("POST", "/api/bets/race/100/filip", picks)).status, 403, "efter start");
  assert.equal((await filip("POST", "/api/bets/race/300/filip", picks)).status, 404, "inställt");
  assert.equal(
    (await filip("POST", "/api/bets/race/200/filip", { p1_driver_number: 3, p2_driver_number: 3, p3_driver_number: 44 })).status,
    400
  );
  assert.equal(
    (await filip("POST", "/api/bets/race/200/filip", { p1_driver_number: 3, p2_driver_number: 99, p3_driver_number: 44 })).status,
    400,
    "okänd förare"
  );

  // Andras bets är dolda före start
  const sebView = await admin("GET", "/api/bets/race/200/filip");
  assert.equal(sebView.data.p1_driver_number, 3, "admin ser allt");
  await admin("POST", "/api/bets/race/200/seb", { p1_driver_number: 1, p2_driver_number: 4, p3_driver_number: 16 });
  const hidden = await filip("GET", "/api/bets/race/200/seb");
  assert.equal(hidden.data.hidden, true);
  assert.equal(hidden.data.p1_driver_number, null);
  const summary = await filip("GET", "/api/bets/summary");
  assert.equal(summary.data.raceBets.find((b) => b.userId === "seb").hidden, true);

  // CSRF-skydd: ändrande anrop måste vara JSON (formulär från andra sajter kan inte det)
  const form = await fetch(`${app.base}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "name=evil"
  });
  assert.equal(form.status, 415);

  // Utloggning
  assert.equal((await filip("POST", "/api/auth/logout", {})).status, 200);
  assert.equal((await filip("GET", "/api/metadata")).status, 401);
});

test("inloggning begränsas efter för många försök", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const c = app.client();
  await c("POST", "/api/auth/setup", { name: "Seb", username: "seb", password: "hemligt123" });
  const other = app.client();
  for (let i = 0; i < 10; i++) {
    assert.equal((await other("POST", "/api/auth/login", { username: "seb", password: "fel-losen" })).status, 401);
  }
  assert.equal((await other("POST", "/api/auth/login", { username: "seb", password: "hemligt123" })).status, 429);
});

test("import från WhatsApp och omräknad avräkning", async (t) => {
  process.env.F1_IMPORT_TOKEN = "test-token";
  const app = await startTestApp();
  t.after(() => {
    delete process.env.F1_IMPORT_TOKEN;
    app.close();
  });
  const admin = app.client();
  await admin("POST", "/api/auth/setup", { name: "Seb", username: "seb", password: "hemligt123" });
  await admin("POST", "/api/users", { name: "Filip" });
  const imp = app.client();
  const H = { "X-Import-Token": "test-token" };
  const start100 = Date.now() - 2 * 3600e3;
  const bet = (placedAt, extra = {}) => ({
    p1_driver_number: 3,
    p2_driver_number: 12,
    p3_driver_number: 44,
    placedAt: new Date(placedAt).toISOString(),
    source: "whatsapp",
    ...extra
  });

  assert.equal((await imp("POST", "/api/bets/race/100/filip/import", bet(start100 - 1000), { "X-Import-Token": "fel" })).status, 401);
  assert.equal((await imp("POST", "/api/bets/race/100/filip/import", bet(start100 + 1000), H)).status, 403);
  const late = await imp("POST", "/api/bets/race/100/filip/import", bet(start100 + 1000, { allowLate: true }), H);
  assert.equal(late.status, 201);
  assert.equal(late.data.bet.lateOverride, true);
  assert.equal((await imp("POST", "/api/bets/race/100/filip/import", bet(start100 - 1000), H)).data.status, "exists");
  assert.equal((await imp("POST", "/api/bets/race/100/seb/import", bet(start100 - 5000, { p3_driver_number: 6 }), H)).status, 201);

  const s = await admin("GET", "/api/race/settlement/100");
  assert.equal(s.data.status, "settled");
  assert.deepEqual(s.data.settlement.winners, ["filip"]);
  assert.equal(s.data.settlement.payoutTotal, 100);
  assert.equal(s.data.pot, 0);
  assert.equal(app.store.getResult(100).join(","), "3,12,44", "resultatet cachas");
});
