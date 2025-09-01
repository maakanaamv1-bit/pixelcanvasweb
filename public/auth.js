<<<<<<< HEAD
// public/auth.js
// Firebase Auth helper for PixelCanvas (compat SDK)
// - Supports Google sign-in, sign-out
// - Ensures user record exists via POST /api/users/create
// - Exposes helpers: getIdToken(), callAuthFetch(), isSignedIn(), currentUser()
// - Wires basic UI elements: #btnProfile, #panelProfile, #btnLogout, #userName, #userAvatar, #freeCount
// - Use with firebase-config.js that sets window.firebaseConfig or /env.js (window.env)

(function () {
  // Safety: require firebase compat to be loaded
  if (typeof firebase === 'undefined' || !firebase.auth) {
    console.error('Firebase compat SDK not loaded. Make sure firebase-auth-compat.js is included before auth.js');
    return;
  }

  // DOM elements
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userInfo = document.getElementById("user-info");

  // Initialize Firebase app if not already initialized (firebase-config.js should set window.firebaseConfig)
  const app = firebase.initializeApp(window.firebaseConfig);
  const auth = firebase.getAuth(app);

  
  // Logout
  logoutBtn.addEventListener("click", async () => {
    await firebase.signOut(auth);
    userInfo.textContent = "";
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
  });

  // Auth state persistence
  firebase.onAuthStateChanged(auth, (user) => {
    if (user) {
      userInfo.textContent = `Hello, ${user.displayName}`;
      loginBtn.style.display = "none";
      logoutBtn.style.display = "inline-block";
    } else {
      userInfo.textContent = "";
      loginBtn.style.display = "inline-block";
      logoutBtn.style.display = "none";
    }
  });


  try {
    if (!firebase.apps || firebase.apps.length === 0) {
      if (!window.firebaseConfig) {
        console.warn('window.firebaseConfig not found. auth.js will still load but auth will fail until config is set.');
      } else {
        firebase.initializeApp(window.firebaseConfig);
      }
    }
  } catch (err) {
    console.warn('Firebase initializeApp skipped (already initialized).', err.message || err);
  }

  const auth = firebase.auth();
  const db = firebase.firestore ? firebase.firestore() : null;

  // UI element selectors (if present in DOM)
  const $ = (s) => document.querySelector(s);
  const btnProfile = $('#btnProfile');
  const panelProfile = $('#panelProfile');
  const btnLogout = $('#btnLogout');
  const userNameEl = $('#userName');
  const userAvatarEl = $('#userAvatar');
  const freeCountEl = $('#freeCount');

  // Internal state
  let currentUser = null;
  let currentIdToken = null;
  let refreshTimer = null;

  // Helper: call fetch with Firebase ID token automatic header
  async function callAuthFetch(path, opts = {}) {
    const token = await getIdToken();
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
    opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, opts);
  }

  // Return current user's ID token (refreshes if necessary)
  async function getIdToken(forceRefresh = false) {
    if (!auth.currentUser) throw new Error('Not signed in');
    // firebase.getIdToken returns a string
    const token = await auth.currentUser.getIdToken(forceRefresh);
    currentIdToken = token;
    return token;
  }

  // Sign in with Google popup
  async function signInWithGoogle() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      const result = await auth.signInWithPopup(provider);
      // result.user is the signed-in user
      return result.user;
    } catch (err) {
      console.error('Google sign-in failed', err);
      throw err;
    }
  }

  // Sign out
  async function signOut() {
    try {
      await auth.signOut();
      // clear local state
      currentUser = null;
      currentIdToken = null;
      updateUI(null);
      if (refreshTimer) clearTimeout(refreshTimer);
      return true;
    } catch (err) {
      console.error('SignOut failed', err);
      throw err;
    }
  }

  // Ensure user doc exists server-side (calls POST /api/users/create)
  async function ensureUserDoc(user) {
    try {
      if (!user) throw new Error('No user provided');
      const token = await user.getIdToken();
      const body = { uid: user.uid, displayName: user.displayName || user.name || '' };
      const res = await fetch('/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        console.warn('ensureUserDoc non-ok:', res.status, txt);
        return null;
      }
      const data = await res.json();
      return data;
    } catch (err) {
      console.error('Failed to ensure user doc', err);
      return null;
    }
  }

  // Fetch fresh user profile from server
  async function fetchUserProfile(uid) {
    try {
      const res = await fetch(`/api/users/${uid}`);
      if (!res.ok) throw new Error('Profile fetch failed: ' + res.status);
      return await res.json();
    } catch (err) {
      console.error('fetchUserProfile error', err);
      return null;
    }
  }

  // Periodically refresh ID token (keeps token fresh for server calls)
  function scheduleTokenRefresh() {
    if (!auth.currentUser) return;
    // Clear existing
    if (refreshTimer) clearTimeout(refreshTimer);
    // Get token and schedule a refresh before expiry (~50 minutes by default)
    auth.currentUser.getIdTokenResult().then((tr) => {
      const exp = new Date(tr.expirationTime).getTime();
      const now = Date.now();
      const msUntil = Math.max(60_000, exp - now - 60_000); // refresh 60s before expiry, min 60s
      refreshTimer = setTimeout(async () => {
        try {
          await auth.currentUser.getIdToken(true);
          scheduleTokenRefresh();
        } catch (e) {
          console.warn('Token refresh failed', e);
        }
      }, msUntil);
    }).catch((e) => {
      console.warn('Failed to schedule token refresh', e);
    });
  }

  // Update UI elements when auth state changes / profile loads
  async function updateUI(user) {
    currentUser = user;
    if (user) {
      // basic UI: show user info in profile panel (if exists)
      if (userNameEl) userNameEl.textContent = user.displayName || user.email || 'User';
      if (userAvatarEl) {
        if (user.photoURL) {
          userAvatarEl.src = user.photoURL;
        } else {
          userAvatarEl.src = '/avatar-placeholder.png';
        }
      }
      if (btnLogout) btnLogout.classList.remove('hidden');
      if (freeCountEl) freeCountEl.textContent = '100'; // placeholder until we fetch real profile
      // ensure server-side doc
      const profile = await ensureUserDoc(user);
      if (profile && freeCountEl) {
        freeCountEl.textContent = String(profile.freePixels || 0);
      }
      scheduleTokenRefresh();
    } else {
      // signed out
      if (userNameEl) userNameEl.textContent = 'Guest';
      if (userAvatarEl) userAvatarEl.src = '/avatar-placeholder.png';
      if (btnLogout) btnLogout.classList.add('hidden');
      if (freeCountEl) freeCountEl.textContent = '0';
      if (refreshTimer) clearTimeout(refreshTimer);
    }
  }

  // Listen to Firebase auth state changes
  auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    if (user) {
      try {
        currentIdToken = await user.getIdToken();
      } catch (e) {
        console.warn('Failed to obtain id token initially', e);
      }
    } else {
      currentIdToken = null;
    }
    updateUI(user);
    // broadcast event on window so other modules can react
    try { window.dispatchEvent(new CustomEvent('pc:authChanged', { detail: { user } })); } catch(e){}
  });

  // Wire basic UI buttons if present
  if (btnProfile) {
    btnProfile.addEventListener('click', async () => {
      if (!auth.currentUser) {
        try {
          await signInWithGoogle();
        } catch (e) {
          alert('Sign-in failed: ' + (e.message || e));
        }
      } else {
        // toggle profile panel
        if (panelProfile) panelProfile.classList.toggle('hidden');
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await signOut();
      } catch (e) {
        alert('Sign-out failed: ' + (e.message || e));
      }
    });
  }

  // Utility: get current user (firebase.User) or null
  function getCurrentUser() {
    return auth.currentUser || null;
  }

  // Opens Stripe customer portal via backend and redirects user there
  async function openStripeCustomerPortal() {
    try {
      if (!auth.currentUser) throw new Error('Not signed in');
      const token = await getIdToken();
      const res = await fetch('/api/payments/customer-portal', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('Failed to create portal: ' + txt);
      }
      const data = await res.json();
      if (data.url) window.open(data.url, '_blank');
      else throw new Error('Portal URL missing');
    } catch (err) {
      console.error('openStripeCustomerPortal failed', err);
      alert('Failed to open billing portal: ' + (err.message || err));
    }
  }

  // Helper: check whether current user has a role (admin)
  async function isAdmin() {
    try {
      if (!auth.currentUser) return false;
      const token = await getIdToken();
      // Option A: use custom claims from token
      const tr = await auth.currentUser.getIdTokenResult();
      if (tr && tr.claims && tr.claims.admin) return true;
      // Option B: query user doc
      const res = await fetch(`/api/users/${auth.currentUser.uid}`);
      if (!res.ok) return false;
      const u = await res.json();
      return u.role === 'admin';
    } catch (e) {
      console.warn('isAdmin check failed', e);
      return false;
    }
  }

  // Convenience: Update profile (displayName, bio, avatarUrl)
  async function updateProfile({ displayName, bio, avatarUrl }) {
    try {
      if (!auth.currentUser) throw new Error('Not authenticated');
      const token = await getIdToken();
      const updates = {};
      if (displayName) updates.displayName = displayName;
      if (avatarUrl) updates.avatarUrl = avatarUrl;
      // update server-side profile endpoint
      await fetch(`/api/users/${auth.currentUser.uid}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(updates)
      });
      // optionally update Firebase profile (client)
      await auth.currentUser.updateProfile({ displayName: displayName || auth.currentUser.displayName, photoURL: avatarUrl || auth.currentUser.photoURL });
      // refresh UI
      updateUI(auth.currentUser);
      return true;
    } catch (err) {
      console.error('updateProfile failed', err);
      throw err;
    }
  }

  // Expose API globally
  window.Auth = {
    signInWithGoogle,
    signOut,
    getIdToken,
    callAuthFetch,
    getCurrentUser,
    isSignedIn: () => !!auth.currentUser,
    openStripeCustomerPortal,
    isAdmin,
    updateProfile,
  };

  // For backwards compatibility: trigger initial UI update if already signed in
  if (auth.currentUser) updateUI(auth.currentUser);

  // Debugging helpers
  window.__authDebug = {
    auth,
    getIdToken,
    currentUserRef: () => auth.currentUser,
  };
})();
=======
// public/auth.js
// Firebase Auth helper for PixelCanvas (compat SDK)
// - Supports Google sign-in, sign-out
// - Ensures user record exists via POST /api/users/create
// - Exposes helpers: getIdToken(), callAuthFetch(), isSignedIn(), currentUser()
// - Wires basic UI elements: #btnProfile, #panelProfile, #btnLogout, #userName, #userAvatar, #freeCount
// - Use with firebase-config.js that sets window.firebaseConfig or /env.js (window.env)

(function () {
  // Safety: require firebase compat to be loaded
  if (typeof firebase === 'undefined' || !firebase.auth) {
    console.error('Firebase compat SDK not loaded. Make sure firebase-auth-compat.js is included before auth.js');
    return;
  }

  // DOM elements
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userInfo = document.getElementById("user-info");

  // Initialize Firebase app if not already initialized (firebase-config.js should set window.firebaseConfig)
  const app = firebase.initializeApp(window.firebaseConfig);
  const auth = firebase.getAuth(app);

  
  // Logout
  logoutBtn.addEventListener("click", async () => {
    await firebase.signOut(auth);
    userInfo.textContent = "";
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
  });

  // Auth state persistence
  firebase.onAuthStateChanged(auth, (user) => {
    if (user) {
      userInfo.textContent = `Hello, ${user.displayName}`;
      loginBtn.style.display = "none";
      logoutBtn.style.display = "inline-block";
    } else {
      userInfo.textContent = "";
      loginBtn.style.display = "inline-block";
      logoutBtn.style.display = "none";
    }
  });


  try {
    if (!firebase.apps || firebase.apps.length === 0) {
      if (!window.firebaseConfig) {
        console.warn('window.firebaseConfig not found. auth.js will still load but auth will fail until config is set.');
      } else {
        firebase.initializeApp(window.firebaseConfig);
      }
    }
  } catch (err) {
    console.warn('Firebase initializeApp skipped (already initialized).', err.message || err);
  }

  const auth = firebase.auth();
  const db = firebase.firestore ? firebase.firestore() : null;

  // UI element selectors (if present in DOM)
  const $ = (s) => document.querySelector(s);
  const btnProfile = $('#btnProfile');
  const panelProfile = $('#panelProfile');
  const btnLogout = $('#btnLogout');
  const userNameEl = $('#userName');
  const userAvatarEl = $('#userAvatar');
  const freeCountEl = $('#freeCount');

  // Internal state
  let currentUser = null;
  let currentIdToken = null;
  let refreshTimer = null;

  // Helper: call fetch with Firebase ID token automatic header
  async function callAuthFetch(path, opts = {}) {
    const token = await getIdToken();
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
    opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, opts);
  }

  // Return current user's ID token (refreshes if necessary)
  async function getIdToken(forceRefresh = false) {
    if (!auth.currentUser) throw new Error('Not signed in');
    // firebase.getIdToken returns a string
    const token = await auth.currentUser.getIdToken(forceRefresh);
    currentIdToken = token;
    return token;
  }

  // Sign in with Google popup
  async function signInWithGoogle() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      const result = await auth.signInWithPopup(provider);
      // result.user is the signed-in user
      return result.user;
    } catch (err) {
      console.error('Google sign-in failed', err);
      throw err;
    }
  }

  // Sign out
  async function signOut() {
    try {
      await auth.signOut();
      // clear local state
      currentUser = null;
      currentIdToken = null;
      updateUI(null);
      if (refreshTimer) clearTimeout(refreshTimer);
      return true;
    } catch (err) {
      console.error('SignOut failed', err);
      throw err;
    }
  }

  // Ensure user doc exists server-side (calls POST /api/users/create)
  async function ensureUserDoc(user) {
    try {
      if (!user) throw new Error('No user provided');
      const token = await user.getIdToken();
      const body = { uid: user.uid, displayName: user.displayName || user.name || '' };
      const res = await fetch('/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        console.warn('ensureUserDoc non-ok:', res.status, txt);
        return null;
      }
      const data = await res.json();
      return data;
    } catch (err) {
      console.error('Failed to ensure user doc', err);
      return null;
    }
  }

  // Fetch fresh user profile from server
  async function fetchUserProfile(uid) {
    try {
      const res = await fetch(`/api/users/${uid}`);
      if (!res.ok) throw new Error('Profile fetch failed: ' + res.status);
      return await res.json();
    } catch (err) {
      console.error('fetchUserProfile error', err);
      return null;
    }
  }

  // Periodically refresh ID token (keeps token fresh for server calls)
  function scheduleTokenRefresh() {
    if (!auth.currentUser) return;
    // Clear existing
    if (refreshTimer) clearTimeout(refreshTimer);
    // Get token and schedule a refresh before expiry (~50 minutes by default)
    auth.currentUser.getIdTokenResult().then((tr) => {
      const exp = new Date(tr.expirationTime).getTime();
      const now = Date.now();
      const msUntil = Math.max(60_000, exp - now - 60_000); // refresh 60s before expiry, min 60s
      refreshTimer = setTimeout(async () => {
        try {
          await auth.currentUser.getIdToken(true);
          scheduleTokenRefresh();
        } catch (e) {
          console.warn('Token refresh failed', e);
        }
      }, msUntil);
    }).catch((e) => {
      console.warn('Failed to schedule token refresh', e);
    });
  }

  // Update UI elements when auth state changes / profile loads
  async function updateUI(user) {
    currentUser = user;
    if (user) {
      // basic UI: show user info in profile panel (if exists)
      if (userNameEl) userNameEl.textContent = user.displayName || user.email || 'User';
      if (userAvatarEl) {
        if (user.photoURL) {
          userAvatarEl.src = user.photoURL;
        } else {
          userAvatarEl.src = '/avatar-placeholder.png';
        }
      }
      if (btnLogout) btnLogout.classList.remove('hidden');
      if (freeCountEl) freeCountEl.textContent = '100'; // placeholder until we fetch real profile
      // ensure server-side doc
      const profile = await ensureUserDoc(user);
      if (profile && freeCountEl) {
        freeCountEl.textContent = String(profile.freePixels || 0);
      }
      scheduleTokenRefresh();
    } else {
      // signed out
      if (userNameEl) userNameEl.textContent = 'Guest';
      if (userAvatarEl) userAvatarEl.src = '/avatar-placeholder.png';
      if (btnLogout) btnLogout.classList.add('hidden');
      if (freeCountEl) freeCountEl.textContent = '0';
      if (refreshTimer) clearTimeout(refreshTimer);
    }
  }

  // Listen to Firebase auth state changes
  auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    if (user) {
      try {
        currentIdToken = await user.getIdToken();
      } catch (e) {
        console.warn('Failed to obtain id token initially', e);
      }
    } else {
      currentIdToken = null;
    }
    updateUI(user);
    // broadcast event on window so other modules can react
    try { window.dispatchEvent(new CustomEvent('pc:authChanged', { detail: { user } })); } catch(e){}
  });

  // Wire basic UI buttons if present
  if (btnProfile) {
    btnProfile.addEventListener('click', async () => {
      if (!auth.currentUser) {
        try {
          await signInWithGoogle();
        } catch (e) {
          alert('Sign-in failed: ' + (e.message || e));
        }
      } else {
        // toggle profile panel
        if (panelProfile) panelProfile.classList.toggle('hidden');
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await signOut();
      } catch (e) {
        alert('Sign-out failed: ' + (e.message || e));
      }
    });
  }

  // Utility: get current user (firebase.User) or null
  function getCurrentUser() {
    return auth.currentUser || null;
  }

  // Opens Stripe customer portal via backend and redirects user there
  async function openStripeCustomerPortal() {
    try {
      if (!auth.currentUser) throw new Error('Not signed in');
      const token = await getIdToken();
      const res = await fetch('/api/payments/customer-portal', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('Failed to create portal: ' + txt);
      }
      const data = await res.json();
      if (data.url) window.open(data.url, '_blank');
      else throw new Error('Portal URL missing');
    } catch (err) {
      console.error('openStripeCustomerPortal failed', err);
      alert('Failed to open billing portal: ' + (err.message || err));
    }
  }

  // Helper: check whether current user has a role (admin)
  async function isAdmin() {
    try {
      if (!auth.currentUser) return false;
      const token = await getIdToken();
      // Option A: use custom claims from token
      const tr = await auth.currentUser.getIdTokenResult();
      if (tr && tr.claims && tr.claims.admin) return true;
      // Option B: query user doc
      const res = await fetch(`/api/users/${auth.currentUser.uid}`);
      if (!res.ok) return false;
      const u = await res.json();
      return u.role === 'admin';
    } catch (e) {
      console.warn('isAdmin check failed', e);
      return false;
    }
  }

  // Convenience: Update profile (displayName, bio, avatarUrl)
  async function updateProfile({ displayName, bio, avatarUrl }) {
    try {
      if (!auth.currentUser) throw new Error('Not authenticated');
      const token = await getIdToken();
      const updates = {};
      if (displayName) updates.displayName = displayName;
      if (avatarUrl) updates.avatarUrl = avatarUrl;
      // update server-side profile endpoint
      await fetch(`/api/users/${auth.currentUser.uid}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(updates)
      });
      // optionally update Firebase profile (client)
      await auth.currentUser.updateProfile({ displayName: displayName || auth.currentUser.displayName, photoURL: avatarUrl || auth.currentUser.photoURL });
      // refresh UI
      updateUI(auth.currentUser);
      return true;
    } catch (err) {
      console.error('updateProfile failed', err);
      throw err;
    }
  }

  // Expose API globally
  window.Auth = {
    signInWithGoogle,
    signOut,
    getIdToken,
    callAuthFetch,
    getCurrentUser,
    isSignedIn: () => !!auth.currentUser,
    openStripeCustomerPortal,
    isAdmin,
    updateProfile,
  };

  // For backwards compatibility: trigger initial UI update if already signed in
  if (auth.currentUser) updateUI(auth.currentUser);

  // Debugging helpers
  window.__authDebug = {
    auth,
    getIdToken,
    currentUserRef: () => auth.currentUser,
  };
})();
>>>>>>> e07027fe (Add compression to dependencies)
