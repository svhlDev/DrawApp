const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5 // 100KB max per message
});

// ─── Configuration ───
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

// Host secret: set in Railway dashboard as env var
// If not set, generates one and prints it to logs on startup
const HOST_SECRET = process.env.HOST_SECRET || crypto.randomBytes(6).toString('hex');

// ─── Security Middleware ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
    }
  }
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests'
}));

app.use(express.static('public'));

// ─── Canvas Configuration ───
const CANVAS_W = 1000;
const CANVAS_H = 600;
const MAX_PLAYERS = 10;

// 10 plots in a 5×2 grid, each 200×300
const PLOTS = [];
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 5; col++) {
    PLOTS.push({
      id: row * 5 + col,
      x: col * 200,
      y: row * 300,
      w: 200,
      h: 300
    });
  }
}

// ─── Room State ───
const rooms = new Map();

function createRoom() {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  rooms.set(code, {
    code,
    players: new Map(),
    availablePlots: [...Array(10).keys()],
    strokes: [],
    hostSocketId: null,
    createdAt: Date.now()
  });
  return code;
}

// ─── HTTP Routes ───

// Host page — requires secret in URL
// You bookmark: https://your-app.up.railway.app/host?secret=YOUR_SECRET
app.get('/host', (req, res) => {
  if (req.query.secret !== HOST_SECRET) {
    return res.status(403).send('Forbidden — invalid host secret');
  }
  res.sendFile(__dirname + '/public/host.html');
});

app.get('/play', (req, res) => {
  res.sendFile(__dirname + '/public/play.html');
});

// QR code endpoint (only callable with valid secret)
app.get('/api/qr/:roomCode', async (req, res) => {
  if (req.query.secret !== HOST_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const url = `${BASE_URL}/play?room=${req.params.roomCode}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: '#e94560', light: '#0a0a0a' }
    });
    res.json({ qr: dataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ─── Rate Limiting for Draw Events ───
const drawRateLimits = new Map();
const DRAW_LIMIT = 60;
const DRAW_WINDOW = 1000;

function checkDrawRate(socketId) {
  const now = Date.now();
  let entry = drawRateLimits.get(socketId);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + DRAW_WINDOW };
    drawRateLimits.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= DRAW_LIMIT;
}

// ─── Validation Helpers ───

function validateStroke(data, plot) {
  if (!data || !Array.isArray(data.points) || data.points.length === 0) return false;
  if (data.points.length > 500) return false;
  const tolerance = 25;
  for (const p of data.points) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    if (isNaN(p.x) || isNaN(p.y)) return false;
    if (p.x < plot.x - tolerance || p.x > plot.x + plot.w + tolerance) return false;
    if (p.y < plot.y - tolerance || p.y > plot.y + plot.h + tolerance) return false;
  }
  return true;
}

function sanitizeColor(color) {
  if (typeof color !== 'string') return '#e94560';
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return '#e94560';
}

function clamp(val, min, max) {
  if (typeof val !== 'number' || isNaN(val)) return min;
  return Math.max(min, Math.min(max, val));
}

// ─── Adjacency Helper ───
// Grid is 5 columns × 2 rows: plots 0-4 (top), 5-9 (bottom)
function getAdjacentPlotIds(plotId) {
  const row = Math.floor(plotId / 5);
  const col = plotId % 5;
  const adjacent = [];
  if (row > 0) adjacent.push((row - 1) * 5 + col); // up
  if (row < 1) adjacent.push((row + 1) * 5 + col); // down
  if (col > 0) adjacent.push(row * 5 + (col - 1)); // left
  if (col < 4) adjacent.push(row * 5 + (col + 1)); // right
  return adjacent;
}

// ─── Socket.IO Logic ───

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // ── Host creates a room (requires secret) ──
  socket.on('create-room', ({ secret }, callback) => {
    if (secret !== HOST_SECRET) {
      return callback({ error: 'Invalid host secret' });
    }

    const code = createRoom();
    const room = rooms.get(code);
    room.hostSocketId = socket.id;

    socket.join(`room:${code}`);
    socket.roomCode = code;
    socket.isHost = true;

    console.log(`Room created: ${code} by host ${socket.id}`);
    callback({ code, plots: PLOTS, canvasW: CANVAS_W, canvasH: CANVAS_H });
  });

  // ── Player joins a room ──
  socket.on('join-room', ({ roomCode, playerName }, callback) => {
    const room = rooms.get(roomCode);

    if (!room) return callback({ error: 'Room not found' });
    if (room.players.size >= MAX_PLAYERS) return callback({ error: 'Room is full (10/10)' });
    if (typeof playerName !== 'string' || playerName.trim().length === 0) {
      return callback({ error: 'Name required' });
    }

    const name = playerName.trim().replace(/[<>&"']/g, '').slice(0, 20);

    // Allocate random plot
    const plotIndex = Math.floor(Math.random() * room.availablePlots.length);
    const plotId = room.availablePlots.splice(plotIndex, 1)[0];

    room.players.set(socket.id, { name, plotId });
    socket.join(`room:${roomCode}`);
    socket.roomCode = roomCode;

    // Auto-kick after 15 minutes
    socket.kickTimer = setTimeout(() => {
      const r = rooms.get(socket.roomCode);
      if (!r) return;
      const p = r.players.get(socket.id);
      if (!p) return;

      r.availablePlots.push(p.plotId);
      r.players.delete(socket.id);

      io.to(socket.id).emit('kicked');
      io.to(`room:${socket.roomCode}`).emit('player-left', {
        id: socket.id,
        name: p.name,
        plotId: p.plotId,
        playerCount: r.players.size
      });

      socket.disconnect(true);
      console.log(`Auto-kicked ${p.name} from room ${socket.roomCode} (15min timeout)`);
    }, 15 * 60 * 1000);

    io.to(`room:${roomCode}`).emit('player-joined', {
      id: socket.id,
      name,
      plotId,
      playerCount: room.players.size
    });

    console.log(`${name} joined room ${roomCode}, plot ${plotId}`);

    callback({
      success: true,
      plotId,
      plot: PLOTS[plotId],
      plots: PLOTS,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      strokes: room.strokes,
      players: Array.from(room.players.entries()).map(([id, p]) => ({
        id, name: p.name, plotId: p.plotId
      }))
    });
  });

  // ── Drawing ──
  socket.on('draw', (data) => {
    const room = rooms.get(socket.roomCode);
    if (!room || socket.isHost) return;
    if (!checkDrawRate(socket.id)) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const plot = PLOTS[player.plotId];
    if (!validateStroke(data, plot)) return;

    const stroke = {
      playerId: socket.id,
      plotId: player.plotId,
      points: data.points.slice(0, 500).map(p => ({
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10
      })),
      color: sanitizeColor(data.color),
      brushSize: clamp(Math.round(data.brushSize), 1, 50),
      opacity: clamp(data.opacity, 0.05, 1),
      brush: ['round', 'square', 'spray'].includes(data.brush) ? data.brush : 'round'
    };

    room.strokes.push(stroke);
    if (room.strokes.length > 5000) {
      room.strokes = room.strokes.slice(-4000);
    }

    // Broadcast to everyone in room (including host display)
    socket.to(`room:${socket.roomCode}`).emit('stroke', stroke);
  });

  // ── Host: clear canvas ──
  socket.on('clear-canvas', ({ secret }) => {
    if (secret !== HOST_SECRET) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.strokes = [];
    io.to(`room:${socket.roomCode}`).emit('canvas-cleared');
    console.log(`Canvas cleared in room ${socket.roomCode}`);
  });

  // ── Host: kick player ──
  socket.on('kick-player', ({ secret, playerId }) => {
    if (secret !== HOST_SECRET) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player) return;

    room.availablePlots.push(player.plotId);
    room.players.delete(playerId);

    // Tell the kicked player
    io.to(playerId).emit('kicked');
    // Tell everyone else
    io.to(`room:${socket.roomCode}`).emit('player-left', {
      id: playerId,
      name: player.name,
      plotId: player.plotId,
      playerCount: room.players.size
    });

    // Force disconnect the kicked socket
    const kickedSocket = io.sockets.sockets.get(playerId);
    if (kickedSocket) kickedSocket.disconnect(true);

    console.log(`Kicked ${player.name} from room ${socket.roomCode}`);
  });

  // ── Get adjacent plots for the picker ──
  socket.on('get-adjacent-plots', (callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'No room' });

    const player = room.players.get(socket.id);
    if (!player) return callback({ error: 'Not in room' });

    const adjacentIds = getAdjacentPlotIds(player.plotId);

    // Build a set of occupied plot IDs (by other players)
    const occupiedBy = new Map();
    for (const [id, p] of room.players) {
      if (id !== socket.id) {
        occupiedBy.set(p.plotId, p.name);
      }
    }

    const adjacentPlots = adjacentIds.map(id => {
      const plot = PLOTS[id];
      const occupant = occupiedBy.get(id) || null;
      // Gather strokes for this plot for the preview
      const plotStrokes = room.strokes.filter(s => s.plotId === id);
      return {
        id,
        plot,
        occupied: !!occupant,
        occupantName: occupant,
        strokes: plotStrokes
      };
    });

    callback({ success: true, currentPlotId: player.plotId, adjacentPlots });
  });

  // ── Request plot change (targeted) ──
  socket.on('request-plot-change', ({ targetPlotId }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'No room' });

    const player = room.players.get(socket.id);
    if (!player) return callback({ error: 'Not in room' });

    // Validate target is a real plot
    if (typeof targetPlotId !== 'number' || targetPlotId < 0 || targetPlotId > 9) {
      return callback({ error: 'Invalid plot' });
    }

    // Validate adjacency
    const adjacentIds = getAdjacentPlotIds(player.plotId);
    if (!adjacentIds.includes(targetPlotId)) {
      return callback({ error: 'Plot is not adjacent' });
    }

    // Validate not occupied by another player
    for (const [id, p] of room.players) {
      if (id !== socket.id && p.plotId === targetPlotId) {
        return callback({ error: 'Plot is occupied' });
      }
    }

    const oldPlotId = player.plotId;

    // Free old plot, claim new one
    room.availablePlots.push(oldPlotId);
    const idx = room.availablePlots.indexOf(targetPlotId);
    if (idx !== -1) room.availablePlots.splice(idx, 1);

    player.plotId = targetPlotId;

    io.to(`room:${socket.roomCode}`).emit('plot-changed', {
      id: socket.id,
      name: player.name,
      oldPlotId,
      newPlotId: targetPlotId
    });

    // Return strokes for the new plot so the player can render them
    const plotStrokes = room.strokes.filter(s => s.plotId === targetPlotId);

    callback({ success: true, plotId: targetPlotId, plot: PLOTS[targetPlotId], strokes: plotStrokes });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (socket.kickTimer) clearTimeout(socket.kickTimer);
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (socket.isHost) {
      io.to(`room:${socket.roomCode}`).emit('room-closed');
      rooms.delete(socket.roomCode);
      console.log(`Room ${socket.roomCode} closed (host left)`);
    } else {
      const player = room.players.get(socket.id);
      if (player) {
        room.availablePlots.push(player.plotId);
        room.players.delete(socket.id);
        io.to(`room:${socket.roomCode}`).emit('player-left', {
          id: socket.id,
          name: player.name,
          plotId: player.plotId,
          playerCount: room.players.size
        });
        console.log(`${player.name} left room ${socket.roomCode}`);
      }
    }
    drawRateLimits.delete(socket.id);
  });
});

// ─── Stale Room Cleanup ───
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff) {
      io.to(`room:${code}`).emit('room-closed');
      rooms.delete(code);
      console.log(`Stale room ${code} cleaned up`);
    }
  }
}, 30 * 60 * 1000);

// ─── Start ───
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║            PIXEL FORGE — SERVER              ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  URL:     ${BASE_URL}`);
  console.log(`║  Port:    ${PORT}`);
  console.log(`║  Secret:  ${HOST_SECRET}`);
  console.log('║                                              ║');
  console.log(`║  Host URL (bookmark this):`);
  console.log(`║  ${BASE_URL}/host?secret=${HOST_SECRET}`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
