const YAML = require("yaml");
const { classifyRunner, formatUsd } = require("./runnerRates");

const DEPLOY_RE = /deploy|release|publish|prod/i;
/** Step text that ships something. A job named "build" can still deploy. */
const DEPLOY_STEP_RE =
  /deploy|release|publish|prod|kubectl\s+(apply|rollout|set)|helm\s+(upgrade|install)|terraform\s+apply|pulumi\s+up|docker\s+push|npm\s+publish|cargo\s+publish|twine\s+upload|gh\s+release|wrangler|firebase|vercel|netlify|flyctl|aws\s+s3\s+sync|gsutil|gcloud\s+(run|app|functions)|cloudformation|serverless/i;

/** Applied as the concurrency patch: cancel superseded pull-request runs only, never a push to a branch. */
const CONCURRENCY_LINES = [
  "concurrency:",
  "  group: ${{ github.workflow }}-${{ github.ref }}",
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
];

function looksLikeDeploy(sample, file, doc) {
  if (DEPLOY_RE.test(sample.workflowName || "") || DEPLOY_RE.test(file)) return true;
  for (const [jobId, job] of Object.entries(doc.jobs || {})) {
    if (DEPLOY_RE.test(jobId)) return true;
    if (!job || typeof job !== "object") continue;
    if (typeof job.uses === "string") return true; // reusable workflow: contents unknown
    if (job.environment != null) return true;
    if (DEPLOY_RE.test(String(job.name || ""))) return true;
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!step || typeof step !== "object") continue;
      const text = [step.name, step.run, step.uses].filter((v) => typeof v === "string").join("\n");
      if (DEPLOY_STEP_RE.test(text)) return true;
    }
  }
  return false;
}
const BROWSER_INSTALLERS = [
  { re: /playwright\s+install/i, tool: "playwright", cacheDir: "~/.cache/ms-playwright" },
  { re: /cypress\s+install/i, tool: "cypress", cacheDir: "~/.cache/Cypress" },
];
const MIN_SAMPLES = 3;
const LOW_VALUE_SECONDS = 10;
const MAX_REPOS = 5;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function triggersOf(doc) {
  const raw = doc.on !== undefined ? doc.on : doc.true;
  if (typeof raw === "string") return { [raw]: {} };
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((event) => [String(event), {}]));
  if (raw && typeof raw === "object") return raw;
  return {};
}

function eventConfig(triggers, name) {
  if (!Object.prototype.hasOwnProperty.call(triggers, name)) return null;
  const value = triggers[name];
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function hasPathFilter(config) {
  return config != null && (config.paths != null || config["paths-ignore"] != null);
}

function matchingJobs(sample, jobId) {
  return (sample.jobs || []).filter(
    (job) => job.name === jobId || String(job.name).startsWith(`${jobId} (`),
  );
}

function stepDurations(jobs, stepName) {
  const values = [];
  for (const job of jobs) {
    for (const step of job.steps || []) {
      if (step.name === stepName) values.push(...step.durations);
    }
  }
  return values;
}

function matrixFanout(job) {
  const matrix = job.strategy && job.strategy.matrix;
  if (!matrix || typeof matrix !== "object") return null;
  let product = 1;
  let dims = 0;
  const runners = [];
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    if (!Array.isArray(value) || value.length === 0) continue;
    product *= value.length;
    dims++;
    if (/os|runner|runs-on/i.test(key)) runners.push(...value.map(String));
  }
  const include = Array.isArray(matrix.include) ? matrix.include.length : 0;
  return {
    fanout: dims ? product : include,
    macos: runners.some((value) => /macos/i.test(value)),
  };
}

function baseFinding(sample, file, extra) {
  return {
    repo: sample.fullName,
    workflowFile: sample.workflowPath || file,
    job: extra.job || null,
    footnote: false,
    patch: null,
    ...extra,
  };
}

function analyzeWorkflowYaml(sample, file, yamlText) {
  let doc;
  try {
    doc = YAML.parse(yamlText);
  } catch {
    return [];
  }
  if (!doc || !doc.jobs || typeof doc.jobs !== "object") return [];

  const findings = [];
  const triggers = triggersOf(doc);
  const push = eventConfig(triggers, "push");
  const pull = eventConfig(triggers, "pull_request");
  const deployish = looksLikeDeploy(sample, file, doc);
  const events = new Set(sample.events || []);
  const allDurations = (sample.jobs || []).flatMap((job) => job.durations || []);
  const overallMedian = allDurations.length ? median(allDurations) : 0;

  if (push && pull && events.has("push") && events.has("pull_request")) {
    findings.push(
      baseFinding(sample, file, {
        check: "duplicate-trigger",
        summary: `"${sample.workflowName}" runs on both push and pull_request, and this sample contains both events. A branch push that also opens a pull request starts two billed runs.`,
        diff: deployish
          ? `# In ${file}, keep one of "push" or "pull_request". cancel-in-progress is left off because a job in this workflow looks like a deploy.`
          : ["# Superseded pull-request runs on the same ref are cancelled.", ...CONCURRENCY_LINES].join("\n"),
        impactScore: sample.costUsd || overallMedian,
        patch: deployish ? null : { type: "concurrency" },
      }),
    );
  }

  const unfiltered = (push && !hasPathFilter(push)) || (pull && !hasPathFilter(pull));
  if (unfiltered && allDurations.length >= MIN_SAMPLES && overallMedian >= 60) {
    findings.push(
      baseFinding(sample, file, {
        check: "missing-path-filters",
        summary: `"${sample.workflowName}" has no paths filter. Median job time in this sample is ${Math.round(overallMedian)}s across ${allDurations.length} jobs, so a docs-only commit still pays for the workflow.`,
        diff: ["# Under push: and pull_request:", "paths-ignore:", '  - "**/*.md"', '  - "docs/**"'].join("\n"),
        impactScore: sample.costUsd || overallMedian,
      }),
    );
  }

  if (
    !deployish &&
    !doc.concurrency &&
    (push || pull) &&
    (sample.runCount || 0) >= MIN_SAMPLES &&
    !findings.some((finding) => finding.patch && finding.patch.type === "concurrency")
  ) {
    findings.push(
      baseFinding(sample, file, {
        check: "missing-concurrency",
        summary: `"${sample.workflowName}" has no concurrency group. ${sample.runCount} runs are in this sample, and a newer push to a pull request keeps paying for the run it replaced.`,
        diff: CONCURRENCY_LINES.join("\n"),
        impactScore: (sample.costUsd || overallMedian) / 2,
        patch: { type: "concurrency" },
      }),
    );
  }

  for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (!job || typeof job !== "object" || typeof job.uses === "string") continue;
    const matched = matchingJobs(sample, jobId);
    const durations = matched.flatMap((item) => item.durations || []);
    const med = durations.length ? median(durations) : 0;
    const steps = Array.isArray(job.steps) ? job.steps : [];

    for (const installer of BROWSER_INSTALLERS) {
      const step = steps.find((item) => installer.re.test(typeof item.run === "string" ? item.run : ""));
      if (!step) continue;
      const cached = steps.some((item) => {
        if (typeof item.uses !== "string" || !item.uses.startsWith("actions/cache")) return false;
        const path = item.with && item.with.path;
        return path && String(path).includes(installer.cacheDir.replace("~", ""));
      });
      if (cached) continue;
      const stepName = step.name || null;
      const observed = stepName ? stepDurations(matched, stepName) : [];
      if (observed.length < MIN_SAMPLES) continue;
      const avg = observed.reduce((sum, value) => sum + value, 0) / observed.length;
      if (avg < LOW_VALUE_SECONDS) continue;
      findings.push(
        baseFinding(sample, file, {
          check: "missing-browser-cache",
          job: jobId,
          summary: `"${jobId}" runs ${installer.tool} install with no cache. Confirmed average ${avg.toFixed(1)}s across ${observed.length} runs in this sample.`,
          diff: [
            `- name: Cache ${installer.tool} browsers`,
            "  uses: actions/cache@v4",
            "  with:",
            `    path: ${installer.cacheDir}`,
            `    key: \${{ runner.os }}-${installer.tool}-\${{ hashFiles('**/package-lock.json', '**/yarn.lock') }}`,
          ].join("\n"),
          impactScore: avg,
        }),
      );
    }

    const matrix = matrixFanout(job);
    if (matrix && matrix.fanout >= 4 && matched.length >= 2) {
      const cost = matched.reduce((sum, item) => sum + (item.costUsd || 0), 0);
      findings.push(
        baseFinding(sample, file, {
          check: "matrix-fanout",
          job: jobId,
          summary: `"${jobId}" fans out to ${matrix.fanout} cells${matrix.macos ? ", including macOS" : ""}. Each cell is a separate billed job. This sample saw ${formatUsd(cost)} across those cells.`,
          diff: "# Keep macOS and other expensive axes on a schedule. Leave the pull-request matrix on Linux.",
          impactScore: cost || med,
        }),
      );
    }

    for (const observed of matched) {
      const rate = classifyRunner(observed.labels, { visibility: sample.visibility });
      if (sample.visibility === "public" && rate.larger && observed.costUsd > 0) {
        const from = (observed.labels || []).find((label) => label.startsWith("ubuntu"));
        const shortLinux = durations.length >= MIN_SAMPLES && med < 90 && String(rate.sku).startsWith("linux") && from;
        findings.push(
          baseFinding(sample, file, {
            check: "public-larger-runner",
            job: jobId,
            summary: `"${jobId}" uses ${rate.sku} on a public repository (${formatUsd(rate.usdPerMinute)}/min). Larger runners are billed on public repositories. This sample is ${observed.minutes} minutes, ${formatUsd(observed.costUsd)}.`,
            diff: shortLinux
              ? `# Median ${Math.round(med)}s. ubuntu-latest is free on this public repository.\nruns-on: ubuntu-latest`
              : "# Larger runners stay on the invoice even when the repository is public. Move the job only if it does not need the extra cores.",
            impactScore: observed.costUsd,
            patch:
              shortLinux && job["runs-on"] === from
                ? { type: "runner", jobId, from, to: "ubuntu-latest" }
                : null,
          }),
        );
        break;
      }
      if (String(rate.sku).startsWith("macos") || rate.sku === "actions_macos") {
        const blob = `${jobId} ${JSON.stringify(job)}`.toLowerCase();
        const needsMac = /xcode|macos|ios|swift|cocoapods|pod install/.test(blob);
        if (!needsMac && durations.length >= MIN_SAMPLES && observed.costUsd > 0) {
          findings.push(
            baseFinding(sample, file, {
              check: "macos-runner",
              job: jobId,
              summary: `"${jobId}" runs on ${rate.sku} at ${formatUsd(rate.usdPerMinute)}/min. The job does not name an Apple toolchain. macOS is about ten times the Linux 2-core rate. This sample is ${formatUsd(observed.costUsd)}.`,
              diff: "# If the job does not need macOS, use ubuntu-latest. If it does, run it on a schedule instead of every pull request.",
              impactScore: observed.costUsd || med,
            }),
          );
        }
        break;
      }
      if (rate.larger && String(rate.sku).startsWith("linux") && durations.length >= MIN_SAMPLES && med < 90) {
        findings.push(
          baseFinding(sample, file, {
            check: "oversized-runner",
            job: jobId,
            summary: `"${jobId}" uses ${rate.sku} (${formatUsd(rate.usdPerMinute)}/min) and the median job in this sample is ${Math.round(med)}s. The larger-runner minute is billed in full.`,
            diff: "# If the job is not actually using the extra cores:\nruns-on: ubuntu-latest",
            impactScore: observed.costUsd || med,
          }),
        );
        break;
      }
    }

    if (job["timeout-minutes"] == null && durations.length >= MIN_SAMPLES) {
      // Matrix cells share a job id, so the median can sit far below the
      // slowest cell. The limit must clear the slowest run seen, with room.
      const slowest = Math.max(...durations);
      const minutes = Math.max(5, Math.ceil(Math.max(med * 3, slowest * 1.5) / 60));
      findings.push(
        baseFinding(sample, file, {
          check: "missing-timeout",
          job: jobId,
          summary: `"${jobId}" has no timeout-minutes. Median in this sample is ${Math.round(med)}s. Slowest is ${Math.round(Math.max(...durations))}s. A hang bills until GitHub's six-hour default. This does not shorten a healthy run.`,
          diff: `timeout-minutes: ${minutes}`,
          impactScore: 0,
          footnote: true,
          patch: { type: "timeout", jobId, minutes },
        }),
      );
    }
  }

  return findings;
}

async function fetchWorkflowFiles(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: ".github/workflows" });
    const files = Array.isArray(data) ? data.filter((file) => /\.ya?ml$/.test(file.name)) : [];
    const contents = [];
    for (const file of files) {
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: file.path,
        });
        if (fileData.content && fileData.encoding === "base64") {
          contents.push({
            file: file.name,
            path: file.path,
            yaml: Buffer.from(fileData.content, "base64").toString("utf8"),
          });
        }
      } catch {
        // one file failing should not drop the repo
      }
    }
    return contents;
  } catch (err) {
    if (err.status === 403 || err.status === 404) return [];
    throw err;
  }
}

async function suggestFixes(octokit, report) {
  const samples = [...(report.samples || [])].sort((a, b) => b.costUsd - a.costUsd);
  const seen = new Set();
  const repos = [];
  for (const sample of samples) {
    const key = sample.fullName;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(sample);
    if (repos.length >= MAX_REPOS) break;
  }

  const findings = [];
  for (const repoSample of repos) {
    const files = await fetchWorkflowFiles(octokit, repoSample.owner, repoSample.repo);
    const repoSamples = samples.filter((sample) => sample.fullName === repoSample.fullName);
    for (const file of files) {
      const sample =
        repoSamples.find((item) => item.workflowPath === file.path || item.workflowPath.endsWith(`/${file.file}`)) ||
        repoSamples.find((item) => item.workflowName === file.file) ||
        null;
      if (!sample) continue;
      findings.push(...analyzeWorkflowYaml(sample, file.file, file.yaml));
    }
  }

  return findings.sort((a, b) => Number(a.footnote) - Number(b.footnote) || b.impactScore - a.impactScore);
}

module.exports = { suggestFixes, analyzeWorkflowYaml, looksLikeDeploy };
