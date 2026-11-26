// Smoke tests for spendtron, matching the plain-assert style already used
// by chomptron's test.js in this fleet.
console.log("Running spendtron tests...\n");

const fs = require("fs");
const {
  auditActionsCost,
  billMinutes,
  RATE_PER_MINUTE,
} = require("./lib/auditActions");
const {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
} = require("./lib/auth");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
    passed++;
  } else {
    console.log(`✗ ${message}`);
    failed++;
  }
}

console.log("File Structure Tests:");
assert(fs.existsSync("./server.js"), "server.js exists");
assert(fs.existsSync("./lib/auditActions.js"), "auditActions.js exists");
assert(fs.existsSync("./db/schema.sql"), "schema.sql exists");
assert(fs.existsSync("./Dockerfile"), "Dockerfile exists");

console.log("\nDependency Tests:");
const pkg = require("./package.json");
assert(pkg.dependencies["@octokit/rest"], "octokit dependency exists");
assert(
  pkg.dependencies["@octokit/auth-app"],
  "octokit auth-app dependency exists",
);
assert(pkg.dependencies.stripe, "stripe dependency exists");
assert(
  pkg.dependencies["@modelcontextprotocol/server"],
  "MCP server dependency exists",
);

console.log(
  "\nBilling math (billMinutes — must match actions-teardown.sh's awk exactly):",
);
// Original: m=(s<=0)?1:int((s+59)/60) — ceil to nearest minute, minimum 1.
assert(
  billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z") === 1,
  "30s run bills as 1 minute",
);
assert(
  billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z") === 1,
  "exactly 60s bills as 1 minute",
);
assert(
  billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:01:01Z") === 2,
  "61s rounds up to 2 minutes",
);
assert(
  billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:05:37Z") === 6,
  "5m37s rounds up to 6 minutes",
);
assert(
  billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z") === 1,
  "zero-duration run still bills 1 minute (min 1)",
);
assert(
  RATE_PER_MINUTE === 0.006,
  "standard private Linux rate is the current $0.006 per minute",
);

console.log(
  "\nAudit aggregation (against a fake installation-scoped Octokit client):",
);

function job(name, start, end, labels, extra = {}) {
  return {
    name,
    conclusion: "success",
    started_at: start,
    completed_at: end,
    labels,
    steps: extra.steps || [],
  };
}

function run(id, name, path, start, end, event) {
  return {
    id,
    name,
    path,
    event,
    run_started_at: start,
    updated_at: end,
  };
}

function fakeOctokit({ repos, runs, jobs }) {
  return {
    paginate: async () =>
      repos.map((repo) => {
        const [owner, name] = repo.fullName.split("/");
        return {
          owner: { login: owner },
          name,
          full_name: repo.fullName,
          fork: false,
          archived: false,
          visibility: repo.visibility || "private",
          private: repo.visibility !== "public",
          default_branch: "main",
          pushed_at: repo.pushed_at || "2026-06-01T00:00:00Z",
        };
      }),
    rest: {
      apps: { listReposAccessibleToInstallation: () => {} },
      actions: {
        listWorkflowRunsForRepo: async ({ owner, repo: name }) => ({
          data: { workflow_runs: runs[`${owner}/${name}`] || [] },
        }),
        listJobsForWorkflowRun: async ({ owner, repo: name, run_id }) => ({
          data: { jobs: (jobs[`${owner}/${name}`] || {})[run_id] || [] },
        }),
      },
    },
  };
}

(async () => {
  const start = "2026-01-01T00:00:00Z";
  const octokit = fakeOctokit({
    repos: [
      { fullName: "acme/app", visibility: "private", pushed_at: "2026-06-02T00:00:00Z" },
      { fullName: "acme/lib", visibility: "private", pushed_at: "2026-06-01T00:00:00Z" },
    ],
    runs: {
      "acme/app": [
        run(1, "CI", ".github/workflows/ci.yml", start, "2026-01-01T00:06:00Z", "push"),
        run(2, "CI", ".github/workflows/ci.yml", start, "2026-01-01T00:04:00Z", "push"),
        run(3, "Deploy", ".github/workflows/deploy.yml", start, "2026-01-01T00:01:00Z", "push"),
      ],
      "acme/lib": [
        run(4, "CI", ".github/workflows/ci.yml", start, "2026-01-01T00:02:00Z", "push"),
      ],
    },
    jobs: {
      "acme/app": {
        1: [job("test", start, "2026-01-01T00:06:00Z", ["ubuntu-latest"])],
        2: [job("test", start, "2026-01-01T00:04:00Z", ["ubuntu-latest"])],
        3: [job("deploy", start, "2026-01-01T00:01:00Z", ["ubuntu-latest"])],
      },
      "acme/lib": {
        4: [job("test", start, "2026-01-01T00:02:00Z", ["ubuntu-latest"])],
      },
    },
  });

  const result = await auditActionsCost(octokit);

  assert(result.sampledRuns === 4, "sampled all 4 runs across 2 repos");
  assert(result.sampledJobs === 4, "sampled one job per run");
  assert(result.totalBillMinutes === 13, "job minutes sum to 6+4+1+2");
  assert(
    Math.abs(result.totalCostUsd - Math.round(13 * 0.006 * 100) / 100) < 1e-9,
    "private ubuntu-latest is priced at $0.006 per minute, not the retired $0.008 rate",
  );
  const ciRows = result.topWorkflows.filter((workflow) => workflow.workflowName === "CI");
  assert(ciRows.length === 2, "the same workflow name in two repos stays two rows");
  const appCi = ciRows.find((workflow) => workflow.repo === "acme/app");
  assert(appCi.billMinutes === 10, "acme/app CI is the 6 and 4 minute jobs only");
  const appRepo = result.topRepos.find((repo) => repo.repo === "acme/app");
  assert(appRepo.billMinutes === 11, "acme/app repo total is 6+4+1");

  const parallel = fakeOctokit({
    repos: [{ fullName: "acme/app", visibility: "private" }],
    runs: {
      "acme/app": [run(9, "CI", ".github/workflows/ci.yml", start, "2026-01-01T00:00:10Z", "push")],
    },
    jobs: {
      "acme/app": {
        9: Array.from({ length: 8 }, (_, index) =>
          job(`unit (${index})`, start, "2026-01-01T00:00:10Z", ["ubuntu-latest"]),
        ),
      },
    },
  });
  const parallelResult = await auditActionsCost(parallel);
  assert(parallelResult.totalBillMinutes === 8, "eight 10-second jobs bill as 8 minutes, not 1");
  assert(
    parallelResult.totalCostUsd === 0.05,
    "eight Linux minutes at $0.006 round to $0.05",
  );

  const pricedPublic = fakeOctokit({
    repos: [{ fullName: "acme/oss", visibility: "public" }],
    runs: {
      "acme/oss": [
        run(1, "CI", ".github/workflows/ci.yml", start, "2026-01-01T00:05:00Z", "push"),
        run(2, "Heavy", ".github/workflows/heavy.yml", start, "2026-01-01T00:02:00Z", "push"),
      ],
    },
    jobs: {
      "acme/oss": {
        1: [job("test", start, "2026-01-01T00:05:00Z", ["ubuntu-latest"])],
        2: [job("build", start, "2026-01-01T00:02:00Z", ["ubuntu-latest-8-cores"])],
      },
    },
  });
  const publicResult = await auditActionsCost(pricedPublic);
  assert(
    publicResult.totalCostUsd === 0.04,
    "a larger runner on a public repository is billed; ubuntu-latest there is not",
  );

  console.log("\nAPI key auth:");
  const rawKey = generateApiKey();
  assert(
    rawKey.startsWith("sk_spendtron_"),
    "generated key has the expected prefix",
  );
  assert(hashApiKey(rawKey) === hashApiKey(rawKey), "hashing is deterministic");
  assert(hashApiKey(rawKey) !== rawKey, "stored hash is not the raw key");
  assert(
    extractBearerToken({ headers: { authorization: `Bearer ${rawKey}` } }) ===
      rawKey,
    "extracts a bearer token from the Authorization header",
  );
  assert(
    extractBearerToken({ headers: {} }) === null,
    "returns null when no Authorization header is present",
  );

  const {
    makeRotateToken,
    verifyRotateToken,
    makeOAuthState,
    oauthStateMatches,
    ROTATE_TTL_MS,
    STATE_TTL_MS,
  } = require("./lib/auth");
  const now = 1_700_000_000_000;
  const rotateTok = makeRotateToken(99, "test-secret", now);
  assert(
    verifyRotateToken(99, rotateTok, "test-secret", now + ROTATE_TTL_MS - 1),
    "rotate token verifies for the same installation before expiry",
  );
  assert(
    !verifyRotateToken(99, rotateTok, "test-secret", now + ROTATE_TTL_MS),
    "rotate token expires",
  );
  assert(
    !verifyRotateToken(100, rotateTok, "test-secret", now),
    "rotate token rejects a different installation",
  );
  assert(
    !verifyRotateToken(99, rotateTok, "other-secret", now),
    "rotate token rejects the wrong secret",
  );
  assert(
    !verifyRotateToken(99, "ab".repeat(32), "test-secret", now),
    "legacy non-expiring rotate tokens are rejected",
  );

  const state = makeOAuthState(99, "test-secret", now);
  assert(
    oauthStateMatches(state, state, "test-secret", now + STATE_TTL_MS - 1)
      ?.installationId === 99,
    "oauth state matches the cookie and carries the installation id",
  );
  assert(
    oauthStateMatches(state, state, "test-secret", now + STATE_TTL_MS) === null,
    "oauth state expires",
  );
  assert(
    oauthStateMatches(state, `${state}x`, "test-secret", now) === null,
    "oauth state rejects a cookie mismatch",
  );
  assert(
    oauthStateMatches(state, state, "other-secret", now) === null,
    "oauth state rejects the wrong secret",
  );

  const { userCanAccessInstallation, exchangeUserAccessToken } = require("./lib/githubOAuth");
  let postedSecret = null;
  const tokenFetch = async (url, options) => {
    postedSecret = new URLSearchParams(options.body).get("client_secret");
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "ghu_test" }),
    };
  };
  assert(
    (await exchangeUserAccessToken({
      clientId: "cid",
      clientSecret: "csecret",
      code: "abc",
      fetchImpl: tokenFetch,
    })) === "ghu_test",
    "oauth code exchange returns the user access token",
  );
  assert(postedSecret === "csecret", "oauth code exchange sends the client secret");

  const pages = [
    {
      installations: [{ id: 1 }],
      link: '<https://api.github.com/user/installations?page=2>; rel="next"',
    },
    { installations: [{ id: 99 }], link: null },
  ];
  const listFetch = async () => {
    const page = pages.shift();
    return {
      ok: true,
      status: 200,
      json: async () => ({ installations: page.installations }),
      headers: { get: (name) => (name === "link" ? page.link : null) },
    };
  };
  assert(
    await userCanAccessInstallation("ghu_test", 99, listFetch),
    "user access check follows installation pages",
  );
  assert(
    !(await userCanAccessInstallation("ghu_test", 5, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ installations: [{ id: 8 }] }),
      headers: { get: () => null },
    }))),
    "user access check rejects an installation the user cannot manage",
  );

  console.log("\nServer wiring (source-order contracts):");
  const serverCode = fs.readFileSync("./server.js", "utf8");
  const installCode = fs.readFileSync("./lib/installations.js", "utf8");
  const html = fs.readFileSync("./index.html", "utf8");
  const billingCode = fs.readFileSync("./lib/billing.js", "utf8");
  const webhookPos = serverCode.indexOf('"/stripe/webhook"');
  const jsonPos = serverCode.indexOf("app.use(express.json");
  assert(
    webhookPos !== -1 && jsonPos !== -1 && webhookPos < jsonPos,
    "stripe webhook is mounted before express.json",
  );
  assert(
    billingCode.includes("checkout.session.completed"),
    "webhook applies checkout.session.completed",
  );
  assert(
    serverCode.includes("getAuditReport"),
    "MCP reads the saved report instead of crawling GitHub on the tool call",
  );
  assert(
    !serverCode.includes("unlockUrlFor") && !serverCode.includes("createUnlockCheckoutUrl"),
    "the tool does not mint a Checkout session",
  );
  assert(
    !serverCode.includes("$39"),
    "the server no longer sells the one-time unlock",
  );
  const buildReportCode = fs.readFileSync("./lib/buildReport.js", "utf8");
  assert(
    buildReportCode.includes("auditActionsCost"),
    "the report builder still runs the live sample",
  );
  assert(
    installCode.includes("account_login = excluded.account_login"),
    "reinstall keeps the existing API key hash",
  );
  assert(
    !installCode.includes("api_key_hash = excluded.api_key_hash"),
    "reinstall does not rotate the API key",
  );
  assert(
    serverCode.includes('GITHUB_APP_SLUG || "spendtron-app"'),
    "default GitHub App slug is spendtron-app",
  );
  assert(
    serverCode.includes("www.spendtron.com"),
    "www host redirects to apex",
  );
  assert(!html.includes("goatcounter"), "no third-party page counter");
  assert(html.includes("/audit"), "landing page leads with the billing export");
  assert(!html.includes("$39"), "landing page no longer sells the $39 unlock");
  assert(
    html.toLowerCase().includes("pull request"),
    "landing page offers a pull request",
  );
  assert(fs.existsSync("./public/privacy.html"), "privacy page exists");
  assert(fs.existsSync("./public/terms.html"), "terms page exists");
  const privacy = fs.readFileSync("./public/privacy.html", "utf8");
  const terms = fs.readFileSync("./public/terms.html", "utf8");
  assert(
    !privacy.includes("$99") && !terms.includes("$99"),
    "privacy and terms no longer describe the $99/mo plan",
  );
  assert(
    privacy.includes("Contents"),
    "privacy discloses Contents read for workflow YAML",
  );
  assert(!terms.includes("$39"), "terms no longer sell the one-time unlock");
  assert(terms.toLowerCase().includes("free"), "terms describe a free audit");
  const accessPos = serverCode.indexOf("await userCanAccessInstallation");
  const createPos = serverCode.indexOf("await createInstallation");
  assert(
    accessPos !== -1 && createPos !== -1 && accessPos < createPos,
    "API key is issued only after the GitHub user is checked against the installation",
  );

  console.log("\nBilling helpers:");
  const billing = require("./lib/billing");
  assert(
    typeof billing.applyStripeEvent === "function",
    "applyStripeEvent is exported",
  );
  assert(
    typeof billing.createPortalUrl === "function",
    "createPortalUrl is exported",
  );

  assert(
    typeof billing.createUnlockCheckoutUrl === "function",
    "createUnlockCheckoutUrl is exported",
  );

  let upserted = null;
  await billing.applyStripeEvent(
    {},
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          metadata: { installationId: "7" },
          customer: "cus_x",
          id: "sub_x",
          status: "active",
        },
      },
    },
    {
      upsertSubscription: async (row) => {
        upserted = row;
      },
      markFixesUnlocked: async () => {},
    },
  );
  assert(
    upserted && upserted.status === "canceled",
    "subscription.deleted stores status canceled (legacy path, harmless if never reached)",
  );
  assert(
    upserted.installationId === 7,
    "subscription event reads installationId from metadata",
  );

  let unlocked = null;
  await billing.applyStripeEvent(
    {},
    {
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          metadata: { installationId: "9", purpose: "fixes_unlock" },
          customer: "cus_y",
        },
      },
    },
    {
      upsertSubscription: async () => {
        throw new Error("should not be called for a one-time unlock");
      },
      markFixesUnlocked: async (row) => {
        unlocked = row;
      },
    },
  );
  assert(
    unlocked && unlocked.installationId === 9 && unlocked.stripeCustomerId === "cus_y",
    "one-time fixes_unlock checkout marks that installation unlocked",
  );

  console.log("\nRunner rates and the billing export:");
  const { classifyRunner } = require("./lib/runnerRates");
  const { auditUsageCsv } = require("./lib/usageCsv");
  const { applyWorkflowPatches } = require("./lib/workflowPatch");
  const { analyzeWorkflowYaml } = require("./lib/suggestFixes");
  const { verifyGithubWebhook } = require("./lib/githubWebhook");
  const { describeAllowance } = require("./lib/allowance");
  const crypto = require("crypto");

  assert(classifyRunner(["ubuntu-latest"], { visibility: "private" }).usdPerMinute === 0.006, "private Linux 2-core is $0.006");
  assert(classifyRunner(["ubuntu-latest"], { visibility: "public" }).billable === false, "public standard Linux is not billed");
  assert(classifyRunner(["macos-latest"], { visibility: "private" }).usdPerMinute === 0.062, "private macOS standard is $0.062");
  assert(classifyRunner(["self-hosted", "linux"], { visibility: "private" }).billable === false, "self-hosted is $0 on GitHub's compute line");
  assert(classifyRunner(["ubuntu-latest-8-cores"], { visibility: "public" }).usdPerMinute === 0.022, "public 8-core Linux stays billable");

  const csv = auditUsageCsv(
    "date,product,sku,quantity,gross_amount,discount_amount,net_amount,repository,workflow_path\n" +
      "2026-11-01,Actions,actions_linux,100,0.60,0.60,0.00,acme/app,.github/workflows/ci.yml\n" +
      "2026-11-02,Actions,actions_macos,10,0.62,0.00,0.62,acme/app,.github/workflows/release.yml\n" +
      "2026-11-02,Codespaces,codespaces,1,1.00,0,1.00,acme/app,\n",
  );
  assert(!csv.error, "detailed usage CSV parses");
  assert(csv.totalNetUsd === 0.62, "CSV net ignores the discounted Linux row and skips Codespaces");
  assert(csv.topWorkflows[0].workflowPath.includes("release.yml"), "the paid workflow ranks first");
  assert(csv.allowance.writtenAudit === false, "a $0.62 export is not a written-audit quote");
  assert(describeAllowance(0, { source: "sample" }).text.includes("$0.00"), "a zero sample says the compute line is $0");
  assert(describeAllowance(250, { source: "export" }).writtenAudit === true, "net spend of $250 asks for a written quote");

  const patched = applyWorkflowPatches(
    "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    [
      { type: "timeout", jobId: "test", minutes: 15 },
      { type: "concurrency" },
    ],
  );
  assert(patched.ok, "workflow YAML patches parse");
  assert(patched.yaml.includes("timeout-minutes: 15"), "timeout-minutes is applied");
  assert(
    patched.yaml.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"),
    "cancel-in-progress is applied to pull-request runs only",
  );
  assert(
    require("yaml").parse(patched.yaml).concurrency["cancel-in-progress"] ===
      "${{ github.event_name == 'pull_request' }}",
    "patched concurrency block is still valid YAML",
  );

  const duplicate = analyzeWorkflowYaml(
    {
      fullName: "acme/app",
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      visibility: "private",
      events: ["push", "pull_request"],
      runCount: 4,
      costUsd: 3,
      jobs: [
        { name: "test", labels: ["ubuntu-latest"], durations: [90, 100, 110], minutes: 6, costUsd: 0.04, steps: [] },
      ],
    },
    "ci.yml",
    "name: CI\non:\n  push:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
  );
  assert(duplicate.some((finding) => finding.check === "duplicate-trigger"), "push and pull_request in the sample is a finding");
  assert(duplicate.some((finding) => finding.check === "missing-path-filters"), "a slow workflow with no paths filter is a finding");
  assert(
    duplicate.some((finding) => finding.check === "missing-timeout" && finding.footnote),
    "timeout is present and marked as a footnote",
  );

  console.log("\nDeploy detection and timeouts:");
  const { looksLikeDeploy } = require("./lib/suggestFixes");
  const buildSample = {
    fullName: "acme/app",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    visibility: "private",
    events: ["push"],
    runCount: 5,
    costUsd: 1,
    jobs: [{ name: "build", labels: ["ubuntu-latest"], durations: [100, 110, 120], minutes: 6, costUsd: 0.04, steps: [] }],
  };
  const deployInBuild = analyzeWorkflowYaml(
    buildSample,
    "ci.yml",
    "name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: ./deploy.sh\n",
  );
  assert(
    !deployInBuild.some((finding) => finding.patch && finding.patch.type === "concurrency"),
    "a deploy step inside a job named build gets no cancel-in-progress patch",
  );
  assert(
    looksLikeDeploy(buildSample, "ci.yml", { jobs: { ship: { steps: [{ uses: "google-github-actions/deploy-cloudrun@v2" }] } } }),
    "a deploy action in uses: counts as a deploy",
  );
  assert(
    looksLikeDeploy(buildSample, "ci.yml", { jobs: { build: { environment: "production", steps: [] } } }),
    "a job with an environment counts as a deploy",
  );
  assert(
    !looksLikeDeploy(buildSample, "ci.yml", { jobs: { test: { steps: [{ run: "npm ci" }, { run: "npm test" }] } } }),
    "plain test steps are not a deploy",
  );
  const plainCi = analyzeWorkflowYaml(
    buildSample,
    "ci.yml",
    "name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
  );
  assert(
    plainCi.some((finding) => finding.patch && finding.patch.type === "concurrency"),
    "a plain test workflow still gets the concurrency patch",
  );

  const matrixTimeout = analyzeWorkflowYaml(
    { ...buildSample, jobs: [{ name: "test (ubuntu)", durations: [60, 60, 60], steps: [] }, { name: "test (macos)", durations: [900], steps: [] }] },
    "ci.yml",
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: npm test\n",
  ).find((finding) => finding.check === "missing-timeout");
  assert(matrixTimeout && matrixTimeout.patch.minutes >= 23, "timeout clears 1.5x the slowest matrix cell, not 3x the median");

  console.log("\nCost math:");
  const { priceJob } = require("./lib/runnerRates");
  const { aggregateObservations } = require("./lib/aggregateJobs");
  const cancelled = priceJob(
    { name: "t", labels: ["ubuntu-latest"], conclusion: "cancelled", started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:04:30Z" },
    { visibility: "private" },
  );
  assert(cancelled && cancelled.minutes === 5 && cancelled.costUsd > 0, "a cancelled job is billed for the minutes it ran");
  assert(
    priceJob({ name: "t", labels: ["ubuntu-latest"], conclusion: "skipped", started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:00:00Z" }) === null,
    "a skipped job is not priced",
  );

  const DAY = 24 * 60 * 60 * 1000;
  const t0 = Date.parse("2026-08-01T00:00:00Z");
  function obsAt(fullName, ms, runId, labels = ["ubuntu-latest"]) {
    const start = new Date(ms).toISOString();
    const end = new Date(ms + 10 * 60 * 1000).toISOString();
    return {
      fullName, owner: fullName.split("/")[0], repo: fullName.split("/")[1], visibility: "private",
      workflowPath: ".github/workflows/ci.yml", workflowName: "CI", event: "push", runId,
      runStartedAt: start, runUpdatedAt: end,
      job: { name: "test", labels, conclusion: "success", started_at: start, completed_at: end, steps: [] },
    };
  }
  // busy: 20 runs inside 2 days ending at t0+90d. quiet: 2 runs 90 days apart.
  const mixed = [];
  for (let i = 0; i < 20; i++) mixed.push(obsAt("acme/busy", t0 + 88 * DAY + i * (2 * DAY / 20), i));
  mixed.push(obsAt("acme/quiet", t0, 100), obsAt("acme/quiet", t0 + 90 * DAY, 101));
  const mixedReport = aggregateObservations(mixed);
  // busy: 20 jobs * 10 min * $0.006 = $1.20 over ~1.9 days -> ~$18.9/mo; quiet: $0.12 over 90 days -> $0.04/mo
  assert(mixedReport.monthlyUsd > 15, `each repo is scaled by its own window (got ${mixedReport.monthlyUsd}, a shared 90-day window gives ~$0.44)`);

  const unknown = aggregateObservations([obsAt("acme/app", t0, 1, ["big-linux-box"])]);
  assert(unknown.unknownRunnerJobs === 1 && unknown.notes.some((note) => note.includes("big-linux-box")), "unrecognized runner labels are called out");

  const storageCsv = auditUsageCsv(
    "date,product,sku,quantity,unit_type,gross_amount,discount_amount,net_amount,repository,workflow_path\n" +
      "2026-11-01,Actions,actions_linux,100,Minutes,0.60,0,0.60,acme/app,.github/workflows/ci.yml\n" +
      "2026-11-01,Actions,actions_storage,500,GigabyteHours,0.10,0,0.10,acme/app,.github/workflows/ci.yml\n",
  );
  assert(storageCsv.topWorkflows[0].minutes === 100, "storage GB-hours are not counted as minutes");
  assert(storageCsv.totalNetUsd === 0.7, "storage dollars still count");

  console.log("\nReport tokens and sign-in:");
  const { makeReportToken, readReportToken, makeChooseToken, readChooseToken } = require("./lib/auth");
  const share = makeReportToken(7, "test-secret", { kind: "share", now });
  const session = makeReportToken(7, "test-secret", { kind: "session", now });
  assert(readReportToken(share, "test-secret", { kind: "share", now })?.installationId === 7, "share token reads as share");
  assert(readReportToken(share, "test-secret", { kind: "session", now }) === null, "a share token is not accepted as a session");
  assert(readReportToken(session, "test-secret", { kind: "session", now })?.installationId === 7, "session token reads as session");
  assert(
    readReportToken(share.replace(/^share\./, "session."), "test-secret", { kind: "session", now }) === null,
    "relabeling a share token as session breaks the signature",
  );
  const choose = makeChooseToken([3, 9], "test-secret", now);
  assert(JSON.stringify(readChooseToken(choose, "test-secret", now)) === "[3,9]", "chooser token lists the installations");
  assert(readChooseToken(choose, "other-secret", now) === null, "chooser token rejects the wrong secret");

  const serverSource = fs.readFileSync("./server.js", "utf8");
  assert(
    /readCookie\(req, REPORT_COOKIE\), ROTATE_SECRET, \{ kind: "session" \}/.test(serverSource),
    "the report cookie must be a session token",
  );
  assert(!/action === "suspend"/.test(serverSource), "a suspension does not revoke the installation");

  console.log("\nBrowser bundle:");
  const vm = require("vm");
  const { browserBundle } = require("./lib/browserBundle");
  const sandbox = { window: {} };
  vm.runInNewContext(browserBundle(), sandbox);
  const browserReport = sandbox.window.spendtron.auditUsageCsv(
    "date,product,sku,quantity,net_amount,repository,workflow_path\n2026-11-01,Actions,actions_macos,10,0.62,acme/app,.github/workflows/release.yml\n",
  );
  assert(browserReport.totalNetUsd === 0.62, "the CSV audit runs in a browser context");
  assert(sandbox.window.spendtron.csvReportPage(browserReport).includes("release.yml"), "the report page renders in a browser context");

  console.log("\nPull requests:");
  const { openFixPullRequests } = require("./lib/openFixPr");
  const calls = [];
  const prOctokit = {
    rest: {
      repos: { get: async () => ({ data: { default_branch: "main" } }) },
      pulls: {
        list: async () => ({ data: [{ html_url: "https://github.com/acme/app/pull/4", head: { ref: "spendtron/cost-abc", repo: { full_name: "acme/app" } } }] }),
        create: async () => { calls.push("create"); return { data: { html_url: "x" } }; },
      },
      git: {
        getRef: async () => { calls.push("getRef"); return { data: { object: { sha: "s" } } }; },
        createRef: async () => { calls.push("createRef"); },
        deleteRef: async () => { calls.push("deleteRef"); },
      },
    },
  };
  const prReport = { repos: [], fixes: [{ repo: "acme/app", workflowFile: ".github/workflows/ci.yml", patch: { type: "concurrency" }, summary: "s", diff: "d" }] };
  const dedupe = await openFixPullRequests(prOctokit, prReport);
  assert(dedupe.existing.length === 1 && !calls.includes("createRef"), "an open spendtron PR is reused, not duplicated");

  calls.length = 0;
  prOctokit.rest.pulls.list = async () => ({ data: [] });
  prOctokit.rest.repos.getContent = async () => ({
    data: { sha: "f", content: Buffer.from("on: push\nconcurrency: x\njobs: {}\n").toString("base64") },
  });
  const noChange = await openFixPullRequests(prOctokit, prReport);
  assert(noChange.errors.length === 1 && calls.includes("deleteRef"), "an unused branch is deleted");

  console.log("\nSite content:");
  const rates = require("./lib/runnerRates");
  const pricingGuide = fs.readFileSync("./public/guides/github-actions-runner-pricing.html", "utf8");
  const guideRates = new Map(
    [...pricingGuide.matchAll(/<code>([a-z0-9_]+)<\/code><\/td><td class="num">\$([0-9.]+)<\/td>/g)].map((m) => [m[1], Number(m[2])]),
  );
  let mismatched = [];
  for (const table of [rates.LINUX_X64_LARGER, rates.LINUX_ARM_LARGER, rates.WINDOWS_X64_LARGER, rates.WINDOWS_ARM_LARGER]) {
    for (const [sku, usd] of Object.values(table)) {
      if (guideRates.get(sku) !== usd) mismatched.push(`${sku}: code ${usd}, guide ${guideRates.get(sku)}`);
    }
  }
  const standardChecks = [
    [["ubuntu-latest"], "actions_linux"],
    [["ubuntu-slim"], "actions_linux_slim"],
    [["ubuntu-24.04-arm"], "actions_linux_arm"],
    [["windows-latest"], "actions_windows"],
    [["windows-11-arm"], "actions_windows_arm"],
    [["macos-latest"], "actions_macos"],
    [["macos-latest-xlarge"], "macos_xl"],
    [["macos-latest-large"], "macos_l"],
  ];
  for (const [labels, sku] of standardChecks) {
    const rate = rates.classifyRunner(labels, { visibility: "private" });
    if (rate.sku !== sku || guideRates.get(sku) !== rate.usdPerMinute) {
      mismatched.push(`${labels[0]}: code ${rate.sku} ${rate.usdPerMinute}, guide ${guideRates.get(sku)}`);
    }
  }
  assert(guideRates.size >= 30 && mismatched.length === 0, `pricing guide matches runnerRates (${mismatched.join("; ") || "all match"})`);
  assert(rates.classifyRunner(["windows-11-arm"]).usdPerMinute === 0.01, "standard Windows arm64 is $0.010");

  const home = fs.readFileSync("./index.html", "utf8");
  assert(home.includes('id="audit-form"') && home.includes("/audit-form.js"), "homepage uses the in-browser usage report form");
  assert(!/subscribed|unlocked|Subscription active/.test(home), "homepage has no leftover Stripe banner");
  assert(!home.includes("not stored"), "homepage does not claim the old server-side handling");
  const sitemap = fs.readFileSync("./public/sitemap.xml", "utf8");
  for (const guide of fs.readdirSync("./public/guides")) {
    const slug = guide.replace(/\.html$/, "");
    assert(sitemap.includes(`/guides/${slug}<`) && home.includes(`/guides/${slug}"`), `guide ${slug} is in the sitemap and linked from the homepage`);
  }

  // ---- free tools ----
  const { lintWorkflow, cronIntervalMinutes, matrixSize } = require("./lib/workflowLint");
  const wf = [
    "name: CI",
    "on:",
    "  push:",
    "  pull_request:",
    "  schedule:",
    '    - cron: "*/5 * * * *"',
    "jobs:",
    "  test:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, macos-latest]",
    "        node: [20, 22]",
    "    steps:",
    "      - uses: actions/setup-node@v4",
    "      - run: npx playwright install",
    "  big:",
    "    runs-on: ubuntu-latest-8-cores",
    "    timeout-minutes: 10",
    "    steps:",
    "      - run: make",
  ].join("\n");
  const lint = lintWorkflow(wf);
  const checks = new Set(lint.findings.map((f) => f.check));
  for (const check of ["duplicate-trigger", "missing-concurrency", "frequent-schedule", "missing-path-filters", "macos-runner", "matrix-fanout", "missing-browser-cache", "missing-dependency-cache", "missing-timeout", "larger-runner"]) {
    assert(checks.has(check), `workflow lint flags ${check}`);
  }
  assert(!lint.findings.some((f) => f.check === "missing-timeout" && f.job === "big"), "workflow lint leaves an existing timeout alone");
  assert(/cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/.test(lint.patchedYaml) && /timeout-minutes: 30/.test(lint.patchedYaml), "workflow lint patches concurrency and timeout");
  assert(lint.findings[0].severity === "high", "workflow lint sorts high severity first");
  const publicLint = lintWorkflow(wf, { visibility: "public" });
  assert(!publicLint.findings.some((f) => f.check === "macos-runner"), "standard macOS on a public repo is free, so not flagged");
  assert(publicLint.findings.some((f) => f.check === "larger-runner" && f.severity === "high"), "larger runner on a public repo is high severity");
  const deployLint = lintWorkflow("on: [push, pull_request]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: kubectl apply -f k8s\n");
  assert(deployLint.deployish && !/concurrency/.test(deployLint.patchedYaml || ""), "deploy workflow gets no automatic concurrency patch");
  assert(!lintWorkflow("jobs: [").ok && !lintWorkflow("").ok && !lintWorkflow("foo: 1").ok, "workflow lint rejects bad input");
  assert(!lintWorkflow("x".repeat(210 * 1024)).ok, "workflow lint caps input size");
  assert(cronIntervalMinutes("*/15 * * * *") === 15 && cronIntervalMinutes("0 * * * *") === 60 && cronIntervalMinutes("0 3 * * *") === null, "cron interval parsing");
  assert(matrixSize({ strategy: { matrix: { a: [1, 2, 3], b: [1, 2], exclude: [{ a: 1, b: 1 }] } } }) === 5, "matrix size counts excludes");

  assert(serverSource.includes('app.post("/api/check-workflow"') && serverSource.includes('"check_workflow_yaml"'), "server exposes the checker over HTTP and MCP");
  assert(typeof sandbox.window.spendtron.rates.classifyRunner === "function" && sandbox.window.spendtron.plans.length === 3, "browser bundle exposes rates and plans for the calculators");
  const toolPages = fs.readdirSync("./public/tools").filter((f) => f.endsWith(".html") && f !== "index.html");
  assert(toolPages.length === 4, "four tool pages");
  const toolsHub = fs.readFileSync("./public/tools/index.html", "utf8");
  for (const page of toolPages) {
    const slug = page.replace(/\.html$/, "");
    const text = fs.readFileSync(`./public/tools/${page}`, "utf8");
    assert(sitemap.includes(`/tools/${slug}<`) && home.includes(`/tools/${slug}"`) && toolsHub.includes(`/tools/${slug}"`), `tool ${slug} is in the sitemap, homepage and hub`);
    assert(text.includes("/tools/tools.js") && (slug === "workflow-checker" || text.includes('src="/audit.js"')), `tool ${slug} loads its scripts`);
  }

  const body = Buffer.from("{}");
  const secret = "whsec";
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  assert(verifyGithubWebhook(body, signature, secret), "GitHub webhook signature verifies");
  assert(!verifyGithubWebhook(body, signature, "other"), "GitHub webhook signature rejects the wrong secret");

  console.log("\n" + "=".repeat(50));
  console.log(
    `${failed === 0 ? "✓" : "✗"} ${passed} passed | ${failed === 0 ? "✗" : "✗"} ${failed} failed`,
  );
  console.log("=".repeat(50));
  if (failed > 0) process.exit(1);
  console.log("\n✓ All spendtron tests passed!");
})();
