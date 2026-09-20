const crypto = require("crypto");

const KEY_PREFIX = "sk_spendtron_";

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

function makeRotateToken(installationId, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`rotate:${installationId}`)
    .digest("hex");
}

function verifyRotateToken(installationId, token, secret) {
  if (!token || !secret) return false;
  const expected = makeRotateToken(installationId, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"));
  } catch {
    return false;
  }
}

module.exports = {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
  makeRotateToken,
  verifyRotateToken,
};
