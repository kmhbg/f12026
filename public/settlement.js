const API_BASE = "/api";

const settlementState = {
  users: [],
  sessions: [],
  drivers: []
};

function $(id) {
  return document.getElementById(id);
}

async function loadMetadata() {
  const res = await fetch(`${API_BASE}/metadata`);
  const data = await res.json();
  settlementState.users = data.users || [];
  settlementState.sessions = data.sessions || [];
  settlementState.drivers = data.drivers || [];
  populateRaceSelect();
}

function populateRaceSelect() {
  const select = $("settlement-race-select");
  select.innerHTML = '<option value="">-- Välj race --</option>';

  const now = new Date();
  settlementState.sessions
    .filter((s) => new Date(s.date_start || s.session_start_utc) <= now)
    .sort(
      (a, b) =>
        new Date(b.date_start || b.session_start_utc) -
        new Date(a.date_start || a.session_start_utc)
    )
    .forEach((s) => {
      const date = new Date(s.date_start || s.session_start_utc).toLocaleDateString();
      const label = `${s.meeting_name || s.circuit_short_name || "Race"} – ${date}`;
      const opt = document.createElement("option");
      opt.value = s.session_key;
      opt.textContent = label;
      select.appendChild(opt);
    });
}

function renderPending() {
  $("settlement-status").textContent =
    "Resultat saknas ännu för valt race.";
  $("settlement-result-table").querySelector("tbody").innerHTML = "";
  $("settlement-winners-table").querySelector("tbody").innerHTML = "";
  $("settlement-total-bets").textContent = "-";
  $("settlement-payout-total").textContent = "-";
  $("settlement-pot").textContent = "-";
}

function renderSettlement(data) {
  const statusEl = $("settlement-status");
  statusEl.textContent = "";

  const { settlement, pot } = data;
  const resultBody = $("settlement-result-table").querySelector("tbody");
  const winnersBody = $("settlement-winners-table").querySelector("tbody");
  resultBody.innerHTML = "";
  winnersBody.innerHTML = "";

  const driverByNumber = new Map(
    settlementState.drivers.map((d) => [Number(d.driver_number), d])
  );
  const userById = new Map(
    settlementState.users.map((u) => [u.id, u])
  );

  settlement.result.forEach((num, idx) => {
    const tr = document.createElement("tr");
    const d = driverByNumber.get(Number(num));
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${d ? d.full_name : `#${num}`}</td>
    `;
    resultBody.appendChild(tr);
  });

  if (settlement.winners.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="2">Inga vinnare.</td>`;
    winnersBody.appendChild(tr);
  } else {
    settlement.winners.forEach((userId) => {
      const tr = document.createElement("tr");
      const user = userById.get(userId);
      const name = user ? user.name : userId;
      tr.innerHTML = `
        <td>${name}</td>
        <td>${settlement.payoutPerWinner.toFixed(2)} kr</td>
      `;
      winnersBody.appendChild(tr);
    });
  }

  $("settlement-total-bets").textContent = settlement.totalBets;
  const potUsed = settlement.potUsed ? ` (inkl. pott ${settlement.potUsed} kr)` : "";
  $("settlement-payout-total").textContent = `${settlement.payoutTotal} kr${potUsed}`;
  $("settlement-pot").textContent = `${pot} kr`;
}

async function loadSettlement(sessionKey) {
  if (!sessionKey) return;
  const res = await fetch(`${API_BASE}/race/settlement/${sessionKey}`);
  if (!res.ok) {
    $("settlement-status").textContent = "Kunde inte hämta rättning.";
    return;
  }
  const data = await res.json();
  if (data.status !== "settled") {
    renderPending();
    return;
  }
  renderSettlement(data);
}

window.addEventListener("DOMContentLoaded", async () => {
  await loadMetadata();
  $("settlement-race-select").addEventListener("change", (e) => {
    loadSettlement(e.target.value);
  });
});
