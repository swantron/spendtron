const path = require("path");
const express = require("express");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const Stripe = require("stripe");
const { McpServer } = require("@modelcontextprotocol/server");
const {
  NodeStreamableHTTPServerTransport,
} = require("@modelcontextprotocol/node");

const {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
  makeRotateToken,
  verifyRotateToken,
  makeOAuthState,
  oauthStateMatches,
  readCookie,
  stateCookieHeader,
  makeReportToken,
  readReportToken,
  reportCookieHeader,
  makeChooseToken,
  readChooseToken,
  STATE_COOKIE,
  REPORT_COOKIE,
  CHOOSE_COOKIE,
} = require("./lib/auth");
const {
  exchangeUserAccessToken,
  userCanAccessInstallation,
  listUserInstallationIds,
} = require("./lib/githubOAuth");
const { createPortalUrl, applyStripeEvent } = require("./lib/billing");
const {
  getInstallationByApiKeyHash,
  getInstallationByInstallationId,
  createInstallation,
  rotateApiKey,
  upsertSubscription,
  markFixesUnlocked,
  getAuditReport,
  saveAuditReport,
  revokeInstallation,
  activeInstallations,
} = require("./lib/installations");
const { buildReport } = require("./lib/buildReport");
const { formatAuditText } = require("./lib/formatAudit");
const { auditUsageCsv } = require("./lib/usageCsv");
const { auditFormPage, csvReportPage, reportPage } = require("./lib/pages");
const { browserBundle } = require("./lib/browserBundle");
const { openFixPullRequests } = require("./lib/openFixPr");
const { verifyGithubWebhook } = require("./lib/githubWebhook");

const app = express();
// Cloud Run terminates TLS and forwards over plain HTTP with
// X-Forwarded-Proto: https — without this, req.protocol reads "http" and
// every generated URL (MCP endpoint shown post-install, Stripe return URLs)
// is wrong.
app.set("trust proxy", true);
const port = process.env.PORT || 8080;

const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;
const GITHUB_APP_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET;
const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "spendtron-app";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:8080";
const ROTATE_SECRET = GITHUB_APP_PRIVATE_KEY || "spendtron-dev-rotate";

function oauthConfigured() {
  return Boolean(GITHUB_APP_CLIENT_ID && GITHUB_APP_CLIENT_SECRET);
}

function callbackUrl(req) {
  return `${req.protocol}://${req.get("host")}/github/callback`;
}

function appendCookie(res, cookie) {
  const previous = res.getHeader("Set-Cookie");
  const list = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  res.setHeader("Set-Cookie", [...list, cookie]);
}

function setStateCookie(req, res, state, maxAge = 600) {
  appendCookie(res, stateCookieHeader(state, { secure: req.protocol === "https", maxAge }));
}

function setReportCookie(req, res, installationId) {
  const token = makeReportToken(installationId, ROTATE_SECRET, { kind: "session" });
  appendCookie(
    res,
    reportCookieHeader(token, { secure: req.protocol === "https", maxAge: 7 * 24 * 60 * 60 }),
  );
  return token;
}

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
      await applyStripeEvent(stripe, event, { upsertSubscription, markFixesUnlocked });
    } catch (err) {
      console.error("Stripe event apply failed:", err);
      return res.status(500).send("Webhook handler failed");
    }

    res.json({ received: true });
  },
);

app.post(
  "/github/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send("GitHub webhook secret not configured");
    if (!verifyGithubWebhook(req.body, req.headers["x-hub-signature-256"], secret)) {
      return res.status(401).send("Invalid signature");
    }
    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }
    const name = req.headers["x-github-event"];
    // Only "deleted". A suspension can be lifted, and GitHub already
    // refuses installation tokens while it lasts.
    if (name === "installation" && event.action === "deleted" && event.installation?.id) {
      try {
        await revokeInstallation(event.installation.id, hashApiKey(generateApiKey()));
      } catch (err) {
        console.error("installation delete failed:", err);
        return res.status(500).send("Webhook handler failed");
      }
    }
    res.json({ ok: true });
  },
);

app.use(express.json({ limit: "1mb" }));
// The /audit form parses the export in the browser. This limit only covers
// the no-JavaScript fallback post.
app.use(express.urlencoded({ extended: false, limit: "20mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", service: "spendtron" });
});

app.get("/ready", (req, res) => {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY || !oauthConfigured()) {
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

const AUDIT_JS = browserBundle();
app.get("/audit.js", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("application/javascript").send(AUDIT_JS);
});

app.get("/audit", (req, res) => {
  res.type("html").send(auditFormPage());
});

app.post("/audit", (req, res) => {
  const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
  const report = auditUsageCsv(csv);
  res.setHeader("Cache-Control", "private, no-store");
  if (report.error) {
    return res.status(400).type("html").send(auditFormPage({ error: report.error }));
  }
  res.type("html").send(csvReportPage(report));
});

/**
 * The cookie must hold a session token to open pull requests. A share token
 * is read-only wherever it is presented, including in a forged cookie.
 */
function reportAccess(req) {
  const cookie = readReportToken(readCookie(req, REPORT_COOKIE), ROTATE_SECRET, { kind: "session" });
  const shareOpts = { kind: "share" };
  const query = readReportToken(typeof req.query.token === "string" ? req.query.token : "", ROTATE_SECRET, shareOpts);
  const body = readReportToken(typeof req.body?.token === "string" ? req.body.token : "", ROTATE_SECRET, shareOpts);
  if (cookie) return { installationId: cookie.installationId, canOpenPrs: true };
  if (query) return { installationId: query.installationId, canOpenPrs: false };
  if (body) return { installationId: body.installationId, canOpenPrs: false };
  return null;
}

async function loadReport(installationId, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await getAuditReport(installationId);
    if (cached) return cached;
  }
  const report = await buildReport(installationOctokit(installationId));
  await saveAuditReport(installationId, report);
  return { report, computedAt: report.generatedAt, stale: false };
}

app.get("/report", async (req, res) => {
  const access = reportAccess(req);
  if (!access) return res.redirect("/login");
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const cached = await loadReport(access.installationId);
    res.type("html").send(
      reportPage({
        report: cached.report,
        stale: cached.stale,
        canOpenPrs: access.canOpenPrs,
        refreshToken: access.canOpenPrs ? "" : String(req.query.token || ""),
      }),
    );
  } catch (err) {
    console.error("report error:", err);
    res.status(500).type("html").send(reportPage({ error: "The GitHub sample failed. Try the billing export, which does not call the API." }));
  }
});

app.post("/report/refresh", async (req, res) => {
  const access = reportAccess(req);
  if (!access) {
    return res.status(403).send("Sign in at /login from this browser to refresh the sample.");
  }
  try {
    await loadReport(access.installationId, { refresh: true });
    if (access.canOpenPrs) return res.redirect("/report");
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    res.redirect(`/report?token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error("refresh error:", err);
    res.status(500).type("html").send(reportPage({ error: "Refresh failed before a new sample was saved." }));
  }
});

app.post("/report/prs", async (req, res) => {
  const access = reportAccess(req);
  if (!access || !access.canOpenPrs) {
    return res.status(403).send("Sign in at /login from this browser to open pull requests.");
  }
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const cached = await loadReport(access.installationId);
    const prResult = await openFixPullRequests(
      installationOctokit(access.installationId),
      cached.report,
    );
    res.type("html").send(
      reportPage({
        report: cached.report,
        stale: cached.stale,
        canOpenPrs: true,
        prResult,
      }),
    );
  } catch (err) {
    console.error("pull request error:", err);
    res.status(500).type("html").send(reportPage({ error: "Could not open pull requests." }));
  }
});

function oauthNotConfigured(res) {
  return res.status(503).type("html").send(
    connectedPage({
      title: "GitHub sign-in is not configured",
      bodyHtml: `<p>This host is missing the GitHub App OAuth client id and secret, so it will not issue or rotate API keys.</p>`,
    }),
  );
}

function startOAuth(req, res, installationId) {
  const state = makeOAuthState(installationId, ROTATE_SECRET);
  setStateCookie(req, res, state);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", GITHUB_APP_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackUrl(req));
  authorize.searchParams.set("state", state);
  res.redirect(authorize.toString());
}

/** Installation id 0 in the OAuth state means "sign in", not "install". */
const LOGIN_STATE_ID = 0;

/** Returning users: sign in with GitHub, then land on the saved report. */
app.get("/login", (req, res) => {
  if (!oauthConfigured()) return oauthNotConfigured(res);
  startOAuth(req, res, LOGIN_STATE_ID);
});

app.get("/login/choose", (req, res) => {
  const allowed = readChooseToken(readCookie(req, CHOOSE_COOKIE), ROTATE_SECRET);
  const installationId = Number(req.query.installation_id);
  if (!allowed || !allowed.includes(installationId)) {
    return res.redirect("/login");
  }
  appendCookie(res, `${CHOOSE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/login; Max-Age=0`);
  setReportCookie(req, res, installationId);
  res.redirect("/report");
});

async function finishLogin(req, res, userToken) {
  const ids = await listUserInstallationIds(userToken);
  const rows = await activeInstallations(ids);
  if (rows.length === 0) {
    return res.type("html").send(
      connectedPage({
        title: "No spendtron install on this account",
        bodyHtml: `<p>None of the GitHub accounts you manage has spendtron installed. <a href="/github/install">Install the GitHub App</a>, or <a href="/audit">paste a billing export</a>, which needs no install.</p>`,
      }),
    );
  }
  if (rows.length === 1) {
    setReportCookie(req, res, Number(rows[0].installation_id));
    return res.redirect("/report");
  }
  const token = makeChooseToken(rows.map((row) => row.installation_id), ROTATE_SECRET);
  appendCookie(
    res,
    `${CHOOSE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/login; Max-Age=600${req.protocol === "https" ? "; Secure" : ""}`,
  );
  const links = rows
    .map(
      (row) =>
        `<li><a href="/login/choose?installation_id=${Number(row.installation_id)}">${escapeHtml(row.account_login)}</a></li>`,
    )
    .join("");
  return res.type("html").send(
    connectedPage({ title: "Pick an account", bodyHtml: `<ul>${links}</ul>` }),
  );
}

/** Start of the install flow — GitHub's own installation UI handles repo
 * selection; this just points at it. The callback refuses to mint a key
 * until the installing user completes OAuth. */
app.get("/github/install", (req, res) => {
  if (!oauthConfigured()) return oauthNotConfigured(res);
  res.redirect(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`);
});

/**
 * Two hops land here. GitHub's setup URL arrives with an unsigned
 * installation_id; we only stash that id into a signed state cookie and
 * send the browser through the App's OAuth flow. The second hop brings
 * back code + state, and a key is issued only if that user's installations
 * include the id.
 */
app.get("/github/callback", async (req, res) => {
  if (!oauthConfigured()) return oauthNotConfigured(res);

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (code) return finishAuthorizedInstall(req, res, code);
  if (typeof req.query.error === "string") {
    return res
      .status(403)
      .send("GitHub sign-in was declined. Start again from /github/install.");
  }

  const installationId = Number(req.query.installation_id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return res.status(400).send("Missing installation_id.");
  }

  startOAuth(req, res, installationId);
});

async function finishAuthorizedInstall(req, res, code) {
  const stateQuery = typeof req.query.state === "string" ? req.query.state : "";
  const parsed = oauthStateMatches(
    stateQuery,
    readCookie(req, STATE_COOKIE),
    ROTATE_SECRET,
  );
  setStateCookie(req, res, "", 0);
  if (!parsed) {
    return res
      .status(403)
      .send("Invalid or expired GitHub sign-in. Start again from /github/install.");
  }

  const installationId = parsed.installationId;
  try {
    const userToken = await exchangeUserAccessToken({
      clientId: GITHUB_APP_CLIENT_ID,
      clientSecret: GITHUB_APP_CLIENT_SECRET,
      code,
      redirectUri: callbackUrl(req),
    });
    if (installationId === LOGIN_STATE_ID) return await finishLogin(req, res, userToken);
    const allowed = await userCanAccessInstallation(userToken, installationId);
    if (!allowed) {
      return res
        .status(403)
        .send("That GitHub account cannot manage this installation.");
    }

    const { data: installation } = await appOctokit().rest.apps.getInstallation({
      installation_id: installationId,
    });
    const accountLogin = installation.account.login;
    const host = `${req.protocol}://${req.get("host")}`;

    const existing = await getInstallationByInstallationId(installationId);
    if (existing && existing.uninstalled_at) {
      // Reinstalled after an uninstall revoked the old key.
      const rawApiKey = generateApiKey();
      await rotateApiKey(installationId, hashApiKey(rawApiKey));
      setReportCookie(req, res, installationId);
      return res.type("html").send(
        connectedPage({
          title: `Reconnected to ${accountLogin}`,
          bodyHtml: `<p><a href="/report">Open the chart</a>. The key from before the uninstall no longer works. Your new API key (shown once — save it now):</p>
<pre>${escapeHtml(rawApiKey)}</pre>
<p>Bearer token for <code>${escapeHtml(host)}/mcp</code>.</p>`,
        }),
      );
    }
    if (existing) {
      setReportCookie(req, res, installationId);
      const rotateToken = makeRotateToken(installationId, ROTATE_SECRET);
      return res.type("html").send(
        connectedPage({
          title: `Already connected to ${accountLogin}`,
          bodyHtml: `<p><a href="/report">Open the chart</a>. The sample prices each job at its runner's current rate. Pull requests for the safe edits are on that page.</p>
<p>This GitHub org is already set up. Your existing API key still works. If you lost it, <a href="/github/rotate?installation_id=${installationId}&amp;token=${encodeURIComponent(rotateToken)}">issue a new one</a>. The link expires in 15 minutes.</p>
<p>MCP, after a report has been saved: <code>${escapeHtml(host)}/mcp</code></p>`,
        }),
      );
    }

    const rawApiKey = generateApiKey();
    await createInstallation({
      installationId,
      accountLogin,
      apiKeyHash: hashApiKey(rawApiKey),
    });
    setReportCookie(req, res, installationId);

    return res.type("html").send(
      connectedPage({
        title: `Connected to ${accountLogin}`,
        bodyHtml: `<p><a href="/report">Open the chart</a>. That page runs the sample and can open pull requests. The API key below is only for MCP, and MCP reads the saved report.</p>
<p>Your API key (shown once — save it now):</p>
<pre>${escapeHtml(rawApiKey)}</pre>
<p>Bearer token for <code>${escapeHtml(host)}/mcp</code>.</p>`,
      }),
    );
  } catch (err) {
    console.error("GitHub callback error:", err.message);
    res.status(500).send("Could not complete installation.");
  }
}

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
      "Reads the saved spendtron report for this API key: workflows priced per job at current GitHub runner rates, plus corroborated workflow changes. Does not scan GitHub itself. Open /report to build or refresh the sample.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (ctx) => {
    const installation = ctx.http?.authInfo?.extra?.installation;
    if (!installation) {
      throw new Error(
        "Not authenticated — connect at /github/install and use your API key.",
      );
    }

    const cached = await getAuditReport(installation.installation_id);
    const token = makeReportToken(installation.installation_id, ROTATE_SECRET, { kind: "share" });
    const reportUrl = `${APP_BASE_URL}/report?token=${encodeURIComponent(token)}`;
    const text = formatAuditText(cached && cached.report, {
      reportUrl,
      stale: Boolean(cached && cached.stale),
    });
    return { content: [{ type: "text", text }] };
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
