# PixelCanvas Full — Firebase + Stripe (Heroku-ready)

This repo is a starter full integration of a Wplace-like collaborative pixel board.
It includes an Express server (server.js), Firebase Admin (Firestore/auth) and Stripe
checkout + webhook example. Frontend is in /public.

## Setup (Heroku)
1. Create a Firebase project. Create a service account (JSON) and copy the JSON into an env var on Heroku:
   - Name: FIREBASE_SERVICE_ACCOUNT
   - Value: the full JSON **base64-encoded** (see instructions below)
2. Create a Stripe account and products/prices for the color packs and pixel packs. Set these env vars on Heroku:
   - STRIPE_SECRET_KEY
   - STRIPE_WEBHOOK_SECRET
   - STRIPE_PRICE_COLORS_60 (price ID)
   - STRIPE_PRICE_COLORS_120 (price ID)
   - STRIPE_PRICE_COLORS_ALL_MONTHLY (price ID)
   - STRIPE_PRICE_PIXELS_100 (price ID)
3. On Heroku set additional env var:
   - FIREBASE_PROJECT_ID (your project id)
4. Deploy:
   ```bash
   git init
   heroku create <app-name>
   git add .
   git commit -m "Initial"
   git push heroku main
   heroku config:set FIREBASE_SERVICE_ACCOUNT=$(base64 serviceAccountKey.json | tr -d '\n')
   ```
   (Alternatively set config vars with the Heroku dashboard.)

5. Open the app: `heroku open`

## Local development
- Create a `.env` file with the following keys (example):
  FIREBASE_SERVICE_ACCOUNT=<base64-encoded-JSON>
  FIREBASE_PROJECT_ID=your-project-id
  STRIPE_SECRET_KEY=sk_test_...
  STRIPE_WEBHOOK_SECRET=whsec_...

- Install deps and run:
  ```bash
  npm install
  npm start
  ```

## Notes
- Replace `public/firebase-config.js` contents with your Firebase client config for frontend auth.
- This project enforces important server-side checks (ID token verification, cooldown) but you should
  review and harden Firestore rules and server logic before production.
