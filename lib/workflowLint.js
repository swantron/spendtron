const YAML = require("yaml");
const { classifyRunner } = require("./runnerRates");

function perMinute(rate) {
  return `$${Number(rate).toFixed(3)}/min`;
}
const { looksLikeDeploy } = require("./suggestFixes");
const { applyWorkflowPatches } = require("./workflowPatch");

/**
 * Static checks on one pasted workflow file. Unlike suggestFixes, there is
 * no run history here, so every finding is phrased as something to check,
 * not a measured saving. Only edits that cannot change which tests run are
 * applied to the patched copy: a concurrency group for a non-deploy
 * workflow, and timeouts.
 */

const MAX_YAML_BYTES = 200 * 1024;
const DEFAULT_TIMEOUT_MINUTES = 30;
const SETUP_CACHE = [
  { re: /^actions\/setup-node@/, tool: "Node", input: "cache", example: "cache: npm" },
  { re: /^actions\/setup-python@/, tool: "Python", input: "cache", example: "cache: pip" },
  { re: /^actions\/setup-java@/, tool: "Java", input: "cache", example: "cache: gradle" },
];
const BROWSER_INSTALLERS = [
  { re: /playwright\s+install/i, tool: "Playwright", cacheDir: "~/.cache/ms-playwright" },
  { re: /cypress\s+install/i, tool: "Cypress", cacheDir: "~/.cache/Cypress" },
];
const APPLE_RE = /xcode|xcodebuild|macos|ios|swift|cocoapods|pod install|fastlane|notar|codesign|brew/i;

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

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Runner labels a job can land on, with matrix expressions expanded where they are literal. */
function runnerLabels(job) {
  const runsOn = job["runs-on"];
  const matrix = (job.strategy && job.strategy.matrix) || {};
  const out = [];
  const expand = (value) => {
    const text = String(value);
    const ref = text.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
    if (ref) {
      const values = asList(matrix[ref[1]]).map(String);
      const included = asList(matrix.include)
        .map((item) => item && item[ref[1]])
        .filter((item) => item != null)
        .map(String);
      return [...values, ...included];
    }
    return [text];
  };
  if (runsOn && typeof runsOn === "object" && !Array.isArray(runsOn)) {
    // runs-on: { group, labels }
    for (const label of asList(runsOn.labels)) out.push([String(label)]);
    if (runsOn.group) out.push(["self-hosted"]);
    return out;
  }
  if (Array.isArray(runsOn)) return [runsOn.map(String)];
  if (runsOn != null) for (const label of expand(runsOn)) out.push([label]);
  return out;
}

function matrixSize(job) {
  const matrix = job.strategy && job.strategy.matrix;
  if (!matrix || typeof matrix !== "object" || typeof matrix === "string") return 1;
  let product = 1;
  let dims = 0;
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    if (!Array.isArray(value) || value.length === 0) continue;
    product *= value.length;
    dims++;
  }
  const include = Array.isArray(matrix.include) ? matrix.include.length : 0;
  const exclude = Array.isArray(matrix.exclude) ? matrix.exclude.length : 0;
  if (!dims) return Math.max(1, include);
  return Math.max(1, product - exclude);
}

/** Minimum interval in minutes a cron expression fires at, for the common forms only. */
function cronIntervalMinutes(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour] = parts;
  const everyHour = hour === "*";
  if (minute === "*") return everyHour ? 1 : null;
  const step = minute.match(/^\*\/(\d+)$/);
  if (step && everyHour) return Number(step[1]);
  if (/^[\d,]+$/.test(minute) && everyHour) {
    const count = minute.split(",").length;
    return Math.floor(60 / count);
  }
  return null;
}

function finding(check, severity, summary, extra = {}) {
  return { check, severity, summary, job: null, fix: null, ...extra };
}

/**
 * @param {string} yamlText one workflow file
 * @param {{ visibility?: "public" | "private" }} options
 */
function lintWorkflow(yamlText, { visibility = "private" } = {}) {
  const text = String(yamlText || "");
  if (!text.trim()) return { ok: false, error: "Paste a workflow file first." };
  if (Buffer.byteLength(text, "utf8") > MAX_YAML_BYTES) {
    return { ok: false, error: "That file is over 200 KB. Paste one workflow file at a time." };
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    return { ok: false, error: `The YAML did not parse: ${String(err.message).split("\n")[0]}` };
  }
  if (!doc || typeof doc !== "object" || !doc.jobs || typeof doc.jobs !== "object") {
    return { ok: false, error: "No jobs: block found. Paste a file from .github/workflows." };
  }

  const isPublic = visibility === "public";
  const findings = [];
  const patches = [];
  const triggers = triggersOf(doc);
  const push = eventConfig(triggers, "push");
  const pull = eventConfig(triggers, "pull_request");
  const deployish = looksLikeDeploy({ workflowName: doc.name || "" }, "", doc);
  const workflowName = doc.name ? `"${doc.name}"` : "This workflow";
  const jobs = Object.entries(doc.jobs).filter(([, job]) => job && typeof job === "object");

  if (push && pull && !push.branches && !push["branches-ignore"] && !push.tags) {
    findings.push(
      finding(
        "duplicate-trigger",
        "high",
        `${workflowName} runs on every push and on pull_request. A push to a branch with an open pull request starts two billed runs of the same commit.`,
        {
          fix: ["on:", "  push:", "    branches: [main]", "  pull_request:"].join("\n"),
        },
      ),
    );
  }

  if ((push && !hasPathFilter(push)) || (pull && !hasPathFilter(pull))) {
    findings.push(
      finding(
        "missing-path-filters",
        "medium",
        `${workflowName} has no paths or paths-ignore filter, so a README or docs-only change runs every job.`,
        {
          fix: ["# Under push: and pull_request:", "paths-ignore:", '  - "**/*.md"', '  - "docs/**"'].join("\n"),
        },
      ),
    );
  }

  if (!doc.concurrency && pull) {
    if (deployish) {
      findings.push(
        finding(
          "missing-concurrency",
          "medium",
          `${workflowName} has no concurrency group. It looks like it deploys, so cancelling a run part-way is risky. If superseded pull-request runs are safe to stop, add a group that only cancels on pull_request.`,
          {
            fix: [
              "concurrency:",
              "  group: ${{ github.workflow }}-${{ github.ref }}",
              "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
            ].join("\n"),
          },
        ),
      );
    } else {
      findings.push(
        finding(
          "missing-concurrency",
          "high",
          `${workflowName} has no concurrency group. Each new push to a pull request leaves the previous run going, and both are billed.`,
          {
            fix: [
              "concurrency:",
              "  group: ${{ github.workflow }}-${{ github.ref }}",
              "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
            ].join("\n"),
            patched: true,
          },
        ),
      );
      patches.push({ type: "concurrency" });
    }
  }

  for (const cron of asList(triggers.schedule)) {
    const interval = cron && cronIntervalMinutes(cron.cron);
    if (interval != null && interval < 60) {
      const runsPerMonth = Math.round((30 * 24 * 60) / interval);
      findings.push(
        finding(
          "frequent-schedule",
          "high",
          `The schedule "${cron.cron}" fires about every ${interval} minute${interval === 1 ? "" : "s"}: roughly ${runsPerMonth.toLocaleString("en-US")} runs a month. Each job in each run is billed at least one minute.`,
          { fix: "# Hourly is usually enough for a health check:\n- cron: \"0 * * * *\"" },
        ),
      );
    }
  }

  for (const [jobId, job] of jobs) {
    if (typeof job.uses === "string") continue; // reusable workflow; its file is checked on its own
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const cells = matrixSize(job);
    const labelSets = runnerLabels(job);
    const rates = labelSets.map((labels) => ({ labels, rate: classifyRunner(labels, { visibility }) }));

    const mac = rates.find(({ rate }) => String(rate.sku).startsWith("macos") || rate.sku === "actions_macos");
    if (mac && (mac.rate.usdPerMinute > 0 || mac.rate.larger)) {
      const needsMac = APPLE_RE.test(`${jobId} ${JSON.stringify(steps)}`);
      findings.push(
        finding(
          "macos-runner",
          needsMac ? "medium" : "high",
          needsMac
            ? `"${jobId}" runs on macOS (${perMinute(mac.rate.usdPerMinute)}, about 10× Linux) and looks like it needs Apple tools. Consider running it on main or a schedule rather than on every pull request.`
            : `"${jobId}" runs on macOS (${perMinute(mac.rate.usdPerMinute)}, about 10× Linux) and no step names Xcode, Swift, iOS, or another Apple tool. If it doesn't need a Mac, ubuntu-latest is far cheaper.`,
          {
            job: jobId,
            fix: needsMac
              ? "# Run the macOS job only after merge:\nif: github.event_name == 'push' && github.ref == 'refs/heads/main'"
              : "runs-on: ubuntu-latest",
          },
        ),
      );
    }

    const larger = rates.find(({ rate }) => rate.larger && rate.usdPerMinute > 0);
    if (larger && !mac) {
      findings.push(
        finding(
          "larger-runner",
          isPublic ? "high" : "medium",
          isPublic
            ? `"${jobId}" uses a larger runner (${larger.rate.sku}, ${perMinute(larger.rate.usdPerMinute)}). Larger runners are billed even on public repositories, where ubuntu-latest is free.`
            : `"${jobId}" uses a larger runner (${larger.rate.sku}, ${perMinute(larger.rate.usdPerMinute)},${Math.round(larger.rate.usdPerMinute / 0.006)}× the 2-core rate). It pays off only if the job runs that much faster.`,
          { job: jobId, fix: "# If the job is not using the extra cores:\nruns-on: ubuntu-latest" },
        ),
      );
    }

    const windows = rates.find(({ rate }) => rate.sku === "actions_windows" && rate.usdPerMinute > 0);
    if (windows && cells === 1) {
      findings.push(
        finding(
          "windows-runner",
          "low",
          `"${jobId}" runs on Windows at ${perMinute(windows.rate.usdPerMinute)}, about 1.7× Linux. Worth it only if the job tests Windows behavior.`,
          { job: jobId },
        ),
      );
    }

    if (cells >= 4) {
      const hasMacCell = rates.some(({ rate }) => String(rate.sku).includes("macos") && rate.usdPerMinute > 0);
      findings.push(
        finding(
          "matrix-fanout",
          hasMacCell || cells >= 9 ? "high" : "medium",
          `"${jobId}" expands to ${cells} matrix jobs per run${hasMacCell ? ", including macOS" : ""}. Each is billed separately and rounded up to a whole minute.`,
          {
            job: jobId,
            fix: "# Run the full matrix after merge; keep pull requests on one cell:\nstrategy:\n  matrix:\n    os: ${{ github.event_name == 'pull_request' && fromJSON('[\"ubuntu-latest\"]') || fromJSON('[\"ubuntu-latest\",\"windows-latest\",\"macos-latest\"]') }}",
          },
        ),
      );
    }

    for (const installer of BROWSER_INSTALLERS) {
      const step = steps.find((item) => item && installer.re.test(typeof item.run === "string" ? item.run : ""));
      if (!step) continue;
      const cached = steps.some(
        (item) =>
          item &&
          typeof item.uses === "string" &&
          item.uses.startsWith("actions/cache") &&
          String((item.with && item.with.path) || "").includes(installer.cacheDir.replace("~", "")),
      );
      if (cached) continue;
      findings.push(
        finding(
          "missing-browser-cache",
          "medium",
          `"${jobId}" downloads ${installer.tool} browsers on every run with no cache. That is often 30 to 90 seconds per job.`,
          {
            job: jobId,
            fix: [
              `- name: Cache ${installer.tool} browsers`,
              "  uses: actions/cache@v4",
              "  with:",
              `    path: ${installer.cacheDir}`,
              `    key: \${{ runner.os }}-${installer.tool.toLowerCase()}-\${{ hashFiles('**/package-lock.json') }}`,
            ].join("\n"),
          },
        ),
      );
    }

    for (const setup of SETUP_CACHE) {
      const step = steps.find((item) => item && typeof item.uses === "string" && setup.re.test(item.uses));
      if (!step) continue;
      const withs = step.with || {};
      if (withs[setup.input] != null) continue;
      const cachedElsewhere = steps.some(
        (item) => item && typeof item.uses === "string" && item.uses.startsWith("actions/cache"),
      );
      if (cachedElsewhere) continue;
      findings.push(
        finding(
          "missing-dependency-cache",
          "medium",
          `"${jobId}" sets up ${setup.tool} without the built-in dependency cache, so packages download on every run.`,
          { job: jobId, fix: `- uses: ${step.uses}\n  with:\n    ${setup.example}` },
        ),
      );
    }

    if (job["timeout-minutes"] == null) {
      findings.push(
        finding(
          "missing-timeout",
          "low",
          `"${jobId}" has no timeout-minutes. A hung job bills until GitHub's six-hour limit: 360 minutes${cells > 1 ? ` per matrix cell, ${cells} cells` : ""}. ${DEFAULT_TIMEOUT_MINUTES} minutes is a placeholder; set it to about three times a normal run.`,
          { job: jobId, fix: `timeout-minutes: ${DEFAULT_TIMEOUT_MINUTES}`, patched: true },
        ),
      );
      patches.push({ type: "timeout", jobId, minutes: DEFAULT_TIMEOUT_MINUTES });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const patchedResult = patches.length ? applyWorkflowPatches(text, patches) : null;
  return {
    ok: true,
    name: doc.name || null,
    jobCount: jobs.length,
    deployish,
    findings,
    patchedYaml: patchedResult && patchedResult.ok ? patchedResult.yaml : null,
  };
}

module.exports = { lintWorkflow, cronIntervalMinutes, matrixSize, runnerLabels, MAX_YAML_BYTES };
