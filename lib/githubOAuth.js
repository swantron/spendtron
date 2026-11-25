/**
 * Confirms the browser that came back from GitHub's setup URL is a user who
 * can manage that installation. The setup URL's installation_id is unsigned;
 * GitHub's own docs say to ignore it until a user access token lists it.
 */

function nextInstallationsUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      if (url.protocol !== "https:" || url.hostname !== "api.github.com") return null;
      return url.toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function exchangeUserAccessToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
  if (redirectUri) params.set("redirect_uri", redirectUri);

  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error || "GitHub OAuth exchange failed");
    err.status = res.status;
    throw err;
  }
  return data.access_token;
}

/** Every installation of this app the signed-in user can manage. */
async function listUserInstallationIds(userToken, fetchImpl = fetch) {
  const ids = [];
  let url = "https://api.github.com/user/installations?per_page=100";
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "spendtron",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const err = new Error(`GitHub installations lookup failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    for (const installation of data.installations || []) ids.push(Number(installation.id));
    const link = typeof res.headers?.get === "function" ? res.headers.get("link") : null;
    url = nextInstallationsUrl(link);
  }
  return ids;
}

async function userCanAccessInstallation(userToken, installationId, fetchImpl = fetch) {
  const ids = await listUserInstallationIds(userToken, fetchImpl);
  return ids.includes(Number(installationId));
}

module.exports = {
  exchangeUserAccessToken,
  userCanAccessInstallation,
  listUserInstallationIds,
  nextInstallationsUrl,
};
