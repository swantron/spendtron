# spendtron

Prices GitHub Actions jobs at current per-runner rates and opens a pull request for the edits that are safe to apply.

Paste a detailed usage CSV at `/audit` and the chart renders immediately. Nothing is stored. Connect the GitHub App when you want a live sample: each job is billed at its SKU, parallel jobs add, and the same workflow name in two repositories stays two rows. The report page is the next screen after install. MCP reads that saved report and does not crawl GitHub on the tool call.

The chart, the sample, and pull requests you request are free. A written audit is a quote when the figure is about $200 or more (`joe@swantron.com`). The pull request applies timeouts, cancel-in-progress on non-deploy workflows, and a short public-repo job leaving a larger Linux runner. Path filters, matrix fanout, and macOS runners are described in the pull request and left for you to edit.

There is also a composite action at `github-action/` (`uses: swantron/spendtron/github-action@main`) that writes the same ranking for one repository into the job summary. On `pull_request` it also keeps one comment on the pull request up to date. The job needs:

```yaml
permissions:
  actions: read        # list runs and jobs
  contents: read
  pull-requests: write # the comment; leave it out to get the job summary only
steps:
  - uses: swantron/spendtron/github-action@main
```

Pull requests from forks get a read-only token, so they get the job summary and no comment.

Free tools under `/tools/` act as SEO landing pages and need no account:

- **Workflow checker** (`/tools/workflow-checker`): `POST /api/check-workflow` → `lib/workflowLint.js`, a static check with no run data. It is also the keyless MCP tool `check_workflow_yaml`. The pasted YAML is not stored.
- **Cost calculator**, **self-hosted break-even** and **larger runner calculator** run in the browser. They take their rates from `runnerRates.js` through `/audit.js`, so the rate table has one source.

The pages are static HTML in `public/tools/`, and `public/tools/tools.js` drives all four.

The underlying audit logic started as `~/code/ci-audit/actions-teardown.sh` (bash + `gh api`) — `lib/auditActions.js` is the same algorithm, ported to run per-installation against many customers' orgs instead of one local `gh`-authenticated user.

## Status

Real product, not a waitlist — see `HANDOFF.md`/`FINDINGS.md`/`CARRD.md` in `~/code/ci-audit` for the history of how this got here (an earlier waitlist-and-post-to-Reddit attempt correctly got abandoned; the audit logic itself was always real).

The GitHub App must be **public** (GitHub → spendtron-app → Advanced → Make this GitHub App public) so anyone can hit Connect GitHub. That toggle lives in the GitHub UI, not this repo.

## Setup

1. Copy `.env.example` to `.env.local` (or set these in Cloud Run's Secret Manager for prod).
2. Create a GitHub App at github.com/settings/apps/new — slug **`spendtron-app`**, permissions: **Actions: Read-only**, **Contents: Read and write**, **Pull requests: Read and write**, **Workflows: Read and write**, **Metadata: Read-only**. Contents, Pull requests, and Workflows write are what the report button uses to open a pull request; GitHub refuses an app's commit to `.github/workflows/` without Workflows write. Without them the chart still works and the button returns GitHub's 403. Set both the user-authorization **Callback URL** and the **Setup URL** to `<your deployed host>/github/callback`, and enable **Redirect on update**. Set the webhook URL to `<host>/github/webhook`, send the `installation` event, and put the secret in `GITHUB_WEBHOOK_SECRET` (Secret Manager secret `github-webhook-secret`). An uninstall revokes the API key and drops the saved report; billing rows are kept. `deploy.sh` mounts it. Leave **Request user authorization (OAuth) during installation** off; the server starts OAuth itself so `state` is bound to the installation id. Generate a client secret and set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. Make the App public before sending customers to `/github/install`. On Cloud Run, create the two OAuth secrets before the next deploy (`github-app-client-id`, `github-app-client-secret`); `deploy.sh` mounts them, and without them the new revision's `/ready` stays not-ready and `/github/callback` will not issue keys.
3. Returning users sign in at `/login`: GitHub OAuth, then the report for the one installation they manage, or a picker if there are several. The report cookie is a signed session token and is the only thing that can open pull requests. The `?token=` link MCP returns is a share token and stays read-only even if pasted into a cookie.
4. Create a Neon Postgres database, run `db/schema.sql` against it. The file is safe to rerun. An existing database picks up the `audit_reports` table and the `installations.uninstalled_at` column from it.
5. Stripe is legacy. The audit is free. Keep the webhook at `/stripe/webhook` so an older `checkout.session.completed` still records. Do not create a new charge for the report.
6. Map both `spendtron.com` and `www.spendtron.com` to the Cloud Run service (www should CNAME to `ghs.googlehosted.com` at Squarespace). The app 301s www → apex.
7. Privacy / terms for Stripe: `https://spendtron.com/privacy` and `https://spendtron.com/terms`.
8. `npm install && npm start`.

## Test

`npm test` — covers the cost-math port (must match `actions-teardown.sh`'s bash/awk exactly) and API-key auth, against a mocked GitHub client (no live credentials needed for these).
