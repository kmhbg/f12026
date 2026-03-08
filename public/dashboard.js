//update
const API_BASE = "/api";

const state = {
  seasonYear: null,
  users: [],
  seasonBets: [],
  drivers: [],
  teams: [],
  driverStandings: [],
  constructorStandings: [],
  standingsUpdatedAt: null,
  raceStandings: null
};

function $(id) {
  return document.getElementById(id);
}

function wrapTable(table) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  wrapper.appendChild(table);
  return wrapper;
}

function normalizeKey(value) {
  return (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

async function loadMetadata() {
  const res = await fetch(`${API_BASE}/metadata`);
  const data = await res.json();
  state.seasonYear = data.seasonYear || null;
  state.users = data.users || [];
  state.drivers = data.drivers || [];
  state.teams = data.teams || [];
}

async function loadSummary() {
  const res = await fetch(`${API_BASE}/bets/summary`);
  const data = await res.json();
  state.seasonBets = data.seasonBets || [];
  state.users = data.users || state.users;
}

async function loadStandings() {
  const res = await fetch(`${API_BASE}/standings`);
  const data = await res.json();
  state.driverStandings = data.drivers || [];
  state.constructorStandings = data.constructors || [];
  state.standingsUpdatedAt = data.updatedAt || null;
}

async function loadRaceStandings() {
  const res = await fetch(`${API_BASE}/race/standings`);
  const data = await res.json();
  state.raceStandings = data || null;
}

function buildDriverStandingsMap() {
  const byNumber = new Map();
  const byName = new Map();

  state.driverStandings.forEach((d) => {
    const position = Number(d.position) || Number(d.position_number);
    const number = Number(d.driver_number || d.number);
    const name =
      d.driver_name ||
      d.full_name ||
      [d.first_name, d.last_name].filter(Boolean).join(" ");

    if (number && position) {
      byNumber.set(number, position);
    }

    if (name && position) {
      byName.set(normalizeKey(name), position);
    }
  });

  return { byNumber, byName };
}

function buildConstructorStandingsMap() {
  const byName = new Map();

  state.constructorStandings.forEach((t) => {
    const position = Number(t.position) || Number(t.position_number);
    const name = t.team_name || t.constructor_name || t.name;
    if (name && position) {
      byName.set(normalizeKey(name), position);
    }
  });

  return byName;
}

function getDriverName(driverNumber) {
  const found = state.drivers.find(
    (d) => Number(d.driver_number) === Number(driverNumber)
  );
  return found ? found.full_name : `#${driverNumber}`;
}

function buildUserCard(user, bet, driverMap, constructorMap) {
  const card = document.createElement("div");
  card.className = "dashboard-card";

  const heading = document.createElement("h3");
  heading.textContent = user.name;
  card.appendChild(heading);

  const driverSection = document.createElement("div");
  driverSection.className = "section-block";

  const driverTitle = document.createElement("h4");
  driverTitle.textContent = "Förare";
  driverSection.appendChild(driverTitle);

  const driverTable = document.createElement("table");
  driverTable.innerHTML = `
    <thead>
      <tr>
        <th>Bet-pos</th>
        <th>Förare</th>
        <th>Tabell-pos</th>
        <th>Diff</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const driverBody = driverTable.querySelector("tbody");

  let driverDiffSum = 0;
  let driverCount = 0;

  const driverPredictions = (bet?.driverPredictions || [])
    .slice()
    .sort((a, b) => a.predictedPosition - b.predictedPosition);

  driverPredictions.forEach((p) => {
    const tr = document.createElement("tr");
    const actual =
      driverMap.byNumber.get(Number(p.driver_number)) ||
      driverMap.byName.get(normalizeKey(getDriverName(p.driver_number)));

    const diff = actual ? actual - Number(p.predictedPosition) : null;
    if (actual) {
      driverDiffSum += Math.abs(diff);
      driverCount += 1;
    }

    tr.innerHTML = `
      <td>${p.predictedPosition}</td>
      <td>${getDriverName(p.driver_number)}</td>
      <td>${actual || "-"}</td>
      <td>${diff === null ? "-" : diff > 0 ? `+${diff}` : diff}</td>
    `;
    driverBody.appendChild(tr);
  });

  if (driverPredictions.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4">Inga förar-bets.</td>`;
    driverBody.appendChild(tr);
  }

  driverSection.appendChild(wrapTable(driverTable));

  const driverSummary = document.createElement("p");
  driverSummary.className = "info";
  driverSummary.textContent =
    driverCount > 0
      ? `Summa diff (förare): ${driverDiffSum}`
      : "Summa diff (förare): -";
  driverSection.appendChild(driverSummary);

  const teamSection = document.createElement("div");
  teamSection.className = "section-block";

  const teamTitle = document.createElement("h4");
  teamTitle.textContent = "Stall";
  teamSection.appendChild(teamTitle);

  const teamTable = document.createElement("table");
  teamTable.innerHTML = `
    <thead>
      <tr>
        <th>Bet-pos</th>
        <th>Stall</th>
        <th>Tabell-pos</th>
        <th>Diff</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const teamBody = teamTable.querySelector("tbody");

  let teamDiffSum = 0;
  let teamCount = 0;

  const teamPredictions = (bet?.teamPredictions || [])
    .slice()
    .sort((a, b) => a.predictedPosition - b.predictedPosition);

  teamPredictions.forEach((p) => {
    const actual = constructorMap.get(normalizeKey(p.team_name));
    const diff = actual ? actual - Number(p.predictedPosition) : null;
    if (actual) {
      teamDiffSum += Math.abs(diff);
      teamCount += 1;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.predictedPosition}</td>
      <td>${p.team_name}</td>
      <td>${actual || "-"}</td>
      <td>${diff === null ? "-" : diff > 0 ? `+${diff}` : diff}</td>
    `;
    teamBody.appendChild(tr);
  });

  if (teamPredictions.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4">Inga stall-bets.</td>`;
    teamBody.appendChild(tr);
  }

  teamSection.appendChild(wrapTable(teamTable));

  const teamSummary = document.createElement("p");
  teamSummary.className = "info";
  teamSummary.textContent =
    teamCount > 0 ? `Summa diff (stall): ${teamDiffSum}` : "Summa diff (stall): -";
  teamSection.appendChild(teamSummary);

  card.appendChild(driverSection);
  card.appendChild(teamSection);

  if (state.raceStandings && Array.isArray(state.raceStandings.leaderboard)) {
    const entry = state.raceStandings.leaderboard.find(
      (e) => e.userId === user.id
    );
    const raceSection = document.createElement("div");
    raceSection.className = "section-block";

    const raceTitle = document.createElement("h4");
    raceTitle.textContent = "Racebet";
    raceSection.appendChild(raceTitle);

    const points = entry ? entry.points : 0;
    const wins = entry ? entry.wins.length : 0;
    const totalScore = entry ? entry.totalScore : points;
    const raceInfo = document.createElement("p");
    raceInfo.className = "info";
    raceInfo.textContent = `Poäng: ${points} · Vinster: ${wins} · Total: ${totalScore}`;
    raceSection.appendChild(raceInfo);

    if (entry && entry.wins.length > 0) {
      const winsList = document.createElement("ul");
      winsList.className = "info";
      entry.wins.slice(0, 5).forEach((w) => {
        const item = document.createElement("li");
        const date = w.date ? new Date(w.date).toLocaleDateString() : "";
        item.textContent = `${w.raceName}${date ? ` (${date})` : ""}`;
        winsList.appendChild(item);
      });
      raceSection.appendChild(winsList);
    }

    card.appendChild(raceSection);
  }

  return card;
}

function renderDashboard() {
  const container = $("dashboard-container");
  container.innerHTML = "";

  const driverMap = buildDriverStandingsMap();
  const constructorMap = buildConstructorStandingsMap();

  const updatedEl = $("dashboard-updated");
  if (state.standingsUpdatedAt) {
    const date = new Date(state.standingsUpdatedAt);
    updatedEl.textContent = `Uppdaterad: ${date.toLocaleString()}`;
  } else {
    updatedEl.textContent = "";
  }

  const raceUpdatedEl = $("race-updated");
  const raceTableBody = $("race-leaderboard").querySelector("tbody");
  raceTableBody.innerHTML = "";

  const totalScores = new Map();
  state.users.forEach((user) => {
    const bet = state.seasonBets.find(
      (b) => b.userId === user.id && (!state.seasonYear || b.seasonYear === state.seasonYear)
    );
    let driverTotal = 0;
    let driverCount = 0;
    let teamTotal = 0;
    let teamCount = 0;
    if (bet) {
      (bet.driverPredictions || []).forEach((p) => {
        const actual =
          driverMap.byNumber.get(Number(p.driver_number)) ||
          driverMap.byName.get(normalizeKey(getDriverName(p.driver_number)));
        if (actual) {
          driverTotal += Math.abs(actual - Number(p.predictedPosition));
          driverCount += 1;
        }
      });
      (bet.teamPredictions || []).forEach((p) => {
        const actual = constructorMap.get(normalizeKey(p.team_name));
        if (actual) {
          teamTotal += Math.abs(actual - Number(p.predictedPosition));
          teamCount += 1;
        }
      });
    }
    const seasonScore =
      driverCount + teamCount > 0 ? driverTotal + teamTotal : null;
    totalScores.set(user.id, seasonScore);
  });

  if (state.raceStandings && Array.isArray(state.raceStandings.leaderboard)) {
    const leaderboardWithTotal = state.raceStandings.leaderboard.map((entry) => {
      const seasonScore = totalScores.get(entry.userId);
      const totalScore =
        seasonScore === null ? entry.points : entry.points - seasonScore;
      return { ...entry, totalScore, seasonScore };
    });

    leaderboardWithTotal.forEach((entry, index) => {
      const tr = document.createElement("tr");
      const winsCount = entry.wins ? entry.wins.length : 0;
      const totalValue =
        entry.seasonScore === null
          ? `${entry.points} (race)`
          : `${entry.totalScore.toFixed(1)} (race - diff)`;
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td>${entry.name}</td>
        <td>${entry.points}</td>
        <td>${winsCount}</td>
        <td>${totalValue}</td>
      `;
      raceTableBody.appendChild(tr);
    });
    if (state.raceStandings.updatedAt) {
      const date = new Date(state.raceStandings.updatedAt);
      raceUpdatedEl.textContent = `Uppdaterad: ${date.toLocaleString()}`;
    } else {
      raceUpdatedEl.textContent = "";
    }
  } else {
    raceUpdatedEl.textContent = "Inga race-resultat ännu.";
  }

  state.users.forEach((user) => {
    const bet = state.seasonBets.find(
      (b) => b.userId === user.id && (!state.seasonYear || b.seasonYear === state.seasonYear)
    );
    const card = buildUserCard(user, bet, driverMap, constructorMap);
    container.appendChild(card);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  }
  await Promise.all([loadMetadata(), loadSummary(), loadStandings(), loadRaceStandings()]);
  renderDashboard();
});
