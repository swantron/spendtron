const { sql } = require("./db");

async function getInstallationByApiKeyHash(apiKeyHash) {
  const db = sql();
  const rows = await db.query(
    `select installation_id, account_login, free_trial_used_at
     from installations where api_key_hash = $1`,
    [apiKeyHash],
  );
  return rows[0] ?? null;
}

async function getInstallationByInstallationId(installationId) {
  const db = sql();
  const rows = await db.query(
    `select installation_id, account_login, free_trial_used_at
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
    `update installations set api_key_hash = $2 where installation_id = $1`,
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

module.exports = {
  getInstallationByApiKeyHash,
  getInstallationByInstallationId,
  createInstallation,
  rotateApiKey,
  markFreeTrialUsed,
  getSubscriptionStatus,
  upsertSubscription,
};
