const crypto = require("crypto");

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (e) {
    return false;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(function (s) { return s.trim(); });
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf(name + "=") === 0) {
      return parts[i].slice((name + "=").length);
    }
  }
  return null;
}

function deny(res, code, message) {
  // Clear the state cookie on any terminal outcome.
  res.setHeader("Set-Cookie",
    "oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.statusCode = code;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

module.exports = async function handler(req, res) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const secret = process.env.SESSION_SECRET;

  if (!clientId || !clientSecret || !secret) {
    deny(res, 500,
      "Server not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and SESSION_SECRET.");
    return;
  }

  const query = req.query || {};
  const code = typeof query.code === "string" ? query.code : "";
  const state = typeof query.state === "string" ? query.state : "";

  // a. CSRF: the returned state must match the signed state cookie.
  const stateCookie = readCookie(req, "oauth_state");
  if (!code || !state || !stateCookie ||
      !timingSafeEqualString(state, stateCookie)) {
    deny(res, 403, "Invalid OAuth state.");
    return;
  }
  // And the nonce inside it must carry a valid signature.
  const segs = state.split(".");
  if (segs.length !== 2 ||
      !timingSafeEqualString(segs[1], sign(segs[0], secret))) {
    deny(res, 403, "Invalid OAuth state.");
    return;
  }

  // b. Exchange the code for an access token.
  let accessToken = "";
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "agent-admin"
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code
      })
    });
    const tokenJson = await tokenRes.json();
    accessToken = (tokenJson && tokenJson.access_token) || "";
  } catch (e) {
    deny(res, 502, "Token exchange failed.");
    return;
  }
  if (!accessToken) {
    deny(res, 502, "Token exchange returned no access token.");
    return;
  }

  // c. Fetch the GitHub user (login = username).
  let login = "";
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "agent-admin"
      }
    });
    if (!userRes.ok) {
      deny(res, 502, "Could not read GitHub user.");
      return;
    }
    const userJson = await userRes.json();
    login = (userJson && userJson.login) || "";
  } catch (e) {
    deny(res, 502, "Could not read GitHub user.");
    return;
  }
  if (!login) {
    deny(res, 502, "GitHub user had no login.");
    return;
  }

  // d. Allowlist check (case-insensitive). Falls back to AGENT_REPO_OWNER.
  const rawList =
    process.env.AUTHORIZED_GITHUB_USERS || process.env.AGENT_REPO_OWNER || "";
  const allowed = rawList
    .split(",")
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s.length > 0; });
  if (allowed.indexOf(login.toLowerCase()) === -1) {
    deny(res, 403, "This GitHub account is not authorized for this agent.");
    return;
  }

  // e. Mint the SAME session cookie format send/messages already verify:
  //    op_session=op.<issuedAt>.<expiresAt>.<hmac over the first three parts>.
  //    SameSite=Lax (not Strict) so the cookie survives the cross-site
  //    redirect back from github.com.
  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_MAX_AGE * 1000;
  const payload = `op.${issuedAt}.${expiresAt}`;
  const cookieValue = `${payload}.${sign(payload, secret)}`;

  const sessionCookie =
    `op_session=${cookieValue}` +
    "; Path=/" +
    "; HttpOnly" +
    "; Secure" +
    "; SameSite=Lax" +
    `; Max-Age=${COOKIE_MAX_AGE}`;

  // f. Clear the state cookie and redirect to the chat page.
  const clearState =
    "oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

  res.setHeader("Set-Cookie", [sessionCookie, clearState]);
  res.statusCode = 302;
  res.setHeader("Location", "/chat.html");
  res.end();
};
