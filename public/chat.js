<<<<<<< HEAD
// public/chat.js
// Real-time chat client for PixelCanvas
// - Uses Socket.IO (if present) for realtime messages & typing indicators
// - Uses /api/chat/recent and /api/chat/send for history and sending
// - Integrates with window.Auth (getIdToken) and firebase auth fallback
// - Provides basic rate-limiting, sanitization, optimistic UI, and typing indicator

(function () {
  // Configuration
  const CHAT_HISTORY_ENDPOINT = '/api/chat/recent';
  const CHAT_SEND_ENDPOINT = '/api/chat/send';
  const MAX_HISTORY = 200; // messages to fetch
  const MESSAGE_MAX_LENGTH = 500;
  const CLIENT_RATE_LIMIT_MS = 1200; // minimum ms between sends (client-side)
  const TYPING_DEBOUNCE_MS = 1200; // how long until typing indicator clears
  const SOCKET_EVENT_IN = ['chatMessage', 'newMessage']; // listen to both event names

  // UI selectors (if present)
  const $ = (sel) => document.querySelector(sel);
  const chatPanel = $('#panelChat') || document.body; // fallback
  const chatBox = $('#chatMessages') || null; // container for messages
  const chatInput = $('#chatInput') || null;
  const sendBtn = $('#chatSend') || null;
  const typingIndicator = (() => {
    let el = document.getElementById('chatTyping');
    if (!el && chatPanel) {
      // create small typing indicator area inside panelChat
      el = document.createElement('div');
      el.id = 'chatTyping';
      el.style.fontSize = '12px';
      el.style.color = '#9ca3af';
      el.style.padding = '6px 8px';
      el.style.minHeight = '20px';
      if (chatPanel.querySelector) {
        chatPanel.appendChild(el);
      }
    }
    return el;
  })();

  // Socket
  let socket = null;
  if (typeof io !== 'undefined') {
    try {
      socket = io();
      socket.on('connect', () => console.debug('[chat] socket connected', socket.id));
    } catch (e) {
      console.warn('[chat] socket.io not available', e);
      socket = null;
    }
  }

  // Internal state
  let lastSendTs = 0;
  let localPending = new Map(); // id => DOM element (optimistic messages)
  let typingTimers = {}; // userId => timeout
  let currentUser = null;

  // ------- Utilities -------
  function escapeHtml(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // replace simple :emoji: tokens with unicode (small set)
  function emojiReplace(text) {
    const map = {
      ':smile:': '😄',
      ':laugh:': '😆',
      ':heart:': '❤️',
      ':thumbsup:': '👍',
      ':eyes:': '👀',
      ':party:': '🥳',
      ':wave:': '👋'
    };
    return text.replace(/:\w+:/g, (m) => map[m] || m);
  }

  function sanitizeMsg(raw) {
    let s = String(raw || '').slice(0, MESSAGE_MAX_LENGTH);
    s = sanitizeWhitespace(s);
    s = emojiReplace(s);
    return escapeHtml(s);
  }

  function sanitizeWhitespace(s) {
    // collapse multiple spaces, trim
    return s.replace(/\s+/g, ' ').trim();
  }

  function nowIso(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleString();
  }

  function buildMessageElement(msg, opts = {}) {
    // msg: { id?, from, fromName, text, createdAt } createdAt may be Date or string
    const wrapper = document.createElement('div');
    wrapper.className = 'pc-chat-msg flex gap-2 items-start py-1';

    const isSelf = currentUser && msg.from === currentUser.uid;

    const avatar = document.createElement('img');
    avatar.className = 'pc-chat-avatar';
    avatar.style.width = '36px';
    avatar.style.height = '36px';
    avatar.style.borderRadius = '8px';
    avatar.style.objectFit = 'cover';
    avatar.style.background = '#ddd';
    avatar.src = msg.avatarUrl || (isSelf ? (currentUser.photoURL || '/avatar-placeholder.png') : '/avatar-placeholder.png');

    const body = document.createElement('div');
    body.className = 'pc-chat-body';

    const meta = document.createElement('div');
    meta.className = 'pc-chat-meta';
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = msg.fromName || msg.from || 'anon';
    nameSpan.style.marginRight = '8px';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'pc-chat-time';
    timeSpan.style.color = '#9ca3af';
    timeSpan.style.fontSize = '12px';
    timeSpan.textContent = msg.createdAt ? nowIso(msg.createdAt) : nowIso();

    meta.appendChild(nameSpan);
    meta.appendChild(timeSpan);

    const textNode = document.createElement('div');
    textNode.className = 'pc-chat-text';
    textNode.innerHTML = sanitizeMsg(msg.text || '');

    body.appendChild(meta);
    body.appendChild(textNode);

    if (isSelf) {
      wrapper.style.justifyContent = 'flex-end';
      wrapper.appendChild(body);
      wrapper.appendChild(avatar);
    } else {
      wrapper.appendChild(avatar);
      wrapper.appendChild(body);
    }

    if (opts.pending) {
      wrapper.dataset.pending = '1';
      wrapper.style.opacity = '0.7';
    }
    if (opts.failed) {
      const errBadge = document.createElement('span');
      errBadge.textContent = 'Failed';
      errBadge.style.color = '#fff';
      errBadge.style.background = '#ef4444';
      errBadge.style.padding = '2px 6px';
      errBadge.style.borderRadius = '6px';
      errBadge.style.marginLeft = '8px';
      meta.appendChild(errBadge);
    }

    if (msg.id) wrapper.dataset.mid = msg.id;

    return wrapper;
  }

  function appendMessageToDOM(msg, opts = {}) {
    if (!chatBox) return;
    const el = buildMessageElement(msg, opts);
    chatBox.appendChild(el);
    // auto-scroll: if user is near bottom, scroll to bottom; otherwise keep position
    const isNearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 140;
    if (isNearBottom) chatBox.scrollTop = chatBox.scrollHeight;
    return el;
  }

  // ------- Auth integration -------
  async function getIdToken() {
    // prefer window.Auth.getIdToken if available
    if (window.Auth && window.Auth.getIdToken) {
      try { return await window.Auth.getIdToken(); } catch (e) { /* fallback */ }
    }
    // fallback to firebase SDK
    if (window.firebase && firebase.auth && firebase.auth().currentUser) {
      return firebase.auth().currentUser.getIdToken();
    }
    throw new Error('Not authenticated');
  }

  // update currentUser from Firebase
  function refreshCurrentUser() {
    if (window.Auth && window.Auth.getCurrentUser) {
      try {
        currentUser = window.Auth.getCurrentUser();
        return;
      } catch (e) { /* ignore */ }
    }
    if (window.firebase && firebase.auth) currentUser = firebase.auth().currentUser || null;
  }

  // Listen to auth changes and update currentUser
  window.addEventListener('pc:authChanged', (ev) => {
    refreshCurrentUser();
  });

  // ------- Load history -------
  let loadingHistory = false;
  async function loadHistory() {
    if (loadingHistory) return;
    loadingHistory = true;
    try {
      const resp = await fetch(`${CHAT_HISTORY_ENDPOINT}`);
      if (!resp.ok) throw new Error('Failed to load chat history');
      const data = await resp.json();
      // data is an array of message objects (we expect format from backend)
      if (Array.isArray(data)) {
        if (chatBox) chatBox.innerHTML = '';
        data.slice(-MAX_HISTORY).forEach(m => {
          // normalize createdAt if Firestore timestamp: server returned Date? In our routes we returned Date object or null
          const msg = {
            id: m.id || m._id || null,
            from: m.from || m.sender || m.uid || 'unknown',
            fromName: m.fromName || m.displayName || m.name || m.from,
            avatarUrl: m.avatarUrl || null,
            text: m.text || '',
            createdAt: m.createdAt ? (new Date(m.createdAt)) : null
          };
          appendMessageToDOM(msg);
        });
        // small scroll to bottom
        if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
      }
    } catch (err) {
      console.error('[chat] loadHistory error', err);
    } finally {
      loadingHistory = false;
    }
  }

  // ------- Sending messages -------
  async function sendMessage(rawText, opts = {}) {
    try {
      refreshCurrentUser();
      if (!currentUser) {
        alert('Please sign in to send messages');
        return { success: false, error: 'not-authenticated' };
      }

      const now = Date.now();
      if (now - lastSendTs < CLIENT_RATE_LIMIT_MS) {
        return { success: false, error: 'You are sending messages too quickly' };
      }

      // Basic heuristics to avoid spammy content: repeated char sequences, very long repeated strings, many urls
      const textNormalized = String(rawText || '').trim();
      if (!textNormalized) return { success: false, error: 'Empty message' };
      if (textNormalized.length > MESSAGE_MAX_LENGTH) return { success: false, error: 'Message too long' };
      if ((textNormalized.match(/https?:\/\//g) || []).length > 4) return { success: false, error: 'Too many links' };

      // Sanitization & preview
      const sanitized = sanitizeMsg(textNormalized);

      // Optimistic UI: show message locally as pending
      const tempId = 'local_' + Math.random().toString(36).slice(2, 9);
      const pendingMsg = {
        id: tempId,
        from: currentUser.uid,
        fromName: currentUser.displayName || currentUser.email || currentUser.uid,
        avatarUrl: currentUser.photoURL || null,
        text: sanitized,
        createdAt: new Date()
      };
      const domEl = appendMessageToDOM(pendingMsg, { pending: true });
      localPending.set(tempId, domEl);

      // Notify others via socket typing -> send event? We'll emit via server only after successful POST; emit typing stop
      if (socket) socket.emit('typing', { uid: currentUser.uid, name: pendingMsg.fromName, typing: false });

      // get idToken and send to server
      let token;
      try { token = await getIdToken(); } catch (e) { throw new Error('Auth token required'); }

      lastSendTs = now;

      // POST to server
      const resp = await fetch(CHAT_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ text: textNormalized })
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.error) {
        // mark failed
        const el = localPending.get(tempId);
        if (el) {
          // append failed badge
          const failBadge = document.createElement('span');
          failBadge.textContent = 'Failed';
          failBadge.style.background = '#ef4444';
          failBadge.style.color = '#fff';
          failBadge.style.padding = '2px 6px';
          failBadge.style.borderRadius = '6px';
          failBadge.style.marginLeft = '8px';
          const meta = el.querySelector('.pc-chat-meta');
          if (meta) meta.appendChild(failBadge);
          el.style.opacity = '0.6';
        }
        localPending.delete(tempId);
        return { success: false, error: (json && json.error) || 'Send failed' };
      }

      // success — server stored the message; server should broadcast via socket; if server returns id, update dom
      const serverId = json.id || (json.message && json.message.id) || null;
      // Remove pending marker
      const el = localPending.get(tempId);
      if (el) {
        el.removeAttribute('data-pending');
        el.style.opacity = '1';
        if (serverId) el.dataset.mid = serverId;
        localPending.delete(tempId);
      }

      // If server didn't broadcast for some reason, append message from server payload
      // But our socket listeners will handle realtime display.

      // Dispatch event
      try { window.dispatchEvent(new CustomEvent('pc:chatSent', { detail: { text: textNormalized, id: serverId } })); } catch (e) {}

      return { success: true, id: serverId };
    } catch (err) {
      console.error('[chat] sendMessage error', err);
      return { success: false, error: err.message || 'Send error' };
    }
  }

  // ------- Typing indicator -------
  let typingUsers = new Map(); // uid -> expiresAt
  function setTypingIndicatorText() {
    if (!typingIndicator) return;
    const now = Date.now();
    // remove expired
    for (const [uid, t] of typingUsers) if (t <= now) typingUsers.delete(uid);
    const names = Array.from(typingUsers.keys()).slice(0, 3).map(uid => uid); // we store uid only; later can map to names
    if (names.length === 0) {
      typingIndicator.textContent = '';
    } else if (names.length === 1) {
      typingIndicator.textContent = `${names[0]} is typing...`;
    } else {
      typingIndicator.textContent = `${names.length} people are typing...`;
    }
  }

  function remoteUserTyping(payload) {
    try {
      if (!payload) return;
      const uid = payload.uid || payload.from;
      const name = payload.name || payload.fromName || uid;
      // add/extend
      typingUsers.set(name, Date.now() + TYPING_DEBOUNCE_MS + 300);
      setTypingIndicatorText();
      // schedule clear
      setTimeout(() => setTypingIndicatorText(), TYPING_DEBOUNCE_MS + 500);
    } catch (e) { console.warn('remoteUserTyping err', e); }
  }

  // Listen to socket typing events
  if (socket) {
    socket.on('typing', (payload) => {
      remoteUserTyping(payload);
    });
    // Listen for incoming messages
    SOCKET_EVENT_IN.forEach((evName) => {
      socket.on(evName, (msg) => {
        try {
          // server may send different shapes
          const m = {
            id: msg.id || msg._id || null,
            from: msg.from || msg.sender || msg.uid || (msg.owner || null),
            fromName: msg.fromName || msg.displayName || msg.name || msg.ownerName || msg.from,
            avatarUrl: msg.avatarUrl || null,
            text: msg.text || msg.color ? `${msg.ownerName || msg.owner}: placed pixel` : msg.text || '',
            createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date()
          };

          appendMessageToDOM(m);
          try { window.dispatchEvent(new CustomEvent('pc:chatMessageReceived', { detail: m })); } catch (e) {}
        } catch (e) {
          console.warn('[chat] socket message processing error', e);
        }
      });
    });
  }

  // ------- UI wiring -------
  function initUI() {
    if (chatInput) {
      // enable enter-to-send
      chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (sendBtn) sendBtn.click();
        } else {
          // typing notify
          if (socket && currentUser) {
            socket.emit('typing', { uid: currentUser.uid, name: currentUser.displayName || currentUser.email || currentUser.uid, typing: true });
          }
        }
      });

      // on input, send typing events (debounced)
      let typingTimer = null;
      chatInput.addEventListener('input', () => {
        if (!socket || !currentUser) return;
        if (typingTimer) clearTimeout(typingTimer);
        socket.emit('typing', { uid: currentUser.uid, name: currentUser.displayName || currentUser.email || currentUser.uid, typing: true });
        typingTimer = setTimeout(() => {
          if (socket) socket.emit('typing', { uid: currentUser.uid, name: currentUser.displayName || currentUser.email || currentUser.uid, typing: false });
        }, TYPING_DEBOUNCE_MS);
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        if (!chatInput) return;
        const raw = chatInput.value || '';
        const result = await sendMessage(raw);
        if (result.success) {
          chatInput.value = '';
        } else {
          if (result.error) alert('Send failed: ' + result.error);
        }
      });
    }

    // show "please sign in" when not signed
    refreshCurrentUser();
    if (!currentUser && chatBox) {
      chatBox.innerHTML = '<p class="text-muted">Sign in to join the chat</p>';
    }
  }

  // ------- Initialization -------
  (function start() {
    refreshCurrentUser();
    initUI();
    loadHistory();

    // If socket exists, subscribe to server "chatMessage" or "newMessage" events (already wired above)
    if (socket) {
      // optionally join rooms here (global vs groups) when server supports it
    }
  })();

  // Public API
  window.PCChat = {
    sendMessage,
    loadHistory,
    appendMessageToDOM,
    getCurrentUser: () => currentUser,
  };

  // expose for debugging
  window.__pc_chat_debug = { sendMessage, loadHistory };
})();
=======
// public/chat.js
// Real-time chat client for PixelCanvas
// - Uses Socket.IO (if present) for realtime messages & typing indicators
// - Uses /api/chat/recent and /api/chat/send for history and sending
// - Integrates with window.Auth (getIdToken) and firebase auth fallback
// - Provides basic rate-limiting, sanitization, optimistic UI, and typing indicator

(function () {
  // Configuration
  const CHAT_HISTORY_ENDPOINT = '/api/chat/recent';
  const CHAT_SEND_ENDPOINT = '/api/chat/send';
  const MAX_HISTORY = 200; // messages to fetch
  const MESSAGE_MAX_LENGTH = 500;
  const CLIENT_RATE_LIMIT_MS = 1200; // minimum ms between sends (client-side)
  const TYPING_DEBOUNCE_MS = 1200; // how long until typing indicator clears
  const SOCKET_EVENT_IN = ['chatMessage', 'newMessage']; // listen to both event names

  // UI selectors (if present)
  const $ = (sel) => document.querySelector(sel);
  const chatPanel = $('#panelChat') || document.body; // fallback
  const chatBox = $('#chatMessages') || null; // container for messages
  const chatInput = $('#chatInput') || null;
  const sendBtn = $('#chatSend') || null;
  const typingIndicator = (() => {
    let el = document.getElementById('chatTyping');
    if (!el && chatPanel) {
      // create small typing indicator area inside panelChat
      el = document.createElement('div');
      el.id = 'chatTyping';
      el.style.fontSize = '12px';
      el.style.color = '#9ca3af';
      el.style.padding = '6px 8px';
      el.style.minHeight = '20px';
      if (chatPanel.querySelector) {
        chatPanel.appendChild(el);
      }
    }
    return el;
  })();

  // Socket
  let socket = null;
  if (typeof io !== 'undefined') {
    try {
      socket = io();
      socket.on('connect', () => console.debug('[chat] socket connected', socket.id));
    } catch (e) {
      console.warn('[chat] socket.io not available', e);
      socket = null;
    }
  }

  // Internal state
  let lastSendTs = 0;
  let localPending = new Map(); // id => DOM element (optimistic messages)
  let typingTimers = {}; // userId => timeout
  let currentUser = null;

  // ------- Utilities -------
  function escapeHtml(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // replace simple :emoji: tokens with unicode (small set)
  function emojiReplace(text) {
    const map = {
      ':smile:': '😄',
      ':laugh:': '😆',
      ':heart:': '❤️',
      ':thumbsup:': '👍',
      ':eyes:': '👀',
      ':party:': '🥳',
      ':wave:': '👋'
    };
    return text.replace(/:\w+:/g, (m) => map[m] || m);
  }

  function sanitizeMsg(raw) {
    let s = String(raw || '').slice(0, MESSAGE_MAX_LENGTH);
    s = sanitizeWhitespace(s);
    s = emojiReplace(s);
    return escapeHtml(s);
  }

  function sanitizeWhitespace(s) {
    // collapse multiple spaces, trim
    return s.replace(/\s+/g, ' ').trim();
  }

  function nowIso(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleString();
  }

  function buildMessageElement(msg, opts = {}) {
    // msg: { id?, from, fromName, text, createdAt } createdAt may be Date or string
    const wrapper = document.createElement('div');
    wrapper.className = 'pc-chat-msg flex gap-2 items-start py-1';

    const isSelf = currentUser && msg.from === currentUser.uid;

    const avatar = document.createElement('img');
    avatar.className = 'pc-chat-avatar';
    avatar.style.width = '36px';
    avatar.style.height = '36px';
    avatar.style.borderRadius = '8px';
    avatar.style.objectFit = 'cover';
    avatar.style.background = '#ddd';
    avatar.src = msg.avatarUrl || (isSelf ? (currentUser.photoURL || '/avatar-placeholder.png') : '/avatar-placeholder.png');

    const body = document.createElement('div');
    body.className = 'pc-chat-body';

    const meta = document.createElement('div');
    meta.className = 'pc-chat-meta';
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = msg.fromName || msg.from || 'anon';
    nameSpan.style.marginRight = '8px';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'pc-chat-time';
    timeSpan.style.color = '#9ca3af';
    timeSpan.style.fontSize = '12px';
    timeSpan.textContent = msg.createdAt ? nowIso(msg.createdAt) : nowIso();

    meta.appendChild(nameSpan);
    meta.appendChild(timeSpan);

    const textNode = document.createElement('div');
    textNode.className = 'pc-chat-text';
    textNode.innerHTML = sanitizeMsg(msg.text || '');

    body.appendChild(meta);
    body.appendChild(textNode);

    if (isSelf) {
      wrapper.style.justifyContent = 'flex-end';
      wrapper.appendChild(body);
      wrapper.appendChild(avatar);
    } else {
      wrapper.appendChild(avatar);
      wrapper.appendChild(body);
    }

    if (opts.pending) {
      wrapper.dataset.pending = '1';
      wrapper.style.opacity = '0.7';
    }
    if (opts.failed) {
      const errBadge = document.createElement('span');
      errBadge.textContent = 'Failed';
      errBadge.style.color = '#fff';
      errBadge.style.background = '#ef4444';
      errBadge.style.padding = '2px 6px';
      errBadge.style.borderRadius = '6px';
      errBadge.style.marginLeft = '8px';
      meta.appendChild(errBadge);
    }

    if (msg.id) wrapper.dataset.mid = msg.id;

    return wrapper;
  }

  function appendMessageToDOM(msg, opts = {}) {
    if (!chatBox) return;
    const el = buildMessageElement(msg, opts);
    chatBox.appendChild(el);
    // auto-scroll: if user is near bottom, scroll to bottom; otherwise keep position
    const isNearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 140;
    if (isNearBottom) chatBox.scrollTop = chatBox.scrollHeight;
    return el;
  }

  // ------- Auth integration -------
  async function getIdToken() {
    // prefer window.Auth.getIdToken if available
    if (window.Auth && window.Auth.getIdToken) {
      try { return await window.Auth.getIdToken(); } catch (e) { /* fallback */ }
    }
    // fallback to firebase SDK
    if (window.firebase && firebase.auth && firebase.auth().currentUser) {
      return firebase.auth().currentUser.getIdToken();
    }
    throw new Error('Not authenticated');
  }

  // update currentUser from Firebase
  function refreshCurrentUser() {
    if (window.Auth && window.Auth.getCurrentUser) {
      try {
        currentUser = window.Auth.getCurrentUser();
        return;
      } catch (e) { /* ignore */ }
    }
    if (window.firebase && firebase.auth) currentUser = firebase.auth().currentUser || null;
  }

  // Listen to auth changes and update currentUser
  window.addEventListener('pc:authChanged', (ev) => {
    refreshCurrentUser();
  });

  // ------- Load history -------
  let loadingHistory = false;
  async function loadHistory() {
    if (loadingHistory) return;
    loadingHistory = true;
    try {
      const resp = await fetch(`${CHAT_HISTORY_ENDPOINT}`);
      if (!resp.ok) throw new Error('Failed to load chat history');
      const data = await resp.json();
      // data is an array of message objects (we expect format from backend)
      if (Array.isArray(data)) {
        if (chatBox) chatBox.innerHTML = '';
        data.slice(-MAX_HISTORY).forEach(m => {
          // normalize createdAt if Firestore timestamp: server returned Date? In our routes we returned Date object or null
          const msg = {
            id: m.id || m._id || null,
            from: m.from || m.sender || m.uid || 'unknown',
            fromName: m.fromName || m.displayName || m.name || m.from,
            avatarUrl: m.avatarUrl || null,
            text: m.text || '',
            createdAt: m.createdAt ? (new Date(m.createdAt)) : null
          };
          appendMessageToDOM(msg);
        });
        // small scroll to bottom
        if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
      }
    } catch (err) {
      console.error('[chat] loadHistory error', err);
    } finally {
      loadingHistory = false;
    }
  }

  // ------- Sending messages -------
  async function sendMessage(rawText, opts = {}) {
    try {
      refreshCurrentUser();
      if (!currentUser) {
        alert('Please sign in to send messages');
        return { success: false, error: 'not-authenticated' };
      }

      const now = Date.now();
      if (now - lastSendTs < CLIENT_RATE_LIMIT_MS) {
        return { success: false, error: 'You are sending messages too quickly' };
      }

      // Basic heuristics to avoid spammy content: repeated char sequences, very long repeated strings, many urls
      const textNormalized = String(rawText || '').trim();
      if (!textNormalized) return { success: false, error: 'Empty message' };
      if (textNormalized.length > MESSAGE_MAX_LENGTH) return { success: false, error: 'Message too long' };
      if ((textNormalized.match(/https?:\/\//g) || []).length > 4) return { success: false, error: 'Too many links' };

      // Sanitization & preview
      const sanitized = sanitizeMsg(textNormalized);

      // Optimistic UI: show message locally as pending
      const tempId = 'local_' + Math.random().toString(36).slice(2, 9);
      const pendingMsg = {
        id: tempId,
        from: currentUser.uid,
        fromName: currentUser.displayName || currentUser.email || currentUser.uid,
        avatarUrl: currentUser.photoURL || null,
        text: sanitized,
        createdAt: new Date()
      };
      const domEl = appendMessageToDOM(pendingMsg, { pending: true });
      localPending.set(tempId, domEl);

      // Notify others via socket typing -> send event? We'll emit via server only after successful POST; emit typing stop
      if (socket) socket.emit('typing', { uid: currentUser.uid, name: pendingMsg.fromName, typing: false });

      // get idToken and send to server
      let token;
      try { token = await getIdToken(); } catch (e) { throw new Error('Auth token required'); }

      lastSendTs = now;

      // POST to server
      const resp = await fetch(CHAT_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ text: textNormalized })
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.error) {
        // mark failed
        const el = localPending.get(tempId);
        if (el) {
          // append failed badge
          const failBadge = document.createElement('span');
          failBadge.textContent = 'Failed';
          failBadge.style.background = '#ef4444';
          failBadge.style.color = '#fff';
          failBadge.style.padding = '2px 6px';
          failBadge.style.borderRadius = '6px';
          failBadge.style.marginLeft = '8px';
          const meta = el.querySelector('.pc-chat-meta');
          if (meta) meta.appendChild(failBadge);
          el.style.opacity = '0.6';
        }
        localPending.delete(tempId);
        return { success: false, error: (json && json.error) || 'Send failed' };
      }

      // success — server stored the message; server should broadcast via socket; if server returns id, update dom
      const serverId = json.id || (json.message && json.message.id) || null;
      // Remove pending marker
      const el = localPending.get(tempId);
      if (el) {
        el.removeAttribute('data-pending');
        el.style.opacity = '1';
        if (serverId) el.dataset.mid = serverId;
        localPending.delete(tempId);
      }

      // If server didn't broadcast for some reason, append message from server payload
      // But our socket listeners will handle realtime display.

      // Dispatch event
      try { window.dispatchEvent(new CustomEvent('pc:chatSent', { detail: { text: textNormalized, id: serverId } })); } catch (e) {}

      return { success: true, id: serverId };
    } catch (err) {
      console.error('[chat] sendMessage error', err);
      return { success: false, error: err.message || 'Send error' };
    }
  }

  // ------- Typing indicator -------
  let typingUsers = new Map(); // uid -> expiresAt
  function setTypingIndicatorText() {
    if (!typingIndicator) return;
    const now = Date.now();
    // remove expired
    for (const [uid, t] of typingUsers) if (t <= now) typingUsers.delete(uid);
    const names = Array.from(typingUsers.keys()).slice(0, 3).map(uid => uid); // we store uid only; later can map to names
    if (names.length === 0) {
      typingIndicator.textContent = '';
    } else if (names.length === 1) {
      typingIndicator.textContent = `${names[0]} is typing...`;
    } else {
      typingIndicator.textContent = `${names.length} people are typing...`;
    }
  }

  function remoteUserTyping(payload) {
    try {
      if (!payload) return;
      const uid = payload.uid || payload.from;
      const name = payload.name || payload.fromName || uid;
      // add/extend
      typingUsers.set(name, Date.now() + TYPING_DEBOUNCE_MS + 300);
      setTypingIndicatorText();
      // schedule clear
      setTimeout(() => setTypingIndicatorText(), TYPING_DEBOUNCE_MS + 500);
    } catch (e) { console.warn('remoteUserTyping err', e); }
  }

  // Listen to socket typing events
  if (socket) {
    socket.on('typing', (payload) => {
      remoteUserTyping(payload);
    });
    // Listen for incoming messages
    SOCKET_EVENT_IN.forEach((evName) => {
      socket.on(evName, (msg) => {
        try {
          // server may send different shapes
          const m = {
            id: msg.id || msg._id || null,
            from: msg.from || msg.sender || msg.uid || (msg.owner || null),
            fromName: msg.fromName || msg.displayName || msg.name || msg.ownerName || msg.from,
            avatarUrl: msg.avatarUrl || null,
            text: msg.text || msg.color ? `${msg.ownerName || msg.owner}: placed pixel` : msg.text || '',
            createdAt: msg.createdAt ? new Date(msg.createdAt) : new Date()
          };

          appendMessageToDOM(m);
          try { window.dispatchEvent(new CustomEvent('pc:chatMessageReceived', { detail: m })); } catch (e) {}
        } catch (e) {
          console.warn('[chat] socket message processing error', e);
        }
      });
    });
  }

  // ------- UI wiring -------
  function initUI() {
    if (chatInput) {
      // enable enter-to-send
      chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (sendBtn) sendBtn.click();
        } else {
          // typing notify
          if (socket && currentUser) {
            socket.emit('typing', { uid: currentUser.uid, name: currentUser.displayName || currentUser.email || currentUser.uid, typing: true });
          }
        }
      });

      // on input, send typing events (debounced)
      let typingTimer = null;
      chatInput.addEventListener('input', () => {
        if (!socket || !currentUser) return;
        if (typingTimer) clearTimeout(typingTimer);
        socket.emit('typing', { uid: currentUser.uid, name: currentUser.displayName || currentUser.email || currentUser.uid, typing: true });
        typingTimer = setTimeout(() => {
          if (socket) socket.emit('typing', { uid: currentUser.uid, name: currentUser.displayName || currentUser.email || currentUser.uid, typing: false });
        }, TYPING_DEBOUNCE_MS);
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        if (!chatInput) return;
        const raw = chatInput.value || '';
        const result = await sendMessage(raw);
        if (result.success) {
          chatInput.value = '';
        } else {
          if (result.error) alert('Send failed: ' + result.error);
        }
      });
    }

    // show "please sign in" when not signed
    refreshCurrentUser();
    if (!currentUser && chatBox) {
      chatBox.innerHTML = '<p class="text-muted">Sign in to join the chat</p>';
    }
  }

  // ------- Initialization -------
  (function start() {
    refreshCurrentUser();
    initUI();
    loadHistory();

    // If socket exists, subscribe to server "chatMessage" or "newMessage" events (already wired above)
    if (socket) {
      // optionally join rooms here (global vs groups) when server supports it
    }
  })();

  // Public API
  window.PCChat = {
    sendMessage,
    loadHistory,
    appendMessageToDOM,
    getCurrentUser: () => currentUser,
  };

  // expose for debugging
  window.__pc_chat_debug = { sendMessage, loadHistory };
})();
>>>>>>> e07027fe (Add compression to dependencies)
