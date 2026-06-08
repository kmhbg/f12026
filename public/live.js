//update
const API_BASE = "/api";
const POLL_MS = 3000;

const state = {
  timer: null
};

function $(id) {
  return document.getElementById(id);
}

function statusLabel(status) {
  switch (status) {
    case "live":
      return "Pågår";
    case "upcoming":
      return "Kommande";
    case "finished":
      return "Avslutad";
    case "cancelled":
      return "Inställd";
    default:
      return "Okänd";
  }
}

function formatSessionInfo(session) {
  if (!session) return "Ingen session hittades.";
  const name = session.session_name || session.session_type || "Session";
  const circuit = session.circuit_short_name || session.location || "";
  const start = session.date_start ? new Date(session.date_start).toLocaleString("sv-SE") : "";
  return `${name} – ${circuit}${start ? ` (${start})` : ""}`;
}

function drawTrack(canvas, locations, positions) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0d0d0f";
  ctx.fillRect(0, 0, w, h);

  if (!locations.length) {
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Kartan visas när sessionen är live", w / 2, h / 2);
    return;
  }

  const xs = locations.map((l) => l.x);
  const ys = locations.map((l) => l.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 36;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);

  const posByDriver = new Map(positions.map((p) => [p.driver_number, p.position]));

  locations.forEach((loc) => {
    const x = pad + (loc.x - minX) * scale;
    const y = h - pad - (loc.y - minY) * scale;
    const pos = posByDriver.get(loc.driver_number) || "?";
    const isPodium = Number(pos) <= 3;

    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = isPodium ? "#e10600" : "#f5f5f5";
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = isPodium ? "#fff" : "#111";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(pos), x, y);
  });
}

function renderPositions(positions) {
  const tbody = $("live-positions-table").querySelector("tbody");
  tbody.innerHTML = "";

  positions.forEach((row) => {
    const tr = document.createElement("tr");
    const driverName = row.driver?.full_name || `Förare ${row.driver_number}`;
    const teamName = row.driver?.team_name || "";
    tr.innerHTML = `
      <td>${row.position}</td>
      <td>${row.driver_number}</td>
      <td>${driverName}</td>
      <td>${teamName}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function refreshLive() {
  try {
    const res = await fetch(`${API_BASE}/live`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    $("live-session-info").textContent = formatSessionInfo(data.session);
    $("live-status").textContent = `Status: ${statusLabel(data.status)}`;
    $("live-updated").textContent = data.updatedAt
      ? `Senast uppdaterad: ${new Date(data.updatedAt).toLocaleTimeString("sv-SE")}`
      : "";

    renderPositions(data.positions || []);
    drawTrack($("live-track"), data.locations || [], data.positions || []);
  } catch (err) {
    $("live-session-info").textContent = "Kunde inte hämta live-data.";
    $("live-status").textContent = err.message || "Fel vid hämtning";
  }
}

function startPolling() {
  refreshLive();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refreshLive, POLL_MS);
}

window.addEventListener("load", startPolling);
window.addEventListener("beforeunload", () => {
  if (state.timer) clearInterval(state.timer);
});
