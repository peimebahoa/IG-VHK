// api/check-ig-username.js

export default async function handler(req, res) {
  const username = (req.query.username || "").toString().trim();

  if (!username) {
    res.status(400).json({ error: "username is required" });
    return;
  }

  // For now, just echo the username (test build works first)
  res.status(200).json({ ok: true, username });
}
