const { formatUsd } = require("./runnerRates");

function formatAuditText(report, { reportUrl, stale = false } = {}) {
  if (!report) {
    return [
      "No saved audit yet.",
      reportUrl ? `Open ${reportUrl} to run one. The chart is on that page. This tool reads the saved report so the call stays fast.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lines = [];
  if (stale) lines.push("Saved report is more than 6 hours old. Refresh it on the report page.");
  lines.push(report.allowance?.text || "");
  lines.push(
    `Sampled ${report.sampledJobs} jobs across ${report.sampledRuns} runs. Gross GitHub-hosted compute in the sample: ${formatUsd(report.totalCostUsd)}.`,
  );
  if (report.monthlyUsd != null) {
    lines.push(
      `Estimated monthly run-rate from a ${report.windowDays}-day window: ${formatUsd(report.monthlyUsd)}.`,
    );
  }
  if (report.topShare) {
    lines.push(`The top workflow is ${report.topShare}% of this sample.`);
  }
  for (const note of report.notes || []) lines.push(note);

  lines.push("", "Workflows, priced per job at the runner's current rate:");
  for (const workflow of report.topWorkflows || []) {
    lines.push(
      `- ${workflow.label}: ${workflow.billMinutes} min, ${formatUsd(workflow.costUsd)}${workflow.topSku ? ` (${workflow.topSku})` : ""}`,
    );
  }

  lines.push("", "Repositories:");
  for (const repo of report.topRepos || []) {
    lines.push(`- ${repo.repo}: ${repo.billMinutes} min, ${formatUsd(repo.costUsd)}`);
  }

  const fixes = report.fixes || [];
  if (report.fixError) lines.push("", `Workflow suggestions failed: ${report.fixError}`);
  if (fixes.length) {
    lines.push("", "Changes, highest impact first. Timeout lines are last because they do not shorten a healthy run:");
    for (const fix of fixes) {
      lines.push("", `[${fix.repo}] ${fix.summary}`, fix.diff);
    }
  } else {
    lines.push("", "No corroborated workflow change in the top repositories.");
  }

  if (report.writtenAudit) {
    lines.push(
      "",
      "This figure is large enough that a written audit is worth a quote. Email joe@swantron.com. The chart and the pull requests are free.",
    );
  }
  if (reportUrl) {
    lines.push("", `Chart and pull requests: ${reportUrl}`);
  }
  return lines.filter((line) => line !== undefined).join("\n");
}

module.exports = { formatAuditText };
