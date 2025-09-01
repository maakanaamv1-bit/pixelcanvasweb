// pixelcanvas_full/routes/leaderboard.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();

/**
 * GET /api/leaderboard/top?range=today|month|year&limit=50
 * Reads from pre-aggregated stats collections:
 *   statsAgg (daily), statsAggMonth, statsAggYear
 */
router.get("/top", async (req, res) => {
  try {
    const range = (req.query.range || "today").toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100); // max 100

    let collectionName = null;
    let docId = null;

    const now = new Date();

    if (range === "today") {
      collectionName = "statsAgg"; // daily aggregation
      docId = now.toISOString().slice(0, 10); // YYYY-MM-DD
    } else if (range === "month") {
      collectionName = "statsAggMonth";
      docId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    } else if (range === "year") {
      collectionName = "statsAggYear";
      docId = String(now.getUTCFullYear());
    } else {
      return res.status(400).json({ error: "Invalid range" });
    }

    // Fetch aggregated stats
    const doc = await db.collection(collectionName).doc(docId).get();
    if (!doc.exists) {
      return res.json([]); // no stats yet
    }

    const data = doc.data() || {};

    // Convert object { uid: count } → array
    const arr = Object.keys(data)
      .map((uid) => ({ uid, count: data[uid] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    if (arr.length === 0) {
      return res.json([]);
    }

    // Batch fetch user displayNames
    const userRefs = arr.map((r) => db.collection("users").doc(r.uid));
    const userDocs = await db.getAll(...userRefs);

    const out = arr.map((r, idx) => {
      const uDoc = userDocs[idx];
      const displayName =
        uDoc && uDoc.exists && uDoc.data().displayName
          ? uDoc.data().displayName
          : r.uid;
      return { uid: r.uid, name: displayName, count: r.count };
    });

    return res.json(out);
  } catch (e) {
    console.error("[Leaderboard Error]", e);
    return res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

module.exports = router;
