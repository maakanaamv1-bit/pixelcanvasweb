// pixelcanvas_full/routes/pixels.js
// Production-ready pixels API with server-side validation, cooldowns, aggregates, and Socket.IO broadcast.

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

// CONFIG
const GRID_LIMIT = 10000; // logical board: 0 .. GRID_LIMIT-1
const COOLDOWN_MS = 10000; // 10 seconds default cooldown per user (server enforced)
const MAX_COLOR_LENGTH = 7; // '#RRGGBB'
const MAX_PIXEL_BATCH = 2000; // limit for box queries

// Utility: verify Firebase ID token (Authorization: Bearer <idToken>)
async function verifyToken(req) {
  const auth = req.headers.authorization || '';
  const parts = auth.split(' ');
  if (parts[0] !== 'Bearer' || !parts[1]) throw new Error('Unauthorized');
  const decoded = await admin.auth().verifyIdToken(parts[1]);
  return decoded;
}

// Utility: validate integer coordinate within board bounds
function validateCoord(n) {
  if (typeof n !== 'number') return false;
  if (!Number.isFinite(n)) return false;
  if (!Number.isInteger(n)) return false;
  if (n < 0 || n >= GRID_LIMIT) return false;
  return true;
}

// Utility: validate color string e.g. #aabbcc
function isHexColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s) && s.length === MAX_COLOR_LENGTH;
}

// Helper: safe numeric parse
function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * POST /api/pixels/place
 * Body: { x: number, y: number, color: "#rrggbb" }
 * Auth: required (Firebase ID token in Authorization header)
 *
 * Server-side logic:
 * - verify token
 * - validate x,y,color
 * - check user's cooldown (lastPlacedAt stored on user doc in ms)
 * - check user freePixels/playPoints and decrement appropriately (transaction)
 * - write pixel doc at id `${x}_${y}` with color, owner, filledAt
 * - update aggregates: statsAgg (daily), statsAggMonth, statsAggYear
 * - broadcast via Socket.IO (if server exposes io)
 */
router.post('/place', async (req, res) => {
  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    // validate payload
    const { x, y, color } = req.body;
    if (!validateCoord(x) || !validateCoord(y)) {
      return res.status(400).json({ success: false, error: 'Invalid coordinates' });
    }
    if (!isHexColor(color)) {
      return res.status(400).json({ success: false, error: 'Invalid color format. Use #RRGGBB' });
    }

    const userRef = db.collection('users').doc(uid);
    const pxRef = db.collection('pixels').doc(`${x}_${y}`);

    // Transaction: enforce cooldown + deduct resources + write pixel + update aggregates
    const result = await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) throw new Error('User not found');

      const user = uSnap.data();

      // cooldown check: lastPlacedAt in ms
      const nowMs = Date.now();
      const lastPlaced = user.lastPlacedAt || 0;
      if (nowMs - lastPlaced < COOLDOWN_MS) {
        const wait = COOLDOWN_MS - (nowMs - lastPlaced);
        throw Object.assign(new Error('Cooldown'), { code: 'COOLDOWN', waitMs: wait });
      }

      // Check resource: prefer freePixels, fall back to playPoints
      const free = Number(user.freePixels || 0);
      const points = Number(user.playPoints || 0);

      if (free <= 0 && points <= 0) {
        throw Object.assign(new Error('No free pixels or play points available'), { code: 'NO_PIXELS' });
      }

      // Optional: enforce allowedColors if present on user doc (array of hex strings)
      if (user.allowedColors && Array.isArray(user.allowedColors) && user.colorPack !== 'all') {
        const allowed = user.allowedColors.map((c) => (typeof c === 'string' ? c.toLowerCase() : c));
        if (!allowed.includes(color.toLowerCase())) {
          throw Object.assign(new Error('Color locked by your plan'), { code: 'COLOR_LOCKED' });
        }
      }

      // Write pixel doc (merge to allow storing metadata later)
      const pixelData = {
        x,
        y,
        color,
        owner: uid,
        ownerName: user.displayName || user.email || 'anon',
        filledAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(pxRef, pixelData, { merge: true });

      // Update user counters: decrement freePixels or playPoints, increment totals, set lastPlacedAt
      const updates = {};
      if (free > 0) updates.freePixels = admin.firestore.FieldValue.increment(-1);
      else updates.playPoints = admin.firestore.FieldValue.increment(-1);

      updates.pixelsDrawnAllTime = admin.firestore.FieldValue.increment(1);
      updates.lastPlacedAt = nowMs;
      updates.playPoints = updates.playPoints || admin.firestore.FieldValue.increment(0); // ensure field present

      tx.update(userRef, updates);

      // Update aggregates: daily, monthly, yearly
      const dt = new Date(nowMs);
      const dayId = dt.toISOString().slice(0, 10); // YYYY-MM-DD
      const monthId = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; // YYYY-MM
      const yearId = `${dt.getUTCFullYear()}`; // YYYY

      const dailyRef = db.collection('statsAgg').doc(dayId);
      const monthlyRef = db.collection('statsAggMonth').doc(monthId);
      const yearlyRef = db.collection('statsAggYear').doc(yearId);

      tx.set(dailyRef, { [uid]: admin.firestore.FieldValue.increment(1) }, { merge: true });
      tx.set(monthlyRef, { [uid]: admin.firestore.FieldValue.increment(1) }, { merge: true });
      tx.set(yearlyRef, { [uid]: admin.firestore.FieldValue.increment(1) }, { merge: true });

      return { cooldownUntil: nowMs + COOLDOWN_MS };
    });

    // Broadcast via Socket.IO if server exposes io (server.js exports io)
    try {
      const srv = require('../server');
      if (srv && srv.io && typeof srv.io.emit === 'function') {
        srv.io.emit('pixelPlaced', { x, y, color, owner: uid });
      }
    } catch (err) {
      // non-fatal
      console.warn('Socket broadcast failed:', err && err.message);
    }

    return res.json({ success: true, cooldownUntil: result.cooldownUntil });
  } catch (err) {
    // Structured error responses
    if (err && err.code === 'COOLDOWN') {
      return res.status(429).json({ success: false, error: 'Cooldown', waitMs: err.waitMs || COOLDOWN_MS });
    }
    if (err && err.code === 'NO_PIXELS') {
      return res.status(402).json({ success: false, error: 'No free pixels or play points' });
    }
    if (err && err.code === 'COLOR_LOCKED') {
      return res.status(403).json({ success: false, error: 'Color locked by your plan' });
    }
    console.error('[Pixels Place Error]', err && (err.stack || err.message || err));
    return res.status(400).json({ success: false, error: err && err.message ? err.message : 'Failed to place pixel' });
  }
});

/**
 * GET /api/pixels/box?left=&top=&right=&bottom=&limit=
 * Returns pixel docs inside an axis-aligned bounding box.
 * NOTE: This is a naive implementation using inequality queries on 'x' only and then filtering by 'y'.
 * For production-scale boards, switch to tiled documents (e.g., store 256x256 tiles) to allow efficient queries.
 */
router.get('/box', async (req, res) => {
  try {
    const left = toInt(req.query.left, 0);
    const top = toInt(req.query.top, 0);
    const right = toInt(req.query.right, left + 100);
    const bottom = toInt(req.query.bottom, top + 100);
    const limit = Math.min(toInt(req.query.limit, 1000), MAX_PIXEL_BATCH);

    // bounding sanity
    if (!validateCoord(left) && left !== 0) return res.status(400).json({ error: 'Invalid left' });
    if (!validateCoord(right) && right !== GRID_LIMIT - 1) return res.status(400).json({ error: 'Invalid right' });
    if (!validateCoord(top) && top !== 0) return res.status(400).json({ error: 'Invalid top' });
    if (!validateCoord(bottom) && bottom !== GRID_LIMIT - 1) return res.status(400).json({ error: 'Invalid bottom' });
    if (right - left > 2000 || bottom - top > 2000) return res.status(400).json({ error: 'Box too large' });

    // Firestore: query by x range (single inequality field) then filter by y in memory (note: may require pagination)
    const snap = await db.collection('pixels')
      .where('x', '>=', left)
      .where('x', '<=', right)
      .limit(limit)
      .get();

    const out = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.y >= top && d.y <= bottom) out.push(d);
    });

    return res.json(out);
  } catch (err) {
    console.error('[Pixels Box Error]', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'Failed to fetch pixels' });
  }
});

module.exports = router;
