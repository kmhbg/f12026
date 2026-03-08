//update
const API_BASE = "/api";

const adminState = {
  seasonYear: null,
  seasonLocked: false,
  seasonOverrideOpen: false,
  users: [],
  sessions: [],
  drivers: [],
  summary: null,
  viewerId: null
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

async function loadMetadata() {
  const res = await fetch(`${API_BASE}/metadata`);
  const data = await res.json();

  adminState.seasonYear = data.seasonYear;
  adminState.seasonLocked = !!data.seasonLocked;
  adminState.seasonOverrideOpen = !!data.seasonOverrideOpen;
  adminState.users = data.users;
  adminState.sessions = data.sessions;
  adminState.drivers = data.drivers;

  populateUserSelects();
  populateRaceSelect();
  updateSeasonOverrideUI();
}

function populateUserSelects() {
  const userSelect = $("admin-user-select");
  const viewerSelect = $("admin-viewer-select");

  userSelect.innerHTML = '<option value="">-- Välj --</option>';
  viewerSelect.innerHTML = '<option value="">-- Välj --</option>';

  adminState.users.forEach((u) => {
    const opt1 = document.createElement("option");
    opt1.value = u.id;
    opt1.textContent = u.name;
    userSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = u.id;
    opt2.textContent = u.name;
    viewerSelect.appendChild(opt2);
  });
}

function populateRaceSelect() {
  const raceSelect = $("admin-race-select");
  if (!raceSelect) return;

  raceSelect.innerHTML = '<option value="">-- Välj race --</option>';

  const now = new Date();

  adminState.sessions
    .slice()
    .sort(
      (a, b) =>
        new Date(a.date_start || a.session_start_utc) -
        new Date(b.date_start || b.session_start_utc)
    )
    .forEach((s) => {
      const date = new Date(
        s.date_start || s.session_start_utc || now.toISOString()
      ).toLocaleDateString();
      const label = `${s.meeting_name || s.circuit_short_name || "Race"} – ${date}`;
      const opt = document.createElement("option");
      opt.value = s.session_key;
      opt.textContent = label;
      raceSelect.appendChild(opt);
    });
}

async function adminAddUser() {
  const nameInput = $("admin-new-user-name");
  const statusEl = $("admin-user-status");

  const name = nameInput.value.trim();
  if (!name) {
    statusEl.textContent = "Ange ett namn för den nya bettaren.";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });

    if (!res.ok) {
      statusEl.textContent = "Kunde inte lägga till användare.";
      return;
    }

    const user = await res.json();
    adminState.users.push(user);
    populateUserSelects();
    nameInput.value = "";
    statusEl.textContent = "Användare tillagd.";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Ett fel uppstod vid skapande av användare.";
  }
}

async function adminDeleteUser() {
  const statusEl = $("admin-user-status");
  const userSelect = $("admin-user-select");
  const userId = userSelect.value;

  if (!userId) {
    statusEl.textContent = "Välj först vilken bettare du vill ta bort.";
    return;
  }

  const user = adminState.users.find((u) => u.id === userId);
  const label = user ? user.name : userId;
  const confirmed = window.confirm(
    `Är du säker på att du vill ta bort bettaren "${label}" och alla dess bets?`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${userId}`, {
      method: "DELETE"
    });
    if (!res.ok) {
      statusEl.textContent = "Kunde inte ta bort användare.";
      return;
    }

    adminState.users = adminState.users.filter((u) => u.id !== userId);
    populateUserSelects();

    statusEl.textContent = "Användare borttagen.";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Ett fel uppstod vid borttagning av användare.";
  }
}

async function loadSummary() {
  const viewerSelect = $("admin-viewer-select");
  const statusEl = $("admin-summary-status");
  const viewerId = viewerSelect.value;

  if (!viewerId) {
    statusEl.textContent = "Välj en användare att visa sammanställningen som.";
    return;
  }

  adminState.viewerId = viewerId;

  try {
    const res = await fetch(
      `${API_BASE}/bets/summary?userId=${encodeURIComponent(viewerId)}`
    );
    if (!res.ok) {
      statusEl.textContent = "Kunde inte ladda sammanställning.";
      return;
    }
    const data = await res.json();
    adminState.summary = data;
    renderSummary();
    statusEl.textContent = "Sammanställning uppdaterad.";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Ett fel uppstod vid hämtning av sammanställning.";
  }
}

function renderSummary() {
  if (!adminState.summary) return;

  const seasonContainer = $("admin-summary-season");
  const racesContainer = $("admin-summary-races");

  seasonContainer.innerHTML = "";
  racesContainer.innerHTML = "";

  const driverByNumber = new Map(
    adminState.drivers.map((d) => [Number(d.driver_number), d])
  );

  // Årsbett per användare (egen tabell per användare)
  adminState.summary.users.forEach((u) => {
    const bet = adminState.summary.seasonBets.find(
      (b) => b.userId === u.id && b.seasonYear === adminState.summary.seasonYear
    );

    const wrapper = document.createElement("div");
    wrapper.className = "section-block";

    const heading = document.createElement("h4");
    heading.textContent = u.name;
    wrapper.appendChild(heading);

    const driverMap = new Map();
    const teamMap = new Map();

    if (bet && Array.isArray(bet.driverPredictions)) {
      bet.driverPredictions.forEach((p) => {
        const d = driverByNumber.get(Number(p.driver_number));
        const name = d ? d.full_name : `#${p.driver_number}`;
        driverMap.set(Number(p.predictedPosition), name);
      });
    }

    if (bet && Array.isArray(bet.teamPredictions)) {
      bet.teamPredictions.forEach((p) => {
        teamMap.set(Number(p.predictedPosition), p.team_name);
      });
    }

    const maxPos = Math.max(
      driverMap.size > 0 ? Math.max(...driverMap.keys()) : 0,
      teamMap.size > 0 ? Math.max(...teamMap.keys()) : 0
    );

    const seasonTable = document.createElement("table");
    seasonTable.innerHTML = `
      <thead>
        <tr>
          <th>Pos</th>
          <th>Förare</th>
          <th>Stall</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const seasonBody = seasonTable.querySelector("tbody");

    if (maxPos === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="3">Inga årsbett.</td>`;
      seasonBody.appendChild(tr);
    } else {
      for (let pos = 1; pos <= maxPos; pos += 1) {
        const tr = document.createElement("tr");
        const driverName = driverMap.get(pos) || "-";
        const teamName = teamMap.get(pos) || "-";
        tr.innerHTML = `
          <td>${pos}</td>
          <td>${driverName}</td>
          <td>${teamName}</td>
        `;
        seasonBody.appendChild(tr);
      }
    }

    wrapper.appendChild(wrapTable(seasonTable));
    seasonContainer.appendChild(wrapper);
  });

  // Racebett per race och användare
  const raceBetsBySession = new Map();
  adminState.summary.raceBets.forEach((b) => {
    const key = String(b.session_key);
    if (!raceBetsBySession.has(key)) raceBetsBySession.set(key, []);
    raceBetsBySession.get(key).push(b);
  });

  const sessionsByKey = new Map(
    adminState.sessions.map((s) => [String(s.session_key), s])
  );

  Array.from(raceBetsBySession.entries())
    .sort(([aKey], [bKey]) => Number(aKey) - Number(bKey))
    .forEach(([sessionKey, bets]) => {
      const session = sessionsByKey.get(sessionKey);
      if (!session) return;

      const wrapper = document.createElement("div");
      wrapper.className = "section-block";

      const heading = document.createElement("h4");
      const date = new Date(
        session.date_start || session.session_start_utc
      ).toLocaleString();
      heading.textContent = `${session.meeting_name || "Race"} – ${date}`;
      wrapper.appendChild(heading);

      const table = document.createElement("table");
      table.innerHTML = `
        <thead>
          <tr>
            <th>Användare</th>
            <th>P1</th>
            <th>P2</th>
            <th>P3</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const body = table.querySelector("tbody");

      bets
        .slice()
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .forEach((bet) => {
          const tr = document.createElement("tr");
          const user = adminState.summary.users.find((u) => u.id === bet.userId);

          const tdUser = document.createElement("td");
          tdUser.textContent = user ? user.name : bet.userId;
          tr.appendChild(tdUser);

          if (bet.hidden) {
            const td = document.createElement("td");
            td.colSpan = 3;
            td.textContent = "Dolt tills racet har startat.";
            tr.appendChild(td);
          } else {
            [1, 2, 3].forEach((pos) => {
              const td = document.createElement("td");
              const key =
                pos === 1
                  ? "p1_driver_number"
                  : pos === 2
                  ? "p2_driver_number"
                  : "p3_driver_number";
              const num = bet[key];
              if (num) {
                const d = driverByNumber.get(Number(num));
                td.textContent = d ? d.full_name : `#${num}`;
              } else {
                td.textContent = "-";
              }
              tr.appendChild(td);
            });
          }

          body.appendChild(tr);
        });

      wrapper.appendChild(wrapTable(table));
      racesContainer.appendChild(wrapper);
    });
}

function renderSingleRaceSummary(sessionKey) {
  const container = $("admin-summary-race-single");
  if (!container) return;
  container.innerHTML = "";

  if (!adminState.summary) {
    container.textContent = "Ladda först sammanställning ovan.";
    return;
  }

  const bets = adminState.summary.raceBets.filter(
    (b) => String(b.session_key) === String(sessionKey)
  );
  if (bets.length === 0) {
    container.textContent = "Inga bets hittades för detta race.";
    return;
  }

  const sessionsByKey = new Map(
    adminState.sessions.map((s) => [String(s.session_key), s])
  );
  const session = sessionsByKey.get(String(sessionKey));

  const driverByNumber = new Map(
    adminState.drivers.map((d) => [Number(d.driver_number), d])
  );

  const heading = document.createElement("h4");
  if (session) {
    const date = new Date(
      session.date_start || session.session_start_utc
    ).toLocaleString();
    heading.textContent = `${session.meeting_name || "Race"} – ${date}`;
  } else {
    heading.textContent = "Valt race";
  }
  container.appendChild(heading);

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>Användare</th>
        <th>P1</th>
        <th>P2</th>
        <th>P3</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const body = table.querySelector("tbody");

  bets
    .slice()
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .forEach((bet) => {
      const tr = document.createElement("tr");
      const user = adminState.summary.users.find((u) => u.id === bet.userId);

      const tdUser = document.createElement("td");
      tdUser.textContent = user ? user.name : bet.userId;
      tr.appendChild(tdUser);

      if (bet.hidden) {
        const td = document.createElement("td");
        td.colSpan = 3;
        td.textContent = "Dolt tills racet har startat.";
        tr.appendChild(td);
      } else {
        [1, 2, 3].forEach((pos) => {
          const td = document.createElement("td");
          const key =
            pos === 1
              ? "p1_driver_number"
              : pos === 2
              ? "p2_driver_number"
              : "p3_driver_number";
          const num = bet[key];
          if (num) {
            const d = driverByNumber.get(Number(num));
            td.textContent = d ? d.full_name : `#${num}`;
          } else {
            td.textContent = "-";
          }
          tr.appendChild(td);
        });
      }

      body.appendChild(tr);
    });

  container.appendChild(wrapTable(table));
}

function updateSeasonOverrideUI() {
  const btn = $("admin-season-override-btn");
  const stateEl = $("admin-season-override-state");
  if (!btn || !stateEl) return;

  if (adminState.seasonOverrideOpen) {
    btn.textContent = "Stäng årsbett";
    stateEl.textContent = "Årsbett är tillfälligt öppna.";
  } else {
    btn.textContent = "Öppna årsbett";
    stateEl.textContent = "Årsbett är låsta enligt säsongsstart.";
  }
}

async function toggleSeasonOverride() {
  const statusEl = $("admin-season-override-status");
  const nextValue = !adminState.seasonOverrideOpen;

  try {
    const res = await fetch(`${API_BASE}/settings/season-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextValue })
    });

    if (!res.ok) {
      statusEl.textContent = "Kunde inte uppdatera årsbett-status.";
      return;
    }

    const data = await res.json();
    adminState.seasonOverrideOpen = !!data.seasonOverrideOpen;
    updateSeasonOverrideUI();
    statusEl.textContent = "Status uppdaterad.";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Ett fel uppstod vid uppdatering.";
  }
}

function adminShowRaceSummary() {
  const raceSelect = $("admin-race-select");
  const sessionKey = raceSelect ? raceSelect.value : "";
  const statusEl = $("admin-summary-status");

  if (!sessionKey) {
    statusEl.textContent = "Välj ett race att visa sammanställning för.";
    return;
  }

  if (!adminState.summary) {
    statusEl.textContent = "Ladda först sammanställning ovan.";
    return;
  }

  renderSingleRaceSummary(sessionKey);
}

function setupAdminListeners() {
  $("admin-add-user-btn").addEventListener("click", adminAddUser);
  $("admin-delete-user-btn").addEventListener("click", adminDeleteUser);
  $("admin-load-summary-btn").addEventListener("click", loadSummary);
  $("admin-show-race-btn").addEventListener("click", adminShowRaceSummary);
  const seasonOverrideBtn = $("admin-season-override-btn");
  if (seasonOverrideBtn) {
    seasonOverrideBtn.addEventListener("click", toggleSeasonOverride);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  setupAdminListeners();
  await loadMetadata();
});

