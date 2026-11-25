const crypto = require("crypto");

const KEY_PREFIX = "sk_spendtron_";
const STATE_COOKIE = "spendtron_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const ROTATE_TTL_MS = 15 * 60 * 1000;
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REPORT_COOKIE = "spendtron_report";
const CHOOSE_COOKIE = "spendtron_choose";

/** Raw key shown to the customer exactly once, at issuance. */
function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString("hex");
}

/** Only the hash is ever stored — same principle as a password. */
function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Plain bearer-token middleware, not OAuth — this is a simple opaque API
 * key looked up in our own DB, not a token from a third-party
 * authorization server, so it doesn't need the OAuth-shaped
 * token-introspection abstraction MCP's auth helpers are built around.
 */
function extractBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Short-lived proof that this browser may rotate the key. The expiry is
 * inside the signed payload — a token with no timestamp used to stay valid
 * forever, and the callback used to hand one to anyone who knew the
 * installation id.
 */
function makeRotateToken(installationId, secret, now = Date.now()) {
  const exp = now + ROTATE_TTL_MS;
  const payload = `${installationId}.${exp}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyRotateToken(installationId, token, secret, now = Date.now()) {
  if (!token || !secret || installationId == null) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [id, expStr, sig] = parts;
  if (id !== String(installationId)) return false;
  if (!/^\d+$/.test(expStr)) return false;
  if (now >= Number(expStr)) return false;
  return safeEqual(sign(`${id}.${expStr}`, secret), sig);
}

/**
 * Binds a browser session to one installation id across the GitHub OAuth
 * hop. GitHub's setup redirect supplies installation_id with no signature,
 * so the id is only trusted later, after it has been copied into this
 * token and the signed-in user can manage that installation.
 */
function makeOAuthState(installationId, secret, now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = now + STATE_TTL_MS;
  const payload = `${nonce}.${exp}.${installationId}`;
  return `${payload}.${sign(payload, secret)}`;
}

function readOAuthState(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 4) return null;
  const [nonce, expStr, installationId, sig] = parts;
  if (!/^[a-f0-9]{32}$/.test(nonce)) return null;
  if (!/^\d+$/.test(expStr) || !/^\d+$/.test(installationId)) return null;
  if (now >= Number(expStr)) return null;
  const payload = `${nonce}.${expStr}.${installationId}`;
  if (!safeEqual(sign(payload, secret), sig)) return null;
  return { installationId: Number(installationId), exp: Number(expStr) };
}

function oauthStateMatches(queryState, cookieState, secret, now = Date.now()) {
  if (!queryState || !cookieState || !safeEqual(queryState, cookieState)) return null;
  return readOAuthState(queryState, secret, now);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function stateCookieHeader(token, { secure = false, maxAge = 600 } = {}) {
  const secureAttr = secure ? "; Secure" : "";
  return `${STATE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/github; Max-Age=${maxAge}${secureAttr}`;
}

/**
 * Two kinds of report token, signed differently so one cannot stand in for
 * the other. "session" lives only in the HttpOnly cookie set after GitHub
 * sign-in and may open pull requests. "share" is the read-only link handed
 * to MCP clients and anyone the customer forwards it to. Where a token
 * arrives (cookie vs query) is not trusted; its signed kind is.
 */
const REPORT_KINDS = new Set(["session", "share"]);

function makeReportToken(installationId, secret, { kind = "share", now = Date.now() } = {}) {
  if (!REPORT_KINDS.has(kind)) throw new Error(`unknown report token kind ${kind}`);
  const exp = now + REPORT_TTL_MS;
  const payload = `${kind}.${installationId}.${exp}`;
  return `${payload}.${sign(`report:${payload}`, secret)}`;
}

function readReportToken(token, secret, { kind, now = Date.now() } = {}) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 4) return null;
  const [tokenKind, installationId, expStr, sig] = parts;
  if (!REPORT_KINDS.has(tokenKind)) return null;
  if (kind && tokenKind !== kind) return null;
  if (!/^\d+$/.test(installationId) || !/^\d+$/.test(expStr)) return null;
  if (now >= Number(expStr)) return null;
  const payload = `${tokenKind}.${installationId}.${expStr}`;
  if (!safeEqual(sign(`report:${payload}`, secret), sig)) return null;
  return { installationId: Number(installationId), kind: tokenKind };
}

/**
 * After a /login sign-in that found several installations, this short-lived
 * cookie lists the ids that user may pick. Picking one swaps it for a
 * session cookie without a second trip through GitHub.
 */
function makeChooseToken(installationIds, secret, now = Date.now()) {
  const exp = now + STATE_TTL_MS;
  const payload = `choose.${installationIds.map(Number).join("-")}.${exp}`;
  return `${payload}.${sign(payload, secret)}`;
}

function readChooseToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 4 || parts[0] !== "choose") return null;
  const [, ids, expStr, sig] = parts;
  if (!/^\d+(-\d+)*$/.test(ids) || !/^\d+$/.test(expStr)) return null;
  if (now >= Number(expStr)) return null;
  if (!safeEqual(sign(`choose.${ids}.${expStr}`, secret), sig)) return null;
  return ids.split("-").map(Number);
}

function reportCookieHeader(token, { secure = false, maxAge = 604800 } = {}) {
  const secureAttr = secure ? "; Secure" : "";
  return `${REPORT_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureAttr}`;
}

module.exports = {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
  makeRotateToken,
  verifyRotateToken,
  makeOAuthState,
  readOAuthState,
  oauthStateMatches,
  readCookie,
  stateCookieHeader,
  makeReportToken,
  readReportToken,
  reportCookieHeader,
  makeChooseToken,
  readChooseToken,
  CHOOSE_COOKIE,
  STATE_COOKIE,
  REPORT_COOKIE,
  REPORT_TTL_MS,
  STATE_TTL_MS,
  ROTATE_TTL_MS,
};
