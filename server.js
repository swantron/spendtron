const express = require("express");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const Stripe = require("stripe");
const { McpServer } = require("@modelcontextprotocol/server");
const { NodeStreamableHTTPServerTransport } = require("@modelcontextprotocol/node");

const { auditActionsCost } = require("./lib/auditActions");
const { generateApiKey, hashApiKey, extractBearerToken } = require("./lib/auth");
const { createSubscribeCheckoutUrl } = require("./lib/billing");
const {
  getInstallationByApiKeyHash,
  createInstallation,
  markFreeTrialUsed,
  getSubscriptionStatus,
  upsertSubscription,
} = require("./lib/installations");

const app = express();
const port = process.env.PORT || 8080;

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "spendtron";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:8080";

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

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", service: "spendtron" });
});

app.get("/ready", (req, res) => {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return res.status(503).json({ status: "not ready", error: "GitHub App not configured" });
  }
  res.status(200).json({ status: "ready", service: "spendtron" });
});

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<title>spendtron</title>
<h1>spendtron</h1>
<p>Ranks a GitHub org's Actions workflows by real compute cost. One free audit per org, then $99/mo.</p>
<p><a href="/github/install">Connect GitHub</a></p>`);
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
    const { data: installation } = await appOctokit().rest.apps.getInstallation({
      installation_id: installationId,
    });
    const accountLogin = installation.account.login;

    const rawApiKey = generateApiKey();
    await createInstallation({
      installationId,
      accountLogin,
      apiKeyHash: hashApiKey(rawApiKey),
    });

    const subscribeUrl = stripe
      ? await createSubscribeCheckoutUrl(stripe, installationId, APP_BASE_URL)
      : "#stripe-not-configured";

    res.type("html").send(`<!doctype html>
<title>spendtron — connected</title>
<h1>Connected to ${accountLogin}</h1>
<p>Your API key (shown once — save it now):</p>
<pre>${rawApiKey}</pre>
<p>Add it as a bearer token in your MCP client's config for <code>${req.protocol}://${req.get("host")}/mcp</code>.</p>
<p>Your first <code>check_actions_cost</code> call is free. After that: <a href="${subscribeUrl}">subscribe, $99/mo</a>.</p>`);
  } catch (err) {
    console.error("GitHub callback error:", err);
    res.status(500).send("Could not complete installation.");
  }
});

/** Stripe needs the raw body for signature verification — mounted before
 * the express.json() body would otherwise consume it, using its own
 * raw parser scoped to just this route. */
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

    const sub = event.data.object;
    const installationId = Number(sub.metadata?.installationId);

    if (installationId && ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      await upsertSubscription({
        installationId,
        stripeCustomerId: sub.customer,
        stripeSubscriptionId: sub.id,
        status: sub.status,
      });
    }

    res.json({ received: true });
  },
);

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
      throw new Error("Not authenticated — connect at /github/install and use your API key.");
    }

    const alreadyTrialed = Boolean(installation.free_trial_used_at);
    const subscriptionStatus = await getSubscriptionStatus(installation.installation_id);
    const subscribed = subscriptionStatus === "active";

    if (!subscribed && alreadyTrialed) {
      const subscribeUrl = await createSubscribeCheckoutUrl(stripe, installation.installation_id, APP_BASE_URL);
      return {
        content: [{
          type: "text",
          text: `Your free audit's been used. Subscribe ($99/mo) to keep auditing: ${subscribeUrl}`,
        }],
      };
    }
    if (!subscribed) {
      await markFreeTrialUsed(installation.installation_id);
    }

    const octokit = installationOctokit(installation.installation_id);
    const result = await auditActionsCost(octokit);

    const lines = [
      `Sampled ${result.sampledRuns} recent runs. Fleet total: ~${result.totalBillMinutes} bill-minutes (~$${result.totalCostUsd}/period at private Ubuntu rates).`,
      "",
      "Top workflows by compute:",
      ...result.topWorkflows.map(
        (w) => `- ${w.workflow}: ${w.billMinutes} min, ${w.runs} runs, avg ${w.avgSeconds}s, ~$${w.costUsd}`,
      ),
      "",
      "Top repos by compute:",
      ...result.topRepos.map((r) => `- ${r.repo}: ${r.billMinutes} min, ${r.runs} runs, ~$${r.costUsd}`),
    ];

    if (!subscribed) {
      const subscribeUrl = await createSubscribeCheckoutUrl(stripe, installation.installation_id, APP_BASE_URL);
      lines.push("", `That was your free audit. Subscribe ($99/mo) for ongoing audits: ${subscribeUrl}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

app.post("/mcp", async (req, res) => {
  const rawKey = extractBearerToken(req);
  let installation = null;
  if (rawKey) {
    installation = await getInstallationByApiKeyHash(hashApiKey(rawKey));
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
