// Reads a GitHub detailed usage export in the browser and draws the chart
// in place. Needs /audit.js loaded first. Without JavaScript the form posts
// to /audit instead.
(function () {
  var form = document.getElementById("audit-form");
  if (!form || !window.spendtron) return;
  var file = document.getElementById("audit-file");
  var area = document.getElementById("audit-csv");
  var errorBox = document.getElementById("audit-error");
  function show(text) {
    var report = window.spendtron.auditUsageCsv(text);
    if (report.error) {
      errorBox.textContent = report.error;
      return;
    }
    document.open();
    document.write(window.spendtron.csvReportPage(report));
    document.close();
  }
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (file && file.files && file.files[0]) {
      file.files[0].text().then(show);
    } else {
      show(area ? area.value : "");
    }
  });
})();
