const { priceJob, billMinutes, classifyRunner, formatUsd } = require("./runnerRates");
const { describeAllowance } = require("./allowance");

const DAY_MS = 24 * 60 * 60 * 1000;

function roundUsd(amount) {
  return Math.round(amount * 100) / 100;
}

function addStep(bucket, name, seconds) {
  const existing = bucket.get(name) || [];
  existing.push(seconds);
  bucket.set(name, existing);
}

/**
 * Turn fetched jobs into a ranked report. Observations from different
 * repositories stay separate: a workflow named CI in two repos is two rows.
 *
 * @param {Array<{
 *   fullName: string,
 *   owner: string,
 *   repo: string,
 *   visibility: string,
 *   defaultBranch?: string,
 *   workflowPath: string,
 *   workflowName: string,
 *   event?: string,
 *   runStartedAt?: string,
 *   runUpdatedAt?: string,
 *   job?: object | null,
 * }>} observations
 */
function aggregateObservations(observations, { repoCount = 0, reposConsidered = 0, partial = false } = {}) {
  const workflows = new Map();
  const repos = new Map();
  const repoMeta = new Map();
  const timestamps = [];
  let sampledRuns = new Set();
  let sampledJobs = 0;
  let totalMinutes = 0;
  let totalCost = 0;
  let cancelledJobs = 0;
  let unknownRunnerJobs = 0;
  const unknownRunnerLabels = new Set();

  for (const obs of observations) {
    const visibility = obs.visibility || "private";
    const workflowKey = `${obs.fullName}\t${obs.workflowPath || obs.workflowName}`;
    repoMeta.set(obs.fullName, {
      owner: obs.owner,
      repo: obs.repo,
      fullName: obs.fullName,
      visibility,
      defaultBranch: obs.defaultBranch || "main",
    });

    let priced = null;
    let approximate = false;
    if (obs.job) {
      priced = priceJob(obs.job, { visibility });
      if (!priced) continue;
    } else if (obs.runStartedAt && obs.runUpdatedAt) {
      approximate = true;
      const minutes = billMinutes(obs.runStartedAt, obs.runUpdatedAt);
      const rate = classifyRunner(["ubuntu-latest"], { visibility });
      priced = {
        name: "(run wall clock, jobs unavailable)",
        minutes,
        seconds: (new Date(obs.runUpdatedAt) - new Date(obs.runStartedAt)) / 1000,
        labels: [],
        rate,
        costUsd: rate.billable ? minutes * rate.usdPerMinute : 0,
        steps: [],
      };
    }
    if (!priced) continue;

    sampledJobs += approximate ? 0 : 1;
    if (priced.conclusion === "cancelled" && priced.minutes > 0) cancelledJobs++;
    if (priced.rate.sku === "not-github-hosted") {
      unknownRunnerJobs++;
      for (const label of priced.labels) unknownRunnerLabels.add(label);
    }
    if (obs.runId != null) sampledRuns.add(`${obs.fullName}:${obs.runId}`);
    totalMinutes += priced.minutes;
    totalCost += priced.costUsd;
    const obsTimes = [];
    if (obs.runStartedAt) obsTimes.push(new Date(obs.runStartedAt).getTime());
    if (obs.job?.completed_at) obsTimes.push(new Date(obs.job.completed_at).getTime());
    timestamps.push(...obsTimes);

    const workflow = workflows.get(workflowKey) || {
      repo: obs.fullName,
      owner: obs.owner,
      repoName: obs.repo,
      visibility,
      defaultBranch: obs.defaultBranch || "main",
      workflowPath: obs.workflowPath || obs.workflowName,
      workflowName: obs.workflowName || obs.workflowPath,
      events: [],
      billMinutes: 0,
      costUsd: 0,
      runs: new Set(),
      jobs: new Map(),
      skuMinutes: new Map(),
      approximate: false,
    };
    workflow.billMinutes += priced.minutes;
    workflow.costUsd += priced.costUsd;
    workflow.approximate = workflow.approximate || approximate;
    if (obs.runId != null) workflow.runs.add(obs.runId);
    if (obs.event) workflow.events.push(obs.event);
    const skuKey = priced.rate.sku;
    workflow.skuMinutes.set(skuKey, (workflow.skuMinutes.get(skuKey) || 0) + priced.minutes);

    const job = workflow.jobs.get(priced.name) || {
      name: priced.name,
      labels: priced.labels,
      durations: [],
      minutes: 0,
      costUsd: 0,
      steps: new Map(),
    };
    job.labels = priced.labels.length ? priced.labels : job.labels;
    job.durations.push(priced.seconds);
    job.minutes += priced.minutes;
    job.costUsd += priced.costUsd;
    for (const step of priced.steps) addStep(job.steps, step.name, step.seconds);
    workflow.jobs.set(priced.name, job);
    workflows.set(workflowKey, workflow);

    const repo = repos.get(obs.fullName) || { repo: obs.fullName, billMinutes: 0, runs: new Set(), costUsd: 0, times: [] };
    repo.times.push(...obsTimes);
    repo.billMinutes += priced.minutes;
    repo.costUsd += priced.costUsd;
    if (obs.runId != null) repo.runs.add(obs.runId);
    repos.set(obs.fullName, repo);
  }

  const topWorkflows = [...workflows.values()]
    .map((workflow) => {
      const topSku = [...workflow.skuMinutes.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        label: `${workflow.repo} · ${workflow.workflowName}`,
        repo: workflow.repo,
        workflowPath: workflow.workflowPath,
        workflowName: workflow.workflowName,
        billMinutes: workflow.billMinutes,
        runs: workflow.runs.size,
        costUsd: roundUsd(workflow.costUsd),
        topSku: topSku ? topSku[0] : null,
        approximate: workflow.approximate,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.billMinutes - a.billMinutes)
    .slice(0, 12);

  const topRepos = [...repos.values()]
    .map((repo) => ({
      repo: repo.repo,
      billMinutes: repo.billMinutes,
      runs: repo.runs.size,
      costUsd: roundUsd(repo.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.billMinutes - a.billMinutes)
    .slice(0, 12);

  const samples = [...workflows.values()].map((workflow) => ({
    owner: workflow.owner,
    repo: workflow.repoName,
    fullName: workflow.repo,
    visibility: workflow.visibility,
    defaultBranch: workflow.defaultBranch,
    workflowPath: workflow.workflowPath,
    workflowName: workflow.workflowName,
    events: [...new Set(workflow.events)],
    runCount: workflow.runs.size,
    costUsd: roundUsd(workflow.costUsd),
    billMinutes: workflow.billMinutes,
    jobs: [...workflow.jobs.values()].map((job) => ({
      name: job.name,
      labels: job.labels,
      durations: job.durations,
      minutes: job.minutes,
      costUsd: roundUsd(job.costUsd),
      steps: [...job.steps.entries()].map(([name, durations]) => ({ name, durations })),
    })),
  }));

  // Each repository is scaled by its own window. A busy repo's last runs
  // cover hours and a quiet repo's cover months; one shared window would
  // shrink the busy repo's cost by the quiet repo's span.
  const finiteTimes = timestamps.filter((value) => Number.isFinite(value));
  let monthlyUsd = null;
  let windowDays = null;
  let extrapolated = false;
  let flooredRepos = 0;
  if (finiteTimes.length >= 2) {
    const spanDays = (Math.max(...finiteTimes) - Math.min(...finiteTimes)) / DAY_MS;
    windowDays = Math.round(spanDays * 10) / 10;
    if (spanDays >= 7) {
      let monthly = 0;
      for (const repo of repos.values()) {
        if (!(repo.costUsd > 0)) continue;
        const times = repo.times.filter((value) => Number.isFinite(value));
        const repoDays = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;
        if (repoDays < 1) flooredRepos++;
        monthly += repo.costUsd * (30 / Math.max(repoDays, 1));
      }
      monthlyUsd = roundUsd(monthly);
      extrapolated = true;
    }
  }

  const allowance = describeAllowance(monthlyUsd != null ? monthlyUsd : totalCost, {
    source: monthlyUsd != null ? "month" : "sample",
  });

  const rankedCost = topWorkflows.reduce((sum, workflow) => sum + workflow.costUsd, 0);
  const topShare = topWorkflows[0] && (rankedCost > 0 || totalMinutes > 0)
    ? Math.round(
        ((rankedCost > 0 ? topWorkflows[0].costUsd / Math.max(totalCost, rankedCost) : topWorkflows[0].billMinutes / Math.max(totalMinutes, 1)) *
          100),
      )
    : 0;

  const notes = [];
  if (repoCount > reposConsidered) {
    notes.push(
      `Sampled the ${reposConsidered} most recently pushed repositories of ${repoCount} visible to the app.`,
    );
  }
  if (partial) notes.push("GitHub rate-limited the sample. Totals are partial.");
  if ([...workflows.values()].some((workflow) => workflow.approximate)) {
    notes.push(
      "Some runs are priced from the run's wall clock at the standard Linux rate because job details were unavailable. Parallel jobs in those runs are undercounted.",
    );
  }
  if (extrapolated) {
    notes.push("The monthly run-rate scales each repository by the time its own sampled runs cover, then adds them.");
  }
  if (flooredRepos > 0) {
    notes.push(
      `${flooredRepos} billed ${flooredRepos === 1 ? "repository ran its whole sample" : "repositories ran their whole sample"} inside one day and ${flooredRepos === 1 ? "is" : "are"} scaled from one day. Treat the run-rate as rough.`,
    );
  }
  if (cancelledJobs > 0) {
    notes.push(`${cancelledJobs} cancelled ${cancelledJobs === 1 ? "job is" : "jobs are"} priced for the minutes ${cancelledJobs === 1 ? "it" : "they"} ran. GitHub bills those.`);
  }
  if (unknownRunnerJobs > 0) {
    const sample = [...unknownRunnerLabels].slice(0, 4).join(", ");
    notes.push(
      `${unknownRunnerJobs} ${unknownRunnerJobs === 1 ? "job" : "jobs"} ran on labels that are not a standard GitHub-hosted name${sample ? ` (${sample})` : ""} and are priced at $0. If those are larger runners with custom labels, they are billed and missing here. The billing export has the real figure.`,
    );
  }
  if (!extrapolated) {
    notes.push(
      "The window is under 7 days, so this is the cost of the sample, not a monthly run-rate.",
    );
  }

  return {
    topWorkflows,
    topRepos,
    samples,
    repos: [...repoMeta.values()],
    totalBillMinutes: totalMinutes,
    totalCostUsd: roundUsd(totalCost),
    sampledRuns: sampledRuns.size,
    sampledJobs,
    cancelledJobs,
    unknownRunnerJobs,
    monthlyUsd,
    windowDays,
    extrapolated,
    topShare,
    allowance,
    writtenAudit: allowance.writtenAudit,
    notes,
    totalCostDisplay: formatUsd(totalCost),
  };
}

module.exports = { aggregateObservations };
