const { billMinutes } = require("./runnerRates");
const { aggregateObservations } = require("./aggregateJobs");

const MAX_REPOS = 20;
const RUNS_PER_REPO = 20;
const JOB_CONCURRENCY = 4;

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Math.min(limit, items.length);
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function visibilityOf(repo) {
  if (repo.visibility) return repo.visibility;
  return repo.private === false ? "public" : "private";
}

function isRateLimit(err) {
  return err?.status === 403 || err?.status === 429;
}

/**
 * Job-level sample. Each job is billed at its runner SKU. Parallel jobs add.
 * Workflow identity is repository + workflow path, so the same display name
 * in two repos stays two rows.
 */
async function auditActionsCost(octokit) {
  const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
  const eligible = repos
    .filter((repo) => !repo.fork && !repo.archived)
    .sort((a, b) => new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0));
  const selected = eligible.slice(0, MAX_REPOS);
  const observations = [];
  let partial = false;

  for (const repo of selected) {
    if (partial) break;
    const owner = repo.owner.login;
    const visibility = visibilityOf(repo);
    let runs = [];
    try {
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo: repo.name,
        per_page: RUNS_PER_REPO,
      });
      runs = data.workflow_runs || [];
    } catch (err) {
      if (isRateLimit(err)) {
        partial = true;
        break;
      }
      continue;
    }

    const jobLists = await pool(runs, JOB_CONCURRENCY, async (run) => {
      if (!run.id) return { run, jobs: null };
      try {
        const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
          owner,
          repo: repo.name,
          run_id: run.id,
        });
        return { run, jobs: data.jobs || [] };
      } catch (err) {
        if (isRateLimit(err)) return { run, jobs: null, rateLimited: true };
        return { run, jobs: null };
      }
    });

    for (const entry of jobLists) {
      if (entry.rateLimited) partial = true;
      const run = entry.run;
      const base = {
        fullName: repo.full_name,
        owner,
        repo: repo.name,
        visibility,
        defaultBranch: repo.default_branch || "main",
        workflowPath: run.path || run.name || "workflow",
        workflowName: run.name || run.path || "workflow",
        event: run.event || "",
        runId: run.id,
        runStartedAt: run.run_started_at,
        runUpdatedAt: run.updated_at,
      };
      if (entry.jobs && entry.jobs.length) {
        for (const job of entry.jobs) observations.push({ ...base, job });
      } else if (run.run_started_at && run.updated_at) {
        observations.push({ ...base, job: null });
      }
    }
  }

  const report = aggregateObservations(observations, {
    repoCount: eligible.length,
    reposConsidered: selected.length,
    partial,
  });
  report.generatedAt = new Date().toISOString();
  return report;
}

module.exports = {
  auditActionsCost,
  billMinutes,
  MAX_REPOS,
  RUNS_PER_REPO,
  /** Standard private Linux 2-core rate. Not a universal minute price. */
  RATE_PER_MINUTE: 0.006,
};
