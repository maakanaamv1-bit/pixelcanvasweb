// server.js -- Render-ready Express + Socket.IO + Firebase Admin + Stripe webhook
'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Trust proxy (Render is behind proxy)
app.set('trust proxy', 1);

// Security + common middleware
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(compression());
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate limiter for /api
const apiLimiter = rateLimit({
  windowMs: 15 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// ---------- Firebase Admin init ----------
const admin = require('firebase-admin');
(function initFirebaseAdmin() {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.warn('[WARN] FIREBASE_SERVICE_ACCOUNT not set. Attempting default credentials.');
      admin.initializeApp();
    } else {
      // Decode Base64 if necessary (safer for Render env variables)
      const saJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
      const sa = JSON.parse(saJson);
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: process.env.FIREBASE_PROJECT_ID || sa.project_id,
      });
    }
    console.log('[OK] Firebase Admin initialized');
  } catch (err) {
    console.error('[FATAL] Firebase Admin init failed:', err.message);
    process.exit(1); // Stop if Firebase fails
  }
})();
const db = admin.firestore();

// ---------- Stripe ----------
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

// ---------- Expose safe public env ----------
app.get('/env.js', (_req, res) => {
  const publicEnv = {
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || '',
    FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || '',
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
    FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || '',
    FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || '',
    FIREBASE_MEASUREMENT_ID: process.env.FIREBASE_MEASUREMENT_ID || '',
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || '',
    STRIPE_PRICE_COLORS_60: process.env.STRIPE_PRICE_COLORS_60 || '',
    STRIPE_PRICE_COLORS_120: process.env.STRIPE_PRICE_COLORS_120 || '',
    STRIPE_PRICE_COLORS_ALL_MONTHLY: process.env.STRIPE_PRICE_COLORS_ALL_MONTHLY || '',
    STRIPE_PRICE_PIXELS_100: process.env.STRIPE_PRICE_PIXELS_100 || '',
    APP_CHECK_KEY: process.env.APP_CHECK_KEY || ''
  };
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.env = ${JSON.stringify(publicEnv)};`);
});

// ---------- Stripe Webhook ----------
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(400).send('Webhook secret not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session?.metadata?.uid;
        const priceId = session?.line_items?.data?.[0]?.price?.id || session?.metadata?.priceId || null;
        if (uid) {
          const updates = { lastPurchaseAt: admin.firestore.FieldValue.serverTimestamp() };
          if (priceId === process.env.STRIPE_PRICE_COLORS_60) updates.colorPack = 'plus60';
          if (priceId === process.env.STRIPE_PRICE_COLORS_120) updates.colorPack = 'plus120';
          if (priceId === process.env.STRIPE_PRICE_COLORS_ALL_MONTHLY) {
            updates.colorPack = 'all';
            updates.colorPackExpiry = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000);
          }
          if (priceId === process.env.STRIPE_PRICE_PIXELS_100) updates.freePixels = admin.firestore.FieldValue.increment(100);
          await db.collection('users').doc(uid).set(updates, { merge: true });
          console.log('[Stripe] granted entitlements to', uid, updates);
        }
        break;
      }
      case 'invoice.payment_succeeded': break;
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const custId = sub.customer;
        if (custId) {
          const q = await db.collection('users').where('stripeCustomerId', '==', custId).limit(1).get();
          if (!q.empty) {
            const doc = q.docs[0];
            await doc.ref.set({ colorPack: 'free', colorPackExpiry: null }, { merge: true });
            console.log('[Stripe] downgraded user', doc.id);
          }
        }
        break;
      }
      default: console.log('[Stripe] unhandled event type', event.type);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe webhook handler error]', err);
    res.status(500).send('Webhook handler error');
  }
});

// ---------- JSON body parser ----------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Static files ----------
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath, { maxAge: '1h' }));

// ---------- API routes ----------
function tryMountRoute(routePath, mountAt) {
  try {
    const r = require(routePath);
    app.use(mountAt, r);
    console.log(`[OK] mounted ${routePath} -> ${mountAt}`);
  } catch (err) {
    console.warn(`[WARN] route not mounted (${routePath}):`, err.message);
  }
}

tryMountRoute('./routes/pixels', '/api/pixels');
tryMountRoute('./routes/users', '/api/users');
tryMountRoute('./routes/leaderboard', '/api/leaderboard');
tryMountRoute('./routes/chat', '/api/chat');
tryMountRoute('./routes/payments', '/api/payments');

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  socket.on('placePixel', (data) => io.emit('pixelPlaced', data));
  socket.on('sendMessage', (msg) => io.emit('chatMessage', msg));
  socket.on('typing', (t) => io.emit('typing', t));
  socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
});

// Graceful shutdown
function shutdown() {
  console.log('Shutdown initiated');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('Forcing shutdown');
    process.exit(1);
  }, 10000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = { app, server, io, admin, db };
