const crypto = require("crypto");

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const expected = process.env.OPERATOR_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!expected || !secret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "server not configured" }));
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const submitted = String(body.password || "");
  if (submitted.length === 0 || submitted.length > 1024) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid" }));
    return;
  }

  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  const equal = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!equal) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "invalid" }));
    return;
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + 7 * 24 * 60 * 60 * 1000;
  const payload = `op.${issuedAt}.${expiresAt}`;
  const sig = sign(payload, secret);
  const cookieValue = `${payload}.${sig}`;

  const cookie =
    `op_session=${cookieValue}` +
    "; Path=/" +
    "; HttpOnly" +
    "; Secure" +
    "; SameSite=Strict" +
    `; Max-Age=${7 * 24 * 60 * 60}`;

  res.setHeader("Set-Cookie", cookie);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
};
