#!/usr/bin/env node
/**
 * Lokal verifiering av podiumprediktionslogik (samma som n8n Code-noden).
 * Kör: node n8n/test-prediction.js [meeting_key]
 * Default meeting_key=1286 (Monaco 2026).
 */

const BASE = "https://api.openf1.org/v1";
const SEASON = 2026;
const WEIGHTS = { qual: 50, fp3: 15, fp2: 10, fp1: 5 };
const PRACTICE_ONLY_SCALE = (WEIGHTS.qual + WEIGHTS.fp3 + WEIGHTS.fp2 + WEIGHTS.fp1) /
  (WEIGHTS.fp3 + WEIGHTS.fp2 + WEIGHTS.fp1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  await sleep(350);
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`OpenF1 ${path}: HTTP ${res.status}`);
  return res.json();
}

function sessionByName(sessions, meetingKey, name) {
  return sessions.find(
    (s) => s.meeting_key === meetingKey && s.session_name === name && !s.is_cancelled
  );
}

function pickTargetRace(sessions, now = new Date()) {
  const races = sessions
    .filter((s) => s.session_name === "Race" && s.year === SEASON && !s.is_cancelled)
    .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

  const qualifying = sessions.filter(
    (s) => s.session_name === "Qualifying" && s.year === SEASON && !s.is_cancelled
  );

  const upcoming = races.filter((r) => new Date(r.date_start) > now);
  if (upcoming.length) return { race: upcoming[0], reason: "nästa kommande race" };

  const inProgress = races
    .filter((r) => {
      const qual = qualifying.find((q) => q.meeting_key === r.meeting_key);
      return (
        qual &&
        new Date(qual.date_end) <= now &&
        new Date(r.date_start) > now
      );
    })
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
  if (inProgress.length) return { race: inProgress[0], reason: "qual klar, race ej startat" };

  const completed = races
    .filter((r) => new Date(r.date_end) <= now)
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
  if (completed.length) return { race: completed[0], reason: "senaste avslutade helg (demo)" };

  return { race: races[races.length - 1], reason: "fallback" };
}

async function getFastestLapRanks(sessionKey) {
  if (!sessionKey) return new Map();
  const results = await fetchJson(`/session_result?session_key=${sessionKey}`);
  if (!Array.isArray(results)) return new Map();
  const ranks = new Map();
  for (const row of results) {
    if (row.position != null && row.driver_number != null) {
      ranks.set(row.driver_number, row.position);
    }
  }
  return ranks;
}

async function predictPodium(meetingKeyOverride) {
  const allSessions = await fetchJson(`/sessions?year=${SEASON}`);
  let meetingKey = meetingKeyOverride;
  let selectionReason = "manuellt meeting_key";

  if (!meetingKey) {
    const picked = pickTargetRace(allSessions);
    meetingKey = picked.race.meeting_key;
    selectionReason = picked.reason;
  }

  const meetingSessions = allSessions.filter((s) => s.meeting_key === meetingKey);
  const raceSession = sessionByName(meetingSessions, meetingKey, "Race");
  const qualSession = sessionByName(meetingSessions, meetingKey, "Qualifying");
  const fp3 = sessionByName(meetingSessions, meetingKey, "Practice 3");
  const fp2 = sessionByName(meetingSessions, meetingKey, "Practice 2");
  const fp1 = sessionByName(meetingSessions, meetingKey, "Practice 1");

  const drivers = await fetchJson(`/drivers?meeting_key=${meetingKey}`);
  const driverMap = new Map();
  for (const d of drivers) {
    driverMap.set(d.driver_number, d);
  }

  let qualRanks = new Map();
  let hasQual = false;
  if (qualSession) {
    const qualResults = await fetchJson(`/session_result?session_key=${qualSession.session_key}`);
    if (Array.isArray(qualResults) && qualResults.length > 0) {
      hasQual = true;
      for (const row of qualResults) {
        if (row.position != null) qualRanks.set(row.driver_number, row.position);
      }
    }
  }

  const fp3Ranks = await getFastestLapRanks(fp3?.session_key);
  const fp2Ranks = await getFastestLapRanks(fp2?.session_key);
  const fp1Ranks = await getFastestLapRanks(fp1?.session_key);

  const w = hasQual
    ? WEIGHTS
    : {
        qual: 0,
        fp3: WEIGHTS.fp3 * PRACTICE_ONLY_SCALE,
        fp2: WEIGHTS.fp2 * PRACTICE_ONLY_SCALE,
        fp1: WEIGHTS.fp1 * PRACTICE_ONLY_SCALE,
      };

  const allDrivers = new Set([
    ...qualRanks.keys(),
    ...fp3Ranks.keys(),
    ...fp2Ranks.keys(),
    ...fp1Ranks.keys(),
  ]);

  const scored = [];
  for (const driverNumber of allDrivers) {
    let score = 0;
    const breakdown = {};
    if (hasQual && qualRanks.has(driverNumber)) {
      breakdown.qual = qualRanks.get(driverNumber);
      score += breakdown.qual * w.qual;
    }
    if (fp3Ranks.has(driverNumber)) {
      breakdown.fp3 = fp3Ranks.get(driverNumber);
      score += breakdown.fp3 * w.fp3;
    }
    if (fp2Ranks.has(driverNumber)) {
      breakdown.fp2 = fp2Ranks.get(driverNumber);
      score += breakdown.fp2 * w.fp2;
    }
    if (fp1Ranks.has(driverNumber)) {
      breakdown.fp1 = fp1Ranks.get(driverNumber);
      score += breakdown.fp1 * w.fp1;
    }
    if (score > 0) scored.push({ driverNumber, score, breakdown });
  }

  scored.sort((a, b) => a.score - b.score);
  const podium = scored.slice(0, 3).map((entry, i) => {
    const d = driverMap.get(entry.driverNumber) || {};
    return {
      position: `P${i + 1}`,
      driver_number: entry.driverNumber,
      name: d.full_name || d.broadcast_name || `#${entry.driverNumber}`,
      acronym: d.name_acronym || "?",
      score: Math.round(entry.score * 10) / 10,
      breakdown: entry.breakdown,
    };
  });

  const confidence = hasQual
    ? "Hög – kvalresultat inkluderat"
    : "Medel – endast träning (normaliserade vikter)";

  return {
    meeting_key: meetingKey,
    circuit: raceSession?.circuit_short_name || raceSession?.location,
    country: raceSession?.country_name,
    race_date: raceSession?.date_start,
    selection_reason: selectionReason,
    has_qualifying: hasQual,
    confidence,
    podium,
    top10: scored.slice(0, 10).map((e) => ({
      driver: driverMap.get(e.driverNumber)?.name_acronym || e.driverNumber,
      score: Math.round(e.score * 10) / 10,
    })),
  };
}

const meetingKey = process.argv[2] ? Number(process.argv[2]) : 1286;

predictPodium(meetingKey)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
