const socket = io();

const params = new URLSearchParams(window.location.search);
const roomCode = params.get('room');

if (!roomCode) {
  document.getElementById('join-error').textContent = 'No room code in URL. Scan the QR again.';
}

// ─── State ───
let myPlot = null;
let myPlotId = null;
let plots = [];
let canvasW, canvasH;
let isDrawing = false;
let currentStroke = [];
let currentBrush = 'round';
let displayRatio = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;

// ─── DOM ───
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const joinBtn = document.getElementById('join-btn');
const changePlotBtn = document.getElementById('change-plot-btn');
const sizeSlider = document.getElementById('brush-size');
const opacitySlider = document.getElementById('opacity');

// Brush size/opacity readout
sizeSlider.addEventListener('input', () => {
  document.getElementById('size-val').textContent = sizeSlider.value;
});
opacitySlider.addEventListener('input', () => {
  document.getElementById('opacity-val').textContent = opacitySlider.value;
});

// Brush type buttons
document.querySelectorAll('.brush-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentBrush = btn.dataset.brush;
  });
});

// ─── Join Room ───

joinBtn.addEventListener('click', joinRoom);
document.getElementById('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) return;
  if (!roomCode) return;

  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining...';

  socket.emit('join-room', { roomCode, playerName: name }, (response) => {
    if (response.error) {
      document.getElementById('join-error').textContent = response.error;
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join';
      return;
    }

    myPlotId = response.plotId;
    myPlot = response.plot;
    plots = response.plots;
    canvasW = response.canvasW;
    canvasH = response.canvasH;

    // Switch screens first so canvas wrapper has dimensions
    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('play-screen').style.display = 'flex';

    initCanvas();

    // Draw existing strokes
    for (const stroke of response.strokes) {
      renderStroke(stroke);
    }
    drawPlotOverlay();
    updatePlotInfo();
  });
}

function initCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const wrapperEl = document.querySelector('.canvas-wrapper');
  const wrapperWidth = wrapperEl.clientWidth - 16;
  const wrapperHeight = wrapperEl.clientHeight - 16;

  // Focus canvas on the player's own plot
  viewOffsetX = myPlot.x;
  viewOffsetY = myPlot.y;

  displayRatio = Math.min(wrapperWidth / myPlot.w, wrapperHeight / myPlot.h);
  const displayW = myPlot.w * displayRatio;
  const displayH = myPlot.h * displayRatio;

  canvas.width = myPlot.w * dpr;
  canvas.height = myPlot.h * dpr;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, myPlot.w, myPlot.h);
}

function updatePlotInfo() {
  document.getElementById('plot-info').textContent =
    `Plot ${myPlotId} · ${myPlot.w}×${myPlot.h}`;
}

// ─── Coordinate Conversion ───

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  return {
    x: (clientX - rect.left) / displayRatio + viewOffsetX,
    y: (clientY - rect.top) / displayRatio + viewOffsetY
  };
}

function isInMyPlot(x, y) {
  return x >= myPlot.x && x <= myPlot.x + myPlot.w &&
         y >= myPlot.y && y <= myPlot.y + myPlot.h;
}

function clampToPlot(x, y) {
  return {
    x: Math.max(myPlot.x, Math.min(myPlot.x + myPlot.w, x)),
    y: Math.max(myPlot.y, Math.min(myPlot.y + myPlot.h, y))
  };
}

// ─── Drawing ───

function getDrawSettings() {
  return {
    color: document.getElementById('color-picker').value,
    brushSize: parseInt(sizeSlider.value),
    opacity: parseInt(opacitySlider.value) / 100,
    brush: currentBrush
  };
}

function startDraw(e) {
  e.preventDefault();
  const pos = getCanvasCoords(e);
  if (!isInMyPlot(pos.x, pos.y)) return;
  isDrawing = true;
  currentStroke = [pos];
}

function moveDraw(e) {
  e.preventDefault();
  if (!isDrawing) return;
  const raw = getCanvasCoords(e);
  const pos = clampToPlot(raw.x, raw.y);
  currentStroke.push(pos);
  renderLocalSegment();
}

function endDraw(e) {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentStroke.length === 0) return;

  const settings = getDrawSettings();
  const strokeData = {
    points: currentStroke,
    ...settings
  };

  // Send to server
  socket.emit('draw', strokeData);

  // Render locally (server won't echo back to sender)
  renderStroke({
    ...strokeData,
    plotId: myPlotId,
    playerId: socket.id
  });

  currentStroke = [];
}

// Touch events
canvas.addEventListener('touchstart', startDraw, { passive: false });
canvas.addEventListener('touchmove', moveDraw, { passive: false });
canvas.addEventListener('touchend', endDraw);
canvas.addEventListener('touchcancel', endDraw);

// Mouse events
canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', moveDraw);
canvas.addEventListener('mouseup', endDraw);
canvas.addEventListener('mouseleave', endDraw);

function renderLocalSegment() {
  if (currentStroke.length < 2) return;
  const { color, brushSize, opacity, brush } = getDrawSettings();

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, myPlot.w, myPlot.h);
  ctx.clip();

  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = brushSize;
  ctx.lineCap = brush === 'square' ? 'butt' : 'round';
  ctx.lineJoin = 'round';

  if (brush === 'spray') {
    const p = currentStroke[currentStroke.length - 1];
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * brushSize;
      ctx.fillRect(
        p.x - viewOffsetX + Math.cos(angle) * radius,
        p.y - viewOffsetY + Math.sin(angle) * radius,
        1.5, 1.5
      );
    }
  } else {
    const a = currentStroke[currentStroke.length - 2];
    const b = currentStroke[currentStroke.length - 1];
    ctx.beginPath();
    ctx.moveTo(a.x - viewOffsetX, a.y - viewOffsetY);
    ctx.lineTo(b.x - viewOffsetX, b.y - viewOffsetY);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─── Stroke Rendering ───

function renderStroke(stroke) {
  const { points, color, brushSize, opacity, brush } = stroke;
  const plot = plots[stroke.plotId];
  if (!plot) return;

  // Only render strokes that belong to the player's plot
  if (plot.id !== myPlotId) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, myPlot.w, myPlot.h);
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
          p.x - viewOffsetX + Math.cos(angle) * radius,
          p.y - viewOffsetY + Math.sin(angle) * radius,
          1.5, 1.5
        );
      }
    }
  } else {
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x - viewOffsetX, points[0].y - viewOffsetY, brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x - viewOffsetX, points[0].y - viewOffsetY);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x - viewOffsetX, points[i].y - viewOffsetY);
      }
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
  drawPlotOverlay();
}

function drawPlotOverlay() {
  // Draw border around the player's plot
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(1, 1, myPlot.w - 2, myPlot.h - 2);

  // "YOUR PLOT" label
  ctx.fillStyle = '#e94560';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('YOUR PLOT', myPlot.w - 6, myPlot.h - 6);
}

// ─── Plot Change ───

changePlotBtn.addEventListener('click', () => {
  changePlotBtn.disabled = true;
  changePlotBtn.textContent = '...';

  socket.emit('request-plot-change', (response) => {
    changePlotBtn.disabled = false;
    changePlotBtn.textContent = '↻ New Plot';

    if (response.error) {
      document.getElementById('status').textContent = response.error;
      setTimeout(() => {
        document.getElementById('status').textContent = '';
      }, 3000);
      return;
    }

    myPlotId = response.plotId;
    myPlot = response.plot;
    initCanvas();
    updatePlotInfo();
    drawPlotOverlay();
  });
});

// ─── Incoming Events ───

socket.on('stroke', renderStroke);

socket.on('player-joined', (data) => {
  document.getElementById('status').textContent = `${data.name} joined`;
  setTimeout(() => {
    document.getElementById('status').textContent = '';
  }, 3000);
});

socket.on('player-left', (data) => {
  document.getElementById('status').textContent = `${data.name} left`;
  setTimeout(() => {
    document.getElementById('status').textContent = '';
  }, 3000);
});

socket.on('plot-changed', (data) => {
  drawPlotOverlay();
});

socket.on('canvas-cleared', () => {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, myPlot.w, myPlot.h);
  drawPlotOverlay();
});

socket.on('kicked', () => {
  alert('You have been removed from the session.');
  window.location.reload();
});

socket.on('room-closed', () => {
  alert('The host has ended the session.');
  window.location.reload();
});

socket.on('disconnect', () => {
  document.getElementById('status').textContent = 'Disconnected — reconnecting...';
});

socket.on('connect', () => {
  if (myPlotId !== null) {
    document.getElementById('status').textContent = 'Reconnected';
    setTimeout(() => {
      document.getElementById('status').textContent = '';
    }, 2000);
  }
});
