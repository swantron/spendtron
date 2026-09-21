# One workflow was 36% of my CI compute. GitHub never showed me.

GitHub Actions will tell you what you spent. It won't tell you which workflow spent it.

The billing page groups usage by repo and by runner type. To find the workflow behind a big number, you open each repo's Actions tab, click into runs, and add up durations yourself. Almost nobody does. So the most expensive workflow in your org tends to stay invisible until the bill is already a problem.

I wanted to see what that blind spot looks like on real data, so I audited my own repos.

## What I ran

I sampled the last ~100 runs per repo across my GitHub fleet: 812 workflow runs in total. For each run I took the billed minutes, grouped them by workflow, and priced them at private-repo Ubuntu rates ($0.008/min).

To be upfront about the caveats: these are my personal repos, they are public, and GitHub doesn't bill Actions minutes on public repos. The ~1,603 billable minutes come to about $12.82 at private rates, and my actual bill was about $0. The dollar figure is a hypothetical. The shape of the data is what matters.

## What it showed

- **One workflow was 36% of the entire fleet's CI compute.** A React app's "CI/CD with Coverage and Playwright" workflow: 572 billed minutes over 93 runs, averaging 5.6 minutes a run.
- **The top three workflows were 59% of all compute.**

I would not have guessed either number. I knew the Playwright job was slow. I did not know it outweighed everything else combined by that margin.

## Why it matters even when the bill is small

On a team with private repos, the same pattern turns into real money, and the cost scales with how often the workflow runs, not how important it is. A slow end-to-end job triggered on every push, including docs-only changes, is the classic offender.

## Three boring fixes

None of these need a runner migration or a new tool:

1. **Path filters.** Don't run the e2e job when only docs or config changed.
2. **Cache the browser install.** Re-downloading Playwright browsers on every run is pure waste.
3. **Concurrency with cancel-in-progress.** Kill superseded runs instead of letting stale ones finish.

## Check your own org

The audit logic is now a small read-only service called spendtron. It uses a GitHub App with two permissions (Actions: read, Metadata: read), so it can't see your code or secrets and never pushes changes. You can call it from Claude or any MCP client, or install the GitHub App directly.

- Site: https://spendtron.com
- MCP endpoint: https://spendtron.com/mcp
- The first audit per org is free; after that it's $99/month.

If your top workflow turns out to be a surprise, I'd like to hear what it was.
