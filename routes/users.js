const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

/**
 * Verify Firebase ID token from Authorization header.
 */
async function verifyToken(req) {
  const auth = req.headers.authorization || '';
  const parts = auth.split(' ');
  if (parts[0] !== 'Bearer' || !parts[1]) throw new Error('Unauthorized');
  return await admin.auth().verifyIdToken(parts[1]);
}

/**
 * Create a user doc if it doesn't exist.
 */
router.post('/create', async (req, res) => {
  try {
    const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
    if (!token) return res.status(401).json({ error: 'no token' });
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const docRef = db.collection('users').doc(uid);
    const doc = await docRef.get();

    if (!doc.exists) {
      await docRef.set({
        uid,
        displayName: req.body.displayName || decoded.name || 'Anon',
        avatarUrl: req.body.avatarUrl || decoded.picture || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        bio: '',
        uniqueCode: uid.slice(0, 4).toUpperCase() + '-' + Math.floor(Math.random() * 9000 + 1000),
        pixelsDrawnAllTime: 0,
        freePixels: 100,
        playPoints: 0,
        lastPlacedAt: 0,
        isBanned: false,
        role: 'user'
      });
    }
    const userDoc = await docRef.get();
    res.json(userDoc.data());
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * Fetch profile by UID.
 */
router.get('/:uid', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.params.uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'not found' });
    res.json(doc.data());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed' });
  }
});

/**
 * Update bio (self only).
 */
router.post('/:uid/bio', async (req, res) => {
  try {
    const decoded = await verifyToken(req);
    if (decoded.uid !== req.params.uid) return res.status(403).json({ error: 'not allowed' });
    await db.collection('users').doc(req.params.uid).update({
      bio: req.body.bio || ''
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

/**
 * Update displayName or avatar (self only).
 */
router.post('/:uid/profile', async (req, res) => {
  try {
    const decoded = await verifyToken(req);
    if (decoded.uid !== req.params.uid) return res.status(403).json({ error: 'not allowed' });
    const update = {};
    if (req.body.displayName) update.displayName = req.body.displayName;
    if (req.body.avatarUrl) update.avatarUrl = req.body.avatarUrl;
    await db.collection('users').doc(req.params.uid).update(update);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

/**
 * Get current user’s stats (requires auth).
 */
router.get('/me/stats', async (req, res) => {
  try {
    const decoded = await verifyToken(req);
    const doc = await db.collection('users').doc(decoded.uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'not found' });
    const data = doc.data();
    res.json({
      pixelsDrawnAllTime: data.pixelsDrawnAllTime || 0,
      playPoints: data.playPoints || 0,
      freePixels: data.freePixels || 0,
      lastPlacedAt: data.lastPlacedAt || 0
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

/**
 * Search users by displayName or uniqueCode.
 */
router.get('/search/query', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json([]);
    const snap = await db.collection('users')
      .orderBy('displayName')
      .startAt(q)
      .endAt(q + '\uf8ff')
      .limit(20)
      .get();
    const out = [];
    snap.forEach(d => out.push(d.data()));
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed' });
  }
});

/**
 * Admin-only: delete user.
 */
router.delete('/:uid', async (req, res) => {
  try {
    const decoded = await verifyToken(req);
    const requester = await db.collection('users').doc(decoded.uid).get();
    if (!requester.exists || requester.data().role !== 'admin') {
      return res.status(403).json({ error: 'admin only' });
    }
    await db.collection('users').doc(req.params.uid).delete();
    await admin.auth().deleteUser(req.params.uid).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
