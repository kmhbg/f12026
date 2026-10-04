// Topplista för racebetten som ren funktion: poäng per race plus saldo i kr.
//
// Poäng (standard, ändras av admin): rätt förare på rätt plats ger `exact`,
// rätt förare i topp 3 men på fel plats ger `podium`, och exakt hela topp 3
// ger dessutom `perfectBonus`. Saldot följer avräkningen i lib/settlement.js:
// insatt = antal bets × insats, vunnet = utbetalning i race man vunnit.

const DEFAULT_SCORING = { exact: 3, podium: 1, perfectBonus: 2 };

function normalizeScoring(raw) {
  const out = { ...DEFAULT_SCORING };
  for (const key of Object.keys(DEFAULT_SCORING)) {
    const n = Number(raw?.[key]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[key] = n;
  }
  return out;
}

function scoreBet(picks, top3, rules = DEFAULT_SCORING) {
  let points = 0;
  let exactHits = 0;
  let podiumHits = 0;
  picks.forEach((driver, i) => {
    if (driver === top3[i]) {
      points += rules.exact;
      exactHits += 1;
    } else if (top3.includes(driver)) {
      points += rules.podium;
      podiumHits += 1;
    }
  });
  const perfect = exactHits === 3;
  if (perfect) points += rules.perfectBonus;
  return { points, exactHits, podiumHits, perfect };
}

const payoutPerWinner = (s) =>
  Number.isFinite(Number(s.payoutPerWinner))
    ? Number(s.payoutPerWinner)
    : s.winners?.length
      ? (Number(s.payoutTotal) || 0) / s.winners.length
      : 0;

function rankOf(entries) {
  const sorted = entries
    .slice()
    .sort((a, b) => b.points - a.points || b.wins - a.wins || b.net - a.net || a.name.localeCompare(b.name));
  return new Map(sorted.map((e, i) => [e.userId, i + 1]));
}

function computeLeaderboard({ races, bets, settlements, users, stake = 50, rules = DEFAULT_SCORING }) {
  const scoring = normalizeScoring(rules);
  const settled = races
    .map((r) => {
      const s = settlements.get(String(r.sessionKey));
      const top3 = Array.isArray(r.top3) && r.top3.length >= 3 ? r.top3 : s?.result;
      return Array.isArray(top3) && top3.length >= 3 ? { ...r, top3: top3.map(Number), settlement: s } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const betsByRace = new Map();
  bets.forEach((b) => {
    const key = String(b.session_key);
    if (!betsByRace.has(key)) betsByRace.set(key, new Map());
    betsByRace.get(key).set(b.userId, b);
  });

  const entries = users.map((u) => ({
    userId: u.id,
    name: u.name,
    points: 0,
    wins: 0,
    exactHits: 0,
    podiumHits: 0,
    racesBet: 0,
    staked: 0,
    won: 0,
    net: 0,
    perRace: {},
    cumulative: []
  }));
  const byId = new Map(entries.map((e) => [e.userId, e]));
  let previousRanks = null;

  settled.forEach((race, index) => {
    const key = String(race.sessionKey);
    const raceBets = betsByRace.get(key) || new Map();
    const s = race.settlement;
    const winners = new Set(s?.winners || []);

    entries.forEach((e) => {
      const bet = raceBets.get(e.userId);
      if (bet) {
        const picks = [bet.p1_driver_number, bet.p2_driver_number, bet.p3_driver_number].map(Number);
        const score = scoreBet(picks, race.top3, scoring);
        e.points += score.points;
        e.exactHits += score.exactHits;
        e.podiumHits += score.podiumHits;
        e.racesBet += 1;
        e.perRace[key] = { points: score.points, perfect: score.perfect, picks };
      }
      if (bet) e.staked += stake;
      // Vinst enligt avräkningen (gamla race kan ha avräknats med andra regler).
      if (winners.has(e.userId)) {
        e.wins += 1;
        e.won += payoutPerWinner(s);
      }
      e.net = e.won - e.staked;
      e.cumulative.push(e.points);
    });

    if (index === settled.length - 2) previousRanks = rankOf(entries);
  });

  const ranks = rankOf(entries);
  const leaderboard = entries
    .map((e) => ({
      ...e,
      rank: ranks.get(e.userId),
      rankChange: previousRanks ? previousRanks.get(e.userId) - ranks.get(e.userId) : 0
    }))
    .sort((a, b) => a.rank - b.rank);

  return {
    scoring,
    races: settled.map((r) => ({
      sessionKey: String(r.sessionKey),
      raceName: r.raceName,
      date: r.date,
      resultTop3: r.top3,
      winners: r.settlement?.winners || [],
      totalBets: r.settlement?.totalBets ?? (betsByRace.get(String(r.sessionKey))?.size || 0)
    })),
    leaderboard,
    leader: leaderboard[0] && leaderboard[0].points > 0 ? leaderboard[0].userId : null
  };
}

module.exports = { computeLeaderboard, scoreBet, normalizeScoring, DEFAULT_SCORING };
