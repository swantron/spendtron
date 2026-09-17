# spendtron

A read-only tool that finds which GitHub Actions workflow is eating your CI bill, ranks workflows and repos by real compute cost, and surfaces PR-ready fixes (path filters, caching, cancel-in-progress).

Delivered as an **MCP server** — call `check_actions_cost` from Claude, ChatGPT, or any MCP-compatible client, no dashboard required. Auth is a GitHub App (read-only: Actions + Metadata) plus a spendtron API key, passed as a bearer token. One free audit per connected org, then $99/mo via Stripe.

The underlying audit logic started as `~/code/ci-audit/actions-teardown.sh` (bash + `gh api`) — `lib/auditActions.js` is the same algorithm, ported to run per-installation against many customers' orgs instead of one local `gh`-authenticated user.

## Status

Real product, not a waitlist — see `HANDOFF.md`/`FINDINGS.md`/`CARRD.md` in `~/code/ci-audit` for the history of how this got here (an earlier waitlist-and-post-to-Reddit attempt correctly got abandoned; the audit logic itself was always real).

## Setup

1. Copy `.env.example` to `.env.local` (or set these in Cloud Run's Secret Manager for prod).
2. Create a GitHub App at github.com/settings/apps/new — permissions: **Actions: Read-only**, **Metadata: Read-only**. Callback URL: `<your deployed host>/github/callback`.
3. Create a Neon Postgres database, run `db/schema.sql` against it.
4. Create a Stripe Price for $99/mo; put its ID in `STRIPE_PRICE_ID`. Point a Stripe webhook at `/stripe/webhook` for `customer.subscription.*` events.
5. `npm install && npm start`.

## Test

`npm test` — covers the cost-math port (must match `actions-teardown.sh`'s bash/awk exactly) and API-key auth, against a mocked GitHub client (no live credentials needed for these).
