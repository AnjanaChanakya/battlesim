const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple static server so index.html loads on localhost:3000
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function createNewRoom(roomId) {
  return {
    id: roomId,
    players: {}, // socket mapping
    p1: null,
    p2: null,
    gameState: {
      round: 1,
      p1: { initial: { tanks: 6, planes: 4 }, reserves: { tanks: 6, planes: 4 }, readied: { tanks: 0, planes: 0 }, order: null },
      p2: { initial: { tanks: 6, planes: 4 }, reserves: { tanks: 6, planes: 4 }, readied: { tanks: 0, planes: 0 }, order: null }
    }
  };
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let playerRole = null; // 'p1' or 'p2'

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    if (data.type === 'JOIN_ROOM') {
      const roomId = data.roomId || 'default-arena';
      if (!rooms.has(roomId)) {
        rooms.set(roomId, createNewRoom(roomId));
      }
      currentRoom = rooms.get(roomId);

      if (!currentRoom.p1) {
        currentRoom.p1 = ws;
        playerRole = 'p1';
      } else if (!currentRoom.p2) {
        currentRoom.p2 = ws;
        playerRole = 'p2';
      } else {
        return ws.send(JSON.stringify({ type: 'ROOM_FULL' }));
      }

      ws.send(JSON.stringify({
        type: 'INIT_ROLE',
        role: playerRole,
        roomId,
        gameState: currentRoom.gameState
      }));

      // Notify both when match is ready
      if (currentRoom.p1 && currentRoom.p2) {
        broadcast(currentRoom, { type: 'MATCH_READY' });
      }
    }

    if (data.type === 'SUBMIT_ORDER') {
      if (!currentRoom || !playerRole) return;
      const gs = currentRoom.gameState;
      gs[playerRole].order = data.order;

      // Broadcast secret status (do NOT reveal action content yet)
      broadcast(currentRoom, {
        type: 'PLAYER_LOCKED',
        player: playerRole
      });

      // Both locked in -> Authoritative Server Resolution
      if (gs.p1.order && gs.p2.order) {
        resolveCombat(currentRoom);
      }
    }

    if (data.type === 'FORFEIT') {
      if (!currentRoom || !playerRole) return;
      const winner = playerRole === 'p1' ? 'Player 2' : 'Player 1';
      broadcast(currentRoom, { type: 'GAME_OVER', winner, reason: 'retreat' });
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      broadcast(currentRoom, { type: 'OPPONENT_DISCONNECTED' });
      rooms.delete(currentRoom.id);
    }
  });
});

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  if (room.p1 && room.p1.readyState === 1) room.p1.send(msg);
  if (room.p2 && room.p2.readyState === 1) room.p2.send(msg);
}

function resolveCombat(room) {
  const gs = room.gameState;
  const a1 = gs.p1.order;
  const a2 = gs.p2.order;

  // 1. Ready Up Execution
  ['p1', 'p2'].forEach(pk => {
    const act = gs[pk].order;
    if (act.type === 'READY') {
      const idle = gs[pk].reserves[act.unit] - gs[pk].readied[act.unit];
      gs[pk].readied[act.unit] += Math.min(act.count, idle);
    }
  });

  // 2. Resolve Clashes
  let p1Dmg = 0;
  let p2Dmg = 0;
  let detail = '';

  if (a1.type === 'ATTACK' && a2.type === 'ATTACK') {
    gs.p1.readied[a1.unit] -= a1.count;
    gs.p2.readied[a2.unit] -= a2.count;

    if (a1.count > a2.count) {
      p2Dmg = a1.count - a2.count;
      detail = `P1 firepower overpowered P2! P2 takes ${p2Dmg} hit(s).`;
    } else if (a2.count > a1.count) {
      p1Dmg = a2.count - a1.count;
      detail = `P2 firepower overpowered P1! P1 takes ${p1Dmg} hit(s).`;
    } else {
      detail = 'Equal firepower clash! All incoming rounds canceled out.';
    }
  } else {
    if (a1.type === 'ATTACK') {
      gs.p1.readied[a1.unit] -= a1.count;
      if (a2.type === 'DEFEND' && a2.unit === a1.unit) detail += `P2 shield negated P1's ${a1.unit}! `;
      else { p2Dmg = a1.count; detail += `P1 direct hit: P2 takes ${p2Dmg} damage! `; }
    }
    if (a2.type === 'ATTACK') {
      gs.p2.readied[a2.unit] -= a2.count;
      if (a1.type === 'DEFEND' && a1.unit === a2.unit) detail += `P1 shield negated P2's ${a2.unit}! `;
      else { p1Dmg = a2.count; detail += `P2 direct hit: P1 takes ${p1Dmg} damage! `; }
    }
    if (a1.type !== 'ATTACK' && a2.type !== 'ATTACK') {
      detail = 'Both sides chose tactical maneuvers. No fire exchanged.';
    }
  }

  // 3. Apply Casualties
  applyCasualties(gs.p1, p1Dmg);
  applyCasualties(gs.p2, p2Dmg);

  // Broadcast simultaneous outcome to both devices
  broadcast(room, {
    type: 'ROUND_RESOLVED',
    round: gs.round,
    p1Order: a1,
    p2Order: a2,
    p1Dmg,
    p2Dmg,
    detail,
    gameState: gs
  });

  // Prepare next round
  gs.round++;
  gs.p1.order = null;
  gs.p2.order = null;
}

function applyCasualties(player, count) {
  for (let i = 0; i < count; i++) {
    if (player.reserves.tanks === 0 && player.reserves.planes === 0) break;
    const targetType = (player.reserves.tanks >= player.reserves.planes && player.reserves.tanks > 0) ? 'tanks' : 'planes';
    player.reserves[targetType]--;
    if (player.readied[targetType] > player.reserves[targetType]) {
      player.readied[targetType] = player.reserves[targetType];
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Authoritative Game Server running on port ${PORT}`));