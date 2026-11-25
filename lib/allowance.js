const PLANS = [
  { name: "GitHub Free", includedUsd: 12 },
  { name: "GitHub Pro and Team", includedUsd: 18 },
  { name: "GitHub Enterprise Cloud", includedUsd: 300 },
];

/** A written review is worth quoting only once the figure is real money. */
const WRITTEN_AUDIT_USD = 200;

function money(amount) {
  return `$${(Math.round(amount * 100) / 100).toFixed(2)}`;
}

function sourceLabel(source) {
  if (source === "export") return "Net Actions spend in this export";
  if (source === "month") return "Estimated monthly run-rate";
  return "Sampled GitHub-hosted compute";
}

/**
 * @param {number} amountUsd gross sample, extrapolated month, or CSV net
 * @param {{ source: "sample" | "month" | "export" }} options
 */
function describeAllowance(amountUsd, { source }) {
  const amount = Math.round((Number(amountUsd) || 0) * 100) / 100;
  if (amount <= 0) {
    const text =
      source === "export"
        ? "Net Actions charges in this export are $0.00. Included usage, public-repository discounts, or self-hosted runners already absorbed the bill."
        : "Estimated GitHub-hosted compute here is $0.00. Standard runners on public repositories and self-hosted runners are not on the Actions compute invoice.";
    return { amountUsd: 0, writtenAudit: false, text };
  }

  let text;
  if (amount <= PLANS[0].includedUsd) {
    text = `${sourceLabel(source)} is ${money(amount)}. That sits inside every plan's included compute: Free $12, Pro and Team $18, Enterprise Cloud $300. The marginal invoice is likely $0.`;
  } else if (amount <= PLANS[1].includedUsd) {
    text = `${sourceLabel(source)} is ${money(amount)}. That is above Free's $12 and inside the $18 included on Pro and Team, and inside Enterprise's $300.`;
  } else if (amount <= PLANS[2].includedUsd) {
    text = `${sourceLabel(source)} is ${money(amount)}. That is above Free, Pro, and Team included compute. Enterprise Cloud includes $300. The billing export's net amount is the number on the invoice.`;
  } else {
    text = `${sourceLabel(source)} is ${money(amount)}. That is above Enterprise Cloud's $300 of included compute.`;
  }

  return {
    amountUsd: amount,
    writtenAudit: amount >= WRITTEN_AUDIT_USD,
    text,
  };
}

module.exports = { describeAllowance, WRITTEN_AUDIT_USD, PLANS };
