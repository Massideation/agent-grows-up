const crypto = require("crypto");

const MIN_PASSWORD_LEN = 12;
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function constantTimeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const stored = process.env.OPERATOR_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!stored || !secret || stored.length < MIN_PASSWORD_LEN) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "Server not configured for login. Set OPERATOR_PASSWORD (12+ chars) and SESSION_SECRET as Vercel env vars."
    }));
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const password = body.password;

  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid credentials" }));
    return;
  }

  if (!constantTimeEqualString(password, stored)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid credentials" }));
    return;
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_MAX_AGE * 1000;
  const payload = `op.${issuedAt}.${expiresAt}`;
  const sig = sign(payload, secret);
  const cookieValue = `${payload}.${sig}`;

  const cookie =
    `op_session=${cookieValue}` +
    "; Path=/" +
    "; HttpOnly" +
    "; Secure" +
    "; SameSite=Strict" +
    `; Max-Age=${COOKIE_MAX_AGE}`;

  res.setHeader("Set-Cookie", cookie);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
};
