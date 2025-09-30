// api/check-ig-username.ts
// Instagram Username Checker – Edge Runtime

export const config = { runtime: "edge" };

const IG_WEB_PROFILE =
  "https://i.instagram.com/api/v1/users/web_profile_info/?username=";

// Public app id used by Instagram web client
const IG_APP_ID = "936619743392459";

function isValidUsername(u: string) {
  if (!u) return false;
  if (u.length < 1 || u.length > 30) return false;
  if (!/^[a-z0-9._]+$/i.test(u)) return false;
  if (u.endsWith(".")) return false;
  if (u.includes("..")) return false;
  return true;
}

function json(data: unknown, init?: ResponseInit) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    // cache in Vercel edge for 60s; no browser cache
    "cache-control": "public, max-age=0, s-maxage=60"
  };
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...headers, ...(init?.headers || {}) }
  });
}

export default async function handler(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const username = (searchParams.get("username") || "").trim();

    if (!isValidUsername(username)) {
      return json(
        {
          error:
            "Invalid username. Use 1–30 chars: letters, numbers, underscores, dots (no trailing dot or double dots)."
        },
        { status: 400 }
      );
    }

    const url = IG_WEB_PROFILE + encodeURIComponent(username);

    const igRes = await fetch(url, {
      headers: {
        // these headers help IG return JSON rather than HTML
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "X-IG-App-ID": IG_APP_ID,
        "Accept-Language": "en-US,en;q=0.9"
      },
      redirect: "follow"
    });

    if (igRes.status === 404) {
      return json({ username, available: true, exists: false, reason: "not_found" });
    }

    if (igRes.status === 429) {
      return json(
        {
          username,
          available: null,
          exists: null,
          error: "Rate limited by Instagram. Try again later."
        },
        { status: 429 }
      );
    }

    if (!igRes.ok) {
      return json(
        {
          username,
          available: null,
          exists: null,
          error: `Upstream error ${igRes.status}`
        },
        { status: 502 }
      );
    }

    let body: any;
    try {
      body = await igRes.json();
    } catch {
      return json(
        { username, available: null, exists: null, error: "Non-JSON response from Instagram." },
        { status: 502 }
      );
    }

    const user = body?.data?.user ?? null;

    if (!user) {
      return json({ username, available: true, exists: false });
    }

    // Optional: simple “fake follower” heuristic signals
    const followers = user.edge_followed_by?.count ?? 0;
    const following = user.edge_follow?.count ?? 0;
    const ratio = followers > 0 ? following / followers : null;
    const signals = {
      ratio,
      suspicious:
        (followers === 0 && following > 0) ||
        (ratio !== null && ratio > 3) ||
        (!user.profile_pic_url_hd && !user.profile_pic_url)
    };

    return json({
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
        profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url
      },
      signals
    });
  } catch (err: any) {
    return json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
