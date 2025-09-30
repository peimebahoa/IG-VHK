// api/check-ig-username.js
// Robust Instagram username checker with retries & fallbacks (Node serverless on Vercel)

const IG_APP_ID = "936619743392459";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  res.setHeader("cache-control", `public, max-age=0, s-maxage=${cacheEdgeSeconds}`);
}

// ---- helpers -----------------------------------------------------------

async function fetchIGWebProfile(username) {
  // Primary endpoint (i.instagram.com) – sometimes returns 400/403 when picky about headers.
  const url1 = "https://i.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(username);
  const h = {
    "User-Agent": UA,
    "X-IG-App-ID": IG_APP_ID,
    "Accept-Language": "en-US,en;q=0.9",
    // Extra hints to look like a browser request:
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Referer": "https://www.instagram.com/"
  };
  const r1 = await fetch(url1, { headers: h, redirect: "follow" });
  return { res: r1, source: "i.instagram.com web_profile_info" };
}

async function fetchIGWebProfileAlt(username) {
  // Alt endpoint (www.instagram.com). Behaves similarly but sometimes works when i. fails.
  const url2 = "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(username);
  const h = {
    "User-Agent": UA,
    "X-IG-App-ID": IG_APP_ID,
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.instagram.com/"
  };
  const r2 = await fetch(url2, { headers: h, redirect: "follow" });
  return { res: r2, source: "www.instagram.com web_profile_info" };
}

async function fetchIGPublicProfilePage(username) {
  // Final fallback: public profile HTML page.
  // 404 here is a strong signal the username is free.
  const pageUrl = "https://www.instagram.com/" + encodeURIComponent(username) + "/";
  const r3 = await fetch(pageUrl, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.instagram.com/"
    },
    redirect: "follow"
  });
  return { res: r3, source: "public profile page" };
}

function buildSignalsFromUser(user) {
  const followers = user?.edge_followed_by?.count ?? 0;
  const following = user?.edge_follow?.count ?? 0;
  const ratio = followers > 0 ? following / followers : null;

  return {
    followers,
    following,
    ratio,
    suspicious:
      (followers === 0 && following > 0) ||
      (ratio !== null && ratio > 3) ||
      (!user?.profile_pic_url_hd && !user?.profile_pic_url)
  };
}

async function parseIGJSON(resp) {
  // Parse JSON body safely. Throws on bad JSON to allow caller to handle.
  const data = await resp.json();
  const user = data?.data?.user ?? null;
  return user;
}

// ---- main handler ------------------------------------------------------

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    setJSON(res, 405);
    return res.json({ error: "Method not allowed. Use GET with ?username=<name>." });
  }

  const username = (req.query.username || "").toString().trim();
  if (!isValidUsername(username)) {
    setJSON(res, 400);
    return res.json({
      error:
        "Invalid username. Use 1–30 chars: letters, numbers, underscores, dots (no trailing dot or double dots)."
    });
  }

  // Try primary → retry once on 400/403 → alternate endpoint → fallback HTML page
  try {
    // 1) Primary
    let { res: r1, source: s1 } = await fetchIGWebProfile(username);

    if (r1.status === 404) {
      setJSON(res, 200);
      return res.json({ username, available: true, exists: false, reason: "not_found", via: s1 });
    }
    if (r1.status === 429) {
      setJSON(res, 429, 0);
      return res.json({ username, available: null, exists: null, error: "Rate limited by Instagram.", via: s1 });
    }
    if (r1.status === 400 || r1.status === 403) {
      // Small backoff then retry once (helps when IG is temperamental)
      await new Promise(r => setTimeout(r, 250));
      ({ res: r1, source: s1 } = await fetchIGWebProfile(username));
    }

    if (r1.ok) {
      try {
        const user = await parseIGJSON(r1);
        if (!user) {
          setJSON(res, 200);
          return res.json({ username, available: true, exists: false, via: s1 });
        }
        const signals = buildSignalsFromUser(user);
        setJSON(res, 200);
        return res.json({
          username,
          available: false,
          exists: true,
          user: {
            id: user.id,
            full_name: user.full_name,
            is_private: user.is_private,
            is_verified: user.is_verified,
            followers: signals.followers,
            following: signals.following,
            profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url
          },
          signals,
          via: s1
        });
      } catch {
        // fall through to alt
      }
    }

    // 2) Alternate endpoint
    const { res: r2, source: s2 } = await fetchIGWebProfileAlt(username);

    if (r2.status === 404) {
      setJSON(res, 200);
      return res.json({ username, available: true, exists: false, reason: "not_found", via: s2 });
    }
    if (r2.status === 429) {
      setJSON(res, 429, 0);
      return res.json({ username, available: null, exists: null, error: "Rate limited by Instagram.", via: s2 });
    }
    if (r2.ok) {
      try {
        const user = await parseIGJSON(r2);
        if (!user) {
          setJSON(res, 200);
          return res.json({ username, available: true, exists: false, via: s2 });
        }
        const signals = buildSignalsFromUser(user);
        setJSON(res, 200);
        return res.json({
          username,
          available: false,
          exists: true,
          user: {
            id: user.id,
            full_name: user.full_name,
            is_private: user.is_private,
            is_verified: user.is_verified,
            followers: signals.followers,
            following: signals.following,
            profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url
          },
          signals,
          via: s2
        });
      } catch {
        // fall through to HTML fallback
      }
    }

    // 3) Public profile HTML page (status-based heuristic)
    const { res: r3, source: s3 } = await fetchIGPublicProfilePage(username);

    if (r3.status === 404) {
      setJSON(res, 200);
      return res.json({ username, available: true, exists: false, reason: "not_found", via: s3 });
    }
    if (r3.ok) {
      // If we get a generic 200 login-wall, we can’t extract JSON here without a session,
      // but 200 strongly suggests the username exists (unless IG changed behavior).
      setJSON(res, 200);
      return res.json({
        username,
        available: false,
        exists: true,
        confidence: "low",
        note: "Determined via public page status (HTML).",
        via: s3
      });
    }

    // If all failed with non-OK and not 404/429:
    setJSON(res, 502, 0);
    return res.json({
      username,
      available: null,
      exists: null,
      error: `Upstream error ${r3.status}`,
      via: s3
    });
  } catch (e) {
    setJSON(res, 500, 0);
    return res.json({ error: e?.message || "Unknown error" });
  }
}
