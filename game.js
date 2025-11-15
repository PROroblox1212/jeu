// game.js (Supabase Realtime client)
// Requirements: create the tables in supabase_schema.sql (plus policies for dev)
// Usage: set SUPABASE_URL and SUPABASE_ANON_KEY below

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://REPLACE.supabase.co';
const SUPABASE_ANON_KEY = 'REPLACE_ANON_KEY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Canvas ---
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = 1200; canvas.height = 700;

// --- UI ---
const usernameEl = document.getElementById('username');
const roomEl = document.getElementById('room');
const connectBtn = document.getElementById('connectBtn');
const statusEl = document.getElementById('status');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const shopBtn = document.getElementById('shopBtn');
const scoresEl = document.getElementById('scores');
const modeSel = document.getElementById('mode');

// --- Game state ---
let localId = null;
let localPlayer = null;
let players = {};   // from DB -> {id: {x,y,name,color,score,skin,last_seen}}
let bullets = [];   // local bullets, optionally persisted
let currentRoom = 'default';
const map = { w: 2400, h: 1400 };
const camera = { x: 0, y: 0, w: canvas.width, h: canvas.height };

// Input
const keys = {};
window.addEventListener('keydown', e => keys[e.key] = true);
window.addEventListener('keyup', e => keys[e.key] = false);
canvas.addEventListener('mousedown', e => fireBullet(e));

// helpers
const now = () => Date.now();
const randColor = () => `hsl(${Math.floor(Math.random()*360)} 70% 60%)`;

// --- Connect / join room ---
connectBtn.onclick = async () => {
  const name = usernameEl.value.trim() || 'Player' + Math.floor(Math.random()*9999);
  currentRoom = roomEl.value.trim() || 'default';
  localId = 'p' + Date.now() + Math.floor(Math.random()*999);
  localPlayer = {
    id: localId,
    name,
    room: currentRoom,
    x: map.w/2 + Math.random()*40-20,
    y: map.h/2 + Math.random()*40-20,
    color: randColor(),
    skin: 'default',
    score: 0,
    last_seen: now()
  };

  // upsert into players table
  await supabase.from('players').upsert(localPlayer).select();

  statusEl.innerText = `Connecté — ${localId} • room: ${currentRoom}`;
  subscribeRealtime(currentRoom);
  startHeartbeat();
};

// --- Heartbeat (update position / last_seen) ---
let heartbeatTimer = null;
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    if (!localPlayer) return;
    localPlayer.last_seen = now();
    // optimistic local write: we update DB each tick (small payload)
    await supabase.from('players').upsert(localPlayer);
  }, 120);
}

// --- Realtime subscription with Postgres changes ---
let playersSubscription = null;
let chatSubscription = null;
let bulletsSubscription = null;

async function subscribeRealtime(room) {
  // unsubscribe existing
  if (playersSubscription) {
    await supabase.removeChannel(playersSubscription);
    playersSubscription = null;
  }
  if (chatSubscription) { await supabase.removeChannel(chatSubscription); chatSubscription = null; }
  if (bulletsSubscription) { await supabase.removeChannel(bulletsSubscription); bulletsSubscription = null; }

  // Subscribe to players table changes filtered by room
  playersSubscription = supabase.channel(`public:players:room=${room}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room=eq.${room}` },
      payload => {
        const ev = payload.eventType;
        if (ev === 'INSERT' || ev === 'UPDATE') {
          players[payload.record.id] = payload.record;
        } else if (ev === 'DELETE') {
          delete players[payload.old.id];
        }
      })
    .subscribe();

  // Subscribe to chat (room)
  chatSubscription = supabase.channel(`public:chat:room=${room}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat', filter: `room=eq.${room}` },
      payload => {
        appendChat(payload.record.name, payload.record.text);
      })
    .subscribe();

  // Subscribe to bullets if you want server-authoritative bullets (optional)
  bulletsSubscription = supabase.channel(`public:bullets:room=${room}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bullets', filter: `room=eq.${room}` },
      payload => {
        // handle bullets if persisted
        // INSERT => add, DELETE => remove
      })
    .subscribe();

  // initial fetch of players and chat
  const { data: pRows } = await supabase.from('players').select('*').eq('room', room);
  players = {};
  for (const r of pRows) players[r.id] = r;

  const { data: chats } = await supabase.from('chat').select('*').eq('room', room).order('created_at', { ascending: true }).limit(200);
  for (const c of chats) appendChat(c.name, c.text);
}

// --- Chat ---
chatSend.onclick = async () => {
  const text = chatInput.value.trim();
  if (!text || !localPlayer) return;
  await supabase.from('chat').insert({ room: currentRoom, name: localPlayer.name, text });
  chatInput.value = '';
};
function appendChat(name, text) {
  const el = document.createElement('div');
  el.innerText = `${name}: ${text}`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// --- Shooting (client-side + optional server persistence) ---
function fireBullet(evt) {
  if (!localPlayer) return;
  // Get angle from player to mouse
  const rect = canvas.getBoundingClientRect();
  const mx = evt.clientX - rect.left + camera.x;
  const my = evt.clientY - rect.top + camera.y;
  const dx = mx - localPlayer.x;
  const dy = my - localPlayer.y;
  const len = Math.hypot(dx, dy) || 1;
  const speed = 800; // px / s for bullet
  const vx = (dx / len) * speed;
  const vy = (dy / len) * speed;

  // local bullet (visual)
  bullets.push({ x: localPlayer.x, y: localPlayer.y, vx, vy, owner: localId, life: 200 });

  // optionally persist bullet (server can validate & broadcast)
  // await supabase.from('bullets').insert({ room: currentRoom, x: localPlayer.x, y: localPlayer.y, vx, vy, owner: localId });
}

// --- Game update loop ---
let last = performance.now();
function update(dt) {
  if (!localPlayer) return;
  // Movement control
  const speed = 300; // px / s
  let mvx = 0, mvy = 0;
  if (keys['w'] || keys['ArrowUp']) mvy -= speed * dt;
  if (keys['s'] || keys['ArrowDown']) mvy += speed * dt;
  if (keys['a'] || keys['ArrowLeft']) mvx -= speed * dt;
  if (keys['d'] || keys['ArrowRight']) mvx += speed * dt;
  localPlayer.x = Math.max(16, Math.min(map.w-16, localPlayer.x + mvx));
  localPlayer.y = Math.max(16, Math.min(map.h-16, localPlayer.y + mvy));

  // update local player DB record occasionally (heartbeat handles frequent upserts)
  // bullets movement
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life--;
    if (b.life <= 0 || b.x < 0 || b.x > map.w || b.y < 0 || b.y > map.h) bullets.splice(i, 1);
    else {
      // collisions (client-side prediction): check other players locally
      for (const id in players) {
        if (id === localId) continue;
        const p = players[id];
        if (!p) continue;
        const dx = p.x - b.x, dy = p.y - b.y;
        if (dx*dx + dy*dy < 20*20) {
          // hit detected locally: increment owner's score, decrement target
          if (b.owner === localId) localPlayer.score = (localPlayer.score || 0) + 50;
          players[id].score = (players[id].score || 0) - 10;
          // persist score changes (optional; in prod, server should handle)
          supabase.from('players').upsert({ id: localId, score: localPlayer.score, room: currentRoom }).catch(()=>{});
          supabase.from('players').upsert({ id, score: players[id].score, room: currentRoom }).catch(()=>{});
          bullets.splice(i,1);
          break;
        }
      }
    }
  }

  // Camera follow
  camera.x = Math.floor(localPlayer.x - camera.w/2);
  camera.y = Math.floor(localPlayer.y - camera.h/2);
  camera.x = Math.max(0, Math.min(map.w - camera.w, camera.x));
  camera.y = Math.max(0, Math.min(map.h - camera.h, camera.y));
}

function draw() {
  // Background
  ctx.fillStyle = '#061029'; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.save(); ctx.translate(-camera.x, -camera.y);

  // Grid
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let gx = 0; gx < map.w; gx += 80) ctx.fillRect(gx, 0, 1, map.h);
  for (let gy = 0; gy < map.h; gy += 80) ctx.fillRect(0, gy, map.w, 1);

  // players
  for (const id in players) {
    const p = players[id];
    if (!p) continue;
    // fade if not seen in a while
    if (now() - (p.last_seen || 0) > 15000) continue;
    ctx.beginPath(); ctx.fillStyle = p.color || '#fff'; ctx.arc(p.x, p.y, 16, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'white'; ctx.font = '14px Arial'; ctx.fillText(p.name, p.x - 20, p.y - 26);
  }

  // bullets
  for (const b of bullets) {
    ctx.beginPath(); ctx.fillStyle = '#ffd700'; ctx.arc(b.x, b.y, 5, 0, Math.PI*2); ctx.fill();
  }

  ctx.restore();

  // scoreboard UI
  scoresEl.innerHTML = '';
  const arr = Object.values(players).map(p => ({ name: p.name, score: p.score || 0, color: p.color })).sort((a,b)=>b.score - a.score);
  for (const a of arr.slice(0,8)) {
    const el = document.createElement('div'); el.innerText = `${a.name} — ${a.score}`; el.style.color = a.color; scoresEl.appendChild(el);
  }
}

// Main loop
function tick(t) {
  const dt = Math.min(40, t - last) / 1000;
  last = t;
  update(dt);
  draw();
  requestAnimationFrame(tick);
}
let last = performance.now();
requestAnimationFrame(tick);

// --- cleanup on unload ---
window.addEventListener('beforeunload', async () => {
  if (!localId) return;
  await supabase.from('players').delete().eq('id', localId).eq('room', currentRoom);
});

// --- shop: simple local UI placeholder ---
shopBtn.onclick = () => {
  alert('Shop: à implémenter (acheter des skins → sauvegarder dans table profiles).');
};
