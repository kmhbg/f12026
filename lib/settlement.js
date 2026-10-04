// Avräkning som ren funktion: samma bets + resultat ger alltid samma utfall.
// Inget lagras vid läsning, så sena importer och ändrade regler räknas om
// automatiskt.
//
// Regel (tills vidare): vinnarna delar racets insatser (stake × antal bets).
// Den samlade potten betalas inte ut; utan vinnare går insatserna till potten.
// Avräkningar från före v2 (räknade med äldre regler) används som de är.

function computeSettlements({ races, bets, stake = 50, legacy = new Map(), potOffset = 0 }) {
  const ordered = races.slice().sort((a, b) => a.start - b.start);
  const settlements = new Map();
  let pot = potOffset;

  for (const race of ordered) {
    const key = String(race.sessionKey);
    const frozen = legacy.get(key);
    if (frozen) {
      pot += Number(frozen.potDelta) || 0;
      settlements.set(key, { ...frozen, sessionKey: key, legacy: true, potAfter: pot });
      continue;
    }
    if (!Array.isArray(race.top3) || race.top3.length < 3) continue;

    const raceBets = bets.filter((b) => String(b.session_key) === key);
    const winners = raceBets.filter(
      (b) =>
        Number(b.p1_driver_number) === race.top3[0] &&
        Number(b.p2_driver_number) === race.top3[1] &&
        Number(b.p3_driver_number) === race.top3[2]
    );
    const payoutTotal = raceBets.length * stake;
    const potDelta = winners.length === 0 ? payoutTotal : 0;
    pot += potDelta;

    settlements.set(key, {
      sessionKey: key,
      result: race.top3,
      winners: winners.map((w) => w.userId),
      totalBets: raceBets.length,
      payoutTotal,
      payoutPerWinner: winners.length > 0 ? payoutTotal / winners.length : 0,
      potUsed: 0,
      potDelta,
      potAfter: pot,
      legacy: false
    });
  }

  return { settlements, pot };
}

module.exports = { computeSettlements };
