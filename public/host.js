const socket = io();

// Extract secret from URL
const params = new URLSearchParams(window.location.search);
const SECRET = params.get('secret');

const setupEl = document.getElementById('setup');
const sessionEl = document.getElementById('session');
const createBtn = document.getElementById('create-btn');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const playerListEl = document.getElementById('player-list');

let roomCode = null;
let plots = [];
let canvasW, canvasH;
let players = new Map(); // id -> { name, plotId }

// Plot colors for visual distinction
const PLOT_COLORS = [
  '#e94560', '#ffa502', '#2ed573', '#1e90ff', '#a29bfe',
  '#fd79a8', '#00cec9', '#fdcb6e', '#6c5ce7', '#ff6b6b'
];

// ─── Create Room ───

createBtn.addEventListener('click', () => {
  socket.emit('create-room', { secret: SECRET }, (data) => {
    if (data.error) {
      alert(data.error);
      return;
    }

    roomCode = data.code;
    plots = data.plots;
    canvasW = data.canvasW;
    canvasH = data.canvasH;

    // Size canvas (2x for sharpness)
    const scale = 2;
    canvas.width = canvasW * scale;
    canvas.height = canvasH * scale;
    canvas.style.width = '100%';
    canvas.style.maxWidth = canvasW + 'px';
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvasW, canvasH);
    drawPlotGrid();

    // Show session
    setupEl.style.display = 'none';
    sessionEl.style.display = 'flex';
    document.getElementById('room-code').textContent = roomCode;

    // Fetch QR
    fetch(`/api/qr/${roomCode}?secret=${SECRET}`)
      .then(r => r.json())
      .then(data => {
        document.getElementById('qr-img').src = data.qr;
        document.getElementById('qr-url').textContent = data.url;
      });
  });
});

// ─── Canvas Rendering ───

function drawPlotGrid() {
  for (const plot of plots) {
    // Plot border
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    // Plot number
    ctx.fillStyle = '#1a1a2e';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${plot.id}`, plot.x + 6, plot.y + 16);
  }

  // Show assigned player names on plots
  for (const [id, player] of players) {
    const plot = plots[player.plotId];
    if (!plot) continue;
    const color = PLOT_COLORS[player.plotId % PLOT_COLORS.length];

    // Colored border for assigned plots
    ctx.strokeStyle = color + '60';
    ctx.lineWidth = 2;
    ctx.strokeRect(plot.x + 1, plot.y + 1, plot.w - 2, plot.h - 2);

    // Name tag
    ctx.fillStyle = color + '30';
    ctx.fillRect(plot.x + 2, plot.y + 2, plot.w - 4, 20);
    ctx.fillStyle = color;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(player.name, plot.x + 6, plot.y + 14);
  }
}

function renderStroke(stroke) {
  const { points, color, brushSize, opacity, brush } = stroke;
  const plot = plots[stroke.plotId];
  if (!plot) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = brushSize;
  ctx.lineCap = brush === 'square' ? 'butt' : 'round';
  ctx.lineJoin = 'round';

  if (brush === 'spray') {
    for (const p of points) {
      for (let i = 0; i < 8; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * brushSize;
        ctx.fillRect(
          p.x + Math.cos(angle) * radius,
          p.y + Math.sin(angle) * radius,
          1.5, 1.5
        );
      }
    }
  } else {
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
  drawPlotGrid();
}

function redrawCanvas(strokes) {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, canvasW, canvasH);
  for (const stroke of strokes) {
    renderStroke(stroke);
  }
  drawPlotGrid();
}

// ─── Player List ───

function updatePlayerList() {
  playerListEl.innerHTML = '';
  document.getElementById('player-count').textContent = `${players.size}/10`;

  for (const [id, player] of players) {
    const li = document.createElement('li');
    li.className = 'player-item';

    const color = PLOT_COLORS[player.plotId % PLOT_COLORS.length];

    li.innerHTML = `
      <span class="player-dot" style="background:${color}"></span>
      <span class="player-name">${player.name}</span>
      <span class="player-plot">Plot ${player.plotId}</span>
      <button class="btn-kick" data-id="${id}" title="Kick player">✕</button>
    `;
    playerListEl.appendChild(li);
  }

  // Attach kick handlers
  document.querySelectorAll('.btn-kick').forEach(btn => {
    btn.addEventListener('click', () => {
      const playerId = btn.dataset.id;
      const player = players.get(playerId);
      if (confirm(`Kick ${player?.name}?`)) {
        socket.emit('kick-player', { secret: SECRET, playerId });
      }
    });
  });
}

// ─── Admin Controls ───

document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('Clear the entire canvas? This cannot be undone.')) {
    socket.emit('clear-canvas', { secret: SECRET });
  }
});

document.getElementById('export-btn').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `pixel-forge-${roomCode}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
});

// ─── Socket Events ───

socket.on('stroke', renderStroke);

socket.on('player-joined', (data) => {
  players.set(data.id, { name: data.name, plotId: data.plotId });
  updatePlayerList();
  drawPlotGrid();
});

socket.on('player-left', (data) => {
  players.delete(data.id);
  updatePlayerList();
  // Redraw grid to remove their name tag
  // (We'd need all strokes to fully redraw — for now just update overlay)
  drawPlotGrid();
});

socket.on('plot-changed', (data) => {
  const player = players.get(data.id);
  if (player) {
    player.plotId = data.newPlotId;
    updatePlayerList();
    drawPlotGrid();
  }
});

socket.on('canvas-cleared', () => {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, canvasW, canvasH);
  drawPlotGrid();
});
