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

create index if not exists installations_api_key_hash_idx
  on installations (api_key_hash);

-- One row per installation's Stripe subscription state. Looked up by
-- installation_id, updated by the Stripe webhook on subscription events.
create table if not exists subscriptions (
  installation_id bigint primary key references installations (installation_id),
  stripe_customer_id text not null,
  stripe_subscription_id text,
  status text not null default 'inactive',
  updated_at timestamptz not null default now()
);
