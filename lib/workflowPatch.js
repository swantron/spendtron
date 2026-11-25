const YAML = require("yaml");

function quoteScalar(doc, value) {
  const node = doc.createNode(value);
  if (node && typeof node === "object") node.type = "QUOTE_DOUBLE";
  return node;
}

/**
 * Apply only the edits that are safe to commit without changing which
 * tests run: a timeout, cancel-in-progress for pull-request runs of a
 * non-deploy workflow, and
 * a short public-repo job leaving a larger Linux runner.
 */
function applyWorkflowPatches(yamlText, patches) {
  const doc = YAML.parseDocument(String(yamlText));
  if (doc.errors && doc.errors.length) return { ok: false, yaml: yamlText, error: "YAML did not parse." };

  for (const patch of patches) {
    if (patch.type === "timeout") {
      const jobs = doc.get("jobs");
      const job = jobs && typeof jobs.get === "function" ? jobs.get(patch.jobId, true) : null;
      if (job && typeof job.set === "function" && job.get("timeout-minutes") == null) {
        job.set("timeout-minutes", patch.minutes);
      }
    } else if (patch.type === "concurrency") {
      if (!doc.has("concurrency")) {
        const block = doc.createNode({});
        block.set("group", quoteScalar(doc, "${{ github.workflow }}-${{ github.ref }}"));
        // Cancel superseded pull-request runs only. A push to a branch
        // (often main) finishes even when a newer push arrives.
        block.set("cancel-in-progress", "${{ github.event_name == 'pull_request' }}");
        doc.set("concurrency", block);
      }
    } else if (patch.type === "runner") {
      const jobs = doc.get("jobs");
      const job = jobs && typeof jobs.get === "function" ? jobs.get(patch.jobId, true) : null;
      if (job && typeof job.get === "function" && job.get("runs-on") === patch.from) {
        job.set("runs-on", patch.to);
      }
    }
  }

  return { ok: true, yaml: String(doc) };
}

module.exports = { applyWorkflowPatches };
