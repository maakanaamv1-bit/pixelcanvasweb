// pixelcanvas_full/server.js
// Express + Socket.IO + Firebase Admin + Stripe + Security + Webhook (raw body) + Healthy defaults

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

// --- Create app + server + socket ---
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --- Trust proxy (Heroku) ---
app.set('trust proxy', 1);

// --- Security & perf middleware ---
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors());
app.use(compression());
app.use(cookieParser());

// --- Logging ---
const LOG_FORMAT = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(LOG_FORMAT));

// --- Firebase Admin initialization ---
const admin = require('firebase-admin');

(function initFirebaseAdmin() {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.warn('[WARN] FIREBASE_SERVICE_ACCOUNT not set; attempting default credentials.');
      admin.initializeApp();
    } else {
      const sa = JSON.parse(
        Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
      );
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: process.env.FIREBASE_PROJECT_ID || sa.project_id,
      });
    }
    console.log('[OK] Firebase Admin initialized');
  } catch (err) {
    console.error('[FATAL] Failed to initialize Firebase Admin:', err.message);
    process.exit(1);
  }
})();
const db = admin.firestore();

// --- Stripe init ---
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = require('stripe')(stripeSecret);

// --- Attach io/admin to req for routes that broadcast or need admin ---
app.use((req, _res, next) => {
  req.io = io;
  req.admin = admin;
  req.db = db;
  next();
});

// --- Health check & basic info ---
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/version', (_req, res) => res.json({ name: 'pixelcanvas_full', version: '1.0.0' }));

// --- A tiny rate limiter for public APIs (tune as needed) ---
const apiLimiter = rateLimit({
  windowMs: 15 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// --- Serve static frontend ---
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders: (res) => {
    // Prevent indexing by search engines if desired during early stages:
    // res.setHeader('X-Robots-Tag', 'noindex');
  }
}));

// --- /env.js: expose *non-secret* public config to the browser ---
// Do NOT add secrets here. Only safe/public values.
app.get('/env.js', (_req, res) => {
  const publicEnv = {
    // Firebase public config (frontend)
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'REPLACE_ME_API_KEY',
    FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || 'REPLACE_ME.firebaseapp.com',
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'REPLACE_ME_PROJECT_ID',
    FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || 'REPLACE_ME.appspot.com',
    FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '000000000000',
    FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || '1:000000000000:web:xxxxxxxxxxxx',
    FIREBASE_MEASUREMENT_ID: process.env.FIREBASE_MEASUREMENT_ID || undefined,

    // Stripe price IDs (public SKUs ok to expose)
    STRIPE_PRICE_COLORS_60: process.env.STRIPE_PRICE_COLORS_60 || '',
    STRIPE_PRICE_COLORS_120: process.env.STRIPE_PRICE_COLORS_120 || '',
    STRIPE_PRICE_COLORS_ALL_MONTHLY: process.env.STRIPE_PRICE_COLORS_ALL_MONTHLY || '',
    STRIPE_PRICE_PIXELS_100: process.env.STRIPE_PRICE_PIXELS_100 || '',

    // Optional App Check site key
    APP_CHECK_KEY: process.env.APP_CHECK_KEY || '',
  };
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.env = ${JSON.stringify(publicEnv)};`);
});

// --- Body parsers for regular JSON endpoints (do this BEFORE routes, AFTER webhook raw route definition below) ---
const jsonParser = express.json({ limit: '1mb' });
const urlencodedParser = express.urlencoded({ extended: true });

// --- Stripe webhook: must use raw body! Mount BEFORE json parser ---
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not set');
    }
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle event types
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session?.metadata?.uid;
        // Map price IDs to entitlements
        const lineItems = session?.display_items || session?.line_items || null;
        const priceId = session?.items?.data?.[0]?.price?.id
          || session?.line_items?.[0]?.price?.id
          || session?.metadata?.priceId
          || null;

        if (uid) {
          const userRef = db.collection('users').doc(uid);
          const updates = {
            // generic marker that something was purchased
            lastPurchaseAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          // Grant entitlements by price id
          if (priceId) {
            if (priceId === process.env.STRIPE_PRICE_COLORS_60) {
              updates.colorPack = 'plus60';
              // Could also set allowedColors array on user doc server-side
            } else if (priceId === process.env.STRIPE_PRICE_COLORS_120) {
              updates.colorPack = 'plus120';
            } else if (priceId === process.env.STRIPE_PRICE_COLORS_ALL_MONTHLY) {
              updates.colorPack = 'all';
              updates.colorPackExpiry = admin.firestore.Timestamp.fromMillis(
                Date.now() + 28 * 24 * 60 * 60 * 1000
              );
            } else if (priceId === process.env.STRIPE_PRICE_PIXELS_100) {
              updates.freePixels = admin.firestore.FieldValue.increment(100);
            }
          }

          await userRef.set(updates, { merge: true });
          console.log(`[Stripe Webhook] Granted entitlements for ${uid}`, updates);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        // subscription renewal hook (extend expiry, etc.)
        break;
      }
      case 'customer.subscription.deleted': {
        // downgrade entitlements if 'all' plan expired
        const sub = event.data.object;
        const custId = sub.customer;
        if (custId) {
          // find users with stripeCustomerId == custId
          const q = await db.collection('users').where('stripeCustomerId', '==', custId).limit(1).get();
          if (!q.empty) {
            const doc = q.docs[0];
            await doc.ref.set({ colorPack: 'free', colorPackExpiry: null }, { merge: true });
            console.log('[Stripe Webhook] Downgraded user after subscription canceled:', doc.id);
          }
        }
        break;
      }
      default:
        // Log unhandled events quietly
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook Handler Error]', err);
    res.status(500).send('Webhook handler failed');
  }
});

// --- Regular body parsers for all other routes (must be AFTER webhook raw) ---
app.use(jsonParser);
app.use(urlencodedParser);

// --- Routes ---
const pixelsRoute = require('./routes/pixels');
const usersRoute = require('./routes/users');
const leaderboardRoute = require('./routes/leaderboard');
const chatRoute = require('./routes/chat');
const paymentsRoute = require('./routes/payments');

app.use('/api/pixels', pixelsRoute);
app.use('/api/users', usersRoute);
app.use('/api/leaderboard', leaderboardRoute);
app.use('/api/chat', chatRoute);
app.use('/api/payments', paymentsRoute);

// --- Fallback to index.html for single-page app routes (optional) ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 404 handler (after all routes/static) ---
app.use((req, res, _next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not Found' });
  }
  // For unknown non-API routes, return index to let client handle 404s (SPA style)
  return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Centralized error handler ---
app.use((err, _req, res, _next) => {
  console.error('[Express Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Server Error' });
});

// --- Socket.IO events ---
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Example relay events (client may emit; server rebroadcasts)
  socket.on('placePixel', (data) => {
    io.emit('pixelPlaced', data);
  });
  socket.on('sendMessage', (msg) => {
    io.emit('chatMessage', msg);
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

// --- Graceful shutdown ---
function shutdown(sig) {
  console.log(`[${sig}] Graceful shutdown starting...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('Forcing shutdown…');
    process.exit(1);
  }, 10_000);
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));

// --- Start server ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = { app, io, admin, db, server };
