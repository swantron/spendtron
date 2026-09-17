/**
 * Ports actions-teardown.sh (~/code/ci-audit/actions-teardown.sh) from bash
 * to JS, using an installation-scoped Octokit client instead of the `gh`
 * CLI (which assumes a locally-authenticated human, not a service acting
 * on behalf of many customers). Same algorithm, same numbers:
 * - Round each run's wall-clock duration up to the nearest minute (min 1),
 *   matching how GitHub bills.
 * - Cost at the private-repo Ubuntu rate ($0.008/min) — this is what the
 *   org would be billed if these repos were private (they must be, to be
 *   worth auditing — see ci-audit/FINDINGS.md: public repos bill $0).
 */
const RATE_PER_MINUTE = 0.008;
const RUNS_PER_REPO = 100;

function billMinutes(startedAt, updatedAt) {
  const seconds = (new Date(updatedAt) - new Date(startedAt)) / 1000;
  if (seconds <= 0) return 1;
  return Math.ceil(seconds / 60);
}

/**
 * @param {import('@octokit/rest').Octokit} octokit - installation-scoped client
 * @returns {Promise<{
 *   topWorkflows: Array<{ workflow: string, billMinutes: number, runs: number, avgSeconds: number, costUsd: number }>,
 *   topRepos: Array<{ repo: string, billMinutes: number, runs: number, costUsd: number }>,
 *   totalBillMinutes: number,
 *   totalCostUsd: number,
 *   sampledRuns: number,
 * }>}
 */
async function auditActionsCost(octokit) {
  const repos = await octokit.paginate(
    octokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );

  const workflowStats = new Map(); // name -> { mins, runs, sec }
  const repoStats = new Map(); // full_name -> { mins, runs }
  let sampledRuns = 0;

  for (const repo of repos) {
    if (repo.fork || repo.archived) continue;

    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner: repo.owner.login,
      repo: repo.name,
      per_page: RUNS_PER_REPO,
    });

    for (const run of data.workflow_runs ?? []) {
      if (!run.run_started_at || !run.updated_at) continue;
      sampledRuns++;

      const mins = billMinutes(run.run_started_at, run.updated_at);
      const seconds = (new Date(run.updated_at) - new Date(run.run_started_at)) / 1000;

      const w = workflowStats.get(run.name) ?? { mins: 0, runs: 0, sec: 0 };
      w.mins += mins;
      w.runs += 1;
      w.sec += seconds;
      workflowStats.set(run.name, w);

      const r = repoStats.get(repo.full_name) ?? { mins: 0, runs: 0 };
      r.mins += mins;
      r.runs += 1;
      repoStats.set(repo.full_name, r);
    }
  }

  const topWorkflows = [...workflowStats.entries()]
    .map(([workflow, s]) => ({
      workflow,
      billMinutes: s.mins,
      runs: s.runs,
      avgSeconds: Math.round(s.sec / s.runs),
      costUsd: Math.round(s.mins * RATE_PER_MINUTE * 100) / 100,
    }))
    .sort((a, b) => b.billMinutes - a.billMinutes)
    .slice(0, 12);

  const topRepos = [...repoStats.entries()]
    .map(([repo, s]) => ({
      repo,
      billMinutes: s.mins,
      runs: s.runs,
      costUsd: Math.round(s.mins * RATE_PER_MINUTE * 100) / 100,
    }))
    .sort((a, b) => b.billMinutes - a.billMinutes)
    .slice(0, 12);

  const totalBillMinutes = [...workflowStats.values()].reduce((sum, s) => sum + s.mins, 0);

  return {
    topWorkflows,
    topRepos,
    totalBillMinutes,
    totalCostUsd: Math.round(totalBillMinutes * RATE_PER_MINUTE * 100) / 100,
    sampledRuns,
  };
}

module.exports = { auditActionsCost, billMinutes, RATE_PER_MINUTE };
