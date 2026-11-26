/* spendtron free tools. Calculators run entirely in the browser using the
 * same rate table the audit uses (/audit.js). The workflow checker posts the
 * pasted file to /api/check-workflow, which does not store it. */
(function () {
  "use strict";
  var S = window.spendtron || {};
  var R = S.rates;

  function $(id) { return document.getElementById(id); }
  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function usd(n) {
    var v = Math.round(Number(n) * 100) / 100;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function rate(n) { return "$" + Number(n).toFixed(3); }
  function num(id, fallback) {
    var v = parseFloat($(id).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  }
  function int(n) { return Math.round(n).toLocaleString("en-US"); }

  /** Every GitHub-hosted SKU, priced by the same classifier the audit uses. */
  function runnerOptions() {
    if (!R) return [];
    var list = [];
    function add(group, label, name) {
      var r = R.classifyRunner([label]);
      list.push({ group: group, label: label, name: name, sku: r.sku, rate: r.usdPerMinute, larger: r.larger });
    }
    add("Standard", "ubuntu-latest", "Linux 2-core (ubuntu-latest)");
    add("Standard", "ubuntu-slim", "Linux 1-core (ubuntu-slim)");
    add("Standard", "ubuntu-24.04-arm", "Linux 2-core arm64");
    add("Standard", "windows-latest", "Windows 2-core (windows-latest)");
    add("Standard", "windows-11-arm", "Windows 2-core arm64");
    add("Standard", "macos-latest", "macOS standard (macos-latest)");
    function table(group, t, prefix, suffix) {
      Object.keys(t).map(Number).sort(function (a, b) { return a - b; }).forEach(function (cores) {
        var r = t[cores];
        list.push({ group: group, label: r[0], name: prefix + " " + cores + "-core" + suffix, sku: r[0], rate: r[1], larger: true });
      });
    }
    table("Larger: Linux x64", R.LINUX_X64_LARGER, "Linux", "");
    table("Larger: Linux arm64", R.LINUX_ARM_LARGER, "Linux", " arm64");
    table("Larger: Windows x64", R.WINDOWS_X64_LARGER, "Windows", "");
    table("Larger: Windows arm64", R.WINDOWS_ARM_LARGER, "Windows", " arm64");
    add("Larger: macOS", "macos-latest-large", "macOS 12-core (large)");
    add("Larger: macOS", "macos-latest-xlarge", "macOS 5-core M2 Pro (xlarge)");
    add("Larger: GPU", "linux-gpu", "Linux 4-core GPU");
    add("Larger: GPU", "windows-gpu", "Windows 4-core GPU");
    return list;
  }

  function selectHtml(options, selectedSku, cls) {
    var groups = {};
    var order = [];
    options.forEach(function (o) {
      if (!groups[o.group]) { groups[o.group] = []; order.push(o.group); }
      groups[o.group].push(o);
    });
    return '<select class="' + cls + '">' + order.map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (o) {
        return '<option value="' + esc(o.sku) + '"' + (o.sku === selectedSku ? " selected" : "") + ">" +
          esc(o.name) + " · " + rate(o.rate) + "/min</option>";
      }).join("") + "</optgroup>";
    }).join("") + "</select>";
  }

  function bySku(options, sku) {
    for (var i = 0; i < options.length; i++) if (options[i].sku === sku) return options[i];
    return options[0];
  }

  function planIncluded() {
    var el = $("plan");
    return el ? Number(el.value) || 0 : 0;
  }

  function planSelectHtml() {
    var plans = S.plans || [];
    return '<option value="0">No included compute</option>' + plans.map(function (p, i) {
      return '<option value="' + p.includedUsd + '"' + (i === 0 ? " selected" : "") + ">" + esc(p.name) + " ($" + p.includedUsd + " included)</option>";
    }).join("");
  }

  /* ---------- Actions cost calculator ---------- */
  function costCalculator() {
    var root = $("cost-calc");
    if (!root) return;
    var options = runnerOptions();
    var rows = $("cost-rows");
    $("plan").innerHTML = planSelectHtml();
    var seed = [
      { sku: "actions_linux", runs: 400, jobs: 3, minutes: 6 },
      { sku: "actions_macos", runs: 100, jobs: 1, minutes: 14 },
    ];
    function addRow(r) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + selectHtml(options, r.sku, "c-sku") + "</td>" +
        '<td><input class="c-runs" type="number" min="0" step="1" value="' + r.runs + '" aria-label="Runs per month"></td>' +
        '<td><input class="c-jobs" type="number" min="0" step="1" value="' + r.jobs + '" aria-label="Jobs per run"></td>' +
        '<td><input class="c-min" type="number" min="0" step="0.1" value="' + r.minutes + '" aria-label="Minutes per job"></td>' +
        '<td class="num c-out"></td>' +
        '<td><button type="button" class="link c-del" aria-label="Remove row">×</button></td>';
      rows.appendChild(tr);
    }
    seed.forEach(addRow);
    $("cost-add").addEventListener("click", function () { addRow({ sku: "actions_linux", runs: 100, jobs: 1, minutes: 5 }); calc(); });
    rows.addEventListener("click", function (e) {
      if (e.target.classList.contains("c-del")) { e.target.closest("tr").remove(); calc(); }
    });
    root.addEventListener("input", calc);
    root.addEventListener("change", calc);

    function calc() {
      var isPublic = $("cost-public").checked;
      var gross = 0, minutesTotal = 0, freeMinutes = 0;
      Array.prototype.forEach.call(rows.querySelectorAll("tr"), function (tr) {
        var o = bySku(options, tr.querySelector(".c-sku").value);
        var runs = parseFloat(tr.querySelector(".c-runs").value) || 0;
        var jobs = parseFloat(tr.querySelector(".c-jobs").value) || 0;
        var m = parseFloat(tr.querySelector(".c-min").value) || 0;
        var billedPerJob = m > 0 ? Math.ceil(m) : 0;
        var minutes = runs * jobs * billedPerJob;
        var free = isPublic && !o.larger;
        var cost = free ? 0 : minutes * o.rate;
        gross += cost;
        minutesTotal += minutes;
        if (free) freeMinutes += minutes;
        tr.querySelector(".c-out").innerHTML = usd(cost) + '<br><span class="small">' + int(minutes) + " min" + (free ? ", free (public)" : "") + "</span>";
      });
      var included = planIncluded();
      var net = Math.max(0, gross - included);
      $("cost-result").innerHTML =
        '<div class="stats">' +
        stat("Billed minutes / month", int(minutesTotal)) +
        stat("Gross / month", usd(gross)) +
        stat("After included compute", usd(net), true) +
        stat("Per year", usd(net * 12)) +
        "</div>" +
        '<p class="small">Each job is rounded up to a whole minute, so ' + int(minutesTotal) + " billed minutes may be more than the time the jobs actually ran. " +
        (freeMinutes ? int(freeMinutes) + " of them are on standard runners in a public repository, which are free. " : "") +
        (included ? "Included compute is " + usd(included) + " a month and is spent at each runner's own rate. " : "") +
        (net === 0 && gross > 0 ? "<b>This fits inside the included compute, so the invoice line would be $0.</b>" : "") +
        "</p>";
    }
    calc();
  }

  function stat(label, value, strong) {
    return '<div class="stat' + (strong ? " strong" : "") + '"><div class="v">' + value + '</div><div class="l">' + esc(label) + "</div></div>";
  }

  /* ---------- Self-hosted break-even ---------- */
  function selfHosted() {
    var root = $("sh-calc");
    if (!root) return;
    var options = runnerOptions();
    $("sh-runner-wrap").innerHTML = selectHtml(options, "actions_linux", "sh-sku");
    $("plan").innerHTML = planSelectHtml();
    root.addEventListener("input", calc);
    root.addEventListener("change", calc);
    function calc() {
      var o = bySku(options, root.querySelector(".sh-sku").value);
      var minutes = num("sh-minutes", 0);
      var machine = num("sh-machine", 0);
      var hours = num("sh-hours", 0);
      var hourly = num("sh-hourly", 0);
      var included = planIncluded();
      var hosted = Math.max(0, minutes * o.rate - included);
      var self = machine + hours * hourly;
      var diff = hosted - self;
      var breakEven = o.rate > 0 ? (self + included) / o.rate : Infinity;
      var runners = Math.max(1, Math.ceil(minutes / (43200 * 0.5)));
      $("sh-result").innerHTML =
        '<div class="stats">' +
        stat("GitHub-hosted / month", usd(hosted)) +
        stat("Self-hosted / month", usd(self)) +
        stat(diff >= 0 ? "Self-hosting saves" : "Self-hosting costs extra", usd(Math.abs(diff)), true) +
        stat("Break-even minutes / month", Number.isFinite(breakEven) ? int(breakEven) : "n/a") +
        "</div>" +
        '<p class="small">' +
        (Number.isFinite(breakEven)
          ? "Below about " + int(breakEven) + " minutes a month on " + esc(o.name) + ", GitHub-hosted is cheaper once upkeep is counted. "
          : "") +
        "One always-on runner can do at most 43,200 job-minutes a month. At half busy, " + int(minutes) + " minutes needs about " + runners +
        " runner" + (runners === 1 ? "" : "s") + ", so price the machine line for that many. GitHub doesn't charge per minute for self-hosted runners.</p>";
    }
    calc();
  }

  /* ---------- Larger runner calculator ---------- */
  function largerRunner() {
    var root = $("lr-calc");
    if (!root) return;
    var families = {
      linux: { name: "Linux x64", base: R.classifyRunner(["ubuntu-latest"]), table: R.LINUX_X64_LARGER },
      arm: { name: "Linux arm64", base: R.classifyRunner(["ubuntu-24.04-arm"]), table: R.LINUX_ARM_LARGER },
      windows: { name: "Windows x64", base: R.classifyRunner(["windows-latest"]), table: R.WINDOWS_X64_LARGER },
    };
    root.addEventListener("input", calc);
    root.addEventListener("change", calc);
    function calc() {
      var fam = families[$("lr-os").value] || families.linux;
      var minutes = num("lr-minutes", 10);
      var p = Math.min(100, num("lr-parallel", 60)) / 100;
      var jobs = num("lr-jobs", 500);
      var isPublic = $("lr-public").checked;
      var baseRate = isPublic ? 0 : fam.base.usdPerMinute;
      var baseBilled = Math.ceil(minutes);
      var baseCost = baseBilled * baseRate;
      var rowsHtml = [];
      rowsHtml.push(row("2-core standard", fam.base.usdPerMinute, isPublic, minutes, baseBilled, baseCost, jobs, baseCost, null));
      Object.keys(fam.table).map(Number).sort(function (a, b) { return a - b; }).forEach(function (cores) {
        if (cores <= 2) return;
        var r = fam.table[cores];
        var est = minutes * ((1 - p) + p * 2 / cores);
        var billed = Math.max(1, Math.ceil(est));
        var cost = billed * r[1];
        var needed = baseRate > 0 ? r[1] / baseRate : null;
        rowsHtml.push(row(cores + "-core", r[1], false, est, billed, cost, jobs, baseCost, needed));
      });
      $("lr-result").innerHTML =
        "<table><thead><tr><th>Runner</th><th class=num>Per min</th><th class=num>Est. job time</th><th class=num>Cost / job</th><th class=num>Per month</th><th class=num>vs 2-core</th><th class=num>Break-even speedup</th></tr></thead><tbody>" +
        rowsHtml.join("") + "</tbody></table>" +
        '<p class="small">Job time assumes ' + Math.round(p * 100) + "% of the job speeds up in proportion to cores and the rest doesn't (Amdahl's law). Measure a few real runs before switching; installs, network waits, and single-threaded test runners rarely scale. " +
        (isPublic ? "<b>On a public repository the 2-core runner is free, so every larger runner is pure added cost.</b>" : "") + "</p>";
    }
    function row(name, perMin, free, est, billed, cost, jobs, baseCost, needed) {
      var delta = cost - baseCost;
      var cls = delta > 0.0001 ? "worse" : delta < -0.0001 ? "better" : "";
      return "<tr><td>" + esc(name) + "</td><td class=num>" + (free ? "free" : rate(perMin)) + "</td><td class=num>" + est.toFixed(1) +
        " min</td><td class=num>" + usd(cost) + '</td><td class=num>' + usd(cost * jobs) + '</td><td class="num ' + cls + '">' +
        (needed == null && !delta ? "—" : (delta >= 0 ? "+" : "−") + usd(Math.abs(delta * jobs))) + "</td><td class=num>" +
        (needed == null ? "—" : needed.toFixed(1) + "× faster") + "</td></tr>";
    }
    calc();
  }

  /* ---------- Workflow checker ---------- */
  var EXAMPLE = [
    "name: CI",
    "on:",
    "  push:",
    "  pull_request:",
    "jobs:",
    "  test:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, windows-latest, macos-latest]",
    "        node: [20, 22]",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: ${{ matrix.node }}",
    "      - run: npm ci",
    "      - run: npx playwright install --with-deps",
    "      - run: npm test",
    "",
  ].join("\n");

  function checker() {
    var form = $("wf-form");
    if (!form) return;
    $("wf-example").addEventListener("click", function () { $("wf-yaml").value = EXAMPLE; form.requestSubmit(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var out = $("wf-result");
      var yaml = $("wf-yaml").value;
      var visibility = form.querySelector('input[name="visibility"]:checked').value;
      out.innerHTML = '<p class="small">Checking…</p>';
      fetch("/api/check-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: yaml, visibility: visibility }),
      })
        .then(function (r) { return r.json(); })
        .then(function (res) { out.innerHTML = renderCheck(res); wireCopy(out); out.scrollIntoView({ behavior: "smooth", block: "start" }); })
        .catch(function () { out.innerHTML = '<p class="error">The check failed to run. Try again in a moment.</p>'; });
    });
  }

  function renderCheck(res) {
    if (!res.ok) return '<p class="error">' + esc(res.error || "That didn't work.") + "</p>";
    var counts = { high: 0, medium: 0, low: 0 };
    res.findings.forEach(function (f) { counts[f.severity]++; });
    var head = res.findings.length
      ? "<h2>" + res.findings.length + " thing" + (res.findings.length === 1 ? "" : "s") + " to check</h2><p class=small>" +
        counts.high + " high, " + counts.medium + " medium, " + counts.low + " low, across " + res.jobCount + " job" + (res.jobCount === 1 ? "" : "s") + ".</p>"
      : "<h2>Nothing obvious</h2><p>The static checks found no cost issues in this file. The expensive part may be how often it runs; the <a href=\"/\">usage report</a> shows that.</p>";
    var items = res.findings.map(function (f) {
      return '<div class="finding"><div><span class="sev ' + f.severity + '">' + f.severity + "</span>" +
        (f.job ? ' <code>' + esc(f.job) + "</code>" : "") + (f.patched ? ' <span class="small">· applied in the patched file</span>' : "") +
        "</div><p>" + esc(f.summary) + "</p>" + (f.fix ? "<pre>" + esc(f.fix) + "</pre>" : "") + "</div>";
    }).join("");
    var patched = res.patchedYaml
      ? "<h2>Patched file</h2><p class=small>Adds only what can't change which tests run: a concurrency group that cancels superseded pull-request runs, and job timeouts. Check the timeout values before committing.</p>" +
        '<div class="copywrap"><button type="button" class="copy" data-target="wf-patched">Copy</button><pre id="wf-patched">' + esc(res.patchedYaml) + "</pre></div>"
      : "";
    var deploy = res.deployish ? '<p class="small">This workflow looks like it deploys, so the concurrency group was not added automatically.</p>' : "";
    return head + items + deploy + patched +
      '<div class="cta"><p><strong>Which of these actually costs money?</strong></p><p>A static check can\'t see how often a workflow runs. <a href="/github/install">Connect the GitHub App</a> to price every job from real runs and open these fixes as a pull request, or load your <a href="/">usage report</a> with no account. Both free.</p></div>';
  }

  function wireCopy(root) {
    Array.prototype.forEach.call(root.querySelectorAll("button.copy"), function (b) {
      b.addEventListener("click", function () {
        var text = $(b.getAttribute("data-target")).textContent;
        navigator.clipboard.writeText(text).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); });
      });
    });
  }

  function init() {
    if (!R && !$("wf-form")) {
      var el = document.querySelector(".tool");
      if (el) el.innerHTML = '<p class="error">The rate table did not load. Reload the page.</p>';
      return;
    }
    if (R) { costCalculator(); selfHosted(); largerRunner(); }
    checker();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
