-- One row per GitHub App installation (one org/account). The API key is
-- what a customer pastes into their MCP client as a bearer token — we
-- store only its hash, never the raw key, same principle as a password.
create table if not exists installations (
  id bigint generated always as identity primary key,
  installation_id bigint not null unique,
  account_login text not null,
  api_key_hash text not null unique,
  free_trial_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Set by the installation.deleted webhook. The key hash is replaced at the
-- same time, so the old key stops authenticating. Billing rows are kept.
alter table installations add column if not exists uninstalled_at timestamptz;

create index if not exists installations_api_key_hash_idx
  on installations (api_key_hash);

-- One row per installation's billing state. Looked up by installation_id,
-- updated by the Stripe webhook. stripe_subscription_id/status are legacy
-- from the original $99/mo recurring model; fixes_unlocked_at is the
-- current model — a one-time payment that permanently unlocks fix diffs
-- for that installation (the ranking itself is always free, matching
-- GitHub's own Actions Usage Metrics).
create table if not exists subscriptions (
  installation_id bigint primary key references installations (installation_id),
  stripe_customer_id text not null,
  stripe_subscription_id text,
  status text not null default 'inactive',
  fixes_unlocked_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Last live sample for an installation. MCP reads this instead of crawling
-- GitHub on every tool call. Replaced on refresh. Deleted with the installation.
create table if not exists audit_reports (
  installation_id bigint primary key references installations (installation_id) on delete cascade,
  report jsonb not null,
  computed_at timestamptz not null default now()
);
