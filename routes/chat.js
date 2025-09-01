// pixelcanvas_full/routes/chat.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();

/**
 * Utility: sanitize text input to avoid XSS / injection
 */
function sanitizeText(str) {
  if (!str) return "";
  return String(str)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim()
    .slice(0, 500); // cap message length
}

/**
 * GET /api/chat/recent
 * Returns the most recent 200 chat messages in ascending order
 */
router.get("/recent", async (req, res) => {
  try {
    const snap = await db
      .collection("chats")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const out = [];
    snap.forEach((doc) => {
      const data = doc.data();
      out.push({
        id: doc.id,
        from: data.from || "unknown",
        fromName: data.fromName || "anon",
        text: data.text || "",
        createdAt: data.createdAt ? data.createdAt.toDate() : null,
      });
    });

    // reverse for chronological order
    return res.json(out.reverse());
  } catch (e) {
    console.error("[Chat Recent Error]", e);
    return res.status(500).json({ error: "Failed to load chat history" });
  }
});

/**
 * POST /api/chat/send
 * Requires Authorization: Bearer <idToken>
 * Body: { text }
 */
router.post("/send", async (req, res) => {
  try {
    const token = req.headers.authorization
      ? req.headers.authorization.split(" ")[1]
      : null;
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Validate & sanitize input
    const rawText = req.body.text;
    const text = sanitizeText(rawText);
    if (!text) return res.status(400).json({ error: "Empty message" });

    const payload = {
      from: decoded.uid,
      fromName:
        decoded.name ||
        decoded.displayName ||
        decoded.email ||
        "anon",
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection("chats").add(payload);

    // Optional: emit via Socket.IO (if integrated in server.js)
    if (req.io) {
      req.io.emit("chatMessage", { id: ref.id, ...payload });
    }

    return res.json({ success: true, id: ref.id });
  } catch (e) {
    console.error("[Chat Send Error]", e);
    return res.status(400).json({ error: e.message });
  }
});

module.exports = router;
