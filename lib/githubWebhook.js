const crypto = require("crypto");

function verifyGithubWebhook(body, signature, secret) {
  if (!signature || !secret || body == null) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  const left = Buffer.from(String(signature));
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { verifyGithubWebhook };
