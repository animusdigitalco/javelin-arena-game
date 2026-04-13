const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

// ─── Rooms ───
const rooms = new Map(); // code -> { players: Map<id, ws>, host: id }
let nextId = 1;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function broadcast(room, msg, excludeId) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  room.players.forEach((ws, id) => {
    if (id !== excludeId && ws.readyState === 1) ws.send(data);
  });
}

function playerList(room) {
  return Array.from(room.players.keys());
}

function promoteHost(room, code) {
  if (room.players.size === 0) { rooms.delete(code); return; }
  const newHost = room.players.keys().next().value;
  room.host = newHost;
  broadcast(room, { type: 'host-changed', peerId: newHost });
}

// ─── HTTP + WebSocket ───
const server = http.createServer((req, res) => {
  // Health check
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const peerId = 'p' + (nextId++);
  let myRoom = null;
  let myCode = null;

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        const code = genCode();
        const room = { players: new Map(), host: peerId };
        room.players.set(peerId, ws);
        rooms.set(code, room);
        myRoom = room;
        myCode = code;
        ws.send(JSON.stringify({ type: 'created', room: code, peerId, isHost: true }));
        break;
      }

      case 'join': {
        const code = (msg.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' })); break; }
        if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full' })); break; }
        room.players.set(peerId, ws);
        myRoom = room;
        myCode = code;
        ws.send(JSON.stringify({ type: 'joined', room: code, peerId, isHost: false, players: playerList(room) }));
        broadcast(room, { type: 'player-joined', peerId }, peerId);
        break;
      }

      case 'relay': {
        if (!myRoom) break;
        const data = JSON.stringify({ type: 'relay', from: peerId, data: msg.data });
        myRoom.players.forEach((pws, id) => {
          if (id !== peerId && pws.readyState === 1) pws.send(data);
        });
        break;
      }

      case 'start-game': {
        if (!myRoom || myRoom.host !== peerId) break;
        broadcast(myRoom, { type: 'game-started' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    myRoom.players.delete(peerId);
    broadcast(myRoom, { type: 'player-left', peerId });
    if (myRoom.host === peerId) promoteHost(myRoom, myCode);
    if (myRoom.players.size === 0) rooms.delete(myCode);
    myRoom = null;
    myCode = null;
  });
});

// Heartbeat interval
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

server.listen(PORT, () => console.log(`Relay server on port ${PORT}`));
