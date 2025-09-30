// api/check-ig-username.js
// Real Instagram username checker (Node.js serverless on Vercel)

const IG_WEB_PROFILE =
  "https://i.instagram.com/api/v1/users/web_profile_info/?username=";
// Public App ID used by instagram.com web client
const IG_APP_ID = "936619743392459";

// Basic (close-to-IG) validation
function isValidUsername(u) {
  if (!u) return false;
  if (u.length < 1 || u.length > 30) return false;
  if (!/^[a-z0-9._]+$/i.test(u)) return false;
  if (u.endsWith(".")) return false;
  if (u.includes("..")) return false;
  return true;
}

function setCORS(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function setJSON(res, status = 200, cacheEdgeSeconds = 60) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Edge cache for 60s; no browser cache
  res.setHeader("cache-control", `public, max-age=0, s-maxage=${cacheEdgeSeconds}`);
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    setJSON(res, 405);
    res.json({ error: "Method not allowed. Use GET with ?username=<name>." });
    return;
  }

  const username = (req.query.username || "").toString().trim();

  if (!isValidUsername(username)) {
    setJSON(res, 400);
    res.json({
      error:
        "Invalid username. Use 1–30 chars: letters, numbers, underscores, dots (no trailing dot or double dots).",
    });
    return;
  }

  try {
    const igRes = await fetch(IG_WEB_PROFILE + encodeURIComponent(username), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "X-IG-App-ID": IG_APP_ID,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    // Common upstream cases
    if (igRes.status === 404) {
      setJSON(res, 200);
      res.json({ username, available: true, exists: false, reason: "not_found" });
      return;
    }
    if (igRes.status === 429) {
      setJSON(res, 429, 0);
      res.json({
        username,
        available: null,
        exists: null,
        error: "Rate limited by Instagram. Try again later.",
      });
      return;
    }
    if (!igRes.ok) {
      setJSON(res, 502, 0);
      res.json({
        username,
        available: null,
        exists: null,
        error: `Upstream error ${igRes.status}`,
      });
      return;
    }

    let body;
    try {
      body = await igRes.json();
    } catch {
      setJSON(res, 502, 0);
      res.json({
        username,
        available: null,
        exists: null,
        error: "Non-JSON response from Instagram.",
      });
      return;
    }

    const user = body?.data?.user ?? null;

    if (!user) {
      setJSON(res, 200);
      res.json({ username, available: true, exists: false });
      return;
    }

    // Extract and compute simple quality signals
    const followers = user.edge_followed_by?.count ?? 0;
    const following = user.edge_follow?.count ?? 0;
    const ratio = followers > 0 ? following / followers : null;
    const signals = {
      ratio,
      suspicious:
        (followers === 0 && following > 0) ||
        (ratio !== null && ratio > 3) ||
        (!user.profile_pic_url_hd && !user.profile_pic_url),
    };

    setJSON(res, 200);
    res.json({
      username,
      available: false,
      exists: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        is_private: user.is_private,
        is_verified: user.is_verified,
        followers,
        following,
        profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url,
      },
      signals,
    });
  } catch (e) {
    setJSON(res, 500, 0);
    res.json({ error: e?.message || "Unknown error" });
  }
}
