# Directory listing copy — spendtron

Source of truth is `public/llms.txt`. Use this after `mcp-publisher publish` puts
`server.json` in the official MCP Registry — Smithery and PulseMCP both pull
from that registry, so publishing there first means less to fill in by hand.

## Common fields (reuse everywhere)

- **Name:** spendtron
- **One-liner (≤80 chars):** Find the workflow eating your CI bill — with fix diffs, verified.
- **Category / tags:** DevOps, CI/CD, GitHub, cost, observability
- **Repo:** https://github.com/swantron/spendtron
- **Homepage:** https://spendtron.com
- **MCP endpoint:** https://spendtron.com/mcp (streamable HTTP)
- **Auth:** Bearer token (API key). No OAuth.
- **Tools (1):** `check_actions_cost` — no arguments; ranks the connected GitHub
  org's Actions workflows and repos by real compute cost, plus fix diffs
  (missing cache, missing `timeout-minutes`) confirmed against real recent
  run timing, not estimates.
- **Pricing:** cost ranking and one confirmed fix diff free on every call.
  Unlocking the full fix list is a one-time $39 — not a subscription.
- **Logo:** none yet — reuse the landing page's accent green (#3fb950) on
  dark (#0d1117) if a directory wants brand colors.

### Short description (≤160 chars, for cards/listings)

> Ranks your GitHub org's Actions workflows by real compute cost and suggests pasteable fix diffs, confirmed against your run history. Ranking + 1 fix free; rest is $39 one-time.

### Long description (about/README-style)

> GitHub Actions shows you a total bill. It doesn't show you which workflow drove it, and it doesn't tell you what to change. spendtron does both: connect a read-only GitHub App (Actions, Contents, Metadata — no write access, no secrets) and call `check_actions_cost` from Claude or any MCP client to get your workflows and repos ranked by compute cost, plus fix diffs like a missing browser-install cache or a missing `timeout-minutes` guard against a runaway job — each one confirmed against your actual recent run timing before it's ever shown, not an estimate. In one real audit, a single workflow turned out to be 36% of all CI compute across the fleet — invisible until someone looked. The ranking and one confirmed fix are free on every call; unlocking the full fix list is a one-time $39, not a subscription.
>
> Write-up: https://spendtron.com/blog/ci-audit-36-percent

### Install / connect snippet

```
claude mcp add --transport http spendtron https://spendtron.com/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Get an API key by installing the GitHub App: https://spendtron.com/github/install

---

## Smithery (smithery.ai/new)

- Connect via GitHub (`swantron/spendtron`), or list as a remote/hosted server
  pointing at `https://spendtron.com/mcp`.
- Manifest fields: name `spendtron`, description = short description above,
  auth method = **API key / bearer token** (not OAuth, not none) — Smithery
  needs this set correctly so it prompts installers for the key instead of
  trying an OAuth flow.
- Tools: 1 (`check_actions_cost`).
- License: none declared in the repo yet — add one (e.g. MIT, or "proprietary"
  if this should stay closed-source) before submitting, since Smithery's
  manifest expects a license field.

## Glama (glama.ai)

- Glama auto-indexes from GitHub, so submitting the repo URL
  (`https://github.com/swantron/spendtron`) is the main step.
- Fill in when prompted: one-line capability summary (short description
  above), transport = streamable HTTP, tool count = 1, install snippet above.
- Glama favors servers with a clear README and working install instructions —
  the repo's `README.md` already documents setup; double check it still
  matches the live GitHub App flow (Setup URL, not a manual callback) before
  submitting.
- Note: Glama's quality bar leans toward open-source servers. spendtron's
  server code is source-available in a public repo but the hosted service is
  paid — say so plainly in the submission notes so it's not flagged as
  misleading.

## MCP Registry (official — do this first)

- `cd ~/code/spendtron && mcp-publisher login github && mcp-publisher publish`
- Uses the existing `server.json` (name `io.github.swantron/spendtron`).
- Smithery and PulseMCP both pull from this registry, so this is the one
  submission that pays off twice.

## PulseMCP (pulsemcp.com/submit)

- As of this writeup, PulseMCP's manual submission form was paused while they
  rework ingestion — check https://www.pulsemcp.com/submit before assuming
  the form works.
- PulseMCP also crawls the official MCP Registry directly, so publishing
  there (above) may get spendtron listed with no manual submission needed.
  Worth checking pulsemcp.com/servers for "spendtron" a few days after the
  registry publish before filing a manual submission.

## Claude.ai custom connector (for your own use, not a public directory)

- Claude.ai supports static bearer-token headers on custom connectors (beta).
- Add connector → URL `https://spendtron.com/mcp` → header
  `Authorization: Bearer YOUR_API_KEY`. No OAuth setup needed.
- This is not a public listing — it's how you or a teammate would use
  spendtron inside claude.ai directly, worth testing once the API key flow is
  live end-to-end.
