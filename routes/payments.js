// pixelcanvas_full/routes/payments.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "");

/**
 * POST /api/payments/create-session
 * Creates a Stripe Checkout session (subscription or one-time).
 * Requires Firebase ID token in Authorization header.
 */
router.post("/create-session", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const { priceId, successUrl, cancelUrl, mode } = req.body;
    if (!priceId) {
      return res.status(400).json({ error: "priceId is required" });
    }

    // Ensure mode is either subscription or payment (default = subscription)
    const checkoutMode =
      mode && mode.toLowerCase() === "payment" ? "payment" : "subscription";

    // Retrieve or create Stripe customer for this UID
    let userDoc = await db.collection("users").doc(uid).get();
    let customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: decoded.email || undefined,
        metadata: { uid },
      });
      customerId = customer.id;
      await db.collection("users").doc(uid).set(
        {
          stripeCustomerId: customerId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      mode: checkoutMode,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { uid, mode: checkoutMode },
      success_url: successUrl || `${req.headers.origin}/success`,
      cancel_url: cancelUrl || `${req.headers.origin}/cancel`,
    });

    return res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error("[Stripe Checkout Error]", e);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/payments/customer-portal
 * Returns a Stripe Billing Portal link for managing subscriptions.
 */
router.get("/customer-portal", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists || !userDoc.data().stripeCustomerId) {
      return res.status(400).json({ error: "User not linked to Stripe" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: userDoc.data().stripeCustomerId,
      return_url: req.headers.origin || "https://yourdomain.com/",
    });

    return res.json({ url: portalSession.url });
  } catch (e) {
    console.error("[Stripe Portal Error]", e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
