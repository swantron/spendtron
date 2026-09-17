// Smoke tests for spendtron, matching the plain-assert style already used
// by chomptron's test.js in this fleet.
console.log("Running spendtron tests...\n");

const fs = require("fs");
const { auditActionsCost, billMinutes, RATE_PER_MINUTE } = require("./lib/auditActions");
const { generateApiKey, hashApiKey, extractBearerToken } = require("./lib/auth");

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
assert(pkg.dependencies["@octokit/auth-app"], "octokit auth-app dependency exists");
assert(pkg.dependencies.stripe, "stripe dependency exists");
assert(pkg.dependencies["@modelcontextprotocol/server"], "MCP server dependency exists");

console.log("\nBilling math (billMinutes — must match actions-teardown.sh's awk exactly):");
// Original: m=(s<=0)?1:int((s+59)/60) — ceil to nearest minute, minimum 1.
assert(billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z") === 1, "30s run bills as 1 minute");
assert(billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z") === 1, "exactly 60s bills as 1 minute");
assert(billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:01:01Z") === 2, "61s rounds up to 2 minutes");
assert(billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:05:37Z") === 6, "5m37s rounds up to 6 minutes");
assert(billMinutes("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z") === 1, "zero-duration run still bills 1 minute (min 1)");
assert(RATE_PER_MINUTE === 0.008, "rate matches actions-teardown.sh's private-repo Ubuntu rate");

console.log("\nAudit aggregation (against a fake installation-scoped Octokit client):");

function fakeOctokit(reposByOwnerRepo) {
  const repos = Object.keys(reposByOwnerRepo).map((key) => {
    const [owner, repo] = key.split("/");
    return { owner: { login: owner }, name: repo, full_name: key, fork: false, archived: false };
  });
  return {
    paginate: async () => repos,
    rest: {
      apps: { listReposAccessibleToInstallation: () => {} },
      actions: {
        listWorkflowRunsForRepo: async ({ owner, repo }) => ({
          data: { workflow_runs: reposByOwnerRepo[`${owner}/${repo}`] },
        }),
      },
    },
  };
}

(async () => {
  const octokit = fakeOctokit({
    "acme/app": [
      { name: "CI", run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:06:00Z" }, // 6 min
      { name: "CI", run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:04:00Z" }, // 4 min
      { name: "Deploy", run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z" }, // 1 min
    ],
    "acme/lib": [
      { name: "CI", run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:02:00Z" }, // 2 min
    ],
  });

  const result = await auditActionsCost(octokit);

  assert(result.sampledRuns === 4, "sampled all 4 runs across 2 repos");
  assert(result.totalBillMinutes === 13, "total bill-minutes sums correctly (6+4+1+2)");
  assert(
    Math.abs(result.totalCostUsd - Math.round(13 * 0.008 * 100) / 100) < 1e-9,
    "total cost matches minutes * rate, rounded to the cent",
  );

  const ci = result.topWorkflows.find((w) => w.workflow === "CI");
  assert(ci.billMinutes === 12, "CI workflow aggregates across repos (6+4+2)");
  assert(ci.runs === 3, "CI workflow run count is correct");
  assert(result.topWorkflows[0].workflow === "CI", "top workflow sorted by bill-minutes descending");

  const appRepo = result.topRepos.find((r) => r.repo === "acme/app");
  assert(appRepo.billMinutes === 11, "acme/app repo total is correct (6+4+1)");

  console.log("\nAPI key auth:");
  const rawKey = generateApiKey();
  assert(rawKey.startsWith("sk_spendtron_"), "generated key has the expected prefix");
  assert(hashApiKey(rawKey) === hashApiKey(rawKey), "hashing is deterministic");
  assert(hashApiKey(rawKey) !== rawKey, "stored hash is not the raw key");
  assert(
    extractBearerToken({ headers: { authorization: `Bearer ${rawKey}` } }) === rawKey,
    "extracts a bearer token from the Authorization header",
  );
  assert(
    extractBearerToken({ headers: {} }) === null,
    "returns null when no Authorization header is present",
  );

  console.log("\n" + "=".repeat(50));
  console.log(`${failed === 0 ? "✓" : "✗"} ${passed} passed | ${failed === 0 ? "✗" : "✗"} ${failed} failed`);
  console.log("=".repeat(50));
  if (failed > 0) process.exit(1);
  console.log("\n✓ All spendtron tests passed!");
})();
