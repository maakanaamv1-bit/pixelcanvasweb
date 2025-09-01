<<<<<<< HEAD
// public/canvas.js
// Production-ready canvas renderer & pixel interaction layer for PixelCanvas
// - requires: <canvas id="pixelCanvas"> in DOM
// - expects server endpoints: /api/pixels/box (GET) and /api/pixels/place (POST)
// - expects Socket.IO client connected as `io()` (socket emits 'pixelPlaced')
// - uses window.env for public config (server exposes /env.js) if needed

(function () {
  // Config (tweak if needed)
  const TILE_SIZE = 64; // logical pixels per tile (server-side tiling recommended later)
  const CACHE_TILE_LIMIT = 500; // number of tiles to keep in cache
  const FETCH_DEBOUNCE_MS = 120; // debounce for viewport load
  const MAX_BOX_PIXELS = 2000; // server limit (consistent with routes)
  const DEFAULT_COOLDOWN_MS = 10000; // fallback
  const GRID_LIMIT = 10000; // logical board size (0..GRID_LIMIT-1)
  const BASE_ZOOM = 1.0; // starting scale multiplier for logical pixel -> screen px

  // DOM / Canvas setup
  const canvas = document.getElementById("pixelCanvas");
  if (!canvas) throw new Error("No canvas#pixelCanvas element found");
  const ctx = canvas.getContext("2d", { alpha: false });

  // Offscreen canvas for drawing tiles (helps reduce flicker)
  const offscreen = document.createElement("canvas");
  const offctx = offscreen.getContext("2d", { alpha: false });

  // Device pixel ratio handling
  const DPR = window.devicePixelRatio || 1;

  // Viewport / world state
  let viewport = { width: window.innerWidth, height: window.innerHeight };
  let zoom = 0.5; // logical pixels -> screen px multiplier
  let offsetX = GRID_LIMIT / 2; // world center coordinate (logical)
  let offsetY = GRID_LIMIT / 2;
  let isDragging = false;
  let lastPointer = null;

  // Pixel cache: map tileKey -> { pixels: Map("x_y"->color), ts }
  const tileCache = new Map(); // insertion order used for simple LRU eviction

  // Optional: map of pending server placements to show "filling" animation locally
  const pendingFills = new Map(); // key -> { untilMs, color, owner }

  // Current color (exposed setter)
  let currentColor = "#ff4d6d";

  // Socket.io (assumes socket script included and connection established)
  let socket = null;
  if (typeof io !== "undefined") {
    try {
      socket = io();
      socket.on("connect", () => console.log("socket connected:", socket.id));
      socket.on("pixelPlaced", onSocketPixelPlaced);
    } catch (e) {
      console.warn("Socket.io not available or failed:", e);
    }
  }

  // Utility helpers
  function worldToScreen(wx, wy) {
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    return [cx + (wx - offsetX) * zoom, cy + (wy - offsetY) * zoom];
  }
  function screenToWorld(sx, sy) {
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    return [
      Math.floor((sx - cx) / zoom + offsetX),
      Math.floor((sy - cy) / zoom + offsetY),
    ];
  }
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function tileKeyFor(x, y) {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    return `${tx}_${ty}`;
  }
  function tileBoundsFromKey(key) {
    const [tx, ty] = key.split("_").map(Number);
    const left = tx * TILE_SIZE;
    const top = ty * TILE_SIZE;
    const right = left + TILE_SIZE - 1;
    const bottom = top + TILE_SIZE - 1;
    return { tx, ty, left, top, right, bottom };
  }
  function ensureCanvasSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    viewport.width = w;
    viewport.height = h;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Offscreen should match canvas size for safe blitting (we'll scale tiles inside though)
    offscreen.width = Math.max(512, Math.round(w * DPR));
    offscreen.height = Math.max(512, Math.round(h * DPR));
  }

  // LRU cache eviction
  function touchTile(key) {
    if (!tileCache.has(key)) return;
    const v = tileCache.get(key);
    tileCache.delete(key);
    v.ts = Date.now();
    tileCache.set(key, v);
    if (tileCache.size > CACHE_TILE_LIMIT) {
      // evict oldest
      const firstKey = tileCache.keys().next().value;
      tileCache.delete(firstKey);
    }
  }

  function setTilePixels(key, pixelsObj) {
    // pixelsObj: array of {x,y,color} or map-like object
    const map = new Map();
    if (Array.isArray(pixelsObj)) {
      pixelsObj.forEach((p) => {
        map.set(`${p.x}_${p.y}`, p.color);
      });
    } else if (pixelsObj && typeof pixelsObj === "object") {
      Object.keys(pixelsObj).forEach((k) => map.set(k, pixelsObj[k]));
    }
    tileCache.set(key, { pixels: map, ts: Date.now() });
    touchTile(key);
  }

  async function fetchBox(left, top, right, bottom) {
    // Sanitize & clamp
    left = clamp(Math.floor(left), 0, GRID_LIMIT - 1);
    top = clamp(Math.floor(top), 0, GRID_LIMIT - 1);
    right = clamp(Math.floor(right), 0, GRID_LIMIT - 1);
    bottom = clamp(Math.floor(bottom), 0, GRID_LIMIT - 1);

    // server limit awareness: if box too big, split into smaller requests
    const width = right - left + 1;
    const height = bottom - top + 1;
    const area = width * height;
    const maxSingle = Math.max(100, MAX_BOX_PIXELS);
    const results = [];

    // naive split: horizontal slices
    if (area <= maxSingle) {
      try {
        const q = `/api/pixels/box?left=${left}&top=${top}&right=${right}&bottom=${bottom}&limit=${MAX_BOX_PIXELS}`;
        const resp = await fetch(q, { cache: "no-store" });
        if (!resp.ok) throw new Error("Fetch box failed: " + resp.status);
        const data = await resp.json();
        return data; // array of {x,y,color}
      } catch (err) {
        console.error("fetchBox error", err);
        return [];
      }
    } else {
      // split into vertical strips
      const cols = Math.ceil(area / maxSingle);
      const sliceW = Math.ceil(width / cols);
      for (let i = 0; i < cols; i++) {
        const l = left + i * sliceW;
        const r = Math.min(right, l + sliceW - 1);
        try {
          const resp = await fetch(`/api/pixels/box?left=${l}&top=${top}&right=${r}&bottom=${bottom}&limit=${MAX_BOX_PIXELS}`, { cache: "no-store" });
          if (!resp.ok) throw new Error("Fetch chunk failed: " + resp.status);
          const d = await resp.json();
          results.push(...d);
        } catch (err) {
          console.error("fetchBox chunk error", err);
        }
      }
      return results;
    }
  }

  // Compute tiles that intersect current viewport plus padding
  function tilesInView(paddingTiles = 1) {
    // compute visible logical coordinates
    const cx = offsetX;
    const cy = offsetY;
    const halfW = (viewport.width / 2) / zoom;
    const halfH = (viewport.height / 2) / zoom;
    const left = Math.floor(cx - halfW) - paddingTiles * TILE_SIZE;
    const top = Math.floor(cy - halfH) - paddingTiles * TILE_SIZE;
    const right = Math.ceil(cx + halfW) + paddingTiles * TILE_SIZE;
    const bottom = Math.ceil(cy + halfH) + paddingTiles * TILE_SIZE;

    const tLeft = Math.floor(Math.max(0, left) / TILE_SIZE);
    const tTop = Math.floor(Math.max(0, top) / TILE_SIZE);
    const tRight = Math.floor(Math.max(0, right) / TILE_SIZE);
    const tBottom = Math.floor(Math.max(0, bottom) / TILE_SIZE);

    const keys = [];
    for (let ty = tTop; ty <= tBottom; ty++) {
      for (let tx = tLeft; tx <= tRight; tx++) {
        keys.push(`${tx}_${ty}`);
      }
    }
    return keys;
  }

  // Load tiles for the viewport, debounced
  let fetchTimer = null;
  function scheduleFetchVisible() {
    if (fetchTimer) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(loadVisibleTiles, FETCH_DEBOUNCE_MS);
  }

  async function loadVisibleTiles() {
    fetchTimer = null;
    const keys = tilesInView(1);
    // For each tile not in cache, fetch pixels inside tile bounds
    const toFetch = [];
    const tileRequests = [];
    for (const key of keys) {
      if (!tileCache.has(key)) {
        const { left, top, right, bottom } = tileBoundsFromKey(key);
        toFetch.push({ key, left, top, right, bottom });
      } else {
        touchTile(key);
      }
    }
    // Group requests into reasonable box queries per contiguous ranges (naive)
    for (const t of toFetch) {
      tileRequests.push(fetchBox(t.left, t.top, t.right, t.bottom).then((pixels) => {
        // pixels is array of {x,y,color}
        setTilePixels(t.key, pixels);
      }).catch((e) => {
        console.error("Tile fetch failed:", t.key, e);
      }));
    }
    await Promise.allSettled(tileRequests);
    render(); // redraw when new tiles arrive
  }

  // Rendering: draws cached pixels visible in viewport onto canvas
  function render() {
    // clear
    ctx.clearRect(0, 0, canvas.width / DPR, canvas.height / DPR);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);

    // iterate visible tiles (to reduce overdraw)
    const keys = tilesInView(0);
    const pxSize = Math.max(1, Math.floor(zoom)); // on-screen pixel size
    for (const key of keys) {
      const t = tileCache.get(key);
      if (!t) continue;
      // draw each pixel in tile
      for (const [k, color] of t.pixels.entries()) {
        const [sx, sy] = k.split("_").map(Number);
        // check bounds quickly
        const [screenX, screenY] = worldToScreen(sx, sy);
        // small optimization: check if on-screen (allow pxSize slack)
        if (screenX + pxSize < 0 || screenX - pxSize > viewport.width || screenY + pxSize < 0 || screenY - pxSize > viewport.height) continue;
        ctx.fillStyle = color;
        // draw rectangle representing logical pixel at current zoom
        ctx.fillRect(Math.round(screenX), Math.round(screenY), Math.max(1, pxSize), Math.max(1, pxSize));
      }
    }

    // pending fills overlay (in-progress placed pixels)
    const now = Date.now();
    for (const [k, p] of pendingFills.entries()) {
      const [sx, sy] = k.split("_").map(Number);
      const [screenX, screenY] = worldToScreen(sx, sy);
      const remain = p.untilMs - now;
      if (remain <= 0) {
        pendingFills.delete(k);
        continue;
      }
      // draw radial progress (simple rectangle bar)
      const w = Math.max(1, Math.floor(zoom));
      ctx.fillStyle = p.color + "88"; // semi-transparent
      ctx.fillRect(Math.round(screenX), Math.round(screenY), Math.max(1, w), Math.max(1, w));
      // small progress indicator
      const frac = (p.totalMs ? (p.totalMs - remain) / p.totalMs : 0.6);
      ctx.fillStyle = "#00000066";
      ctx.fillRect(Math.round(screenX), Math.round(screenY + Math.max(1, w) - 3), Math.max(1, Math.floor(w * frac)), 3);
    }
  }

  // Handle socket updates for single pixel placed by others
  function onSocketPixelPlaced(data) {
    // Expected data: { x, y, color, owner? }
    if (!data || typeof data.x !== "number") return;
    const key = tileKeyFor(data.x, data.y);
    // If we have tile, update pixel in-place, else fetch tile region later
    if (tileCache.has(key)) {
      const t = tileCache.get(key);
      t.pixels.set(`${data.x}_${data.y}`, data.color);
      touchTile(key);
    } else {
      // we'll fetch missing tiles on next scheduled load
      scheduleFetchVisible();
    }
    render();
  }

  // Place a pixel (user action)
  // This function handles getting an ID token from Firebase (frontend auth),
  // calling server API, handling server response (cooldown), and marking pending fill.
  async function placePixelAt(wx, wy, color) {
    // sanity
    if (!Number.isInteger(wx) || !Number.isInteger(wy)) throw new Error("Invalid world coords");
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid color format");

    // get firebase idToken if auth is present
    let idToken = null;
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        idToken = await firebase.auth().currentUser.getIdToken();
      } else {
        alert("Sign in required to paint");
        return { success: false, error: "not-authenticated" };
      }
    } catch (e) {
      console.error("Failed to get idToken", e);
      return { success: false, error: "token-failed" };
    }

    // optimistic UI: mark pending fill locally (server will reconcile)
    const key = `${wx}_${wy}`;
    const now = Date.now();
    const fillMs = DEFAULT_COOLDOWN_MS; // server will return actual cooldown on success; fallback
    pendingFills.set(key, { untilMs: now + fillMs, color, totalMs: fillMs });

    render();

    // call API
    try {
      const resp = await fetch("/api/pixels/place", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer " + idToken,
        },
        body: JSON.stringify({ x: wx, y: wy, color }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        // remove pending fill
        pendingFills.delete(key);
        render();
        return { success: false, error: data.error || "place-failed" };
      }
      // if server returned cooldownUntil, adjust pending fill duration
      if (data.cooldownUntil) {
        pendingFills.set(key, { untilMs: data.cooldownUntil, color, totalMs: data.cooldownUntil - now });
      } else {
        // schedule to remove pending fill after default
        pendingFills.set(key, { untilMs: now + fillMs, color, totalMs: fillMs });
      }
      // broadcast (server or socket will also broadcast; local update can be done here)
      // update local cache immediately so user sees the pixel once filled
      setTimeout(() => {
        // when fill done, move pixel into cache (server likely already wrote)
        // We'll fetch tile for reliability
        const tk = tileKeyFor(wx, wy);
        if (tileCache.has(tk)) {
          tileCache.get(tk).pixels.set(key, color);
        } else {
          // fetch the tile containing this pixel
          const { left, top, right, bottom } = tileBoundsFromKey(tk);
          fetchBox(left, top, right, bottom).then((pixels) => {
            setTilePixels(tk, pixels);
            render();
          });
        }
      }, Math.max(50, (data.cooldownUntil ? (data.cooldownUntil - now) : fillMs)));

      return { success: true, server: data };
    } catch (err) {
      console.error("placePixel error", err);
      pendingFills.delete(key);
      render();
      return { success: false, error: err.message };
    }
  }

  // Interaction handlers (pan/zoom/click)
  canvas.addEventListener("mousedown", (e) => {
    isDragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mouseup", () => {
    isDragging = false;
    lastPointer = null;
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = (e.clientX - lastPointer.x) / zoom;
    const dy = (e.clientY - lastPointer.y) / zoom;
    offsetX -= dx;
    offsetY -= dy;
    lastPointer = { x: e.clientX, y: e.clientY };
    scheduleFetchVisible();
    render();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    // compute pointer world pos to zoom towards pointer
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [beforeWx, beforeWy] = screenToWorld(px, py);
    const delta = -e.deltaY * 0.001;
    const newZoom = clamp(zoom * (1 + delta), 0.05, 8);
    zoom = newZoom;
    // adjust offset so the world point under pointer stays stationary
    const [afterSx, afterSy] = worldToScreen(beforeWx, beforeWy);
    const screenDx = px - afterSx;
    const screenDy = py - afterSy;
    offsetX -= screenDx / zoom;
    offsetY -= screenDy / zoom;
    scheduleFetchVisible();
    render();
  }, { passive: false });

  // Click to place pixel (single pixel)
  canvas.addEventListener("click", async (ev) => {
    // ignore clicks that were part of drag
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    // clamp coords
    if (wx < 0 || wx >= GRID_LIMIT || wy < 0 || wy >= GRID_LIMIT) return;
    const res = await placePixelAt(wx, wy, currentColor);
    if (!res.success) {
      if (res.error === "Cooldown") {
        // server may return structured cooldown info — display later through UI
        console.warn("On cooldown:", res);
      } else {
        alert("Place failed: " + (res.error || "unknown"));
      }
    } else {
      // success: already handled by pending fill & tile update
    }
  });

  // Programmatic API exposed to other frontend modules:
  const API = {
    setColor: (hex) => { if (/^#[0-9a-fA-F]{6}$/.test(hex)) currentColor = hex; else console.warn("Invalid color", hex); },
    getColor: () => currentColor,
    centerOn: (wx, wy) => { offsetX = wx; offsetY = wy; scheduleFetchVisible(); render(); },
    loadRegion: (left, top, right, bottom) => fetchBox(left, top, right, bottom).then((pixels) => {
      // bucket pixels into tiles
      const tileBuckets = new Map();
      for (const p of pixels) {
        const key = tileKeyFor(p.x, p.y);
        if (!tileBuckets.has(key)) tileBuckets.set(key, []);
        tileBuckets.get(key).push(p);
      }
      for (const [k, arr] of tileBuckets) setTilePixels(k, arr);
      render();
    }),
    redraw: () => render(),
    getCacheStats: () => ({ tiles: tileCache.size }),
    // expose placePixel (for UI "paint" button to paint repeatedly)
    placePixelAt,
  };

  // initialization
  function init() {
    ensureCanvasSize();
    window.addEventListener("resize", () => { ensureCanvasSize(); scheduleFetchVisible(); render(); });
    scheduleFetchVisible(); // initial load
    // small animation loop for pending fills cleanup & redraws
    setInterval(() => {
      // remove expired pending fills
      const now = Date.now();
      let changed = false;
      for (const [k, p] of pendingFills) {
        if (p.untilMs <= now) {
          pendingFills.delete(k);
          changed = true;
        }
      }
      if (changed) render();
    }, 250);
  }

  // expose API to global so other scripts can use it
  window.PixelCanvas = API;

  // start
  init();

  // helper: debug hook to pre-load area around center
  window.__preloadCenter = function (radius = 200) {
    const left = Math.floor(offsetX - radius);
    const top = Math.floor(offsetY - radius);
    const right = Math.floor(offsetX + radius);
    const bottom = Math.floor(offsetY + radius);
    API.loadRegion(left, top, right, bottom);
  };
})();
=======
// public/canvas.js
// Production-ready canvas renderer & pixel interaction layer for PixelCanvas
// - requires: <canvas id="pixelCanvas"> in DOM
// - expects server endpoints: /api/pixels/box (GET) and /api/pixels/place (POST)
// - expects Socket.IO client connected as `io()` (socket emits 'pixelPlaced')
// - uses window.env for public config (server exposes /env.js) if needed

(function () {
  // Config (tweak if needed)
  const TILE_SIZE = 64; // logical pixels per tile (server-side tiling recommended later)
  const CACHE_TILE_LIMIT = 500; // number of tiles to keep in cache
  const FETCH_DEBOUNCE_MS = 120; // debounce for viewport load
  const MAX_BOX_PIXELS = 2000; // server limit (consistent with routes)
  const DEFAULT_COOLDOWN_MS = 10000; // fallback
  const GRID_LIMIT = 10000; // logical board size (0..GRID_LIMIT-1)
  const BASE_ZOOM = 1.0; // starting scale multiplier for logical pixel -> screen px

  // DOM / Canvas setup
  const canvas = document.getElementById("pixelCanvas");
  if (!canvas) throw new Error("No canvas#pixelCanvas element found");
  const ctx = canvas.getContext("2d", { alpha: false });

  // Offscreen canvas for drawing tiles (helps reduce flicker)
  const offscreen = document.createElement("canvas");
  const offctx = offscreen.getContext("2d", { alpha: false });

  // Device pixel ratio handling
  const DPR = window.devicePixelRatio || 1;

  // Viewport / world state
  let viewport = { width: window.innerWidth, height: window.innerHeight };
  let zoom = 0.5; // logical pixels -> screen px multiplier
  let offsetX = GRID_LIMIT / 2; // world center coordinate (logical)
  let offsetY = GRID_LIMIT / 2;
  let isDragging = false;
  let lastPointer = null;

  // Pixel cache: map tileKey -> { pixels: Map("x_y"->color), ts }
  const tileCache = new Map(); // insertion order used for simple LRU eviction

  // Optional: map of pending server placements to show "filling" animation locally
  const pendingFills = new Map(); // key -> { untilMs, color, owner }

  // Current color (exposed setter)
  let currentColor = "#ff4d6d";

  // Socket.io (assumes socket script included and connection established)
  let socket = null;
  if (typeof io !== "undefined") {
    try {
      socket = io();
      socket.on("connect", () => console.log("socket connected:", socket.id));
      socket.on("pixelPlaced", onSocketPixelPlaced);
    } catch (e) {
      console.warn("Socket.io not available or failed:", e);
    }
  }

  // Utility helpers
  function worldToScreen(wx, wy) {
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    return [cx + (wx - offsetX) * zoom, cy + (wy - offsetY) * zoom];
  }
  function screenToWorld(sx, sy) {
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    return [
      Math.floor((sx - cx) / zoom + offsetX),
      Math.floor((sy - cy) / zoom + offsetY),
    ];
  }
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function tileKeyFor(x, y) {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    return `${tx}_${ty}`;
  }
  function tileBoundsFromKey(key) {
    const [tx, ty] = key.split("_").map(Number);
    const left = tx * TILE_SIZE;
    const top = ty * TILE_SIZE;
    const right = left + TILE_SIZE - 1;
    const bottom = top + TILE_SIZE - 1;
    return { tx, ty, left, top, right, bottom };
  }
  function ensureCanvasSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    viewport.width = w;
    viewport.height = h;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Offscreen should match canvas size for safe blitting (we'll scale tiles inside though)
    offscreen.width = Math.max(512, Math.round(w * DPR));
    offscreen.height = Math.max(512, Math.round(h * DPR));
  }

  // LRU cache eviction
  function touchTile(key) {
    if (!tileCache.has(key)) return;
    const v = tileCache.get(key);
    tileCache.delete(key);
    v.ts = Date.now();
    tileCache.set(key, v);
    if (tileCache.size > CACHE_TILE_LIMIT) {
      // evict oldest
      const firstKey = tileCache.keys().next().value;
      tileCache.delete(firstKey);
    }
  }

  function setTilePixels(key, pixelsObj) {
    // pixelsObj: array of {x,y,color} or map-like object
    const map = new Map();
    if (Array.isArray(pixelsObj)) {
      pixelsObj.forEach((p) => {
        map.set(`${p.x}_${p.y}`, p.color);
      });
    } else if (pixelsObj && typeof pixelsObj === "object") {
      Object.keys(pixelsObj).forEach((k) => map.set(k, pixelsObj[k]));
    }
    tileCache.set(key, { pixels: map, ts: Date.now() });
    touchTile(key);
  }

  async function fetchBox(left, top, right, bottom) {
    // Sanitize & clamp
    left = clamp(Math.floor(left), 0, GRID_LIMIT - 1);
    top = clamp(Math.floor(top), 0, GRID_LIMIT - 1);
    right = clamp(Math.floor(right), 0, GRID_LIMIT - 1);
    bottom = clamp(Math.floor(bottom), 0, GRID_LIMIT - 1);

    // server limit awareness: if box too big, split into smaller requests
    const width = right - left + 1;
    const height = bottom - top + 1;
    const area = width * height;
    const maxSingle = Math.max(100, MAX_BOX_PIXELS);
    const results = [];

    // naive split: horizontal slices
    if (area <= maxSingle) {
      try {
        const q = `/api/pixels/box?left=${left}&top=${top}&right=${right}&bottom=${bottom}&limit=${MAX_BOX_PIXELS}`;
        const resp = await fetch(q, { cache: "no-store" });
        if (!resp.ok) throw new Error("Fetch box failed: " + resp.status);
        const data = await resp.json();
        return data; // array of {x,y,color}
      } catch (err) {
        console.error("fetchBox error", err);
        return [];
      }
    } else {
      // split into vertical strips
      const cols = Math.ceil(area / maxSingle);
      const sliceW = Math.ceil(width / cols);
      for (let i = 0; i < cols; i++) {
        const l = left + i * sliceW;
        const r = Math.min(right, l + sliceW - 1);
        try {
          const resp = await fetch(`/api/pixels/box?left=${l}&top=${top}&right=${r}&bottom=${bottom}&limit=${MAX_BOX_PIXELS}`, { cache: "no-store" });
          if (!resp.ok) throw new Error("Fetch chunk failed: " + resp.status);
          const d = await resp.json();
          results.push(...d);
        } catch (err) {
          console.error("fetchBox chunk error", err);
        }
      }
      return results;
    }
  }

  // Compute tiles that intersect current viewport plus padding
  function tilesInView(paddingTiles = 1) {
    // compute visible logical coordinates
    const cx = offsetX;
    const cy = offsetY;
    const halfW = (viewport.width / 2) / zoom;
    const halfH = (viewport.height / 2) / zoom;
    const left = Math.floor(cx - halfW) - paddingTiles * TILE_SIZE;
    const top = Math.floor(cy - halfH) - paddingTiles * TILE_SIZE;
    const right = Math.ceil(cx + halfW) + paddingTiles * TILE_SIZE;
    const bottom = Math.ceil(cy + halfH) + paddingTiles * TILE_SIZE;

    const tLeft = Math.floor(Math.max(0, left) / TILE_SIZE);
    const tTop = Math.floor(Math.max(0, top) / TILE_SIZE);
    const tRight = Math.floor(Math.max(0, right) / TILE_SIZE);
    const tBottom = Math.floor(Math.max(0, bottom) / TILE_SIZE);

    const keys = [];
    for (let ty = tTop; ty <= tBottom; ty++) {
      for (let tx = tLeft; tx <= tRight; tx++) {
        keys.push(`${tx}_${ty}`);
      }
    }
    return keys;
  }

  // Load tiles for the viewport, debounced
  let fetchTimer = null;
  function scheduleFetchVisible() {
    if (fetchTimer) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(loadVisibleTiles, FETCH_DEBOUNCE_MS);
  }

  async function loadVisibleTiles() {
    fetchTimer = null;
    const keys = tilesInView(1);
    // For each tile not in cache, fetch pixels inside tile bounds
    const toFetch = [];
    const tileRequests = [];
    for (const key of keys) {
      if (!tileCache.has(key)) {
        const { left, top, right, bottom } = tileBoundsFromKey(key);
        toFetch.push({ key, left, top, right, bottom });
      } else {
        touchTile(key);
      }
    }
    // Group requests into reasonable box queries per contiguous ranges (naive)
    for (const t of toFetch) {
      tileRequests.push(fetchBox(t.left, t.top, t.right, t.bottom).then((pixels) => {
        // pixels is array of {x,y,color}
        setTilePixels(t.key, pixels);
      }).catch((e) => {
        console.error("Tile fetch failed:", t.key, e);
      }));
    }
    await Promise.allSettled(tileRequests);
    render(); // redraw when new tiles arrive
  }

  // Rendering: draws cached pixels visible in viewport onto canvas
  function render() {
    // clear
    ctx.clearRect(0, 0, canvas.width / DPR, canvas.height / DPR);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);

    // iterate visible tiles (to reduce overdraw)
    const keys = tilesInView(0);
    const pxSize = Math.max(1, Math.floor(zoom)); // on-screen pixel size
    for (const key of keys) {
      const t = tileCache.get(key);
      if (!t) continue;
      // draw each pixel in tile
      for (const [k, color] of t.pixels.entries()) {
        const [sx, sy] = k.split("_").map(Number);
        // check bounds quickly
        const [screenX, screenY] = worldToScreen(sx, sy);
        // small optimization: check if on-screen (allow pxSize slack)
        if (screenX + pxSize < 0 || screenX - pxSize > viewport.width || screenY + pxSize < 0 || screenY - pxSize > viewport.height) continue;
        ctx.fillStyle = color;
        // draw rectangle representing logical pixel at current zoom
        ctx.fillRect(Math.round(screenX), Math.round(screenY), Math.max(1, pxSize), Math.max(1, pxSize));
      }
    }

    // pending fills overlay (in-progress placed pixels)
    const now = Date.now();
    for (const [k, p] of pendingFills.entries()) {
      const [sx, sy] = k.split("_").map(Number);
      const [screenX, screenY] = worldToScreen(sx, sy);
      const remain = p.untilMs - now;
      if (remain <= 0) {
        pendingFills.delete(k);
        continue;
      }
      // draw radial progress (simple rectangle bar)
      const w = Math.max(1, Math.floor(zoom));
      ctx.fillStyle = p.color + "88"; // semi-transparent
      ctx.fillRect(Math.round(screenX), Math.round(screenY), Math.max(1, w), Math.max(1, w));
      // small progress indicator
      const frac = (p.totalMs ? (p.totalMs - remain) / p.totalMs : 0.6);
      ctx.fillStyle = "#00000066";
      ctx.fillRect(Math.round(screenX), Math.round(screenY + Math.max(1, w) - 3), Math.max(1, Math.floor(w * frac)), 3);
    }
  }

  // Handle socket updates for single pixel placed by others
  function onSocketPixelPlaced(data) {
    // Expected data: { x, y, color, owner? }
    if (!data || typeof data.x !== "number") return;
    const key = tileKeyFor(data.x, data.y);
    // If we have tile, update pixel in-place, else fetch tile region later
    if (tileCache.has(key)) {
      const t = tileCache.get(key);
      t.pixels.set(`${data.x}_${data.y}`, data.color);
      touchTile(key);
    } else {
      // we'll fetch missing tiles on next scheduled load
      scheduleFetchVisible();
    }
    render();
  }

  // Place a pixel (user action)
  // This function handles getting an ID token from Firebase (frontend auth),
  // calling server API, handling server response (cooldown), and marking pending fill.
  async function placePixelAt(wx, wy, color) {
    // sanity
    if (!Number.isInteger(wx) || !Number.isInteger(wy)) throw new Error("Invalid world coords");
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid color format");

    // get firebase idToken if auth is present
    let idToken = null;
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        idToken = await firebase.auth().currentUser.getIdToken();
      } else {
        alert("Sign in required to paint");
        return { success: false, error: "not-authenticated" };
      }
    } catch (e) {
      console.error("Failed to get idToken", e);
      return { success: false, error: "token-failed" };
    }

    // optimistic UI: mark pending fill locally (server will reconcile)
    const key = `${wx}_${wy}`;
    const now = Date.now();
    const fillMs = DEFAULT_COOLDOWN_MS; // server will return actual cooldown on success; fallback
    pendingFills.set(key, { untilMs: now + fillMs, color, totalMs: fillMs });

    render();

    // call API
    try {
      const resp = await fetch("/api/pixels/place", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer " + idToken,
        },
        body: JSON.stringify({ x: wx, y: wy, color }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        // remove pending fill
        pendingFills.delete(key);
        render();
        return { success: false, error: data.error || "place-failed" };
      }
      // if server returned cooldownUntil, adjust pending fill duration
      if (data.cooldownUntil) {
        pendingFills.set(key, { untilMs: data.cooldownUntil, color, totalMs: data.cooldownUntil - now });
      } else {
        // schedule to remove pending fill after default
        pendingFills.set(key, { untilMs: now + fillMs, color, totalMs: fillMs });
      }
      // broadcast (server or socket will also broadcast; local update can be done here)
      // update local cache immediately so user sees the pixel once filled
      setTimeout(() => {
        // when fill done, move pixel into cache (server likely already wrote)
        // We'll fetch tile for reliability
        const tk = tileKeyFor(wx, wy);
        if (tileCache.has(tk)) {
          tileCache.get(tk).pixels.set(key, color);
        } else {
          // fetch the tile containing this pixel
          const { left, top, right, bottom } = tileBoundsFromKey(tk);
          fetchBox(left, top, right, bottom).then((pixels) => {
            setTilePixels(tk, pixels);
            render();
          });
        }
      }, Math.max(50, (data.cooldownUntil ? (data.cooldownUntil - now) : fillMs)));

      return { success: true, server: data };
    } catch (err) {
      console.error("placePixel error", err);
      pendingFills.delete(key);
      render();
      return { success: false, error: err.message };
    }
  }

  // Interaction handlers (pan/zoom/click)
  canvas.addEventListener("mousedown", (e) => {
    isDragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mouseup", () => {
    isDragging = false;
    lastPointer = null;
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = (e.clientX - lastPointer.x) / zoom;
    const dy = (e.clientY - lastPointer.y) / zoom;
    offsetX -= dx;
    offsetY -= dy;
    lastPointer = { x: e.clientX, y: e.clientY };
    scheduleFetchVisible();
    render();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    // compute pointer world pos to zoom towards pointer
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [beforeWx, beforeWy] = screenToWorld(px, py);
    const delta = -e.deltaY * 0.001;
    const newZoom = clamp(zoom * (1 + delta), 0.05, 8);
    zoom = newZoom;
    // adjust offset so the world point under pointer stays stationary
    const [afterSx, afterSy] = worldToScreen(beforeWx, beforeWy);
    const screenDx = px - afterSx;
    const screenDy = py - afterSy;
    offsetX -= screenDx / zoom;
    offsetY -= screenDy / zoom;
    scheduleFetchVisible();
    render();
  }, { passive: false });

  // Click to place pixel (single pixel)
  canvas.addEventListener("click", async (ev) => {
    // ignore clicks that were part of drag
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    // clamp coords
    if (wx < 0 || wx >= GRID_LIMIT || wy < 0 || wy >= GRID_LIMIT) return;
    const res = await placePixelAt(wx, wy, currentColor);
    if (!res.success) {
      if (res.error === "Cooldown") {
        // server may return structured cooldown info — display later through UI
        console.warn("On cooldown:", res);
      } else {
        alert("Place failed: " + (res.error || "unknown"));
      }
    } else {
      // success: already handled by pending fill & tile update
    }
  });

  // Programmatic API exposed to other frontend modules:
  const API = {
    setColor: (hex) => { if (/^#[0-9a-fA-F]{6}$/.test(hex)) currentColor = hex; else console.warn("Invalid color", hex); },
    getColor: () => currentColor,
    centerOn: (wx, wy) => { offsetX = wx; offsetY = wy; scheduleFetchVisible(); render(); },
    loadRegion: (left, top, right, bottom) => fetchBox(left, top, right, bottom).then((pixels) => {
      // bucket pixels into tiles
      const tileBuckets = new Map();
      for (const p of pixels) {
        const key = tileKeyFor(p.x, p.y);
        if (!tileBuckets.has(key)) tileBuckets.set(key, []);
        tileBuckets.get(key).push(p);
      }
      for (const [k, arr] of tileBuckets) setTilePixels(k, arr);
      render();
    }),
    redraw: () => render(),
    getCacheStats: () => ({ tiles: tileCache.size }),
    // expose placePixel (for UI "paint" button to paint repeatedly)
    placePixelAt,
  };

  // initialization
  function init() {
    ensureCanvasSize();
    window.addEventListener("resize", () => { ensureCanvasSize(); scheduleFetchVisible(); render(); });
    scheduleFetchVisible(); // initial load
    // small animation loop for pending fills cleanup & redraws
    setInterval(() => {
      // remove expired pending fills
      const now = Date.now();
      let changed = false;
      for (const [k, p] of pendingFills) {
        if (p.untilMs <= now) {
          pendingFills.delete(k);
          changed = true;
        }
      }
      if (changed) render();
    }, 250);
  }

  // expose API to global so other scripts can use it
  window.PixelCanvas = API;

  // start
  init();

  // helper: debug hook to pre-load area around center
  window.__preloadCenter = function (radius = 200) {
    const left = Math.floor(offsetX - radius);
    const top = Math.floor(offsetY - radius);
    const right = Math.floor(offsetX + radius);
    const bottom = Math.floor(offsetY + radius);
    API.loadRegion(left, top, right, bottom);
  };
})();
>>>>>>> e07027fe (Add compression to dependencies)
