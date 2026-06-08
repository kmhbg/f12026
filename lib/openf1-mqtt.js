const mqtt = require("mqtt");
const { OPENF1_MQTT_TOPICS, OPENF1_MQTT_DEFAULTS } = require("./openf1-mqtt-config");

const DEFAULT_TOPICS = OPENF1_MQTT_TOPICS;

const RING_BUFFER_LIMIT = 40;

function parseMessage(payload) {
  try {
    return JSON.parse(payload.toString());
  } catch {
    return null;
  }
}

function rowDateMs(row) {
  return new Date(row?.date || row?.date_start || row?.date_end || 0).getTime();
}

function upsertLatest(map, row, key = "driver_number") {
  const id = row?.[key];
  if (id === undefined || id === null) return;
  const existing = map.get(id);
  const rowMs = rowDateMs(row);
  if (!existing || rowMs >= rowDateMs(existing)) {
    map.set(id, row);
  }
}

function pushRingBuffer(buffer, row, limit = RING_BUFFER_LIMIT) {
  buffer.push(row);
  buffer.sort((a, b) => rowDateMs(b) - rowDateMs(a));
  if (buffer.length > limit) {
    buffer.length = limit;
  }
}

function createSessionState() {
  return {
    session: null,
    positions: new Map(),
    locations: new Map(),
    intervals: new Map(),
    stints: new Map(),
    carData: new Map(),
    lapsByKey: new Map(),
    raceControl: [],
    pitStops: [],
    overtakes: [],
    teamRadio: [],
    weather: null,
    lastMessageAt: null,
    messageCount: 0
  };
}

function createOpenF1MqttIngestor(options = {}) {
  const enabled = options.enabled !== false;
  const broker = options.broker || OPENF1_MQTT_DEFAULTS.broker;
  const port = Number(options.port) || OPENF1_MQTT_DEFAULTS.port;
  const protocol = options.protocol || OPENF1_MQTT_DEFAULTS.protocol;
  const websocketUrl = options.websocketUrl || OPENF1_MQTT_DEFAULTS.websocketUrl;
  const tokenUrl = options.tokenUrl || OPENF1_MQTT_DEFAULTS.tokenUrl;
  const keepalive = Number(options.keepalive) || OPENF1_MQTT_DEFAULTS.keepalive;
  const connectTimeout = Number(options.connectTimeout) || OPENF1_MQTT_DEFAULTS.connectTimeout;
  const qos = Number(options.qos) ?? OPENF1_MQTT_DEFAULTS.qos;
  const authMethod = options.authMethod || OPENF1_MQTT_DEFAULTS.authMethod;
  const configSource = options.configSource || OPENF1_MQTT_DEFAULTS.configSource;
  const username = options.username || null;
  const freshMs = Number(options.freshMs) || 10000;
  const sessionCheckMs = Number(options.sessionCheckMs) || 60000;
  const topics = options.topics || DEFAULT_TOPICS;
  const getAccessToken = options.getAccessToken || null;
  const credentialsAvailable = options.credentialsAvailable === true;
  const detectLiveSession = options.detectLiveSession || null;
  const onLog = options.onLog || ((msg) => console.log(msg));
  const onError = options.onError || ((msg, err) => console.error(msg, err?.message || err));

  let client = null;
  let started = false;
  let connecting = false;
  let accessToken = options.password || options.accessToken || null;
  let tokenExpiresAt = 0;
  let targetSessionKey = null;
  let sessionCheckTimer = null;
  let reconnectTimer = null;
  let lastConnectAt = null;
  let lastDisconnectAt = null;
  let lastError = null;
  let subscribedTopics = [];
  let lastMessageAt = null;
  let messageCount = 0;
  const sessionStates = new Map();

  function log(msg) {
    onLog(`[openf1-mqtt] ${msg}`);
  }

  function err(msg, error) {
    lastError = error?.message || String(error || msg);
    onError(`[openf1-mqtt] ${msg}`, error);
  }

  function getSessionState(sessionKey) {
    const key = String(sessionKey);
    if (!sessionStates.has(key)) {
      sessionStates.set(key, createSessionState());
    }
    return sessionStates.get(key);
  }

  function clearSessionState(sessionKey) {
    sessionStates.delete(String(sessionKey));
  }

  async function resolveAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
      return accessToken;
    }
    if (typeof getAccessToken === "function") {
      const token = await getAccessToken();
      if (token?.access_token) {
        accessToken = token.access_token;
        const expiresIn = Number(token.expires_in) || 3600;
        tokenExpiresAt = Date.now() + expiresIn * 1000;
        return accessToken;
      }
      if (typeof token === "string" && token) {
        accessToken = token;
        tokenExpiresAt = Date.now() + 50 * 60 * 1000;
        return accessToken;
      }
    }
    return accessToken;
  }

  function hasCredentials() {
    return !!(
      accessToken ||
      options.password ||
      credentialsAvailable ||
      (username && typeof getAccessToken === "function")
    );
  }

  function resolveMqttUsername() {
    return username || options.accountUsername || "openf1";
  }

  function handleMessage(topic, payload) {
    const row = parseMessage(payload);
    if (!row) return;

    lastMessageAt = new Date().toISOString();
    messageCount += 1;

    if (topic === "v1/sessions") {
      const sessionKey = row.session_key;
      if (sessionKey == null) return;
      const state = getSessionState(sessionKey);
      state.session = row;
      state.lastMessageAt = Date.now();
      state.messageCount += 1;
      if (targetSessionKey == null) {
        targetSessionKey = String(sessionKey);
      }
      return;
    }

    const sessionKey = row.session_key;
    if (sessionKey == null) return;
    if (targetSessionKey && String(sessionKey) !== String(targetSessionKey)) {
      return;
    }

    const state = getSessionState(sessionKey);
    state.lastMessageAt = Date.now();
    state.messageCount += 1;

    switch (topic) {
      case "v1/location":
        upsertLatest(state.locations, row);
        break;
      case "v1/position":
        upsertLatest(state.positions, row);
        break;
      case "v1/intervals":
        upsertLatest(state.intervals, row);
        break;
      case "v1/stints":
        upsertLatest(state.stints, row);
        break;
      case "v1/car_data":
        upsertLatest(state.carData, row);
        break;
      case "v1/weather":
        if (!state.weather || rowDateMs(row) >= rowDateMs(state.weather)) {
          state.weather = row;
        }
        break;
      case "v1/laps": {
        const lapKey = row._key || `${row.driver_number}:${row.lap_number}`;
        const existing = state.lapsByKey.get(lapKey);
        if (!existing || rowDateMs(row) >= rowDateMs(existing)) {
          state.lapsByKey.set(lapKey, row);
        }
        break;
      }
      case "v1/race_control":
        pushRingBuffer(state.raceControl, row, 50);
        break;
      case "v1/pit":
        pushRingBuffer(state.pitStops, row, 30);
        break;
      case "v1/overtakes":
        pushRingBuffer(state.overtakes, row, 25);
        break;
      case "v1/team_radio":
        pushRingBuffer(state.teamRadio, row, 20);
        break;
      default:
        break;
    }
  }

  function subscribeAll() {
    if (!client?.connected) return;
    subscribedTopics = [];
    topics.forEach((topic) => {
      client.subscribe(topic, { qos }, (error) => {
        if (error) {
          err(`Kunde inte prenumerera på ${topic}`, error);
          return;
        }
        if (!subscribedTopics.includes(topic)) {
          subscribedTopics.push(topic);
        }
      });
    });
  }

  async function connect() {
    if (!enabled || connecting || client?.connected) return;
    if (!hasCredentials()) {
      log(
        "Ingen MQTT-auth – sätt OPENF1_USERNAME + OPENF1_PASSWORD (OAuth) eller OPENF1_MQTT_PASSWORD"
      );
      return;
    }

    const token = await resolveAccessToken();
    if (!token) {
      log("Ingen access token – MQTT inaktiv, använder REST-fallback");
      return;
    }

    const mqttUsername = resolveMqttUsername();
    if (!mqttUsername) {
      log("Ingen MQTT-username – sätt OPENF1_USERNAME eller OPENF1_MQTT_USERNAME");
      return;
    }

    connecting = true;
    const url = `${protocol}://${broker}:${port}`;

    try {
      client = mqtt.connect(url, {
        username: mqttUsername,
        password: token,
        protocol,
        reconnectPeriod: 0,
        connectTimeout,
        keepalive,
        rejectUnauthorized: true
      });

      client.on("connect", () => {
        connecting = false;
        lastConnectAt = new Date().toISOString();
        lastError = null;
        log(`Ansluten till ${broker}:${port}`);
        subscribeAll();
      });

      client.on("message", (topic, payload) => {
        handleMessage(topic, payload);
      });

      client.on("error", (error) => {
        err("MQTT-fel", error);
      });

      client.on("close", () => {
        connecting = false;
        lastDisconnectAt = new Date().toISOString();
        subscribedTopics = [];
        scheduleReconnect();
      });

      client.on("offline", () => {
        subscribedTopics = [];
      });
    } catch (error) {
      connecting = false;
      err("Kunde inte ansluta", error);
      scheduleReconnect();
    }
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      client.end(true);
      client = null;
    }
    subscribedTopics = [];
    lastDisconnectAt = new Date().toISOString();
  }

  function scheduleReconnect() {
    if (!enabled || !started || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (targetSessionKey) {
        connect().catch((error) => err("Reconnect misslyckades", error));
      }
    }, 10000);
  }

  async function refreshTargetSession() {
    if (typeof detectLiveSession !== "function") return;
    try {
      const result = await detectLiveSession();
      const nextKey =
        result?.status === "live" && result?.sessionKey != null
          ? String(result.sessionKey)
          : null;

      if (nextKey !== targetSessionKey) {
        if (targetSessionKey && nextKey) {
          clearSessionState(targetSessionKey);
        }
        targetSessionKey = nextKey;
        if (!nextKey) {
          log("Ingen live-session – MQTT kopplar från");
          disconnect();
          return;
        }
        log(`Live-session: ${nextKey}`);
        await connect();
      } else if (nextKey && !client?.connected) {
        await connect();
      }
    } catch (error) {
      err("Session-koll misslyckades", error);
    }
  }

  function isFresh(sessionKey) {
    const state = sessionStates.get(String(sessionKey));
    if (!state?.lastMessageAt) return false;
    return Date.now() - state.lastMessageAt < freshMs;
  }

  function getStatus() {
    return {
      enabled,
      connected: !!client?.connected,
      connecting,
      broker,
      port,
      protocol,
      websocketUrl,
      tokenUrl,
      authMethod,
      configSource,
      username: resolveMqttUsername(),
      topics: [...topics],
      qos,
      keepalive,
      hasCredentials: hasCredentials(),
      authenticated: !!accessToken,
      targetSessionKey,
      subscribedTopics: [...subscribedTopics],
      lastConnectAt,
      lastDisconnectAt,
      lastMessageAt,
      messageCount,
      lastError,
      freshMs,
      sessionCount: sessionStates.size
    };
  }

  function mapRows(map, sorter) {
    const rows = Array.from(map.values());
    return typeof sorter === "function" ? rows.sort(sorter) : rows;
  }

  function buildBundle(sessionKey, session, status, driverByNumber, enrichWithDrivers, driverLookup) {
    const state = sessionStates.get(String(sessionKey));
    if (!state || !isFresh(sessionKey)) return null;

    const positions = mapRows(state.positions, (a, b) => Number(a.position) - Number(b.position)).map(
      (p) => ({
        driver_number: p.driver_number,
        position: p.position,
        date: p.date,
        driver: driverLookup(driverByNumber, p.driver_number)
      })
    );

    const locations = mapRows(state.locations).map((l) => ({
      driver_number: l.driver_number,
      x: l.x,
      y: l.y,
      z: l.z,
      date: l.date
    }));

    return {
      updatedAt: new Date().toISOString(),
      sessionKey,
      session: session || state.session,
      status,
      source: "mqtt",
      positions,
      locations,
      trackMapAvailable: locations.length > 0
    };
  }

  function buildAnalysis(sessionKey, session, status, driverByNumber, enrichWithDrivers) {
    const state = sessionStates.get(String(sessionKey));
    if (!state || !isFresh(sessionKey)) return null;

    const intervals = enrichWithDrivers(
      mapRows(state.intervals, (a, b) => Number(a.position) - Number(b.position)),
      driverByNumber
    );

    const raceControl = state.raceControl.slice().sort((a, b) => rowDateMs(b) - rowDateMs(a)).slice(0, 30);
    const pitStops = enrichWithDrivers(
      state.pitStops.slice().sort((a, b) => rowDateMs(b) - rowDateMs(a)).slice(0, 25),
      driverByNumber
    );
    const stints = enrichWithDrivers(mapRows(state.stints), driverByNumber);
    const weather = state.weather;
    const overtakes = enrichWithDrivers(
      state.overtakes.slice().sort((a, b) => rowDateMs(b) - rowDateMs(a)).slice(0, 20),
      driverByNumber,
      "overtaking_driver_number"
    );
    const teamRadio = enrichWithDrivers(
      state.teamRadio.slice().sort((a, b) => rowDateMs(b) - rowDateMs(a)).slice(0, 15),
      driverByNumber
    );
    const carData = enrichWithDrivers(mapRows(state.carData), driverByNumber);

    const laps = mapRows(state.lapsByKey);
    const fastestByDriver = new Map();
    laps.forEach((lap) => {
      if (!lap.lap_duration || lap.is_pit_out_lap) return;
      const existing = fastestByDriver.get(lap.driver_number);
      if (!existing || lap.lap_duration < existing.lap_duration) {
        fastestByDriver.set(lap.driver_number, lap);
      }
    });
    const fastestLaps = enrichWithDrivers(
      Array.from(fastestByDriver.values()).sort(
        (a, b) => Number(a.lap_duration) - Number(b.lap_duration)
      ),
      driverByNumber
    );
    const recentLaps = enrichWithDrivers(
      laps
        .slice()
        .sort((a, b) => rowDateMs(b) - rowDateMs(a))
        .slice(0, 25),
      driverByNumber
    );

    return {
      updatedAt: new Date().toISOString(),
      sessionKey,
      session: session || state.session,
      status,
      source: "mqtt",
      intervals,
      raceControl,
      pitStops,
      stints,
      weather,
      overtakes,
      startingGrid: [],
      sessionResult: [],
      fastestLaps,
      recentLaps,
      teamRadio,
      carData,
      available: {
        intervals: intervals.length > 0,
        raceControl: raceControl.length > 0,
        pitStops: pitStops.length > 0,
        stints: stints.length > 0,
        weather: !!weather,
        overtakes: overtakes.length > 0,
        startingGrid: false,
        sessionResult: false,
        laps: fastestLaps.length > 0 || recentLaps.length > 0,
        teamRadio: teamRadio.length > 0,
        carData: carData.length > 0
      }
    };
  }

  return {
    start() {
      if (!enabled) {
        log("MQTT avstängt (OPENF1_MQTT_ENABLED=false)");
        return;
      }
      if (started) return;
      started = true;
      if (!hasCredentials()) {
        log(
          "MQTT aktiverat men saknar auth – sätt OPENF1_USERNAME + OPENF1_PASSWORD (se openf1.org/auth.html)"
        );
      }
      refreshTargetSession().catch((error) => err("Initial session-koll misslyckades", error));
      sessionCheckTimer = setInterval(() => {
        refreshTargetSession().catch((error) => err("Session-koll misslyckades", error));
      }, sessionCheckMs);
      log(`Startad – session-koll var ${Math.round(sessionCheckMs / 1000)}s`);
    },

    stop() {
      started = false;
      if (sessionCheckTimer) {
        clearInterval(sessionCheckTimer);
        sessionCheckTimer = null;
      }
      disconnect();
    },

    getStatus,
    isFresh,
    buildBundle,
    buildAnalysis,
    refreshTargetSession
  };
}

module.exports = { createOpenF1MqttIngestor, DEFAULT_TOPICS };
