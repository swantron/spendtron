const path = require("path");
const express = require("express");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const Stripe = require("stripe");
const { McpServer } = require("@modelcontextprotocol/server");
const {
  NodeStreamableHTTPServerTransport,
} = require("@modelcontextprotocol/node");

const { auditActionsCost } = require("./lib/auditActions");
const {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
  makeRotateToken,
  verifyRotateToken,
} = require("./lib/auth");
const {
  createSubscribeCheckoutUrl,
  createPortalUrl,
  applyStripeEvent,
} = require("./lib/billing");
const {
  getInstallationByApiKeyHash,
  getInstallationByInstallationId,
  createInstallation,
  rotateApiKey,
  markFreeTrialUsed,
  getSubscriptionStatus,
  upsertSubscription,
} = require("./lib/installations");

const app = express();
const port = process.env.PORT || 8080;

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "spendtron-app";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:8080";
const ROTATE_SECRET = GITHUB_APP_PRIVATE_KEY || "spendtron-dev-rotate";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/** App-level auth (not installation-scoped yet) — used only to look up
 * installation metadata (account login) right after a user installs. */
function appOctokit() {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: GITHUB_APP_ID, privateKey: GITHUB_APP_PRIVATE_KEY },
  });
}

/** Installation-scoped client — this is the one that can actually read
 * that org's private repos, restricted to whatever the customer approved
 * at install time (Actions: Read-only, Metadata: Read-only). */
function installationOctokit(installationId) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: GITHUB_APP_ID,
      privateKey: GITHUB_APP_PRIVATE_KEY,
      installationId,
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function connectedPage({ title, bodyHtml }) {
  return `<!doctype html>
<title>spendtron — ${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent2:#58a6ff; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; max-width: 640px; margin: 0 auto; padding: 48px 24px; }
  a { color: var(--accent2); }
  pre { background: #010409; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  .muted { color: var(--muted); }
</style>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
<p class="muted"><a href="/">Back to spendtron</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`;
}

async function subscribeUrlFor(installationId) {
  if (!stripe) return `${APP_BASE_URL}/?subscribed=unavailable`;
  return createSubscribeCheckoutUrl(stripe, installationId, APP_BASE_URL);
}

app.use((req, res, next) => {
  if (req.hostname === "www.spendtron.com") {
    return res.redirect(301, `https://spendtron.com${req.originalUrl}`);
  }
  next();
});

/** Stripe needs the raw body for signature verification. This route MUST be
 * registered before express.json(), or the parser consumes the buffer and
 * constructEvent cannot check the signature. */
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(503).send("Stripe not configured");

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await applyStripeEvent(stripe, event, upsertSubscription);
    } catch (err) {
      console.error("Stripe event apply failed:", err);
      return res.status(500).send("Webhook handler failed");
    }

    res.json({ received: true });
  },
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", service: "spendtron" });
});

app.get("/ready", (req, res) => {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return res
      .status(503)
      .json({ status: "not ready", error: "GitHub App not configured" });
  }
  res.status(200).json({ status: "ready", service: "spendtron" });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

/** Start of the install flow — GitHub's own installation UI handles repo
 * selection; this just points at it. */
app.get("/github/install", (req, res) => {
  res.redirect(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`);
});

/** GitHub redirects here after install with ?installation_id=...&setup_action=install */
app.get("/github/callback", async (req, res) => {
  const installationId = Number(req.query.installation_id);
  if (!installationId) {
    return res.status(400).send("Missing installation_id.");
  }

  try {
    const { data: installation } = await appOctokit().rest.apps.getInstallation(
      {
        installation_id: installationId,
      },
    );
    const accountLogin = installation.account.login;
    const host = `${req.protocol}://${req.get("host")}`;
    const subscribeUrl = await subscribeUrlFor(installationId);

    const existing = await getInstallationByInstallationId(installationId);
    if (existing) {
      const rotateToken = makeRotateToken(installationId, ROTATE_SECRET);
      return res.type("html").send(
        connectedPage({
          title: `Already connected to ${accountLogin}`,
          bodyHtml: `<p>This GitHub org is already set up. Your existing API key still works — we did not issue a new one.</p>
<p>If you lost the key, <a href="/github/rotate?installation_id=${installationId}&amp;token=${encodeURIComponent(rotateToken)}">issue a new one</a>. The old key will stop working.</p>
<p><a href="${escapeHtml(subscribeUrl)}">Subscribe, $99/mo</a> if the free audit is used.</p>`,
        }),
      );
    }

    const rawApiKey = generateApiKey();
    await createInstallation({
      installationId,
      accountLogin,
      apiKeyHash: hashApiKey(rawApiKey),
    });

    return res.type("html").send(
      connectedPage({
        title: `Connected to ${accountLogin}`,
        bodyHtml: `<p>Your API key (shown once — save it now):</p>
<pre>${escapeHtml(rawApiKey)}</pre>
<p>Add it as a bearer token in your MCP client's config for <code>${escapeHtml(host)}/mcp</code>.</p>
<p>Your first <code>check_actions_cost</code> call is free. After that: <a href="${escapeHtml(subscribeUrl)}">subscribe, $99/mo</a>.</p>`,
      }),
    );
  } catch (err) {
    console.error("GitHub callback error:", err);
    res.status(500).send("Could not complete installation.");
  }
});

app.get("/github/rotate", async (req, res) => {
  const installationId = Number(req.query.installation_id);
  const token = String(req.query.token || "");
  if (
    !installationId ||
    !verifyRotateToken(installationId, token, ROTATE_SECRET)
  ) {
    return res
      .status(403)
      .send("Invalid or expired rotate link. Reconnect from /github/install.");
  }

  try {
    const rawApiKey = generateApiKey();
    await rotateApiKey(installationId, hashApiKey(rawApiKey));
    const host = `${req.protocol}://${req.get("host")}`;
    res.type("html").send(
      connectedPage({
        title: "New API key issued",
        bodyHtml: `<p>Save this key. The previous key no longer works.</p>
<pre>${escapeHtml(rawApiKey)}</pre>
<p>MCP endpoint: <code>${escapeHtml(host)}/mcp</code></p>`,
      }),
    );
  } catch (err) {
    console.error("Rotate key error:", err);
    res.status(500).send("Could not rotate the API key.");
  }
});

app.get("/billing/portal", async (req, res) => {
  if (!stripe) return res.status(503).send("Stripe not configured");
  const sessionId = req.query.session_id;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).send("Missing session_id from Checkout.");
  }
  try {
    const checkout = await stripe.checkout.sessions.retrieve(sessionId);
    const customer =
      typeof checkout.customer === "string"
        ? checkout.customer
        : checkout.customer?.id;
    if (!customer) {
      return res.status(400).send("No customer on that Checkout session.");
    }
    const url = await createPortalUrl(stripe, customer, APP_BASE_URL);
    res.redirect(url);
  } catch (err) {
    console.error("Billing portal error:", err);
    res
      .status(400)
      .send(
        "Could not open the billing portal. Use the link in the Stripe receipt email.",
      );
  }
});

const mcpServer = new McpServer({ name: "spendtron", version: "1.0.0" });

mcpServer.registerTool(
  "check_actions_cost",
  {
    title: "Audit GitHub Actions cost",
    description:
      "Ranks your GitHub org's Actions workflows and repos by real compute cost, using your account's spendtron connection (no arguments needed — identified by your API key).",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (ctx) => {
    const installation = ctx.http?.authInfo?.extra?.installation;
    if (!installation) {
      throw new Error(
        "Not authenticated — connect at /github/install and use your API key.",
      );
    }

    const alreadyTrialed = Boolean(installation.free_trial_used_at);
    const subscriptionStatus = await getSubscriptionStatus(
      installation.installation_id,
    );
    const subscribed = subscriptionStatus === "active";

    if (!subscribed && alreadyTrialed) {
      const subscribeUrl = await subscribeUrlFor(installation.installation_id);
      return {
        content: [
          {
            type: "text",
            text: `Your free audit's been used. Subscribe ($99/mo) to keep auditing: ${subscribeUrl}`,
          },
        ],
      };
    }

    const octokit = installationOctokit(installation.installation_id);
    const result = await auditActionsCost(octokit);

    if (!subscribed) {
      await markFreeTrialUsed(installation.installation_id);
    }

    const lines = [
      `Sampled ${result.sampledRuns} recent runs. Fleet total: ~${result.totalBillMinutes} bill-minutes (~$${result.totalCostUsd}/period at private Ubuntu rates).`,
      "",
      "Top workflows by compute:",
      ...result.topWorkflows.map(
        (w) =>
          `- ${w.workflow}: ${w.billMinutes} min, ${w.runs} runs, avg ${w.avgSeconds}s, ~$${w.costUsd}`,
      ),
      "",
      "Top repos by compute:",
      ...result.topRepos.map(
        (r) =>
          `- ${r.repo}: ${r.billMinutes} min, ${r.runs} runs, ~$${r.costUsd}`,
      ),
    ];

    if (!subscribed) {
      const subscribeUrl = await subscribeUrlFor(installation.installation_id);
      lines.push(
        "",
        `That was your free audit. Subscribe ($99/mo) for ongoing audits: ${subscribeUrl}`,
      );
    } else if (stripe) {
      lines.push(
        "",
        "Manage billing from the Stripe receipt email, or reopen Checkout from this tool after cancel.",
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

app.post("/mcp", async (req, res) => {
  const rawKey = extractBearerToken(req);
  let installation = null;
  if (rawKey) {
    installation = await getInstallationByApiKeyHash(hashApiKey(rawKey));
    if (!installation) {
      return res.status(401).json({ error: "Invalid API key" });
    }
  }

  // Pass-through auth, per @modelcontextprotocol/node's documented contract:
  // the transport never populates `req.auth` itself or verifies it — this
  // is a plain API key looked up in our own DB, not a real OAuth token, so
  // `token`/`clientId`/`scopes` are nominal and the actual data rides in
  // `extra`, which AuthInfo reserves for exactly this.
  req.auth = {
    token: rawKey || "",
    clientId: installation ? String(installation.installation_id) : "anonymous",
    scopes: [],
    extra: { installation },
  };

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const server = app.listen(port, () => {
  console.log(`spendtron running on port ${port}`);
});

module.exports = server;
