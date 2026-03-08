//update
const API_BASE = "/api";

const state = {
  seasonYear: null,
  seasonLocked: false,
  seasonOverrideOpen: false,
  users: [],
  currentUserId: null,
  sessions: [],
  drivers: [],
  teams: [],
  currentSeasonBet: null,
  currentRaceBet: null,
  currentSessionKey: null
};

function $(id) {
  return document.getElementById(id);
}

function formatRaceOption(session) {
  const date = new Date(session.date_start || session.session_start_utc);
  const name = session.meeting_name || session.circuit_short_name || "Race";
  return `${name} (${date.toLocaleDateString()})`;
}

async function loadMetadata() {
  const res = await fetch(`${API_BASE}/metadata`);
  const data = await res.json();

  state.seasonYear = data.seasonYear;
  state.seasonLocked = !!data.seasonLocked;
  state.seasonOverrideOpen = !!data.seasonOverrideOpen;
  state.users = data.users;
  state.sessions = data.sessions;
  state.drivers = data.drivers;
  state.teams = data.teams;

  populateUserSelect();
  populateRaceSelect();
  updateSeasonLockInfo();
}

function populateUserSelect() {
  const select = $("user-select");
  select.innerHTML = '<option value="">-- Välj --</option>';
  state.users.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.name;
    select.appendChild(opt);
  });
}

function populateRaceSelect() {
  const select = $("race-select");
  select.innerHTML = '<option value="">-- Välj race --</option>';

  const now = new Date();

  state.sessions
    .filter((s) => new Date(s.date_start || s.session_start_utc) >= now)
    .sort(
      (a, b) =>
        new Date(a.date_start || a.session_start_utc) -
        new Date(b.date_start || b.session_start_utc)
    )
    .forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.session_key;
      opt.textContent = formatRaceOption(s);
      select.appendChild(opt);
    });
}

function renderSeasonBet() {
  const driversBody = $("drivers-table").querySelector("tbody");
  const teamsBody = $("teams-table").querySelector("tbody");

  driversBody.innerHTML = "";
  teamsBody.innerHTML = "";

  const driverMap = new Map();
  const teamMap = new Map();

  if (state.currentSeasonBet) {
    state.currentSeasonBet.driverPredictions.forEach((p) => {
      driverMap.set(p.driver_number, p.predictedPosition);
    });
    state.currentSeasonBet.teamPredictions.forEach((p) => {
      teamMap.set(p.team_name, p.predictedPosition);
    });
  }

  state.drivers
    .slice()
    .sort((a, b) => Number(a.driver_number) - Number(b.driver_number))
    .forEach((d) => {
      const tr = document.createElement("tr");

      const tdNum = document.createElement("td");
      tdNum.textContent = d.driver_number;
      tr.appendChild(tdNum);

      const tdImg = document.createElement("td");
      const img = document.createElement("img");
      img.src = d.headshot_url || "";
      img.alt = d.full_name;
      img.className = "driver-headshot";
      tdImg.appendChild(img);
      tr.appendChild(tdImg);

      const tdName = document.createElement("td");
      tdName.textContent = d.full_name;
      tr.appendChild(tdName);

      const tdTeam = document.createElement("td");
      tdTeam.textContent = d.team_name || "-";
      tr.appendChild(tdTeam);

      const tdPos = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "30";
      input.value = driverMap.get(d.driver_number) || "";
      input.dataset.driverNumber = d.driver_number;
      input.dataset.positionType = "driver";
      if (state.seasonLocked && !state.seasonOverrideOpen) input.disabled = true;
      input.addEventListener("change", () => {
        enforceUniquePositions(input.dataset.positionType, input);
      });
      tdPos.appendChild(input);
      tr.appendChild(tdPos);

      driversBody.appendChild(tr);
    });

  state.teams.forEach((team) => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = team;
    tr.appendChild(tdName);

    const tdPos = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "20";
    input.value = teamMap.get(team) || "";
    input.dataset.teamName = team;
    input.dataset.positionType = "team";
    if (state.seasonLocked && !state.seasonOverrideOpen) input.disabled = true;
    input.addEventListener("change", () => {
      enforceUniquePositions(input.dataset.positionType, input);
    });
    tdPos.appendChild(input);
    tr.appendChild(tdPos);

    teamsBody.appendChild(tr);
  });
}

function enforceUniquePositions(type, changedInput) {
  const selector =
    type === "driver"
      ? "input[data-driver-number]"
      : "input[data-team-name]";
  const tableId = type === "driver" ? "drivers-table" : "teams-table";
  const inputs = Array.from($(tableId).querySelectorAll(selector));
  const seen = new Set();
  let duplicateFound = false;

  inputs.forEach((input) => {
    const value = Number(input.value);
    if (!value) return;
    if (seen.has(value)) {
      if (input === changedInput) {
        input.value = "";
      }
      duplicateFound = true;
    } else {
      seen.add(value);
    }
  });

  if (duplicateFound) {
    const status = $("season-status");
    if (status) {
      status.textContent =
        type === "driver"
          ? "Samma placering kan bara användas en gång per förare."
          : "Samma placering kan bara användas en gång per stall.";
      setTimeout(() => {
        status.textContent = "";
      }, 3000);
    }
  }
}

function hasDuplicatePositions(type) {
  const selector =
    type === "driver"
      ? "input[data-driver-number]"
      : "input[data-team-name]";
  const tableId = type === "driver" ? "drivers-table" : "teams-table";
  const inputs = Array.from($(tableId).querySelectorAll(selector));
  const seen = new Set();
  for (const input of inputs) {
    const value = Number(input.value);
    if (!value) continue;
    if (seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

function getSelectedRaceDrivers() {
  const p1 = Number($("p1-select").value) || null;
  const p2 = Number($("p2-select").value) || null;
  const p3 = Number($("p3-select").value) || null;
  return { p1, p2, p3 };
}

function renderRaceDropdowns() {
  const { p1, p2, p3 } = getSelectedRaceDrivers();
  const selects = [
    { el: $("p1-select"), current: p1 },
    { el: $("p2-select"), current: p2 },
    { el: $("p3-select"), current: p3 }
  ];

  selects.forEach((entry) => {
    const { el, current } = entry;
    el.innerHTML = '<option value="">-- Välj förare --</option>';

    state.drivers.forEach((d) => {
      const id = Number(d.driver_number);

      const alreadyUsed =
        (id === p1 && current !== p1) ||
        (id === p2 && current !== p2) ||
        (id === p3 && current !== p3);

      if (alreadyUsed) return;

      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${d.driver_number} - ${d.full_name}`;
      if (current && id === current) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

function updateSeasonLockInfo() {
  const infoEl = $("season-lock-info");
  const saveBtn = $("save-season-btn");
  const tabSeason = $("tab-season");
  const seasonSection = $("season-section");
  const tabRace = $("tab-race");

  if (!infoEl || !saveBtn || !tabSeason || !seasonSection || !tabRace) return;

  if (state.seasonLocked && !state.seasonOverrideOpen) {
    infoEl.textContent = "Säsongen har startat – årsbet är låst och kan inte ändras.";
    saveBtn.disabled = true;
    // Dölj årsbet-fliken och sektionen helt i vanliga gränssnittet
    tabSeason.style.display = "none";
    seasonSection.classList.add("hidden");
    // Om årsbet var aktiv tabb, växla till race
    if (tabSeason.classList.contains("active")) {
      tabSeason.classList.remove("active");
      tabRace.classList.add("active");
      $("race-section").classList.remove("hidden");
      seasonSection.classList.add("hidden");
    }
  } else {
    if (state.seasonLocked && state.seasonOverrideOpen) {
      infoEl.textContent =
        "Årsbett är tillfälligt öppna av admin – du kan ändra ditt årsbett.";
    } else {
      infoEl.textContent = "";
    }
    saveBtn.disabled = false;
    tabSeason.style.display = "";
  }
}

async function loadSeasonBetForUser(userId) {
  const res = await fetch(`${API_BASE}/bets/season/${userId}`);
  state.currentSeasonBet = await res.json();
  renderSeasonBet();
}

async function loadRaceBetForUserAndSession(userId, sessionKey) {
  const res = await fetch(`${API_BASE}/bets/race/${sessionKey}/${userId}`);
  const bet = await res.json();
  state.currentRaceBet = bet && bet.session_key ? bet : null;

  const p1Select = $("p1-select");
  const p2Select = $("p2-select");
  const p3Select = $("p3-select");

  p1Select.value = "";
  p2Select.value = "";
  p3Select.value = "";

  if (state.currentRaceBet) {
    if (state.currentRaceBet.p1_driver_number) {
      p1Select.value = state.currentRaceBet.p1_driver_number;
    }
    if (state.currentRaceBet.p2_driver_number) {
      p2Select.value = state.currentRaceBet.p2_driver_number;
    }
    if (state.currentRaceBet.p3_driver_number) {
      p3Select.value = state.currentRaceBet.p3_driver_number;
    }
  }

  renderRaceDropdowns();
}

function updateCircuitImage() {
  const img = $("circuit-image");
  if (!state.currentSessionKey) {
    img.classList.add("hidden");
    img.src = "";
    return;
  }

  const session = state.sessions.find(
    (s) => String(s.session_key) === String(state.currentSessionKey)
  );
  if (session && session.circuit_image) {
    img.src = session.circuit_image;
    img.alt =
      session.meeting_name ||
      session.circuit_short_name ||
      "Bana";
    img.classList.remove("hidden");
  } else {
    img.classList.add("hidden");
    img.src = "";
  }
}

async function addUser() {
  // Tom - användarhantering flyttad till admin-sidan
}

async function deleteUser() {
  // Tom - användarhantering flyttad till admin-sidan
}

async function loadSummary() {
  // Tom - sammanställning flyttad till admin-sidan
}

function renderSummary() {
  // Tom - sammanställning flyttad till admin-sidan
}

function setupEventListeners() {
  $("user-select").addEventListener("change", async (e) => {
    const userId = e.target.value;
    state.currentUserId = userId || null;

    const seasonBtn = $("tab-season");
    const raceBtn = $("tab-race");

    if (state.currentUserId) {
      seasonBtn.disabled = state.seasonLocked && !state.seasonOverrideOpen;
      raceBtn.disabled = false;

      if (!state.seasonLocked || state.seasonOverrideOpen) {
        await loadSeasonBetForUser(state.currentUserId);
        openTab("season");
      } else {
        openTab("race");
      }

    } else {
      seasonBtn.disabled = true;
      raceBtn.disabled = true;
      $("season-section").classList.add("hidden");
      $("race-section").classList.add("hidden");
    }
  });

  $("tab-season").addEventListener("click", () => openTab("season"));
  $("tab-race").addEventListener("click", () => openTab("race"));

  $("save-season-btn").addEventListener("click", saveSeasonBet);
  $("save-race-btn").addEventListener("click", saveRaceBet);

  $("race-select").addEventListener("change", async (e) => {
    const sessionKey = e.target.value;
    state.currentSessionKey = sessionKey || null;
    if (!state.currentSessionKey || !state.currentUserId) return;

    updateCircuitImage();
    await loadRaceBetForUserAndSession(state.currentUserId, state.currentSessionKey);
  });

  ["p1-select", "p2-select", "p3-select"].forEach((id) => {
    $(id).addEventListener("change", () => {
      renderRaceDropdowns();
    });
  });

  // Användarhantering finns endast på admin-sidan
}

function openTab(name) {
  $("tab-season").classList.toggle("active", name === "season");
  $("tab-race").classList.toggle("active", name === "race");

  $("season-section").classList.toggle("hidden", name !== "season");
  $("race-section").classList.toggle("hidden", name !== "race");
}

async function saveSeasonBet() {
  if (!state.currentUserId) return;
  if (state.seasonLocked && !state.seasonOverrideOpen) {
    $("season-status").textContent =
      "Säsongen har startat – du kan inte längre ändra årsbet.";
    return;
  }
  if (hasDuplicatePositions("driver") || hasDuplicatePositions("team")) {
    $("season-status").textContent =
      "Varje placering får bara användas en gång per lista.";
    return;
  }

  const driversInputs = $("drivers-table").querySelectorAll(
    "input[data-driver-number]"
  );
  const teamsInputs = $("teams-table").querySelectorAll("input[data-team-name]");

  const driverPredictions = [];
  driversInputs.forEach((input) => {
    const pos = Number(input.value);
    if (!pos) return;
    driverPredictions.push({
      driver_number: Number(input.dataset.driverNumber),
      predictedPosition: pos
    });
  });

  const teamPredictions = [];
  teamsInputs.forEach((input) => {
    const pos = Number(input.value);
    if (!pos) return;
    teamPredictions.push({
      team_name: input.dataset.teamName,
      predictedPosition: pos
    });
  });

  const body = {
    driverPredictions,
    teamPredictions
  };

  const res = await fetch(`${API_BASE}/bets/season/${state.currentUserId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const saved = await res.json();
  state.currentSeasonBet = saved;
  $("season-status").textContent = "Årsbet sparat!";
  setTimeout(() => {
    $("season-status").textContent = "";
  }, 3000);
}

async function saveRaceBet() {
  if (!state.currentUserId || !state.currentSessionKey) return;

  const sessionKey = state.currentSessionKey;
  const { p1, p2, p3 } = getSelectedRaceDrivers();

  const session = state.sessions.find(
    (s) => String(s.session_key) === String(sessionKey)
  );

  const body = {
    raceName: session
      ? session.meeting_name || session.circuit_short_name || ""
      : "",
    p1_driver_number: p1,
    p2_driver_number: p2,
    p3_driver_number: p3
  };

  const res = await fetch(
    `${API_BASE}/bets/race/${sessionKey}/${state.currentUserId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const saved = await res.json();
  state.currentRaceBet = saved;
  $("race-status").textContent = "Racebet sparat!";
  setTimeout(() => {
    $("race-status").textContent = "";
  }, 3000);
}

window.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadMetadata();
});

