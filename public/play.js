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

    // Auto-redirect after 15 minutes
    setTimeout(() => {
      window.location.href = 'https://www.facebook.com/groups/1723374071714261';
    }, 15 * 60 * 1000);

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
  const isEraser = currentBrush === 'eraser';
  return {
    color: isEraser ? '#0a0a0a' : document.getElementById('color-picker').value,
    brushSize: parseInt(sizeSlider.value),
    opacity: isEraser ? 1 : parseInt(opacitySlider.value) / 100,
    brush: isEraser ? 'round' : currentBrush
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

// ─── Full Canvas Renderer (shared by picker + view all) ───

function renderFullCanvas(targetCanvas, data, options) {
  const fc = targetCanvas.getContext('2d');
  const cw = data.canvasW;
  const ch = data.canvasH;
  const scale = targetCanvas.width / cw;

  fc.fillStyle = '#0a0a0a';
  fc.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

  // Render all strokes
  for (const stroke of data.strokes) {
    fc.save();
    fc.globalAlpha = stroke.opacity;
    fc.strokeStyle = stroke.color;
    fc.fillStyle = stroke.color;
    fc.lineWidth = stroke.brushSize * scale;
    fc.lineCap = stroke.brush === 'square' ? 'butt' : 'round';
    fc.lineJoin = 'round';

    if (stroke.brush === 'spray') {
      for (const p of stroke.points) {
        for (let i = 0; i < 4; i++) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * stroke.brushSize * scale;
          fc.fillRect(
            p.x * scale + Math.cos(angle) * radius,
            p.y * scale + Math.sin(angle) * radius,
            1, 1
          );
        }
      }
    } else if (stroke.points.length === 1) {
      fc.beginPath();
      fc.arc(stroke.points[0].x * scale, stroke.points[0].y * scale,
        stroke.brushSize * scale / 2, 0, Math.PI * 2);
      fc.fill();
    } else {
      fc.beginPath();
      fc.moveTo(stroke.points[0].x * scale, stroke.points[0].y * scale);
      for (let i = 1; i < stroke.points.length; i++) {
        fc.lineTo(stroke.points[i].x * scale, stroke.points[i].y * scale);
      }
      fc.stroke();
    }
    fc.restore();
  }

  // Draw grid lines
  fc.strokeStyle = '#1a1a2e';
  fc.lineWidth = 1;
  for (const plot of data.plots) {
    fc.strokeRect(plot.x * scale + 0.5, plot.y * scale + 0.5,
      plot.w * scale - 1, plot.h * scale - 1);
  }

  // Highlight current plot
  const cur = data.plots[data.currentPlotId];
  fc.strokeStyle = '#e94560';
  fc.lineWidth = 2;
  fc.strokeRect(cur.x * scale + 1, cur.y * scale + 1,
    cur.w * scale - 2, cur.h * scale - 2);
  fc.fillStyle = '#e94560';
  fc.font = `bold ${Math.round(9 * scale)}px monospace`;
  fc.textAlign = 'center';
  fc.fillText('YOU', (cur.x + cur.w / 2) * scale, (cur.y + cur.h / 2) * scale);

  // Overlay info on plots (occupied / available)
  if (options && options.showPickerInfo) {
    const occupiedBy = data.occupiedBy || {};

    for (const plot of data.plots) {
      if (plot.id === data.currentPlotId) continue;
      const px = plot.x * scale;
      const py = plot.y * scale;
      const pw = plot.w * scale;
      const ph = plot.h * scale;
      const occupant = occupiedBy[plot.id];

      if (occupant) {
        // Occupied — dim overlay
        fc.fillStyle = 'rgba(0, 0, 0, 0.5)';
        fc.fillRect(px, py, pw, ph);
        fc.fillStyle = '#e94560';
        fc.font = `bold ${Math.round(8 * scale)}px monospace`;
        fc.textAlign = 'center';
        fc.fillText('TAKEN', px + pw / 2, py + ph / 2);
      } else {
        // Available — highlight border
        fc.strokeStyle = '#2ed57380';
        fc.lineWidth = 3;
        fc.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      }
    }
  }
}

// ─── View All ───

const viewAllOverlay = document.getElementById('view-all-overlay');
const viewAllCanvas = document.getElementById('viewall-canvas');
const viewAllBtn = document.getElementById('view-all-btn');

document.getElementById('view-all-close').addEventListener('click', () => {
  viewAllOverlay.style.display = 'none';
});

viewAllBtn.addEventListener('click', () => {
  viewAllBtn.disabled = true;
  viewAllBtn.textContent = '...';

  socket.emit('get-full-canvas', (response) => {
    viewAllBtn.disabled = false;
    viewAllBtn.textContent = 'View All';

    if (response.error) {
      document.getElementById('status').textContent = response.error;
      setTimeout(() => { document.getElementById('status').textContent = ''; }, 3000);
      return;
    }

    viewAllCanvas.width = response.canvasW;
    viewAllCanvas.height = response.canvasH;
    renderFullCanvas(viewAllCanvas, response, { showPickerInfo: false });
    viewAllOverlay.style.display = 'flex';
  });
});

// ─── Plot Picker (grid canvas) ───

const plotPicker = document.getElementById('plot-picker');
const pickerCanvas = document.getElementById('picker-canvas');
let pickerData = null;

document.getElementById('plot-picker-cancel').addEventListener('click', () => {
  plotPicker.style.display = 'none';
});

function openPlotPicker() {
  changePlotBtn.disabled = true;
  changePlotBtn.textContent = '...';

  socket.emit('get-full-canvas', (response) => {
    changePlotBtn.disabled = false;
    changePlotBtn.textContent = '↻ Move';

    if (response.error) {
      document.getElementById('status').textContent = response.error;
      setTimeout(() => { document.getElementById('status').textContent = ''; }, 3000);
      return;
    }

    pickerData = response;
    pickerCanvas.width = response.canvasW;
    pickerCanvas.height = response.canvasH;
    renderFullCanvas(pickerCanvas, response, { showPickerInfo: true });
    plotPicker.style.display = 'flex';
  });
}

function handlePickerTap(e) {
  if (!pickerData) return;
  e.preventDefault();

  const rect = pickerCanvas.getBoundingClientRect();
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }

  const scaleX = pickerData.canvasW / rect.width;
  const scaleY = pickerData.canvasH / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;

  // Find which plot was tapped
  for (const plot of pickerData.plots) {
    if (x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h) {
      if (plot.id === pickerData.currentPlotId) return; // already here
      if (pickerData.occupiedBy[plot.id]) return; // taken
      selectPlot(plot.id);
      return;
    }
  }
}

pickerCanvas.addEventListener('click', handlePickerTap);
pickerCanvas.addEventListener('touchstart', handlePickerTap, { passive: false });

function selectPlot(targetPlotId) {
  plotPicker.style.display = 'none';
  pickerData = null;

  socket.emit('request-plot-change', { targetPlotId }, (response) => {
    if (response.error) {
      document.getElementById('status').textContent = response.error;
      setTimeout(() => { document.getElementById('status').textContent = ''; }, 3000);
      return;
    }

    myPlotId = response.plotId;
    myPlot = response.plot;
    initCanvas();

    // Render existing strokes on the new plot
    for (const stroke of response.strokes) {
      renderStroke(stroke);
    }

    drawPlotOverlay();
    updatePlotInfo();
  });
}

changePlotBtn.addEventListener('click', openPlotPicker);

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
  window.location.href = 'https://www.facebook.com/groups/1723374071714261';
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
