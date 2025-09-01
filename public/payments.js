<<<<<<< HEAD
// payments.js - Client-side Stripe Checkout integration for PixelCanvas
// Handles token retrieval, plan selection, and redirect to Stripe Checkout

// Ensure Stripe.js is loaded in the HTML before using this script
// <script src="https://js.stripe.com/v3/"></script>

const stripe = Stripe(window.STRIPE_PUBLISHABLE_KEY || ''); // injected via backend template or env
const payButtons = document.querySelectorAll('.pay-btn');
const statusBox = document.getElementById('payment-status');
const socket = io();

// Utility: Get Firebase auth token (if logged in)
async function getAuthToken() {
  if (!window.firebase || !firebase.auth) return null;
  const user = firebase.auth().currentUser;
  if (!user) return null;
  return await user.getIdToken();
}

// Show status to user
function setStatus(msg, isError = false) {
  if (!statusBox) return;
  statusBox.textContent = msg;
  statusBox.style.color = isError ? 'red' : 'lime';
}

// Handle Stripe checkout
async function startCheckout(planId) {
  try {
    setStatus('Preparing checkout...');
    const token = await getAuthToken();

    const res = await fetch('/api/payments/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ planId }),
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status}`);
    }

    const data = await res.json();
    if (!data.id) throw new Error('Invalid response from server.');

    // Redirect to Stripe Checkout
    const { error } = await stripe.redirectToCheckout({ sessionId: data.id });
    if (error) throw error;
  } catch (err) {
    console.error(err);
    setStatus(`Payment failed: ${err.message}`, true);
  }
}

// Attach click events to plan buttons
payButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const planId = btn.dataset.plan;
    if (!planId) {
      setStatus('Plan not found.', true);
      return;
    }
    startCheckout(planId);
  });
});

// Listen for successful payment notifications via Socket.IO
socket.on('paymentSuccess', (data) => {
  if (data && data.userId) {
    setStatus(`✅ Payment successful! Welcome premium user #${data.userId}`);
  }
});

// Auto-check URL for Stripe success/cancel redirects
(function handleReturnFromStripe() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('success')) {
    setStatus('✅ Payment completed successfully!');
    // Optionally trigger backend call to refresh user status
  } else if (urlParams.get('canceled')) {
    setStatus('❌ Payment canceled.', true);
  }
})();
=======
// payments.js - Client-side Stripe Checkout integration for PixelCanvas
// Handles token retrieval, plan selection, and redirect to Stripe Checkout

// Ensure Stripe.js is loaded in the HTML before using this script
// <script src="https://js.stripe.com/v3/"></script>

const stripe = Stripe(window.STRIPE_PUBLISHABLE_KEY || ''); // injected via backend template or env
const payButtons = document.querySelectorAll('.pay-btn');
const statusBox = document.getElementById('payment-status');
const socket = io();

// Utility: Get Firebase auth token (if logged in)
async function getAuthToken() {
  if (!window.firebase || !firebase.auth) return null;
  const user = firebase.auth().currentUser;
  if (!user) return null;
  return await user.getIdToken();
}

// Show status to user
function setStatus(msg, isError = false) {
  if (!statusBox) return;
  statusBox.textContent = msg;
  statusBox.style.color = isError ? 'red' : 'lime';
}

// Handle Stripe checkout
async function startCheckout(planId) {
  try {
    setStatus('Preparing checkout...');
    const token = await getAuthToken();

    const res = await fetch('/api/payments/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ planId }),
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status}`);
    }

    const data = await res.json();
    if (!data.id) throw new Error('Invalid response from server.');

    // Redirect to Stripe Checkout
    const { error } = await stripe.redirectToCheckout({ sessionId: data.id });
    if (error) throw error;
  } catch (err) {
    console.error(err);
    setStatus(`Payment failed: ${err.message}`, true);
  }
}

// Attach click events to plan buttons
payButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const planId = btn.dataset.plan;
    if (!planId) {
      setStatus('Plan not found.', true);
      return;
    }
    startCheckout(planId);
  });
});

// Listen for successful payment notifications via Socket.IO
socket.on('paymentSuccess', (data) => {
  if (data && data.userId) {
    setStatus(`✅ Payment successful! Welcome premium user #${data.userId}`);
  }
});

// Auto-check URL for Stripe success/cancel redirects
(function handleReturnFromStripe() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('success')) {
    setStatus('✅ Payment completed successfully!');
    // Optionally trigger backend call to refresh user status
  } else if (urlParams.get('canceled')) {
    setStatus('❌ Payment canceled.', true);
  }
})();
>>>>>>> e07027fe (Add compression to dependencies)
