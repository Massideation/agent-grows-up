const crypto = require("crypto");

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function siteOrigin(req) {
  const proto =
    (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.SESSION_SECRET;

  if (!clientId || !secret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "Server not configured for login. Set GITHUB_CLIENT_ID and SESSION_SECRET as Vercel env vars."
    }));
    return;
  }

  // CSRF nonce: random hex, signed, and mirrored into a short-lived cookie.
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = sign(nonce, secret);
  const state = `${nonce}.${sig}`;

  const stateCookie =
    `oauth_state=${state}` +
    "; Path=/" +
    "; HttpOnly" +
    "; Secure" +
    "; SameSite=Lax" +
    "; Max-Age=600";

  const redirectUri = `${siteOrigin(req)}/api/auth/callback`;

  const authorizeUrl =
    "https://github.com/login/oauth/authorize" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent("read:user")}` +
    `&state=${encodeURIComponent(state)}` +
    "&allow_signup=false";

  res.setHeader("Set-Cookie", stateCookie);
  res.statusCode = 302;
  res.setHeader("Location", authorizeUrl);
  res.end();
};
