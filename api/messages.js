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

async function ghJson(url, pat) {
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "agent-admin"
    }
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error("github " + r.status);
  }
  return r.json();
}

async function listDir(owner, repo, dir, pat) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dir}`;
  const data = await ghJson(url, pat);
  if (!Array.isArray(data)) return [];
  return data.filter(function (e) { return e.type === "file"; });
}

function decode(b64) {
  return Buffer.from(b64 || "", "base64").toString("utf8");
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
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

  const pat = process.env.AGENT_REPO_PAT;
  const owner = process.env.AGENT_REPO_OWNER;
  const repo = process.env.AGENT_REPO_NAME || "agent-001";
  if (!pat || !owner) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "agent repo not configured" }));
    return;
  }

  const items = [];

  try {
    const inboxFiles = await listDir(owner, repo, "inbox", pat);
    const processedFiles = await listDir(owner, repo, "inbox/processed", pat);
    const replyFiles = await listDir(owner, repo, "messages", pat);

    function add(file, from) {
      const name = file.name || "";
      let id = name.replace(/\.md$/, "");
      if (from === "agent") {
        id = id.replace(/-reply$/, "");
      }
      const ts = Number(id);
      if (!Number.isFinite(ts)) return;
      items.push({
        id: id,
        ts: ts,
        from: from,
        downloadUrl: file.download_url,
        sha: file.sha
      });
    }

    inboxFiles.forEach(function (f) { add(f, "operator"); });
    processedFiles.forEach(function (f) { add(f, "operator"); });
    replyFiles
      .filter(function (f) { return /-reply\.md$/.test(f.name || ""); })
      .forEach(function (f) { add(f, "agent"); });

    items.sort(function (a, b) { return a.ts - b.ts; });
    const recent = items.slice(-50);

    const fetched = await Promise.all(recent.map(async function (it) {
      try {
        const url =
          `https://api.github.com/repos/${owner}/${repo}/contents/` +
          (it.from === "agent"
            ? `messages/${it.id}-reply.md`
            : `inbox/${it.id}.md`);
        let data = await ghJson(url, pat);
        if (data === null && it.from === "operator") {
          const altUrl =
            `https://api.github.com/repos/${owner}/${repo}/contents/inbox/processed/${it.id}.md`;
          data = await ghJson(altUrl, pat);
        }
        const text = data && data.content ? decode(data.content) : "";
        return { id: it.id, ts: it.ts, from: it.from, text: text };
      } catch (e) {
        return { id: it.id, ts: it.ts, from: it.from, text: "" };
      }
    }));

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messages: fetched }));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "github read failed: " + String(e.message || e) }));
  }
};
