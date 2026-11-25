const fs = require("fs");
const { aggregateObservations } = require("../lib/aggregateJobs");
const { formatUsd } = require("../lib/runnerRates");

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || "";
const [owner, repo] = repository.split("/");

function fail(message) {
  console.error(message);
  process.exit(0);
}

async function gh(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "spendtron-action",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${url} ${detail.slice(0, 180)}`);
  }
  return response.json();
}

function summary(report) {
  const lines = [
    "### spendtron",
    "",
    report.allowance.text,
    "",
    `Sampled ${report.sampledJobs} jobs across ${report.sampledRuns} runs. Gross GitHub-hosted compute: ${formatUsd(report.totalCostUsd)}.`,
  ];
  if (report.topShare) lines.push(`Top workflow: ${report.topShare}% of this sample.`);
  lines.push("", "| Workflow | Minutes | Estimated cost | SKU |", "| --- | ---: | ---: | --- |");
  for (const workflow of report.topWorkflows) {
    lines.push(
      `| ${workflow.workflowName} | ${workflow.billMinutes} | ${formatUsd(workflow.costUsd)} | ${workflow.topSku || ""} |`,
    );
  }
  for (const note of report.notes || []) lines.push("", note);
  lines.push(
    "",
    "Standard runners on public repositories and self-hosted runners are $0 on GitHub's compute line. Larger runners are billed on public repositories too.",
  );
  return lines.join("\n");
}

const MARKER = "<!-- spendtron-action -->";

async function ghWrite(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "spendtron-action",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${method} ${url} ${detail.slice(0, 180)}`);
  }
  return response.json();
}

/** One comment per pull request, edited in place on later pushes. */
async function commentOnPullRequest(markdown) {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !process.env.GITHUB_EVENT_PATH) return;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request && event.pull_request.number;
  if (!number) return;
  const body = `${MARKER}\n${markdown}`;
  const base = `https://api.github.com/repos/${owner}/${repo}/issues`;
  let mine = null;
  for (let page = 1; page <= 10 && !mine; page++) {
    const comments = await gh(`${base}/${number}/comments?per_page=100&page=${page}`);
    mine = comments.find((comment) => typeof comment.body === "string" && comment.body.startsWith(MARKER)) || null;
    if (comments.length < 100) break;
  }
  if (mine) {
    await ghWrite("PATCH", `${base}/comments/${mine.id}`, { body });
  } else {
    await ghWrite("POST", `${base}/${number}/comments`, { body });
  }
}

async function main() {
  if (!token || !owner || !repo) fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  const repoInfo = await gh(`https://api.github.com/repos/${owner}/${repo}`);
  const visibility = repoInfo.visibility || (repoInfo.private ? "private" : "public");
  const runs = await gh(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=20`,
  );
  const observations = [];
  for (const run of runs.workflow_runs || []) {
    const jobs = await gh(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    const base = {
      fullName: `${owner}/${repo}`,
      owner,
      repo,
      visibility,
      defaultBranch: repoInfo.default_branch,
      workflowPath: run.path || run.name,
      workflowName: run.name || run.path,
      event: run.event,
      runId: run.id,
      runStartedAt: run.run_started_at,
      runUpdatedAt: run.updated_at,
    };
    if (jobs.jobs && jobs.jobs.length) {
      for (const job of jobs.jobs) observations.push({ ...base, job });
    } else {
      observations.push({ ...base, job: null });
    }
  }
  const report = aggregateObservations(observations, { repoCount: 1, reposConsidered: 1 });
  const markdown = summary(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  console.log(markdown);
  try {
    await commentOnPullRequest(markdown);
  } catch (err) {
    console.error("Pull request comment skipped (the job needs pull-requests: write; fork PRs get a read-only token):", err.message);
  }
}

main().catch((err) => fail(err.message));
