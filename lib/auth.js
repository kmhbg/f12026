// Inloggning med användarnamn + lösenord. Lösenord hashas med scrypt,
// sessioner är slumpade tokens i en httpOnly-cookie där bara hashen lagras.

const crypto = require("crypto");

const COOKIE_NAME = "f1_session";
const SESSION_DAYS = 60;
const INVITE_DAYS = 7;
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [scheme, N, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p)
  });
  return crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Lösenordet måste vara minst ${MIN_PASSWORD_LENGTH} tecken`;
  }
  return null;
}

const newToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const daysFromNow = (days) => new Date(Date.now() + days * 86400e3).toISOString();

function slugifyUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (req.secure) parts.push("Secure");
  return parts.join("; ");
}

// Enkel begränsning av inloggningsförsök per IP och användarnamn (i minnet).
function createRateLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    tooMany(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now - entry.start > windowMs) return false;
      return entry.count >= max;
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now - entry.start > windowMs) hits.set(key, { start: now, count: 1 });
      else entry.count += 1;
    },
    reset(key) {
      hits.delete(key);
    }
  };
}

function createAuth(store) {
  function startSession(req, res, userId) {
    const token = newToken();
    store.createSession(hashToken(token), userId, daysFromNow(SESSION_DAYS));
    res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 86400));
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) store.deleteSession(hashToken(token));
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  }

  function createInvite(userId, createdBy) {
    const token = newToken();
    store.createInvite(hashToken(token), userId, createdBy, daysFromNow(INVITE_DAYS));
    return token;
  }

  // Sätter req.user om sessionen är giltig.
  function loadUser(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    req.user = token ? store.sessionUser(hashToken(token)) : null;
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "Inloggning krävs" });
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "Inloggning krävs" });
    if (req.user.role !== "admin") return res.status(403).json({ error: "Kräver admin" });
    next();
  }

  // Cookie-baserad inloggning skyddas mot CSRF genom SameSite=Lax och kravet
  // att ändrande anrop skickas som JSON (formulär från andra sajter kan inte det).
  function requireJsonForWrites(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.method === "DELETE" || req.is("application/json")) return next();
    return res.status(415).json({ error: "Content-Type måste vara application/json" });
  }

  return {
    startSession,
    endSession,
    createInvite,
    loadUser,
    requireUser,
    requireAdmin,
    requireJsonForWrites
  };
}

module.exports = {
  createAuth,
  createRateLimiter,
  hashPassword,
  verifyPassword,
  validatePassword,
  hashToken,
  slugifyUsername,
  parseCookies,
  COOKIE_NAME
};
