const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// === Настройки (меняйте через переменные окружения в проде) ===
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin_password_change_me_now';
const JWT_SECRET     = process.env.JWT_SECRET     || 'jwt_signing_secret_change_me_now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'session_secret_change_me_now';
const TOKEN_TTL      = process.env.TOKEN_TTL      || '6h'; // срок жизни ссылки

// Статика и парсеры
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Простая in-memory карта комнат: roomId -> Set(ws)
const rooms = new Map();

// Короткие ссылки: code -> { roomId, token, kind: 'video'|'audio', expiresAt }
const shortLinks = new Map();

function genCode(len = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function makeShort(kind, roomId, token, ttlMs) {
  // Пытаемся сгенерировать несуществующий код
  let code = genCode();
  while (shortLinks.has(code)) code = genCode();
  const expiresAt = Date.now() + ttlMs;
  shortLinks.set(code, { kind, roomId, token, expiresAt });
  return code;
}

// Периодически чистим протухшие короткие ссылки
setInterval(() => {
  const now = Date.now();
  for (const [code, v] of shortLinks) {
    if (v.expiresAt && v.expiresAt < now) shortLinks.delete(code);
  }
}, 60_000).unref?.();

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

// Вспомогалки
function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// === Авторизация создателя встречи ===
app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    req.session.auth = true;
    // Поддержка возврата к исходному действию
    const next = (req.body && req.body.next) || '/';
    // Разрешаем только относительные пути
    if (typeof next === 'string' && next.startsWith('/')) return res.redirect(next);
    return res.redirect('/');
  }
  res.status(401).send('Неверный пароль');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

// === Создание комнаты: только для залогиненного создателя ===
app.post('/api/create-room', (req, res) => {
  if (!req.session?.auth) return res.status(401).json({ error: 'unauthorized' });

  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });

  const ttlMs = typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('h')
    ? parseInt(TOKEN_TTL) * 3600_000
    : 6 * 3600_000;
  const code = makeShort('video', roomId, token, ttlMs);
  const shortLink = `${req.protocol}://${req.get('host')}/r/${code}`;
  const link = `${req.protocol}://${req.get('host')}/room.html?room=${roomId}&token=${encodeURIComponent(token)}`;
  res.json({ roomId, token, link, shortLink, expiresIn: TOKEN_TTL });
});

app.post('/api/create-audio-room', (req, res) => {
  if (!req.session?.auth) return res.status(401).json({ error: 'unauthorized' });

  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });

  const ttlMs = typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('h')
    ? parseInt(TOKEN_TTL) * 3600_000
    : 6 * 3600_000;
  const code = makeShort('audio', roomId, token, ttlMs);
  const shortLink = `${req.protocol}://${req.get('host')}/a/${code}`;
  const link = `${req.protocol}://${req.get('host')}/audio.html?room=${roomId}&token=${encodeURIComponent(token)}`;
  res.json({ roomId, token, link, shortLink, expiresIn: TOKEN_TTL });
});

// Короткие переходы: /r/:code -> room.html?room=...&token=...
app.get('/r/:code', (req, res) => {
  const v = shortLinks.get(req.params.code);
  if (!v || v.kind !== 'video') return res.status(404).send('Ссылка не найдена или устарела');
  return res.redirect(`/room.html?room=${v.roomId}&token=${encodeURIComponent(v.token)}`);
});

// /a/:code -> audio.html
app.get('/a/:code', (req, res) => {
  const v = shortLinks.get(req.params.code);
  if (!v || v.kind !== 'audio') return res.status(404).send('Ссылка не найдена или устарела');
  return res.redirect(`/audio.html?room=${v.roomId}&token=${encodeURIComponent(v.token)}`);
});

// Прямые переходы после логина: создают комнату и редиректят
app.get('/go/create-video', (req, res) => {
  if (!req.session?.auth) return res.redirect('/login.html?next=/go/create-video');
  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  const ttlMs = typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('h')
    ? parseInt(TOKEN_TTL) * 3600_000
    : 6 * 3600_000;
  const code = makeShort('video', roomId, token, ttlMs);
  return res.redirect(`/r/${code}`);
});

app.get('/go/create-audio', (req, res) => {
  if (!req.session?.auth) return res.redirect('/login.html?next=/go/create-audio');
  const roomId = randomId(8);
  const token = jwt.sign({ roomId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  const ttlMs = typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('h')
    ? parseInt(TOKEN_TTL) * 3600_000
    : 6 * 3600_000;
  const code = makeShort('audio', roomId, token, ttlMs);
  return res.redirect(`/a/${code}`);
});

// === WebSocket сигналинг с проверкой токена ===
wss.on('connection', (ws) => {
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const type = msg.type;

    if (type === 'join') {
      // Поддерживаем оба формата: msg.roomId и msg.data.roomId
      const roomId = String((msg.roomId || (msg.data && msg.data.roomId) || '')).trim();
      const token  = (msg.token || (msg.data && msg.data.token) || '').toString();

      if (!roomId || !token) return send(ws, 'error', { message: 'roomId and token required' });

      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.roomId !== roomId) {
          return send(ws, 'error', { message: 'token/room mismatch' });
        }
      } catch (e) {
        return send(ws, 'error', { message: 'invalid or expired token' });
      }

      const peers = rooms.get(roomId) || new Set();
      if (peers.size >= 2) {
        return send(ws, 'full', { roomId });
      }

      ws.roomId = roomId;
      peers.add(ws);
      rooms.set(roomId, peers);

      const role = peers.size === 1 ? 'host' : 'guest';
      send(ws, 'joined', { roomId, role, peersCount: peers.size });

      for (const peer of peers) {
        if (peer !== ws) send(peer, 'peer-joined', { roomId });
      }
      if (peers.size === 2) {
        for (const peer of peers) send(peer, 'ready', { roomId });
      }
      return;
    }

    if (!ws.roomId) return;

    const peers = rooms.get(ws.roomId);
    if (!peers) return;

    switch (type) {
      case 'offer':
      case 'answer':
      case 'candidate':
        for (const peer of peers) {
          if (peer !== ws) send(peer, type, { data: msg.data || null });
        }
        break;

      case 'leave': {
        const roomId = ws.roomId;
        for (const peer of peers) {
          if (peer !== ws) send(peer, 'leave', {});
        }
        peers.delete(ws);
        if (peers.size === 0) rooms.delete(roomId);
        ws.roomId = null;
        break;
      }

      default:
        send(ws, 'error', { message: `Unknown type: ${type}` });
    }
  });

  ws.on('close', () => {
    const roomId = ws.roomId;
    if (!roomId) return;
    const peers = rooms.get(roomId);
    if (!peers) return;
    peers.delete(ws);
    for (const peer of peers) send(peer, 'leave', {});
    if (peers.size === 0) rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Login page: http://localhost:${PORT}/login.html`);
});
