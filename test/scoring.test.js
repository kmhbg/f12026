const test = require("node:test");
const assert = require("node:assert/strict");
const { computeLeaderboard, scoreBet, normalizeScoring } = require("../lib/scoring");
const { computeSettlements } = require("../lib/settlement");

const bet = (userId, key, [p1, p2, p3]) => ({
  userId,
  session_key: key,
  p1_driver_number: p1,
  p2_driver_number: p2,
  p3_driver_number: p3
});

test("poäng per bet: rätt plats, fel plats och bonus för exakt topp 3", () => {
  const top3 = [3, 12, 44];
  assert.deepEqual(scoreBet([3, 12, 44], top3, normalizeScoring()), { points: 11, exactHits: 3, podiumHits: 0, perfect: true });
  assert.equal(scoreBet([12, 3, 44], top3, normalizeScoring()).points, 5, "två fel plats + en rätt");
  assert.equal(scoreBet([1, 4, 16], top3, normalizeScoring()).points, 0);
  assert.equal(scoreBet([3, 1, 4], top3, normalizeScoring({ exact: 5, podium: 2, perfectBonus: 0 })).points, 5);
  assert.deepEqual(normalizeScoring({ exact: "x", podium: -1, perfectBonus: 4 }), { exact: 3, podium: 1, perfectBonus: 4 });
});

test("topplista: poäng, saldo, matris, trend och placeringsändring", () => {
  const users = [
    { id: "anna", name: "Anna" },
    { id: "bo", name: "Bo" },
    { id: "cia", name: "Cia" }
  ];
  const races = [
    { sessionKey: "1", raceName: "Ett", start: 1, top3: [1, 2, 3] },
    { sessionKey: "2", raceName: "Två", start: 2, top3: [4, 5, 6] },
    { sessionKey: "3", raceName: "Kommande", start: 3, top3: null }
  ];
  const bets = [
    bet("anna", 1, [1, 2, 3]), // 11, vinner 100 kr
    bet("bo", 1, [2, 1, 3]), // 5
    bet("anna", 2, [7, 8, 9]), // 0
    bet("bo", 2, [4, 5, 9]), // 6
    bet("cia", 2, [4, 5, 6]) // 11, vinner 150 kr
  ];
  const { settlements } = computeSettlements({ races, bets, stake: 50 });
  const board = computeLeaderboard({ races, bets, settlements, users, stake: 50 });

  assert.equal(board.races.length, 2, "kommande race räknas inte");
  const [first, second, third] = board.leaderboard;
  // Alla har 11 poäng: vinster och sedan saldo avgör.
  assert.deepEqual(board.leaderboard.map((e) => [e.userId, e.points]), [["cia", 11], ["anna", 11], ["bo", 11]]);
  assert.equal(first.wins, 1);
  assert.equal(first.staked, 50);
  assert.equal(first.won, 150);
  assert.equal(first.net, 100);
  assert.equal(second.net, 0, "anna: 100 kr insatt, 100 kr vunnet");
  assert.equal(third.net, -100);
  assert.equal(first.racesBet, 1);

  assert.deepEqual(third.cumulative, [5, 11]);
  assert.deepEqual(first.cumulative, [0, 11]);
  assert.equal(second.perRace["1"].perfect, true);
  assert.equal(first.perRace["1"], undefined, "inget bet i race 1");

  assert.equal(first.rankChange, 2, "cia från 3:a till 1:a");
  assert.equal(second.rankChange, -1);
  assert.equal(board.leader, "cia");
});

test("gamla avräkningar ger saldo även utan payoutPerWinner", () => {
  const races = [{ sessionKey: "9", raceName: "Gammalt", start: 1, top3: null }];
  const legacy = new Map([["9", { result: [1, 2, 3], winners: ["anna"], totalBets: 2, payoutTotal: 300, potDelta: 0 }]]);
  const bets = [bet("anna", 9, [1, 2, 3]), bet("bo", 9, [3, 2, 1])];
  const { settlements } = computeSettlements({ races, bets, stake: 50, legacy });
  const board = computeLeaderboard({ races, bets, settlements, users: [{ id: "anna", name: "Anna" }, { id: "bo", name: "Bo" }] });

  assert.equal(board.races.length, 1, "resultatet tas från den frysta avräkningen");
  const anna = board.leaderboard.find((e) => e.userId === "anna");
  assert.equal(anna.won, 300);
  assert.equal(anna.net, 250);
  assert.equal(board.leaderboard.find((e) => e.userId === "bo").points, 3 + 1 + 1);
});
