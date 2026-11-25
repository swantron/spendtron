const fs = require("fs");
const path = require("path");

/**
 * The billing-export audit runs in the visitor's browser, so the export is
 * never uploaded and its size is not capped by the server's body limit.
 * These modules are plain CommonJS with no npm dependencies; this wraps
 * them in a tiny require shim instead of adding a bundler.
 */
const MODULES = ["runnerRates", "allowance", "usageCsv", "pages"];

function browserBundle() {
  const defs = MODULES.map((name) => {
    const source = fs.readFileSync(path.join(__dirname, `${name}.js`), "utf8");
    return `${JSON.stringify(`./${name}`)}: function (module, exports, require) {\n${source}\n}`;
  }).join(",\n");
  return `(function () {
var defs = {
${defs}
};
var cache = {};
function load(name) {
  if (cache[name]) return cache[name].exports;
  if (!defs[name]) throw new Error("spendtron bundle is missing " + name);
  var module = { exports: {} };
  cache[name] = module;
  defs[name](module, module.exports, load);
  return module.exports;
}
window.spendtron = {
  auditUsageCsv: load("./usageCsv").auditUsageCsv,
  csvReportPage: load("./pages").csvReportPage
};
})();
`;
}

module.exports = { browserBundle, MODULES };
