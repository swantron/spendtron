const { sql } = require("./db");

async function getInstallationByApiKeyHash(apiKeyHash) {
  const db = sql();
  const rows = await db.query(
    `select installation_id, account_login, free_trial_used_at
     from installations where api_key_hash = $1 and uninstalled_at is null`,
    [apiKeyHash],
  );
  return rows[0] ?? null;
}

async function getInstallationByInstallationId(installationId) {
  const db = sql();
  const rows = await db.query(
    `select installation_id, account_login, free_trial_used_at, uninstalled_at
     from installations where installation_id = $1`,
    [installationId],
  );
  return rows[0] ?? null;
}

/** Insert a new install. On re-entry, keep the existing API key hash. */
async function createInstallation({ installationId, accountLogin, apiKeyHash }) {
  const db = sql();
  const rows = await db.query(
    `insert into installations (installation_id, account_login, api_key_hash)
     values ($1, $2, $3)
     on conflict (installation_id) do update set
       account_login = excluded.account_login
     returning installation_id, account_login, free_trial_used_at, (xmax = 0) as created`,
    [installationId, accountLogin, apiKeyHash],
  );
  return rows[0];
}

async function rotateApiKey(installationId, apiKeyHash) {
  const db = sql();
  await db.query(
    `update installations set api_key_hash = $2, uninstalled_at = null where installation_id = $1`,
    [installationId, apiKeyHash],
  );
}

async function markFreeTrialUsed(installationId) {
  const db = sql();
  await db.query(
    `update installations set free_trial_used_at = now()
     where installation_id = $1 and free_trial_used_at is null`,
    [installationId],
  );
}

async function getSubscriptionStatus(installationId) {
  const db = sql();
  const rows = await db.query(
    `select status from subscriptions where installation_id = $1`,
    [installationId],
  );
  return rows[0]?.status ?? "inactive";
}

async function upsertSubscription({
  installationId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
}) {
  const db = sql();
  await db.query(
    `insert into subscriptions (installation_id, stripe_customer_id, stripe_subscription_id, status, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (installation_id) do update set
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       status = excluded.status,
       updated_at = now()`,
    [installationId, stripeCustomerId, stripeSubscriptionId, status],
  );
}

/** Current billing model: a one-time payment permanently unlocks fix diffs
 * for this installation. Separate from the legacy subscriptions.status
 * column, which the old $99/mo recurring model used. */
async function getFixesUnlockedAt(installationId) {
  const db = sql();
  const rows = await db.query(
    `select fixes_unlocked_at from subscriptions where installation_id = $1`,
    [installationId],
  );
  return rows[0]?.fixes_unlocked_at ?? null;
}

async function markFixesUnlocked({ installationId, stripeCustomerId }) {
  const db = sql();
  await db.query(
    `insert into subscriptions (installation_id, stripe_customer_id, fixes_unlocked_at, updated_at)
     values ($1, $2, now(), now())
     on conflict (installation_id) do update set
       stripe_customer_id = excluded.stripe_customer_id,
       fixes_unlocked_at = coalesce(subscriptions.fixes_unlocked_at, excluded.fixes_unlocked_at),
       updated_at = now()`,
    [installationId, stripeCustomerId],
  );
}

const AUDIT_TTL_MS = 6 * 60 * 60 * 1000;

function asReport(value) {
  if (!value) return null;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function getAuditReport(installationId) {
  const db = sql();
  const rows = await db.query(
    `select report, computed_at from audit_reports where installation_id = $1`,
    [installationId],
  );
  if (!rows[0]) return null;
  const computedAtMs = new Date(rows[0].computed_at).getTime();
  return {
    report: asReport(rows[0].report),
    computedAt: new Date(rows[0].computed_at).toISOString(),
    stale: Date.now() - computedAtMs > AUDIT_TTL_MS,
  };
}

async function saveAuditReport(installationId, report) {
  const db = sql();
  await db.query(
    `insert into audit_reports (installation_id, report, computed_at)
     values ($1, $2::jsonb, now())
     on conflict (installation_id) do update set
       report = excluded.report,
       computed_at = now()`,
    [installationId, JSON.stringify(report)],
  );
}

/**
 * GitHub uninstalled the app. Revoke the API key (replace its hash with one
 * nobody holds) and drop the cached report, but keep the installation and
 * billing rows: a payment record must survive an uninstall, and a reinstall
 * of the same installation id issues a fresh key.
 */
async function revokeInstallation(installationId, unusableKeyHash) {
  const db = sql();
  await db.query(`delete from audit_reports where installation_id = $1`, [installationId]);
  await db.query(
    `update installations set api_key_hash = $2, uninstalled_at = now() where installation_id = $1`,
    [installationId, unusableKeyHash],
  );
}

/** Of these GitHub installation ids, the ones spendtron has an active row for. */
async function activeInstallations(installationIds) {
  if (!installationIds.length) return [];
  const db = sql();
  return db.query(
    `select installation_id, account_login from installations
     where installation_id = any($1::bigint[]) and uninstalled_at is null
     order by account_login`,
    [installationIds],
  );
}

module.exports = {
  getInstallationByApiKeyHash,
  getInstallationByInstallationId,
  createInstallation,
  rotateApiKey,
  markFreeTrialUsed,
  getSubscriptionStatus,
  upsertSubscription,
  getFixesUnlockedAt,
  markFixesUnlocked,
  getAuditReport,
  saveAuditReport,
  revokeInstallation,
  activeInstallations,
  AUDIT_TTL_MS,
};
