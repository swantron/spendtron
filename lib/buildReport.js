const { auditActionsCost } = require("./auditActions");
const { suggestFixes } = require("./suggestFixes");

async function buildReport(octokit) {
  const report = await auditActionsCost(octokit);
  try {
    report.fixes = await suggestFixes(octokit, report);
    report.fixError = null;
  } catch (err) {
    report.fixes = [];
    report.fixError = err.message;
  }
  report.generatedAt = new Date().toISOString();
  return report;
}

module.exports = { buildReport };
