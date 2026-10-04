const test = require("node:test");
const assert = require("node:assert/strict");
const { selectCachesToPrune } = require("../lib/cache-policy");

test("cachen behåller senaste racen, pinnade, nyss använda och pågående byggen", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const old = "2026-09-01T00:00:00Z";
  const entries = [
    { sessionKey: 1, builtAt: old },
    { sessionKey: 2, builtAt: old, pinned: true },
    { sessionKey: 3, builtAt: old, lastUsedAt: "2026-10-04T06:00:00Z" },
    { sessionKey: 4, builtAt: old },
    { sessionKey: 5, builtAt: old },
    { sessionKey: 6, builtAt: old },
    { sessionKey: 7, builtAt: "2026-10-04T11:00:00Z" }
  ];
  const prune = selectCachesToPrune({
    cachedKeys: ["1", "2", "3", "4", "5", "6", "7", "8"],
    entries,
    latestRaceKeys: ["5", "6"],
    buildingKeys: ["4"],
    now
  });
  // 8 saknar rad och byggtid, så den rensas.
  assert.deepEqual(prune, ["1", "8"]);
});
