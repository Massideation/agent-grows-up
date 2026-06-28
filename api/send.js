const crypto = require("crypto");

function verifyCookie(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(function (s) { return s.trim(); });
  let token = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf("op_session=") === 0) {
      token = parts[i].slice("op_session=".length);
      break;
    }
  }
  if (!token) return false;
  const segs = token.split(".");
  if (segs.length !== 4) return false;
  const payload = segs.slice(0, 3).join(".");
  const sig = segs[3];
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  let ok = false;
  try {
    ok = sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) {
    return false;
  }
  if (!ok) return false;
  const expiresAt = Number(segs[2]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (!verifyCookie(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not authenticated" }));
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const message = String(body.message || "").trim();
  if (!message) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "empty message" }));
    return;
  }
  if (message.length > 4096) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "message exceeds 4096 chars" }));
    return;
  }

  const pat = process.env.AGENT_REPO_PAT;
  const owner = process.env.AGENT_REPO_OWNER;
  const repo = process.env.AGENT_REPO_NAME || "agent-001";
  if (!pat || !owner) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "agent repo not configured" }));
    return;
  }

  const ts = Date.now();
  const path = `inbox/${ts}.md`;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const content = Buffer.from(message, "utf8").toString("base64");

  try {
    const ghRes = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "agent-admin",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `inbox: operator message ${ts}`,
        content: content
      })
    });
    if (!ghRes.ok) {
      const txt = await ghRes.text();
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "github write failed", detail: txt.slice(0, 400) }));
      return;
    }
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "github write errored: " + String(e.message || e) }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, id: String(ts) }));
};
