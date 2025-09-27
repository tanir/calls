const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin_password_change_me_now';
const JWT_SECRET = process.env.JWT_SECRET || 'jwt_signing_secret_change_me_now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'session_secret_change_me_now';
const TOKEN_TTL = process.env.TOKEN_TTL || '6h';

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for rooms: roomId -> Set of WebSocket connections
const rooms = new Map();

// Utility functions
function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Authentication routes
app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    req.session.auth = true;
    const next = (req.body && req.body.next) || '/';
    if (typeof next === 'string' && next.startsWith('/')) return res.redirect(next);
    return res.redirect('/');
  }
  res.status(401).send('Invalid password');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

// Room creation routes
app.post('/api/create-room', (req, res) => {
  if (!req.session?.auth) return res.status(401).json({ error: 'unauthorized' });

  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });

  const link = `${req.protocol}://${req.get('host')}/room.html?room=${roomId}&token=${encodeURIComponent(token)}`;
  res.json({ roomId, token, link, expiresIn: TOKEN_TTL });
});

app.post('/api/create-audio-room', (req, res) => {
  if (!req.session?.auth) return res.status(401).json({ error: 'unauthorized' });

  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });

  const link = `${req.protocol}://${req.get('host')}/room.html?room=${roomId}&token=${encodeURIComponent(token)}&type=audio`;
  res.json({ roomId, token, link, expiresIn: TOKEN_TTL });
});

// Direct room creation after login
app.get('/go/create-video', (req, res) => {
  if (!req.session?.auth) return res.redirect('/login.html?next=/go/create-video');
  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return res.redirect(`/room.html?room=${roomId}&token=${encodeURIComponent(token)}`);
});

app.get('/go/create-audio', (req, res) => {
  if (!req.session?.auth) return res.redirect('/login.html?next=/go/create-audio');
  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return res.redirect(`/room.html?room=${roomId}&token=${encodeURIComponent(token)}&type=audio`);
});

// TURN server configuration
app.get('/api/turn', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:turn.bistri.com:80',
      username: 'homeo',
      credential: 'homeo'
    }
  ];
  res.json({ iceServers });
});

// WebSocket signaling
wss.on('connection', (ws) => {
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const { type, roomId, token } = msg;

    // Join room
    if (type === 'join') {
      if (!roomId || !token) {
        return send(ws, 'error', { message: 'roomId and token required' });
      }

      // Verify token
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.roomId !== roomId) {
          return send(ws, 'error', { message: 'token/room mismatch' });
        }
      } catch (e) {
        return send(ws, 'error', { message: 'invalid or expired token' });
      }

      const peers = rooms.get(roomId) || new Set();

      // Room is full
      if (peers.size >= 2) {
        return send(ws, 'full', { roomId });
      }

      // Join room
      ws.roomId = roomId;
      peers.add(ws);
      rooms.set(roomId, peers);

      const role = peers.size === 1 ? 'host' : 'guest';
      send(ws, 'joined', { roomId, role, peersCount: peers.size });

      // Notify existing peer
      for (const peer of peers) {
        if (peer !== ws) send(peer, 'peer-joined', { roomId });
      }

      return;
    }

    // All other messages require being in a room
    if (!ws.roomId) return;

    const peers = rooms.get(ws.roomId);
    if (!peers) return;

    // Forward signaling messages to other peer
    if (['offer', 'answer', 'candidate'].includes(type)) {
      for (const peer of peers) {
        if (peer !== ws) send(peer, type, { data: msg.data });
      }
    }

    // Leave room
    else if (type === 'leave') {
      for (const peer of peers) {
        if (peer !== ws) send(peer, 'leave', {});
      }
      peers.delete(ws);
      if (peers.size === 0) rooms.delete(ws.roomId);
      ws.roomId = null;
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    if (!ws.roomId) return;
    const peers = rooms.get(ws.roomId);
    if (!peers) return;

    peers.delete(ws);
    for (const peer of peers) send(peer, 'leave', {});
    if (peers.size === 0) rooms.delete(ws.roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Login page: http://localhost:${PORT}/login.html`);
});

// Только TURN для фиксированного webrtcuser: берёт пароль из переменных окружения
app.get('/api/turn', (_req, res) => {
  const url = TURN_URL || 'turn:64.226.121.112:3478';
  const username = TURN_USER || 'webrtcuser';
  const credential = TURN_PASS || '';
  res.json({ iceServers: [{ urls: [url], username, credential }] });
});
