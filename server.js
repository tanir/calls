const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Раздаём статические файлы из ./public
app.use(express.static(path.join(__dirname, 'public')));

// Простая in-memory карта комнат: roomId -> Set(ws)
const rooms = new Map();

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

wss.on('connection', (ws) => {
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      return;
    }

    const type = msg.type;

    if (type === 'join') {
      const roomId = String((msg.roomId || (msg.data && msg.data.roomId) || '')).trim();
      if (!roomId) return send(ws, 'error', { message: 'roomId required' });

      const peers = rooms.get(roomId) || new Set();
      if (peers.size >= 2) {
        return send(ws, 'full', { roomId });
      }

      ws.roomId = roomId;
      peers.add(ws);
      rooms.set(roomId, peers);

      const role = peers.size === 1 ? 'host' : 'guest';
      send(ws, 'joined', { roomId, role, peersCount: peers.size });

      // Уведомить остальных
      for (const peer of peers) {
        if (peer !== ws) send(peer, 'peer-joined', { roomId });
      }

      // Когда двое в комнате — дать сигнал "готовы"
      if (peers.size === 2) {
        for (const peer of peers) send(peer, 'ready', { roomId });
      }
      return;
    }

    if (!ws.roomId) return; // Не в комнате — игнор

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
        // Исправлено: используем текущий roomId до обнуления
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
});
