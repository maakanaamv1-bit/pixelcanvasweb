// pixelcanvas_full/public/firebase-config.js
// -----------------------------------------
// PUBLIC Firebase config for client-side SDK
// IMPORTANT: Never include private service account keys here.
// Backend uses FIREBASE_SERVICE_ACCOUNT env var (base64 JSON).

// --- Dynamic Config Loader ---
// In production (Heroku), config can be injected via meta tags or window.env.
// For local dev, fallback to placeholders below.
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

(function loadFirebaseConfig() {
  if (!window.firebaseConfig) {
    window.firebaseConfig = {
      apiKey: window?.env?.FIREBASE_API_KEY || "AIzaSyA_A5iZ9seMg7ZWT35IHCkRAB4eA7ypGPI",
      authDomain: window?.env?.FIREBASE_AUTH_DOMAIN || "pixelcanvas-808ff.firebaseapp.com",
      projectId: window?.env?.FIREBASE_PROJECT_ID || "pixelcanvas-808ff",
      storageBucket: window?.env?.FIREBASE_STORAGE_BUCKET || "pixelcanvas-808ff.firebasestorage.app",
      messagingSenderId: window?.env?.FIREBASE_MESSAGING_SENDER_ID || "797850387625",
      appId: window?.env?.FIREBASE_APP_ID || "1:797850387625:web:6580ed63a73efee01055b8",
      measurementId: window?.env?.FIREBASE_MEASUREMENT_ID || "G-W9KC8YN54H" // optional
    };
  }
})();

// --- Optional App Check (reCAPTCHA v3 or hCaptcha) ---
// Add <meta name="firebase-app-check-key" content="PUBLIC_SITE_KEY"> in index.html if enabled.
window.enableAppCheck = function(firebase) {
  try {
    const key = document.querySelector('meta[name="firebase-app-check-key"]')?.content;
    if (key) {
      const { initializeAppCheck, ReCaptchaV3Provider } = firebase.appCheck;
      initializeAppCheck(firebase.getApp(), {
        provider: new ReCaptchaV3Provider(key),
        isTokenAutoRefreshEnabled: true
      });
      console.log("App Check enabled with reCAPTCHA v3");
    } else {
      console.warn("App Check not configured. Add <meta name='firebase-app-check-key'> to enable.");
    }
  } catch (err) {
    console.error("App Check init failed:", err);
  }
};

// --- Optional Firebase Analytics ---
window.enableAnalytics = function(firebase) {
  try {
    if ("measurementId" in window.firebaseConfig) {
      const analytics = firebase.analytics();
      console.log("Firebase Analytics enabled");
      return analytics;
    }
  } catch (err) {
    console.warn("Analytics not available:", err);
  }
  return null;
};

// --- Optional Firebase Cloud Messaging (FCM) ---
window.enableMessaging = function(firebase) {
  try {
    const messaging = firebase.messaging();
    console.log("Firebase Cloud Messaging ready");
    return messaging;
  } catch (err) {
    console.warn("Messaging not available:", err);
  }
  return null;
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);