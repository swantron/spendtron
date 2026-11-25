const { applyWorkflowPatches } = require("./workflowPatch");

function groupPatches(fixes) {
  const files = new Map();
  for (const fix of fixes || []) {
    if (!fix.patch || !fix.repo || !fix.workflowFile) continue;
    const key = `${fix.repo}\t${fix.workflowFile}`;
    const entry = files.get(key) || { repo: fix.repo, path: fix.workflowFile, patches: [], fixes: [] };
    const signature = JSON.stringify(fix.patch);
    if (!entry.patches.some((patch) => JSON.stringify(patch) === signature)) entry.patches.push(fix.patch);
    entry.fixes.push(fix);
    files.set(key, entry);
  }
  return [...files.values()];
}

async function defaultBranch(octokit, owner, repo, fallback) {
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.default_branch || fallback || "main";
  } catch {
    return fallback || "main";
  }
}

const BRANCH_PREFIX = "spendtron/cost-";

/** An open spendtron pull request already on this repo, if any. */
async function existingSpendtronPr(octokit, owner, repo) {
  const { data } = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 100 });
  return (data || []).find(
    (pr) => pr.head && typeof pr.head.ref === "string" && pr.head.ref.startsWith(BRANCH_PREFIX) && pr.head.repo?.full_name === `${owner}/${repo}`,
  ) || null;
}

async function deleteBranch(octokit, owner, repo, branch) {
  try {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
  } catch {
    // Leaving an empty branch behind is untidy, not harmful.
  }
}

async function openFixPullRequests(octokit, report) {
  const grouped = groupPatches(report.fixes);
  if (grouped.length === 0) {
    return {
      opened: [],
      skipped: "No mechanical patch is safe to apply. Path filters, matrices, and macOS runners are listed on the report for you to edit.",
    };
  }

  const byRepo = new Map();
  for (const file of grouped) {
    const list = byRepo.get(file.repo) || [];
    list.push(file);
    byRepo.set(file.repo, list);
  }

  const opened = [];
  const existing = [];
  const errors = [];
  for (const [fullName, files] of byRepo) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) continue;
    const meta = (report.repos || []).find((item) => item.fullName === fullName);
    const branchBase = await defaultBranch(octokit, owner, repo, meta && meta.defaultBranch);
    let branch = null;
    try {
      const open = await existingSpendtronPr(octokit, owner, repo);
      if (open) {
        existing.push({ repo: fullName, url: open.html_url });
        continue;
      }
      const { data: ref } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branchBase}`,
      });
      branch = `${BRANCH_PREFIX}${Date.now().toString(36)}`;
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      });

      const applied = [];
      for (const file of files) {
        const { data: existing } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: file.path,
          ref: branch,
        });
        const yaml = Buffer.from(existing.content, "base64").toString("utf8");
        const patched = applyWorkflowPatches(yaml, file.patches);
        if (!patched.ok || patched.yaml === yaml) continue;
        await octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: file.path,
          message: `spendtron: price the Actions minute in ${file.path}`,
          content: Buffer.from(patched.yaml).toString("base64"),
          sha: existing.sha,
          branch,
        });
        applied.push(file.path);
      }

      if (applied.length === 0) {
        await deleteBranch(octokit, owner, repo, branch);
        errors.push({ repo: fullName, error: "The patch did not change the workflow file." });
        continue;
      }

      const advisory = (report.fixes || [])
        .filter((fix) => fix.repo === fullName && !fix.patch)
        .map((fix) => `- ${fix.summary}\n\n${fix.diff}`)
        .join("\n\n");
      const body = [
        "Mechanical edits from a spendtron sample of recent jobs, priced at GitHub's current per-runner rates. This is not the invoice. The billing export is the invoice.",
        "",
        "Applied:",
        ...applied.map((path) => `- \`${path}\``),
        "",
        advisory ? `Left for you, because applying them changes which jobs run:\n\n${advisory}` : "No further advisory items on this repo.",
        "",
        "Review the diff. cancel-in-progress applies to pull-request runs only, so a push to a branch always finishes. Timeouts sit at least 1.5x above the slowest run in the sample. Neither shortens a healthy run. A runner downgrade is included only for a short job on a larger Linux runner in a public repository.",
      ].join("\n");

      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: "spendtron: cut the Actions minute",
        head: branch,
        base: branchBase,
        body,
      });
      opened.push({ repo: fullName, url: pr.html_url });
      branch = null;
    } catch (err) {
      if (branch) await deleteBranch(octokit, owner, repo, branch);
      const status = err.status;
      errors.push({
        repo: fullName,
        error:
          status === 403
            ? "GitHub refused the write. On the spendtron-app settings, set Contents, Pull requests, and Workflows to Read and write, then accept the permission update on the installation. Workflows write is what lets an app edit files under .github/workflows."
            : err.message,
      });
    }
  }

  return { opened, existing, errors };
}

module.exports = { openFixPullRequests, groupPatches, BRANCH_PREFIX };
