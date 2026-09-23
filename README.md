# spendtron

A read-only tool that finds which GitHub Actions workflow is eating your CI bill, ranks workflows and repos by real compute cost, and suggests pasteable fix diffs (missing cache, missing `timeout-minutes`) confirmed against real run timing — not estimates.

Delivered as an **MCP server** — call `check_actions_cost` from Claude, ChatGPT, or any MCP-compatible client, no dashboard required. Auth is a GitHub App (read-only: Actions + Contents + Metadata) plus a spendtron API key, passed as a bearer token. The cost ranking and one confirmed fix diff are free on every call. Unlocking the full fix list is a one-time $39 payment via Stripe — not a subscription.

The underlying audit logic started as `~/code/ci-audit/actions-teardown.sh` (bash + `gh api`) — `lib/auditActions.js` is the same algorithm, ported to run per-installation against many customers' orgs instead of one local `gh`-authenticated user.

## Status

Real product, not a waitlist — see `HANDOFF.md`/`FINDINGS.md`/`CARRD.md` in `~/code/ci-audit` for the history of how this got here (an earlier waitlist-and-post-to-Reddit attempt correctly got abandoned; the audit logic itself was always real).

The GitHub App must be **public** (GitHub → spendtron-app → Advanced → Make this GitHub App public) so anyone can hit Connect GitHub. That toggle lives in the GitHub UI, not this repo.

## Setup

1. Copy `.env.example` to `.env.local` (or set these in Cloud Run's Secret Manager for prod).
2. Create a GitHub App at github.com/settings/apps/new — slug **`spendtron-app`**, permissions: **Actions: Read-only**, **Contents: Read-only**, **Metadata: Read-only**. Callback URL: `<your deployed host>/github/callback`. Make the App public before sending customers to `/github/install`.
3. Create a Neon Postgres database, run `db/schema.sql` against it.
4. Create a one-time Stripe Price (not recurring) for the fix-diff unlock; put its ID in `STRIPE_UNLOCK_PRICE_ID`. Point a Stripe webhook at `/stripe/webhook` for `checkout.session.completed`. (`STRIPE_PRICE_ID` and the Customer Portal are legacy from an earlier $99/mo model — no longer wired into any live checkout flow.)
5. Map both `spendtron.com` and `www.spendtron.com` to the Cloud Run service (www should CNAME to `ghs.googlehosted.com` at Squarespace). The app 301s www → apex.
6. Privacy / terms for Stripe: `https://spendtron.com/privacy` and `https://spendtron.com/terms`.
7. `npm install && npm start`.

## Test

`npm test` — covers the cost-math port (must match `actions-teardown.sh`'s bash/awk exactly) and API-key auth, against a mocked GitHub client (no live credentials needed for these).
