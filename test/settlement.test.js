const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSettlements } = require("../lib/settlement");

const bet = (userId, key, p) => ({
  userId,
  session_key: key,
  p1_driver_number: p[0],
  p2_driver_number: p[1],
  p3_driver_number: p[2]
});

test("vinnare delar racets insatser och potten rörs inte (Kuala Lumpur 2026)", () => {
  const { settlements, pot } = computeSettlements({
    races: [{ sessionKey: 11731, start: 1, top3: [3, 12, 44] }],
    bets: [
      bet("oskar", 11731, [3, 12, 6]),
      bet("jonas", 11731, [3, 6, 44]),
      bet("filip", 11731, [3, 12, 44]),
      bet("jonathan", 11731, [3, 6, 44])
    ],
    potOffset: 1650
  });
  const s = settlements.get("11731");
  assert.deepEqual(s.winners, ["filip"]);
  assert.equal(s.payoutTotal, 200);
  assert.equal(s.payoutPerWinner, 200);
  assert.equal(pot, 1650);
});

test("utan vinnare går insatserna till potten, flera vinnare delar", () => {
  const { settlements, pot } = computeSettlements({
    races: [
      { sessionKey: 2, start: 2, top3: [1, 2, 3] },
      { sessionKey: 1, start: 1, top3: [4, 5, 6] }
    ],
    bets: [bet("a", 1, [1, 2, 3]), bet("b", 1, [6, 5, 4]), bet("a", 2, [1, 2, 3]), bet("b", 2, [1, 2, 3])],
    stake: 50
  });
  assert.equal(settlements.get("1").potDelta, 100);
  assert.equal(settlements.get("2").payoutPerWinner, 50);
  assert.equal(pot, 100);
});

test("race utan resultat räknas inte av, frysta avräkningar används som de är", () => {
  const legacy = new Map([["1", { result: [1, 2, 3], winners: ["x"], potDelta: -500, payoutTotal: 600 }]]);
  const { settlements, pot } = computeSettlements({
    races: [
      { sessionKey: 1, start: 1, top3: [9, 9, 9] },
      { sessionKey: 2, start: 2, top3: null }
    ],
    bets: [],
    legacy,
    potOffset: 500
  });
  assert.equal(settlements.get("1").legacy, true);
  assert.deepEqual(settlements.get("1").winners, ["x"]);
  assert.equal(settlements.has("2"), false);
  assert.equal(pot, 0);
});
