const YAML = require("yaml");

/**
 * Two checks only — the ones that survived corroboration against a real
 * fleet (Joe's own repos and a large third-party monorepo) without a false
 * positive. Everything else prototyped alongside these (concurrency,
 * .dockerignore, npm ci) either risks being confidently wrong (concurrency
 * can cancel a live deploy) or corroborated as not worth a customer's
 * attention (npm ci: single-digit seconds in every real instance found).
 * Ship only what's been verified, not everything the detector notices.
 */
const DEPLOY_JOB_RE = /deploy|release|publish|prod/i;
const BROWSER_INSTALLERS = [
  { re: /playwright\s+install/i, tool: "playwright", cacheDir: "~/.cache/ms-playwright" },
  { re: /cypress\s+install/i, tool: "cypress", cacheDir: "~/.cache/Cypress" },
];
const DEFAULT_TIMEOUT_MINUTES = 360;
const RUNS_TO_SAMPLE_TARGET = 12; // stop scanning once we have this many real samples
const MAX_RUNS_TO_SCAN = 100; // hard ceiling on API calls per finding, per MCP call
const BATCH_CONCURRENCY = 5; // conservative — avoid GitHub's secondary rate limiting
const MIN_SAMPLES_TO_CONFIRM = 3;
const LOW_VALUE_AVG_SECONDS = 10;
const MAX_REPOS_TO_SCAN = 5; // only the top-cost repos from the ranking, not the whole fleet

function isReusableWorkflowJob(job) {
  return typeof job.uses === "string" && /\.ya?ml(@|$)/.test(job.uses);
}
function jobSteps(job) {
  return Array.isArray(job.steps) ? job.steps : [];
}
function stepRun(step) {
  return typeof step.run === "string" ? step.run : "";
}
function findCacheStepsCoveringDir(steps, dir) {
  return steps.some((s) => {
    if (typeof s.uses !== "string" || !s.uses.startsWith("actions/cache")) return false;
    const p = s.with && s.with.path;
    if (!p) return false;
    return String(p).split("\n").map((x) => x.trim()).some((x) => x.includes(dir.replace("~", "")) || x === dir);
  });
}
function matchesJobId(job, jobId) {
  return job.name === jobId || job.name.startsWith(jobId + " (");
}
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function detectMissingBrowserCache(workflowName, jobId, job) {
  const steps = jobSteps(job);
  const findings = [];
  for (const installer of BROWSER_INSTALLERS) {
    const hitIdx = steps.findIndex((s) => installer.re.test(stepRun(s)));
    if (hitIdx === -1) continue;
    if (findCacheStepsCoveringDir(steps, installer.cacheDir)) continue;
    findings.push({
      check: "missing-browser-cache",
      workflow: workflowName,
      job: jobId,
      stepName: steps[hitIdx].name || null,
      isJobDuration: false,
      summary: `"${jobId}" runs ${installer.tool} install on every run with no cache covering ${installer.cacheDir}.`,
      diffTemplate: [
        `# Add before the "${installer.tool} install" step in job "${jobId}":`,
        `- name: Cache ${installer.tool} browsers`,
        `  uses: actions/cache@v4`,
        `  with:`,
        `    path: ${installer.cacheDir}`,
        `    key: \${{ runner.os }}-${installer.tool}-\${{ hashFiles('**/package-lock.json', '**/yarn.lock') }}`,
      ].join("\n"),
    });
  }
  return findings;
}

function detectMissingTimeout(workflowName, jobId, job) {
  if (isReusableWorkflowJob(job)) return [];
  if (job["timeout-minutes"] != null) return [];
  return [
    {
      check: "missing-timeout",
      workflow: workflowName,
      job: jobId,
      stepName: null,
      isJobDuration: true,
      summary: `"${jobId}" has no timeout-minutes set — if it ever hangs, GitHub bills up to ${DEFAULT_TIMEOUT_MINUTES} minutes before killing it.`,
    },
  ];
}

function staticFindingsForWorkflow(workflowFile, workflowYaml) {
  let doc;
  try {
    doc = YAML.parse(workflowYaml);
  } catch {
    return [];
  }
  if (!doc || !doc.jobs) return [];
  const workflowName = doc.name || workflowFile;
  const findings = [];
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (isReusableWorkflowJob(job)) continue;
    findings.push(...detectMissingBrowserCache(workflowName, jobId, job));
    findings.push(...detectMissingTimeout(workflowName, jobId, job));
  }
  return findings;
}

async function scanForDurations(octokit, owner, repo, workflowFile, jobName, stepName) {
  let runsScanned = 0;
  const durations = [];
  let page = 1;
  try {
    while (runsScanned < MAX_RUNS_TO_SCAN && durations.length < RUNS_TO_SAMPLE_TARGET) {
      const { data } = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowFile,
        status: "completed",
        per_page: 30,
        page,
      });
      if (data.workflow_runs.length === 0) break;
      const runs = data.workflow_runs.slice(0, MAX_RUNS_TO_SCAN - runsScanned);
      for (let i = 0; i < runs.length; i += BATCH_CONCURRENCY) {
        const batch = runs.slice(i, i + BATCH_CONCURRENCY);
        const results = await Promise.all(
          batch.map((run) =>
            octokit.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: run.id }).catch((e) => ({ __failed: e })),
          ),
        );
        if (results.some((r) => r?.__failed?.status === 403)) {
          return { sampled: durations.length, durations, aborted: true };
        }
        for (const res of results) {
          runsScanned++;
          if (res.__failed) continue;
          const matches = res.data.jobs.filter(
            (j) => matchesJobId(j, jobName) && j.conclusion !== "skipped" && j.conclusion !== "cancelled",
          );
          for (const job of matches) {
            if (stepName) {
              const step = job.steps?.find((s) => s.name === stepName);
              if (step && step.conclusion !== "skipped" && step.started_at && step.completed_at) {
                durations.push((new Date(step.completed_at) - new Date(step.started_at)) / 1000);
              }
            } else if (job.started_at && job.completed_at) {
              durations.push((new Date(job.completed_at) - new Date(job.started_at)) / 1000);
            }
          }
        }
        if (durations.length >= RUNS_TO_SAMPLE_TARGET) break;
      }
      if (data.workflow_runs.length < 30) break;
      page++;
    }
    return { sampled: durations.length, durations };
  } catch (err) {
    return { sampled: durations.length, durations, error: err.message };
  }
}

/**
 * Fetch workflow YAML via Contents API — this is the one thing that needs
 * the Contents: read permission (Actions: read alone only gives run/job
 * metadata, not file content).
 */
async function fetchWorkflowFiles(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: ".github/workflows" });
    const files = Array.isArray(data) ? data.filter((f) => /\.ya?ml$/.test(f.name)) : [];
    const contents = [];
    for (const f of files) {
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({ owner, repo, path: f.path });
        if (fileData.content) {
          contents.push({ file: f.name, yaml: Buffer.from(fileData.content, "base64").toString("utf8") });
        }
      } catch {
        // one file failing to fetch shouldn't drop the whole repo
      }
    }
    return contents;
  } catch (err) {
    if (err.status === 403 || err.status === 404) return []; // no Contents access yet, or no workflows dir
    throw err;
  }
}

/**
 * @param {import('@octokit/rest').Octokit} octokit - installation-scoped
 * @param {Array<{owner: string, repo: string}>} topRepos - from the cost ranking, highest-cost first
 * @returns {Promise<Array>} confirmed findings only (CONFIRMED-COSTLY / CONFIRMED-RISK), sorted best first
 */
async function suggestFixes(octokit, topRepos) {
  const confirmed = [];

  for (const { owner, repo } of topRepos.slice(0, MAX_REPOS_TO_SCAN)) {
    let workflowFiles;
    try {
      workflowFiles = await fetchWorkflowFiles(octokit, owner, repo);
    } catch {
      continue; // don't let one repo's failure kill the whole audit
    }
    if (workflowFiles.length === 0) continue;

    for (const { file, yaml } of workflowFiles) {
      const findings = staticFindingsForWorkflow(file, yaml);
      for (const finding of findings) {
        const corro = await scanForDurations(
          octokit,
          owner,
          repo,
          file,
          finding.job,
          finding.isJobDuration ? null : finding.stepName,
        );
        if (corro.aborted || corro.sampled < MIN_SAMPLES_TO_CONFIRM) continue; // UNCONFIRMED — never shown

        if (finding.check === "missing-timeout") {
          const med = median(corro.durations);
          const suggestedMinutes = Math.max(5, Math.ceil((med / 60) * 3));
          confirmed.push({
            repo: `${owner}/${repo}`,
            check: finding.check,
            summary: `${finding.summary} Median run: ${Math.round(med)}s over ${corro.sampled} recent runs.`,
            diff: [`# In job "${finding.job}" (${file}):`, `  timeout-minutes: ${suggestedMinutes}`].join("\n"),
            impactScore: med, // rough ranking signal — real duration, not a guess
          });
        } else {
          const avg = corro.durations.reduce((a, b) => a + b, 0) / corro.durations.length;
          if (avg < LOW_VALUE_AVG_SECONDS) continue; // CONFIRMED-LOW-VALUE — never shown
          confirmed.push({
            repo: `${owner}/${repo}`,
            check: finding.check,
            summary: `${finding.summary} Confirmed avg ${avg.toFixed(1)}s of pure waste per run over ${corro.sampled} recent runs.`,
            diff: finding.diffTemplate,
            impactScore: avg,
          });
        }
      }
    }
  }

  return confirmed.sort((a, b) => b.impactScore - a.impactScore);
}

module.exports = { suggestFixes };
