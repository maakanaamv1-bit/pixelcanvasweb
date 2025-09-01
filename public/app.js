// app.js - frontend: Firebase auth + canvas interactions + UI
// Requires: firebase-config.js, server endpoints, Socket.IO
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ---------- Socket & Canvas Setup ----------
const socket = io();
const canvas = document.getElementById("pixelCanvas");
const ctx = canvas.getContext("2d");
const BOARD_SIZE = 10000;

let viewport = { width: window.innerWidth, height: window.innerHeight };
let zoom = 0.5;
let offsetX = BOARD_SIZE / 2,
  offsetY = BOARD_SIZE / 2;
const pixelCache = new Map();
let cooldownUntil = 0;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  viewport.width = canvas.width;
  viewport.height = canvas.height;
  render();
}
window.addEventListener("resize", resize);
resize();

// ---------- Coordinate Helpers ----------
function worldToScreen(wx, wy) {
  const cx = viewport.width / 2,
    cy = viewport.height / 2;
  return [cx + (wx - offsetX) * zoom, cy + (wy - offsetY) * zoom];
}
function screenToWorld(sx, sy) {
  const cx = viewport.width / 2,
    cy = viewport.height / 2;
  return [
    Math.floor((sx - cx) / zoom + offsetX),
    Math.floor((sy - cy) / zoom + offsetY),
  ];
}

// ---------- Canvas Pan & Zoom ----------
canvas.addEventListener("mousedown", (e) => {
  canvas.isDragging = true;
  canvas.last = { x: e.clientX, y: e.clientY };
});
window.addEventListener("mouseup", () => {
  canvas.isDragging = false;
});
canvas.addEventListener("mousemove", (e) => {
  if (canvas.isDragging) {
    const dx = (e.clientX - canvas.last.x) / zoom;
    const dy = (e.clientY - canvas.last.y) / zoom;
    offsetX -= dx;
    offsetY -= dy;
    canvas.last = { x: e.clientX, y: e.clientY };
    render();
  }
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoom *= 1 - e.deltaY * 0.001;
    zoom = Math.max(0.05, Math.min(8, zoom));
    render();
  },
  { passive: false }
);

// ---------- Rendering ----------
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const [k, color] of pixelCache.entries()) {
    const [x, y] = k.split("_").map(Number);
    const [sx, sy] = worldToScreen(x, y);
    ctx.fillStyle = color;
    ctx.fillRect(
      Math.round(sx),
      Math.round(sy),
      Math.max(1, Math.floor(zoom)),
      Math.max(1, Math.floor(zoom))
    );
  }

  // cooldown overlay
  if (Date.now() < cooldownUntil) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(10, 10, 150, 40);
    ctx.fillStyle = "#fff";
    ctx.font = "16px Arial";
    ctx.fillText(`Cooldown: ${remaining}s`, 20, 35);
  }
}

// ---------- Realtime Pixel Updates ----------
socket.on("pixelPlaced", (data) => {
  const key = data.x + "_" + data.y;
  pixelCache.set(key, data.color);
  render();
});

// ---------- Color Palette ----------
const palette = [
  "#FF0000",
  "#FFA500",
  "#FFFF00",
  "#008000",
  "#0000FF",
  "#4B0082",
  "#EE82EE",
  "#000000",
  "#FFFFFF",
];
let currentColor = palette[0];

function renderPalette() {
  const paletteDiv = document.getElementById("palette");
  paletteDiv.innerHTML = "";
  palette.forEach((color) => {
    const btn = document.createElement("button");
    btn.style.background = color;
    btn.className = "palette-color";
    btn.onclick = () => (currentColor = color);
    paletteDiv.appendChild(btn);
  });
}
renderPalette();

// ---------- Place Pixel ----------
canvas.addEventListener("click", async (ev) => {
  if (!auth.currentUser) {
    alert("Please sign in to paint");
    return;
  }
  if (Date.now() < cooldownUntil) {
    alert("You are on cooldown!");
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const [wx, wy] = screenToWorld(sx, sy);
  const idToken = await auth.currentUser.getIdToken();
  fetch("/api/pixels/place", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + idToken,
    },
    body: JSON.stringify({ x: wx, y: wy, color: currentColor }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.success) {
        cooldownUntil = Date.now() + (res.cooldown || 5000); // default 5s
      } else alert(res.error || "Place failed");
    })
    .catch((e) => {
      console.error(e);
      alert("Network error");
    });
});

// ---------- Auth UI ----------
document.getElementById("btnProfile").addEventListener("click", async () => {
  if (!auth.currentUser) {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  } else {
    document.getElementById("panelProfile").classList.toggle("hidden");
  }
});

auth.onAuthStateChanged(async (user) => {
  if (user) {
    const token = await user.getIdToken();
    fetch("/api/users/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        uid: user.uid,
        displayName: user.displayName,
        photoURL: user.photoURL,
      }),
    });
    document.getElementById("freeCount").textContent = "100";
    document.getElementById("userName").textContent = user.displayName;
    document.getElementById("userAvatar").src = user.photoURL || "";
  } else {
    document.getElementById("freeCount").textContent = "0";
  }
});

// ---------- UI Toggles ----------
function $(s) {
  return document.querySelector(s);
}
$("#btnChat").addEventListener("click", () =>
  $("#panelChat").classList.toggle("hidden")
);
$("#btnLeaderboard").addEventListener("click", () =>
  $("#panelLeaderboard").classList.toggle("hidden")
);
$("#btnZoomIn").addEventListener("click", () => {
  zoom *= 1.2;
  render();
});
$("#btnZoomOut").addEventListener("click", () => {
  zoom /= 1.2;
  render();
});
$("#btnReset").addEventListener("click", () => {
  zoom = 0.5;
  offsetX = BOARD_SIZE / 2;
  offsetY = BOARD_SIZE / 2;
  render();
});

// ---------- Load Initial Pixels ----------
async function loadInitialPixels() {
  try {
    const res = await fetch("/api/pixels/all");
    const data = await res.json();
    data.forEach((p) => {
      const key = p.x + "_" + p.y;
      pixelCache.set(key, p.color);
    });
    render();
  } catch (e) {
    console.error("Failed to load pixels", e);
  }
}
loadInitialPixels();
