/**
 * GitHub-hosted runner rates from
 * https://docs.github.com/en/billing/reference/actions-runner-pricing
 * (read 24 Nov 2026). Standard runners are free on public repositories.
 * Larger runners are billed everywhere, including public repositories.
 * Self-hosted and unrecognized labels are $0 on GitHub's compute line.
 */

const LINUX_X64_LARGER = {
  4: ["linux_4_core", 0.012],
  8: ["linux_8_core", 0.022],
  16: ["linux_16_core", 0.042],
  32: ["linux_32_core", 0.082],
  64: ["linux_64_core", 0.162],
  96: ["linux_96_core", 0.252],
};
const LINUX_ARM_LARGER = {
  2: ["linux_2_core_arm", 0.005],
  4: ["linux_4_core_arm", 0.008],
  8: ["linux_8_core_arm", 0.014],
  16: ["linux_16_core_arm", 0.026],
  32: ["linux_32_core_arm", 0.05],
  64: ["linux_64_core_arm", 0.098],
};
const WINDOWS_X64_LARGER = {
  4: ["windows_4_core", 0.022],
  8: ["windows_8_core", 0.042],
  16: ["windows_16_core", 0.082],
  32: ["windows_32_core", 0.162],
  64: ["windows_64_core", 0.322],
  96: ["windows_96_core", 0.552],
};
const WINDOWS_ARM_LARGER = {
  2: ["windows_2_core_arm", 0.008],
  4: ["windows_4_core_arm", 0.014],
  8: ["windows_8_core_arm", 0.026],
  16: ["windows_16_core_arm", 0.05],
  32: ["windows_32_core_arm", 0.098],
  64: ["windows_64_core_arm", 0.194],
};

const LINUX_STANDARD = new Set([
  "ubuntu-latest",
  "ubuntu-slim",
  "ubuntu-26.04",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-20.04",
]);
const LINUX_ARM_STANDARD = new Set([
  "ubuntu-latest-arm",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
]);
const WINDOWS_STANDARD = new Set([
  "windows-latest",
  "windows-2025",
  "windows-2022",
  "windows-2019",
]);
const MAC_STANDARD = new Set([
  "macos-latest",
  "macos-15",
  "macos-14",
  "macos-13",
  "macos-12",
]);

function billMinutes(startedAt, endedAt) {
  const seconds = (new Date(endedAt) - new Date(startedAt)) / 1000;
  if (!(seconds > 0)) return 1;
  return Math.ceil(seconds / 60);
}

function formatUsd(amount) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function normalizeLabels(labels) {
  if (!labels) return [];
  const list = Array.isArray(labels) ? labels : [labels];
  return list.map((label) => String(label).trim().toLowerCase()).filter(Boolean);
}

function coreCount(label) {
  const match = label.match(/(\d+)\s*[-_]?\s*cores?/);
  return match ? Number(match[1]) : null;
}

function parseHostedLabel(label) {
  const os = label.startsWith("macos")
    ? "macos"
    : label.startsWith("windows")
      ? "windows"
      : label.startsWith("ubuntu") || label.startsWith("linux-")
        ? "linux"
        : null;
  if (!os) return null;
  const arm = label.includes("arm") || label.includes("aarch64");
  const gpu = label.includes("gpu");
  const cores = coreCount(label);
  const xlarge = label.includes("xlarge");
  const large = !xlarge && label.includes("large");
  const advanced = label.includes("advanced");
  const knownStandard =
    LINUX_STANDARD.has(label) ||
    LINUX_ARM_STANDARD.has(label) ||
    WINDOWS_STANDARD.has(label) ||
    MAC_STANDARD.has(label);
  return { label, os, arm, gpu, cores, xlarge, large, advanced, knownStandard };
}

function lookupCores(table, cores) {
  if (cores == null) return null;
  return table[cores] || null;
}

function skuFor(parsed) {
  if (parsed.gpu) {
    if (parsed.os === "windows") {
      return hosted("windows_4_core_gpu", 0.102, true, "Windows GPU larger runner.");
    }
    return hosted("linux_4_core_gpu", 0.052, true, "Linux GPU larger runner.");
  }

  if (parsed.os === "macos") {
    if (parsed.xlarge || parsed.cores === 5) {
      return hosted("macos_xl", 0.102, true, "macOS 5-core larger runner.");
    }
    if (parsed.large || (parsed.cores != null && parsed.cores >= 12)) {
      return hosted("macos_l", 0.077, true, "macOS 12-core larger runner.");
    }
    return hosted("actions_macos", 0.062, false, "macOS standard runner.");
  }

  if (parsed.os === "windows") {
    const table = parsed.arm ? WINDOWS_ARM_LARGER : WINDOWS_X64_LARGER;
    const found = lookupCores(table, parsed.cores);
    if (found && parsed.cores >= 4) return hosted(found[0], found[1], true, "Windows larger runner.");
    if (parsed.arm && found) return hosted(found[0], found[1], parsed.cores >= 4, "Windows ARM runner.");
    if (parsed.arm) return hosted("windows_2_core_arm", 0.008, false, "Windows ARM standard runner.");
    return hosted("actions_windows", 0.01, false, "Windows standard runner.");
  }

  if (parsed.arm) {
    const found = lookupCores(LINUX_ARM_LARGER, parsed.cores);
    if (found && parsed.cores >= 4) return hosted(found[0], found[1], true, "Linux ARM larger runner.");
    if (parsed.knownStandard || parsed.cores == null || parsed.cores <= 2) {
      return hosted("actions_linux_arm", 0.005, false, "Linux ARM standard runner.");
    }
    if (found) return hosted(found[0], found[1], true, "Linux ARM larger runner.");
  }

  if (parsed.label === "ubuntu-slim" || parsed.cores === 1) {
    return hosted("actions_linux_slim", 0.002, false, "Linux 1-core runner.");
  }

  const found = lookupCores(LINUX_X64_LARGER, parsed.cores);
  if (found) return hosted(found[0], found[1], true, "Linux larger runner.");
  if (parsed.advanced && !parsed.knownStandard) {
    return hosted("linux_2_core_advanced", 0.006, true, "Linux advanced 2-core larger runner.");
  }
  return hosted("actions_linux", 0.006, false, "Linux 2-core standard runner.");
}

function hosted(sku, usdPerMinute, larger, reason) {
  return { sku, usdPerMinute, larger, hosted: true, reason };
}

function zero(sku, reason) {
  return {
    sku,
    usdPerMinute: 0,
    larger: false,
    hosted: false,
    billable: false,
    reason,
  };
}

function classifyRunner(labels, { visibility = "private" } = {}) {
  const list = normalizeLabels(labels);
  if (list.includes("self-hosted")) {
    return zero("self-hosted", "Self-hosted runners are not billed by GitHub.");
  }

  const parsed = list
    .map(parseHostedLabel)
    .filter(Boolean)
    .sort((a, b) => Number(b.gpu) - Number(a.gpu) || Number(b.cores || 0) - Number(a.cores || 0))[0];

  if (!parsed) {
    return zero("not-github-hosted", "Runner labels are not a GitHub-hosted SKU.");
  }

  const sku = skuFor(parsed);
  if (visibility === "public" && !sku.larger) {
    return {
      ...sku,
      usdPerMinute: 0,
      billable: false,
      reason: "Standard GitHub-hosted runners are free on public repositories.",
    };
  }

  return { ...sku, billable: sku.usdPerMinute > 0 };
}

function priceJob(job, { visibility = "private" } = {}) {
  if (!job || !job.started_at || !job.completed_at) return null;
  // Skipped jobs never get a runner. Cancelled jobs are billed for the time
  // they ran, which is the waste cancel-in-progress exists to cut.
  if (job.conclusion === "skipped") return null;
  const seconds = (new Date(job.completed_at) - new Date(job.started_at)) / 1000;
  if (!(seconds >= 0)) return null;
  const minutes = seconds > 0 ? Math.ceil(seconds / 60) : 0;
  const rate = classifyRunner(job.labels, { visibility });
  const steps = [];
  for (const step of job.steps || []) {
    if (!step || !step.started_at || !step.completed_at) continue;
    if (step.conclusion === "skipped") continue;
    const stepSeconds = (new Date(step.completed_at) - new Date(step.started_at)) / 1000;
    if (!(stepSeconds >= 0) || !step.name) continue;
    steps.push({ name: step.name, seconds: stepSeconds });
  }
  return {
    name: job.name || "(unnamed job)",
    conclusion: job.conclusion || null,
    runnerGroup: job.runner_group_name || null,
    minutes,
    seconds,
    labels: normalizeLabels(job.labels),
    rate,
    costUsd: rate.billable ? minutes * rate.usdPerMinute : 0,
    steps,
  };
}

module.exports = {
  billMinutes,
  formatUsd,
  classifyRunner,
  priceJob,
  LINUX_STANDARD,
};
