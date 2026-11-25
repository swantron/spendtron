const { describeAllowance } = require("./allowance");
const { formatUsd } = require("./runnerRates");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const char = src[i];
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => String(value).trim() !== ""));
}

function normHeader(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function column(header, ...names) {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index !== -1) return index;
  }
  return -1;
}

function numberAt(row, index) {
  if (index < 0) return 0;
  const value = Number(String(row[index] ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(value) ? value : 0;
}

function textAt(row, index) {
  if (index < 0) return "";
  return String(row[index] ?? "").trim();
}

/**
 * GitHub's detailed usage report includes workflow_path and net_amount.
 * The summarized report does not. Net is the invoice; gross is before
 * included usage and public-repo discounts.
 */
function auditUsageCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { error: "Paste the detailed usage CSV, including the header row." };
  }
  const header = rows[0].map(normHeader);
  const netIdx = column(header, "net_amount", "net");
  const grossIdx = column(header, "gross_amount", "gross");
  if (netIdx < 0 && grossIdx < 0) {
    return {
      error:
        "This CSV has no net_amount or gross_amount column. Download the detailed usage report from GitHub billing. The summarized report has no workflow path.",
    };
  }
  const workflowIdx = column(header, "workflow_path", "workflow");
  const repoIdx = column(header, "repository", "repo");
  const skuIdx = column(header, "sku");
  const productIdx = column(header, "product");
  const quantityIdx = column(header, "quantity");
  const dateIdx = column(header, "date");
  const discountIdx = column(header, "discount_amount", "discount");
  const unitIdx = column(header, "unit_type", "unit");

  const hasProduct = rows.slice(1).some((row) => textAt(row, productIdx));
  const workflows = new Map();
  let totalNet = 0;
  let totalGross = 0;
  let totalDiscount = 0;
  let kept = 0;
  const dates = [];

  for (const row of rows.slice(1)) {
    const product = textAt(row, productIdx);
    if (hasProduct && product && !/actions/i.test(product)) continue;
    const net = numberAt(row, netIdx);
    const gross = numberAt(row, grossIdx);
    const discount = numberAt(row, discountIdx);
    // Storage rows are GB-hours. Count only compute minutes as minutes;
    // their dollars still count.
    const unit = textAt(row, unitIdx);
    const isMinutes = unit ? /minute/i.test(unit) : !/storage/i.test(textAt(row, skuIdx));
    const quantity = isMinutes ? numberAt(row, quantityIdx) : 0;
    const repo = textAt(row, repoIdx) || "(no repository)";
    const workflow = textAt(row, workflowIdx) || "(no workflow path)";
    const sku = textAt(row, skuIdx) || "";
    const date = textAt(row, dateIdx);
    if (date) dates.push(date);
    const key = `${repo}\t${workflow}`;
    const entry = workflows.get(key) || {
      repo,
      workflow,
      net: 0,
      gross: 0,
      discount: 0,
      quantity: 0,
      skus: new Map(),
    };
    entry.net += net;
    entry.gross += gross;
    entry.discount += discount;
    entry.quantity += quantity;
    if (sku) entry.skus.set(sku, (entry.skus.get(sku) || 0) + (net || gross));
    workflows.set(key, entry);
    totalNet += net;
    totalGross += gross;
    totalDiscount += discount;
    kept++;
  }

  if (kept === 0) {
    return { error: "No Actions rows found in that CSV." };
  }

  const useNet = totalNet > 0 || totalGross === 0;
  const topWorkflows = [...workflows.values()]
    .map((entry) => {
      const topSku = [...entry.skus.entries()].sort((a, b) => b[1] - a[1])[0];
      const costUsd = Math.round((useNet ? entry.net : entry.gross) * 100) / 100;
      return {
        label: `${entry.repo} · ${entry.workflow}`,
        repo: entry.repo,
        workflowPath: entry.workflow,
        costUsd,
        netUsd: Math.round(entry.net * 100) / 100,
        grossUsd: Math.round(entry.gross * 100) / 100,
        minutes: Math.round(entry.quantity),
        topSku: topSku ? topSku[0] : null,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 12);

  const total = Math.round((useNet ? totalNet : totalGross) * 100) / 100;
  const topShare = total > 0 && topWorkflows[0] ? Math.round((topWorkflows[0].costUsd / (useNet ? totalNet : totalGross)) * 100) : 0;
  const allowance = describeAllowance(Math.round(totalNet * 100) / 100, { source: "export" });
  const sortedDates = dates.filter(Boolean).sort();

  return {
    kind: "export",
    topWorkflows,
    topShare,
    totalNetUsd: Math.round(totalNet * 100) / 100,
    totalGrossUsd: Math.round(totalGross * 100) / 100,
    totalDiscountUsd: Math.round(totalDiscount * 100) / 100,
    pricedOn: useNet ? "net" : "gross",
    rowCount: kept,
    allowance,
    writtenAudit: allowance.writtenAudit,
    windowLabel: sortedDates.length ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}` : null,
    totalDisplay: formatUsd(total),
    notes: [
      workflowIdx < 0
        ? "No workflow_path column. This is probably the summarized report. Download the detailed usage report to see workflows."
        : "Dollars are GitHub's figures from the detailed usage export, summed by repository and workflow path.",
    ],
  };
}

module.exports = { auditUsageCsv, parseCsv };
