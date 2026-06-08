/**
 * OpenF1 MQTT client settings aligned with:
 * - https://github.com/br-g/openf1/tree/main/mqtt-config (broker auth: username/password)
 * - https://openf1.org/auth.html (public broker connection for clients)
 *
 * mqtt-config/mosquitto.conf: listener 1883, allow_anonymous false, password_file.
 * mqtt-config/mosquitto.passwd: broker user "openf1" (server-side only).
 *
 * Clients connecting to the public broker use MQTTS on port 8883 with OAuth2:
 * POST https://api.openf1.org/token → access_token used as MQTT password.
 * Username: registered email (OPENF1_USERNAME) or any non-empty string.
 */

const OPENF1_MQTT_TOPICS = [
  "v1/sessions",
  "v1/location",
  "v1/position",
  "v1/intervals",
  "v1/race_control",
  "v1/pit",
  "v1/stints",
  "v1/laps",
  "v1/weather",
  "v1/car_data",
  "v1/overtakes",
  "v1/team_radio"
];

const OPENF1_MQTT_DEFAULTS = {
  broker: "mqtt.openf1.org",
  port: 8883,
  protocol: "mqtts",
  websocketUrl: "wss://mqtt.openf1.org:8084/mqtt",
  tokenUrl: "https://api.openf1.org/token",
  keepalive: 60,
  connectTimeout: 15000,
  qos: 0,
  topics: OPENF1_MQTT_TOPICS,
  authMethod: "oauth2_token_as_password",
  configSource: "openf1/mqtt-config + openf1.org/auth.html"
};

/**
 * Environment variables (never commit passwords):
 * - OPENF1_USERNAME       Registered OpenF1 email/username (also MQTT username)
 * - OPENF1_PASSWORD       OpenF1 account password (used to fetch OAuth token)
 * - OPENF1_MQTT_PASSWORD  Optional pre-fetched access_token (skips /token call)
 * - OPENF1_MQTT_USERNAME  Optional MQTT username override (default: OPENF1_USERNAME)
 * - OPENF1_MQTT_BROKER    Optional broker host (default: mqtt.openf1.org)
 * - OPENF1_MQTT_PORT      Optional broker port (default: 8883)
 * - OPENF1_MQTT_ENABLED   Set "false" to disable MQTT ingest
 */
function loadOpenF1MqttEnv(env = process.env) {
  const username = env.OPENF1_MQTT_USERNAME || env.OPENF1_USERNAME || null;
  const password = env.OPENF1_MQTT_PASSWORD || null;
  const accountPassword = env.OPENF1_PASSWORD || null;

  return {
    enabled: env.OPENF1_MQTT_ENABLED !== "false",
    broker: env.OPENF1_MQTT_BROKER || OPENF1_MQTT_DEFAULTS.broker,
    port: Number(env.OPENF1_MQTT_PORT) || OPENF1_MQTT_DEFAULTS.port,
    protocol: OPENF1_MQTT_DEFAULTS.protocol,
    websocketUrl: OPENF1_MQTT_DEFAULTS.websocketUrl,
    tokenUrl: OPENF1_MQTT_DEFAULTS.tokenUrl,
    keepalive: OPENF1_MQTT_DEFAULTS.keepalive,
    connectTimeout: OPENF1_MQTT_DEFAULTS.connectTimeout,
    qos: OPENF1_MQTT_DEFAULTS.qos,
    topics: OPENF1_MQTT_TOPICS,
    username,
    password,
    accountUsername: env.OPENF1_USERNAME || null,
    accountPassword,
    freshMs: Number(env.OPENF1_MQTT_FRESH_MS) || 10000,
    sessionCheckMs: Number(env.OPENF1_MQTT_SESSION_CHECK_MS) || 60000,
    credentialsAvailable: !!(password || (username && accountPassword)),
    authMethod: OPENF1_MQTT_DEFAULTS.authMethod,
    configSource: OPENF1_MQTT_DEFAULTS.configSource
  };
}

module.exports = {
  OPENF1_MQTT_TOPICS,
  OPENF1_MQTT_DEFAULTS,
  loadOpenF1MqttEnv
};
