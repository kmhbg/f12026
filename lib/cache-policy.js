// Vilka cachade sessioner som ska sparas: de N senaste racen, pinnade
// sessioner, sessioner som använts nyligen (replay av äldre race byggs på
// begäran) och sådant som byggs just nu. Allt annat får rensas.

const RECENT_USE_MS = 24 * 60 * 60 * 1000;

function selectCachesToPrune({ cachedKeys, entries = [], latestRaceKeys = [], buildingKeys = [], now = Date.now(), recentUseMs = RECENT_USE_MS }) {
  const keep = new Set([...latestRaceKeys, ...buildingKeys].map(String));
  const byKey = new Map(entries.map((e) => [String(e.sessionKey), e]));
  return cachedKeys
    .map(String)
    .filter((key) => {
      if (keep.has(key)) return false;
      const entry = byKey.get(key);
      if (entry?.pinned) return false;
      const lastUsed = Date.parse(entry?.lastUsedAt || entry?.builtAt || "");
      return !(Number.isFinite(lastUsed) && now - lastUsed < recentUseMs);
    });
}

module.exports = { selectCachesToPrune, RECENT_USE_MS };
