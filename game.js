// =========================
// CONFIG FIREBASE
// =========================
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getDatabase, ref, set, onValue, remove } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "MET_TA_CLE_ICI",
  authDomain: "TON_PROJET.firebaseapp.com",
  databaseURL: "https://TON_PROJET.firebaseio.com",
  projectId: "TON_PROJET",
  storageBucket: "TON_PROJET.appspot.com",
  messagingSenderId: "000000000",
  appId: "1:000000000:web:abcd12345"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// =========================
// VARIABLES DU JEU
// =========================
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

let players = {}; // tous les joueurs
let myId = null;
let myPlayer = { x: 450, y: 300, color: "", name: "" };

const gameRef = ref(db, "game/players");

// =========================
// GÉNÉRER COULEUR RANDOM
// =========================
function randomColor() {
  return `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`;
}

// =========================
// JOINDRE LE JEU
// =========================
document.getElementById("connectBtn").onclick = () => {
  const username = document.getElementById("username").value;
  if (!username) return alert("Entre un pseudo");

  myId = "P" + Date.now();
  myPlayer = {
    x: 450,
    y: 300,
    color: randomColor(),
    name: username
  };

  set(ref(db, "game/players/" + myId), myPlayer);
  document.getElementById("status").innerText = "Connecté ✔";
};

// =========================
// SYNC DES JOUEURS
// =========================
onValue(gameRef, snap => {
  players = snap.val() || {};
});

// =========================
// SUPPRESSION À LA SORTIE
// =========================
window.addEventListener("beforeunload", () => {
  if (myId) remove(ref(db, "game/players/" + myId));
});

// =========================
// CONTROLES
// =========================
const keys = {};
window.onkeydown = e => (keys[e.key] = true);
window.onkeyup = e => (keys[e.key] = false);

// =========================
// BOUCLE DE JEU
// =========================
function loop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Déplacement
  if (myId) {
    if (keys["w"]) myPlayer.y -= 3;
    if (keys["s"]) myPlayer.y += 3;
    if (keys["a"]) myPlayer.x -= 3;
    if (keys["d"]) myPlayer.x += 3;

    set(ref(db, "game/players/" + myId), myPlayer);
  }

  // Afficher les joueurs
  for (let id in players) {
    const p = players[id];
    if (!p) continue;

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "white";
    ctx.font = "14px Arial";
    ctx.fillText(p.name, p.x - 20, p.y - 20);
  }

  requestAnimationFrame(loop);
}

loop();
