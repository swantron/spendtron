# Directory listing copy — spendtron

Source of truth is `public/llms.txt`. Use this after `mcp-publisher publish` puts
`server.json` in the official MCP Registry — Smithery and PulseMCP both pull
from that registry, so publishing there first means less to fill in by hand.

## Common fields (reuse everywhere)

- **Name:** spendtron
- **One-liner (≤80 chars):** Price Actions jobs at current runner rates and open the pull request.
- **Category / tags:** DevOps, CI/CD, GitHub, cost, observability
- **Repo:** https://github.com/swantron/spendtron
- **Homepage:** https://spendtron.com
- **MCP endpoint:** https://spendtron.com/mcp (streamable HTTP)
- **Auth:** Bearer token (API key). No OAuth.
- **Tools (1):** `check_actions_cost` — no arguments; returns the saved report
  (per-job runner rates and corroborated workflow changes). Scanning happens
  on `/report`, not inside the tool call.
- **Pricing:** chart, live sample, and pull requests are free. A written
  audit is quoted when the figure is about $200 or more.
- **Logo:** none yet — reuse the landing page's accent green (#3fb950) on
  dark (#0d1117) if a directory wants brand colors.

### Short description (≤160 chars, for cards/listings)

> Prices GitHub Actions jobs at current runner rates. Paste a usage export for the chart, or connect the app to open a pull request. Free.

### Long description (about/README-style)

> GitHub Insights already shows workflow minutes. spendtron prices each job at the current runner SKU (parallel jobs add; public standard runners are $0; larger runners are billed on public repositories) and opens a pull request for the safe edits. Paste the detailed usage CSV at /audit for a chart with no account. The chart and the pull requests are free. A written audit is quoted when the figure is about $200 or more.
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
- License: MIT (`LICENSE`, and `"license": "MIT"` in `package.json`).

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
