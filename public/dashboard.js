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
  raceStandings: null,
  analyticsMode: "single",
  selectedUserIds: [],
  singleUserId: null
};

function $(id) {
  return document.getElementById(id);
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

function diffClass(diff) {
  if (diff === null || diff === undefined) return "diff-unknown";
  const abs = Math.abs(Number(diff));
  if (abs === 0) return "diff-exact";
  if (abs <= 1) return "diff-close";
  if (abs <= 3) return "diff-mid";
  return "diff-far";
}

function formatDiff(diff) {
  if (diff === null || diff === undefined) return "–";
  const n = Number(diff);
  if (n > 0) return `+${n}`;
  return String(n);
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

    if (number && position) byNumber.set(number, position);
    if (name && position) byName.set(normalizeKey(name), position);
  });

  return { byNumber, byName };
}

function buildConstructorStandingsMap() {
  const byName = new Map();
  state.constructorStandings.forEach((t) => {
    const position = Number(t.position) || Number(t.position_number);
    const name = t.team_name || t.constructor_name || t.name;
    if (name && position) byName.set(normalizeKey(name), position);
  });
  return byName;
}

function getDriverName(driverNumber) {
  const found = state.drivers.find(
    (d) => Number(d.driver_number) === Number(driverNumber)
  );
  return found ? found.full_name : `#${driverNumber}`;
}

function getUserBet(userId) {
  return state.seasonBets.find(
    (b) =>
      b.userId === userId &&
      (!state.seasonYear || b.seasonYear === state.seasonYear)
  );
}

function computeUserSeasonStats(userId, driverMap, constructorMap) {
  const bet = getUserBet(userId);
  const stats = {
    userId,
    driverDiffSum: 0,
    teamDiffSum: 0,
    driverCount: 0,
    teamCount: 0,
    exactHits: 0,
    closeHits: 0,
    driverRows: [],
    teamRows: []
  };

  if (!bet) return stats;

  (bet.driverPredictions || [])
    .slice()
    .sort((a, b) => a.predictedPosition - b.predictedPosition)
    .forEach((p) => {
      const actual =
        driverMap.byNumber.get(Number(p.driver_number)) ||
        driverMap.byName.get(normalizeKey(getDriverName(p.driver_number)));
      const diff = actual ? actual - Number(p.predictedPosition) : null;
      if (actual) {
        stats.driverDiffSum += Math.abs(diff);
        stats.driverCount += 1;
        if (Math.abs(diff) === 0) stats.exactHits += 1;
        if (Math.abs(diff) <= 1) stats.closeHits += 1;
      }
      stats.driverRows.push({
        predictedPosition: p.predictedPosition,
        driverNumber: p.driver_number,
        driverName: getDriverName(p.driver_number),
        actual,
        diff
      });
    });

  (bet.teamPredictions || [])
    .slice()
    .sort((a, b) => a.predictedPosition - b.predictedPosition)
    .forEach((p) => {
      const actual = constructorMap.get(normalizeKey(p.team_name));
      const diff = actual ? actual - Number(p.predictedPosition) : null;
      if (actual) {
        stats.teamDiffSum += Math.abs(diff);
        stats.teamCount += 1;
        if (Math.abs(diff) === 0) stats.exactHits += 1;
        if (Math.abs(diff) <= 1) stats.closeHits += 1;
      }
      stats.teamRows.push({
        predictedPosition: p.predictedPosition,
        teamName: p.team_name,
        actual,
        diff
      });
    });

  stats.totalDiff = stats.driverDiffSum + stats.teamDiffSum;
  stats.totalCount = stats.driverCount + stats.teamCount;
  return stats;
}

function allUserStats(driverMap, constructorMap) {
  return state.users.map((u) => ({
    user: u,
    ...computeUserSeasonStats(u.id, driverMap, constructorMap)
  }));
}

function renderRaceLeaderboard(driverMap, constructorMap) {
  const raceTableBody = $("race-leaderboard").querySelector("tbody");
  const raceUpdatedEl = $("race-updated");
  raceTableBody.innerHTML = "";

  const totalScores = new Map();
  state.users.forEach((user) => {
    const s = computeUserSeasonStats(user.id, driverMap, constructorMap);
    totalScores.set(
      user.id,
      s.totalCount > 0 ? s.totalDiff : null
    );
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
          : `${entry.totalScore.toFixed(1)} (race − diff)`;
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
      raceUpdatedEl.textContent = `Uppdaterad: ${new Date(
        state.raceStandings.updatedAt
      ).toLocaleString()}`;
    } else {
      raceUpdatedEl.textContent = "";
    }
  } else {
    raceUpdatedEl.textContent = "Inga race-resultat ännu.";
  }
}

function renderKpis(statsList) {
  const el = $("season-kpis");
  el.innerHTML = "";

  const withBets = statsList.filter((s) => s.totalCount > 0);
  if (withBets.length === 0) {
    el.innerHTML = `<p class="info">Inga årsbett inlämnade ännu.</p>`;
    return;
  }

  const best = withBets.slice().sort((a, b) => a.totalDiff - b.totalDiff)[0];
  const avgDiff =
    withBets.reduce((sum, s) => sum + s.totalDiff, 0) / withBets.length;
  const totalExact = withBets.reduce((sum, s) => sum + s.exactHits, 0);

  [
    { label: "Spelare med bett", value: String(withBets.length) },
    { label: "Bäst total diff", value: `${best.totalDiff} (${best.user.name})` },
    { label: "Snitt diff / spelare", value: avgDiff.toFixed(1) },
    { label: "Exakta träffar (±0)", value: String(totalExact) }
  ].forEach((kpi) => {
    const card = document.createElement("div");
    card.className = "stats-kpi";
    card.innerHTML = `<span class="stats-kpi-label">${kpi.label}</span><span class="stats-kpi-value">${kpi.value}</span>`;
    el.appendChild(card);
  });
}

function renderSeasonRanking(statsList) {
  const tbody = $("season-accuracy-table").querySelector("tbody");
  tbody.innerHTML = "";

  const ranked = statsList
    .filter((s) => s.totalCount > 0)
    .sort((a, b) => a.totalDiff - b.totalDiff);

  if (ranked.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7">Inga årsbett att visa.</td>`;
    tbody.appendChild(tr);
    return;
  }

  ranked.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><strong>${s.user.name}</strong></td>
      <td>${s.driverCount ? s.driverDiffSum : "–"}</td>
      <td>${s.teamCount ? s.teamDiffSum : "–"}</td>
      <td><strong>${s.totalDiff}</strong></td>
      <td>${s.exactHits}</td>
      <td>${s.closeHits}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderUserPicker() {
  const picker = $("user-picker");
  picker.innerHTML = "";

  if (state.analyticsMode === "single") {
    const label = document.createElement("label");
    label.className = "picker-label";
    label.textContent = "Välj spelare";
    const select = document.createElement("select");
    select.id = "single-user-select";
    select.className = "analytics-select";
    state.users.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.name;
      if (u.id === state.singleUserId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      state.singleUserId = select.value;
      renderAnalyticsContent(
        buildDriverStandingsMap(),
        buildConstructorStandingsMap()
      );
    });
    label.appendChild(select);
    picker.appendChild(label);
    return;
  }

  const label = document.createElement("span");
  label.className = "picker-label";
  label.textContent =
    state.analyticsMode === "group"
      ? "Inkludera i gruppanalys"
      : "Välj spelare att jämföra";
  picker.appendChild(label);

  const chips = document.createElement("div");
  chips.className = "user-chips";
  state.users.forEach((u) => {
    const chip = document.createElement("label");
    chip.className = "user-chip";
    const checked = state.selectedUserIds.includes(u.id);
    chip.innerHTML = `<input type="checkbox" value="${u.id}" ${
      checked ? "checked" : ""
    } /><span>${u.name}</span>`;
    chip.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) {
        if (!state.selectedUserIds.includes(u.id)) {
          state.selectedUserIds.push(u.id);
        }
      } else {
        state.selectedUserIds = state.selectedUserIds.filter((id) => id !== u.id);
      }
      renderAnalyticsContent(
        buildDriverStandingsMap(),
        buildConstructorStandingsMap()
      );
    });
    chips.appendChild(chip);
  });
  picker.appendChild(chips);
}

function buildComparisonTable(title, rows, users, rowKey) {
  const wrap = document.createElement("div");
  wrap.className = "analytics-block";
  const h = document.createElement("h4");
  h.textContent = title;
  wrap.appendChild(h);

  const table = document.createElement("table");
  table.className = "analytics-table compare-table";
  const head = document.createElement("thead");
  let headHtml = `<tr><th>Faktisk</th><th>${rowKey === "driver" ? "Förare" : "Stall"}</th>`;
  users.forEach((u) => {
    headHtml += `<th>${u.name} bet</th><th>Δ</th>`;
  });
  headHtml += `</tr>`;
  head.innerHTML = headHtml;
  table.appendChild(head);

  const body = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    let html = `<td>${row.actual ?? "–"}</td><td>${row.label}</td>`;
    users.forEach((u) => {
      const cell = row.byUser[u.id];
      const diff = cell?.diff;
      html += `<td>${cell?.predicted ?? "–"}</td><td class="${diffClass(diff)}">${formatDiff(diff)}</td>`;
    });
    tr.innerHTML = html;
    body.appendChild(tr);
  });
  table.appendChild(body);
  wrap.appendChild(document.createElement("div")).className = "table-scroll";
  wrap.lastChild.appendChild(table);
  return wrap;
}

function buildSingleDetailTable(title, rows) {
  const wrap = document.createElement("div");
  wrap.className = "analytics-block";
  wrap.innerHTML = `<h4>${title}</h4>`;
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "analytics-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Bet-pos</th>
        <th>Namn</th>
        <th>Tabell</th>
        <th>Diff</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.predictedPosition}</td>
      <td>${r.driverName || r.teamName}</td>
      <td>${r.actual ?? "–"}</td>
      <td class="${diffClass(r.diff)}">${formatDiff(r.diff)}</td>
    `;
    tbody.appendChild(tr);
  });
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4">Inga bets.</td></tr>`;
  }
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}

function renderSingleMode(container, userId, driverMap, constructorMap) {
  const user = state.users.find((u) => u.id === userId);
  if (!user) {
    container.innerHTML = `<p class="info">Välj en spelare.</p>`;
    return;
  }
  const stats = computeUserSeasonStats(userId, driverMap, constructorMap);
  const summary = document.createElement("div");
  summary.className = "analytics-summary";
  summary.innerHTML = `
    <p><strong>${user.name}</strong> — total diff: <strong>${stats.totalCount ? stats.totalDiff : "–"}</strong>
    · exakta träffar: ${stats.exactHits} · nära (±1): ${stats.closeHits}</p>
  `;
  container.appendChild(summary);
  container.appendChild(buildSingleDetailTable("Förare", stats.driverRows));
  container.appendChild(buildSingleDetailTable("Stall", stats.teamRows));
}

function getCompareRows(kind, userIds, driverMap, constructorMap) {
  const users = state.users.filter((u) => userIds.includes(u.id));
  const labelMap = new Map();

  users.forEach((u) => {
    const stats = computeUserSeasonStats(u.id, driverMap, constructorMap);
    const rows = kind === "driver" ? stats.driverRows : stats.teamRows;
    rows.forEach((r) => {
      const key =
        kind === "driver"
          ? `d-${r.driverNumber}`
          : `t-${normalizeKey(r.teamName)}`;
      const label = kind === "driver" ? r.driverName : r.teamName;
      if (!labelMap.has(key)) {
        labelMap.set(key, {
          label,
          actual: r.actual,
          byUser: {}
        });
      }
      const entry = labelMap.get(key);
      if (r.actual && !entry.actual) entry.actual = r.actual;
      entry.byUser[u.id] = {
        predicted: r.predictedPosition,
        diff: r.diff
      };
    });
  });

  return Array.from(labelMap.values()).sort(
    (a, b) => (a.actual ?? 999) - (b.actual ?? 999)
  );
}

function renderCompareMode(container, userIds, driverMap, constructorMap) {
  if (userIds.length === 0) {
    container.innerHTML = `<p class="info">Välj minst en spelare att jämföra.</p>`;
    return;
  }
  const users = state.users.filter((u) => userIds.includes(u.id));
  container.appendChild(
    buildComparisonTable(
      "Förare – jämförelse mot tabellen",
      getCompareRows("driver", userIds, driverMap, constructorMap),
      users,
      "driver"
    )
  );
  container.appendChild(
    buildComparisonTable(
      "Stall – jämförelse mot tabellen",
      getCompareRows("team", userIds, driverMap, constructorMap),
      users,
      "team"
    )
  );
}

function renderGroupMode(container, userIds, driverMap, constructorMap) {
  if (userIds.length === 0) {
    container.innerHTML = `<p class="info">Välj spelare att inkludera i gruppanalysen.</p>`;
    return;
  }

  ["driver", "team"].forEach((kind) => {
    const rows = getCompareRows(kind, userIds, driverMap, constructorMap);
    const block = document.createElement("div");
    block.className = "analytics-block";
    block.innerHTML = `<h4>${kind === "driver" ? "Förare" : "Stall"} – gruppens gissningar</h4>`;
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "analytics-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Faktisk</th>
          <th>${kind === "driver" ? "Förare" : "Stall"}</th>
          <th>Snitt bet</th>
          <th>Snitt |diff|</th>
          <th>Spridning</th>
          <th>Antal gissningar</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");

    rows.forEach((row) => {
      const preds = Object.values(row.byUser)
        .map((c) => c.predicted)
        .filter((p) => p != null);
      const diffs = Object.values(row.byUser)
        .map((c) => c.diff)
        .filter((d) => d != null)
        .map((d) => Math.abs(Number(d)));
      if (preds.length === 0) return;

      const avgPred = preds.reduce((a, b) => a + b, 0) / preds.length;
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const spread = Math.max(...preds) - Math.min(...preds);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.actual ?? "–"}</td>
        <td>${row.label}</td>
        <td>${avgPred.toFixed(1)}</td>
        <td class="${diffClass(avgDiff)}">${avgDiff.toFixed(1)}</td>
        <td>${spread}</td>
        <td>${preds.length}</td>
      `;
      tbody.appendChild(tr);
    });

    if (tbody.children.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6">Ingen data.</td></tr>`;
    }
    scroll.appendChild(table);
    block.appendChild(scroll);
    container.appendChild(block);
  });
}

function renderAnalyticsContent(driverMap, constructorMap) {
  const container = $("analytics-content");
  container.innerHTML = "";

  if (state.analyticsMode === "single") {
    renderSingleMode(
      container,
      state.singleUserId || state.users[0]?.id,
      driverMap,
      constructorMap
    );
  } else if (state.analyticsMode === "compare") {
    renderCompareMode(container, state.selectedUserIds, driverMap, constructorMap);
  } else {
    renderGroupMode(container, state.selectedUserIds, driverMap, constructorMap);
  }
}

function renderDashboard() {
  const driverMap = buildDriverStandingsMap();
  const constructorMap = buildConstructorStandingsMap();
  const statsList = allUserStats(driverMap, constructorMap);

  const updatedEl = $("dashboard-updated");
  if (state.standingsUpdatedAt) {
    updatedEl.textContent = `Tabell uppdaterad: ${new Date(
      state.standingsUpdatedAt
    ).toLocaleString()}`;
  } else {
    updatedEl.textContent = "";
  }

  renderRaceLeaderboard(driverMap, constructorMap);
  renderKpis(statsList);
  renderSeasonRanking(statsList);
  renderUserPicker();
  renderAnalyticsContent(driverMap, constructorMap);
}

function setupToolbar() {
  document.querySelectorAll(".mode-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.analyticsMode = btn.dataset.mode;
      document.querySelectorAll(".mode-tab").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      renderUserPicker();
      renderAnalyticsContent(
        buildDriverStandingsMap(),
        buildConstructorStandingsMap()
      );
    });
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  await Promise.all([
    loadMetadata(),
    loadSummary(),
    loadStandings(),
    loadRaceStandings()
  ]);

  if (state.users.length > 0) {
    state.singleUserId = state.users[0].id;
    state.selectedUserIds = state.users.map((u) => u.id);
  }

  setupToolbar();
  renderDashboard();
});
