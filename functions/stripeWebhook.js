// pixelcanvas_full/functions/stripeWebhook.js
// Stripe webhook handler - Express route

const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app = express();

// Raw body for Stripe verification
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle checkout completions
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.metadata && session.metadata.uid;

      if (!uid) {
        console.error('⚠️ Missing UID in session metadata');
        return res.json({ received: true });
      }

      try {
        const db = admin.firestore();

        // Extract purchased price IDs (can be multiple)
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 10 }
        );

        for (const item of lineItems.data) {
          const priceId = item.price.id;

          if (priceId === process.env.STRIPE_PRICE_COLORS_60) {
            await db.collection('users').doc(uid).update({
              colorPack: 'plus60',
            });
            console.log(`✅ Granted +60 colors to ${uid}`);
          } else if (priceId === process.env.STRIPE_PRICE_COLORS_120) {
            await db.collection('users').doc(uid).update({
              colorPack: 'plus120',
            });
            console.log(`✅ Granted +120 colors to ${uid}`);
          } else if (priceId === process.env.STRIPE_PRICE_COLORS_ALL_MONTHLY) {
            await db.collection('users').doc(uid).update({
              colorPack: 'all',
              subscriptionActive: true,
              subscriptionStarted: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`✅ Started ALL-COLORS subscription for ${uid}`);
          } else if (priceId === process.env.STRIPE_PRICE_PIXELS_100) {
            await db.collection('users').doc(uid).update({
              availablePixels: admin.firestore.FieldValue.increment(100),
            });
            console.log(`✅ Granted +100 pixels to ${uid}`);
          } else {
            console.warn(`⚠️ Unknown priceId ${priceId} for ${uid}`);
          }
        }
      } catch (err) {
        console.error('❌ Firestore update error:', err.message);
      }
    }

    // Handle subscription cancellations
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const uid = subscription.metadata && subscription.metadata.uid;

      if (uid) {
        try {
          const db = admin.firestore();
          await db.collection('users').doc(uid).update({
            subscriptionActive: false,
          });
          console.log(`⚠️ Subscription cancelled for ${uid}`);
        } catch (err) {
          console.error('❌ Failed to update subscription cancel:', err.message);
        }
      }
    }

    res.json({ received: true });
  }
);

module.exports = app;
