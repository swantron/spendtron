const { formatUsd } = require("./runnerRates");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#3fb950; --accent2:#58a6ff; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.55; max-width: 880px; margin: 0 auto; padding: 40px 24px 80px; }
  a { color: var(--accent2); }
  h1 { font-size: 32px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 12px; }
  h2 { font-size: 20px; margin: 32px 0 12px; }
  p { color: var(--muted); }
  textarea { width: 100%; min-height: 180px; background: #010409; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  button, .btn { display: inline-block; background: var(--accent); color: #05100a; border: 0; border-radius: 8px; padding: 12px 16px; font-weight: 650; text-decoration: none; cursor: pointer; }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
  form { margin: 12px 0; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .note { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 16px 0; }
  .bar { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(80px, 1fr) 15em; gap: 10px; align-items: center; margin: 8px 0; }
  .track { height: 10px; background: #010409; border-radius: 99px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .val { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  pre { background: #010409; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; }
  .foot { color: var(--muted); font-size: 13px; margin-top: 40px; }
  .fix { border-top: 1px solid var(--border); padding: 14px 0; }
  .fix h3 { font-size: 15px; margin: 0 0 6px; }
`;

function layout({ title, body }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico?v=2" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
<style>${CSS}</style>
</head><body>
${body}
<p class="foot"><a href="/">spendtron</a> · <a href="/audit">Usage report</a> · <a href="/guides/reduce-github-actions-minutes">Cutting minutes</a> · <a href="/guides/github-actions-runner-pricing">Runner pricing</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
</body></html>`;
}

function bars(items) {
  const max = Math.max(...items.map((item) => item.costUsd || 0), 0.0001);
  return items
    .map((item) => {
      const width = item.costUsd > 0 ? Math.max(2, Math.round((item.costUsd / max) * 100)) : 0;
      const extra = item.topSku ? ` · ${item.topSku}` : "";
      return `<div class="bar"><div class="label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div><div class="track"><div class="fill" style="width:${width}%"></div></div><div class="val">${escapeHtml(formatUsd(item.costUsd))}${escapeHtml(extra)}</div></div>`;
    })
    .join("");
}

function notes(list) {
  return (list || []).map((note) => `<p>${escapeHtml(note)}</p>`).join("");
}

function writtenAudit(show) {
  if (!show) return "";
  return `<div class="note"><strong>This is invoice territory.</strong><p>A written audit is a separate quote once the figure is about $200 or more. The chart and any pull requests stay free. Email <a href="mailto:joe@swantron.com">joe@swantron.com</a>.</p></div>`;
}

function auditFormPage({ error } = {}) {
  return layout({
    title: "spendtron — billing export",
    body: `<h1>Paste the billing export. The chart is immediate.</h1>
<p>GitHub's detailed usage report already has workflow path, SKU, and net amount. spendtron sums it and tells you whether that net amount is still inside included compute. The file is read in your browser and is not uploaded.</p>
${error ? `<div class="note">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/audit" id="audit-form">
  <p><input type="file" id="audit-file" accept=".csv,text/csv" /></p>
  <textarea name="csv" id="audit-csv" placeholder="Or paste it here: date,product,sku,quantity,unit_type,...,net_amount,repository,workflow_path"></textarea>
  <p>On GitHub's billing usage page, click <b>Get usage report</b>, choose the detailed report, and GitHub emails a download link (it expires after 24 hours). The detailed report covers up to 31 days and is the one with <code>workflow_path</code>. <a href="/guides/github-actions-usage-report">How to read it</a>.</p>
  <p id="audit-error"></p>
  <button type="submit">Show the chart</button>
</form>
<script src="/audit.js"></script>
<script src="/audit-form.js"></script>
<p>Have the GitHub App installed? <a href="/report">Open the live sample</a>. It prices each job at the runner's current rate, then can open a pull request for the safe edits.</p>`,
  });
}

function csvReportPage(report) {
  const share = report.topShare
    ? `<div class="note"><strong>${escapeHtml(String(report.topShare))}%</strong><p>of ${report.pricedOn === "net" ? "net" : "gross"} Actions dollars in this export sit in one workflow.</p></div>`
    : "";
  return layout({
    title: "spendtron — usage export",
    body: `<h1>Usage export</h1>
<p>${escapeHtml(report.allowance.text)}</p>
${share}
<p>Net ${escapeHtml(formatUsd(report.totalNetUsd))} · gross ${escapeHtml(formatUsd(report.totalGrossUsd))} · discount ${escapeHtml(formatUsd(report.totalDiscountUsd))}${report.windowLabel ? ` · ${escapeHtml(report.windowLabel)}` : ""}. ${report.rowCount} Actions rows. Bars use ${report.pricedOn} dollars.</p>
${notes(report.notes)}
<h2>Workflows</h2>
${bars(report.topWorkflows)}
${writtenAudit(report.writtenAudit)}
<p><a class="btn" href="/audit">Load another report</a></p>`,
  });
}

function reportPage({ report, stale, error, canOpenPrs, prResult, refreshToken }) {
  if (error && !report) {
    return layout({
      title: "spendtron — report",
      body: `<h1>The sample did not finish</h1><div class="note">${escapeHtml(error)}</div><p><a href="/login">Sign in with GitHub</a> or <a href="/audit">paste a billing export</a>.</p>`,
    });
  }
  const share = report.topShare
    ? `<div class="note"><strong>${escapeHtml(String(report.topShare))}%</strong><p>of sampled GitHub-hosted compute is one workflow. ${report.extrapolated ? `Monthly run-rate from ${escapeHtml(String(report.windowDays))} days: ${escapeHtml(formatUsd(report.monthlyUsd))}.` : "The window is too short to call this a monthly bill."}</p></div>`
    : "";
  const fixes = (report.fixes || [])
    .map(
      (fix) => `<div class="fix"><h3>${escapeHtml(fix.repo)} · ${escapeHtml(fix.check)}</h3><p>${escapeHtml(fix.summary)}</p><pre>${escapeHtml(fix.diff)}</pre></div>`,
    )
    .join("");
  const prBlock = !canOpenPrs
    ? `<p>Open this page from the browser that connected GitHub to open pull requests. A shared link can read the chart and cannot write to the repositories.</p>`
    : `<form method="post" action="/report/prs"><button type="submit">Open pull requests</button></form><p>Opens one pull request per repository, skipping any repository that already has one open, for timeouts, cancel-in-progress on pull-request runs of non-deploy workflows, and a short public-repo job leaving a larger Linux runner. Path filters, matrices, and macOS stay in the description for you to edit.</p>`;
  const prStatus = prResult
    ? `<div class="note">${
        (prResult.opened || []).map((item) => `<p><a href="${escapeHtml(item.url)}">${escapeHtml(item.repo)}</a></p>`).join("") ||
        ""
      }${(prResult.existing || []).map((item) => `<p>${escapeHtml(item.repo)} already has an open spendtron pull request: <a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>. Merge or close it to open another.</p>`).join("")}${prResult.skipped ? `<p>${escapeHtml(prResult.skipped)}</p>` : ""}${
        (prResult.errors || []).map((item) => `<p>${escapeHtml(item.repo)}: ${escapeHtml(item.error)}</p>`).join("")
      }</div>`
    : "";

  return layout({
    title: "spendtron — live sample",
    body: `<h1>Live sample</h1>
${stale ? `<div class="note">This sample is more than 6 hours old.</div>` : ""}
<p>${escapeHtml(report.allowance.text)}</p>
${share}
<p>${report.sampledJobs} jobs across ${report.sampledRuns} runs. Gross in the sample: ${escapeHtml(formatUsd(report.totalCostUsd))}. ${report.generatedAt ? `Saved ${escapeHtml(report.generatedAt)}.` : ""}</p>
${notes(report.notes)}
<h2>Workflows</h2>
${report.topWorkflows?.length ? bars(report.topWorkflows) : "<p>No completed jobs in the sample.</p>"}
<h2>Changes</h2>
${report.fixError ? `<p>${escapeHtml(report.fixError)}</p>` : ""}
${fixes || "<p>No corroborated change in the repositories sampled.</p>"}
<h2>Pull requests</h2>
${prStatus}
<div class="row">
  <form method="post" action="/report/refresh">${refreshToken ? `<input type="hidden" name="token" value="${escapeHtml(refreshToken)}" />` : ""}<button class="secondary" type="submit">Refresh sample</button></form>
</div>
${prBlock}
${writtenAudit(report.writtenAudit)}`,
  });
}

module.exports = { auditFormPage, csvReportPage, reportPage, escapeHtml };
