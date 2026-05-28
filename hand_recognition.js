const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

const COLORS = ['#ff80b4', '#c880ff', '#ffffff', '#80ffcf', '#80d4ff', '#ffd080'];
const MAX_SPARKLES = 150;
const LANDMARK_SMOOTHING = 0.45;
const CURSOR_SMOOTHING = 0.42;
const MIN_DRAW_DISTANCE = 1.15;
const ERASE_RADIUS = 42;

const video = document.getElementById('video');
const drawCanvas = document.getElementById('drawCanvas');
const trackingCanvas = document.getElementById('trackingCanvas');
const sparkleCanvas = document.getElementById('sparkleCanvas');
const startScreen = document.getElementById('startScreen');
const startBtn = document.getElementById('startBtn');
const startError = document.getElementById('startError');
const trackingState = document.getElementById('trackingState');
const fpsValue = document.getElementById('fpsValue');
const dctx = drawCanvas.getContext('2d');
const tctx = trackingCanvas.getContext('2d');
const sctx = sparkleCanvas.getContext('2d');

let currentColor = '#ff80b4';
let thickness = 6;
let glowAmount = 60;
let cameraStream = null;
let appStarted = false;
let isProcessingFrame = false;
let strokes = [];
let sparkles = [];
let hands = null;
let animFrame = null;
let lastFrameStamp = performance.now();
let fps = 0;
let currentMode = 'none';
let currentModeLabel = 'READY';
let artOffset = { x: 0, y: 0 };

const handStates = new Map();
const activeGrab = { handId: null, lastPoint: null };

function createHandState(id) {
  return {
    id,
    landmarks: null,
    cursorPoint: null,
    currentStroke: [],
    currentStrokeStyle: { color: currentColor, thickness, glow: glowAmount },
    isDrawing: false,
    lastX: null,
    lastY: null,
    rawMode: 'none',
    mode: 'none',
    pendingMode: 'none',
    pendingModeFrames: 0
  };
}

function getHandState(id) {
  if (!handStates.has(id)) {
    handStates.set(id, createHandState(id));
  }
  return handStates.get(id);
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distanceBetweenLandmarks(landmarks, a, b) {
  return Math.hypot(landmarks[a].x - landmarks[b].x, landmarks[a].y - landmarks[b].y);
}

function toCanvasPoint(landmark, width, height) {
  return {
    x: landmark.x * width,
    y: landmark.y * height
  };
}

function screenToArt(point) {
  return {
    x: point.x - artOffset.x,
    y: point.y - artOffset.y
  };
}

function artToScreen(point) {
  return {
    x: point.x + artOffset.x,
    y: point.y + artOffset.y
  };
}

function smoothPoint(previousPoint, nextPoint, factor) {
  if (!previousPoint) {
    return { ...nextPoint };
  }

  return {
    x: lerp(previousPoint.x, nextPoint.x, factor),
    y: lerp(previousPoint.y, nextPoint.y, factor)
  };
}

function smoothLandmarks(previousLandmarks, nextLandmarks) {
  if (!previousLandmarks) {
    return nextLandmarks.map(landmark => ({ ...landmark }));
  }

  return nextLandmarks.map((landmark, index) => ({
    x: lerp(previousLandmarks[index].x, landmark.x, LANDMARK_SMOOTHING),
    y: lerp(previousLandmarks[index].y, landmark.y, LANDMARK_SMOOTHING),
    z: lerp(previousLandmarks[index].z || 0, landmark.z || 0, LANDMARK_SMOOTHING)
  }));
}

function setStartError(message = '') {
  startError.textContent = message;
}

function setStartButtonState(isBusy) {
  startBtn.disabled = isBusy;
  startBtn.textContent = isBusy ? 'Starting...' : 'Start Camera';
}

function setTrackingState(label, color = 'rgba(255, 255, 255, 0.6)') {
  trackingState.textContent = label;
  trackingState.style.color = color;
}

function updateFps() {
  const now = performance.now();
  const frameDuration = now - lastFrameStamp;
  lastFrameStamp = now;
  const instantFps = frameDuration > 0 ? 1000 / frameDuration : 0;
  fps = lerp(fps || instantFps, instantFps, 0.2);
  fpsValue.textContent = String(Math.round(clamp(fps, 0, 99)));
}

function initColorPicker() {
  const picker = document.getElementById('colorPicker');
  COLORS.forEach(color => {
    const btn = document.createElement('div');
    btn.className = 'color-btn' + (color === currentColor ? ' active' : '');
    btn.style.background = color;
    btn.onclick = () => {
      currentColor = color;
      document.querySelectorAll('.color-btn').forEach(item => item.classList.remove('active'));
      btn.classList.add('active');
    };
    picker.appendChild(btn);
  });
}

function saveStroke(state) {
  if (state.currentStroke.length > 1) {
    strokes.push({
      points: state.currentStroke.map(point => ({ ...point })),
      color: state.currentStrokeStyle.color,
      thickness: state.currentStrokeStyle.thickness,
      glow: state.currentStrokeStyle.glow
    });
  }
}

function finalizeStroke(state) {
  if (state.isDrawing) {
    saveStroke(state);
  }
  state.currentStroke = [];
  state.isDrawing = false;
  state.lastX = null;
  state.lastY = null;
}

function resetHandState(state) {
  finalizeStroke(state);
  state.landmarks = null;
  state.cursorPoint = null;
  state.rawMode = 'none';
  state.mode = 'none';
  state.pendingMode = 'none';
  state.pendingModeFrames = 0;
}

function setMode(mode, labelOverride = '') {
  const labels = {
    drawing: 'DRAWING',
    erasing: 'ERASING',
    grab: 'MOVE ART',
    none: 'READY'
  };
  const nextLabel = labelOverride || labels[mode] || 'READY';

  if (mode === currentMode && nextLabel === currentModeLabel) {
    return;
  }

  currentMode = mode;
  currentModeLabel = nextLabel;

  const badge = document.getElementById('modeBadge');
  const text = document.getElementById('modeText');
  badge.classList.remove('drawing', 'erasing', 'grab', 'ready');
  badge.classList.add('visible', mode === 'none' ? 'ready' : mode);
  text.textContent = nextLabel;
}

function updateHud(activeStates) {
  if (activeStates.length === 0) {
    setMode('none', 'READY');
    setTrackingState('SEARCH', 'rgba(255, 255, 255, 0.6)');
    return;
  }

  setTrackingState(activeStates.length === 1 ? '1 HAND' : '2 HANDS', 'rgba(255, 255, 255, 0.82)');

  const drawingCount = activeStates.filter(state => state.mode === 'drawing').length;
  const erasingCount = activeStates.filter(state => state.mode === 'erasing').length;
  const grabbingCount = activeStates.filter(state => state.mode === 'grab').length;

  if (grabbingCount > 0) {
    setMode('grab', grabbingCount > 1 ? 'MOVE ART x2' : 'MOVE ART');
  } else if (drawingCount > 1) {
    setMode('drawing', 'DUAL DRAW');
  } else if (drawingCount > 0 && erasingCount > 0) {
    setMode('drawing', 'DRAW + ERASE');
  } else if (drawingCount > 0) {
    setMode('drawing', 'DRAWING');
  } else if (erasingCount > 0) {
    setMode('erasing', erasingCount > 1 ? 'DUAL ERASE' : 'ERASING');
  } else {
    setMode('grab', activeStates.length > 1 ? 'TRACKING 2' : 'TRACKING');
  }
}

function drawSegment(x1, y1, x2, y2, color, lineThickness, glow) {
  dctx.save();
  dctx.lineCap = 'round';
  dctx.lineJoin = 'round';

  if (glow > 0) {
    dctx.shadowColor = color;
    dctx.shadowBlur = (glow / 100) * 30 + 8;
  }

  dctx.strokeStyle = color;
  dctx.lineWidth = lineThickness;
  dctx.beginPath();
  dctx.moveTo(x1, y1);
  dctx.lineTo(x2, y2);
  dctx.stroke();

  dctx.shadowBlur = 0;
  dctx.strokeStyle = 'rgba(255,255,255,0.45)';
  dctx.lineWidth = Math.max(1, lineThickness * 0.22);
  dctx.beginPath();
  dctx.moveTo(x1, y1);
  dctx.lineTo(x2, y2);
  dctx.stroke();

  dctx.restore();
}

function redrawStrokes() {
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

  strokes.forEach(stroke => {
    for (let i = 1; i < stroke.points.length; i += 1) {
      const from = artToScreen(stroke.points[i - 1]);
      const to = artToScreen(stroke.points[i]);
      drawSegment(from.x, from.y, to.x, to.y, stroke.color, stroke.thickness, stroke.glow);
    }
  });

  handStates.forEach(state => {
    if (state.currentStroke.length < 2) {
      return;
    }

    for (let i = 1; i < state.currentStroke.length; i += 1) {
      const from = artToScreen(state.currentStroke[i - 1]);
      const to = artToScreen(state.currentStroke[i]);
      drawSegment(
        from.x,
        from.y,
        to.x,
        to.y,
        state.currentStrokeStyle.color,
        state.currentStrokeStyle.thickness,
        state.currentStrokeStyle.glow
      );
    }
  });
}

function eraseNear(screenX, screenY, radius) {
  const center = screenToArt({ x: screenX, y: screenY });

  strokes = strokes.map(stroke => {
    const segments = [];
    let activeSegment = [];

    stroke.points.forEach(point => {
      const distance = Math.hypot(point.x - center.x, point.y - center.y);
      if (distance > radius) {
        activeSegment.push(point);
      } else if (activeSegment.length > 1) {
        segments.push({ ...stroke, points: [...activeSegment] });
        activeSegment = [];
      } else {
        activeSegment = [];
      }
    });

    if (activeSegment.length > 1) {
      segments.push({ ...stroke, points: [...activeSegment] });
    }

    return segments;
  }).flat();

  handStates.forEach(state => {
    state.currentStroke = state.currentStroke.filter(point => Math.hypot(point.x - center.x, point.y - center.y) > radius);
  });

  redrawStrokes();
}

function moveArtwork(deltaX, deltaY) {
  artOffset.x += deltaX;
  artOffset.y += deltaY;
  redrawStrokes();
}

function spawnSparkles(point, mode, color) {
  if (!point || mode === 'none') {
    return;
  }

  const burstCount = mode === 'erasing' ? 3 : mode === 'grab' ? 1 : 2;
  for (let i = 0; i < burstCount; i += 1) {
    sparkles.push({
      x: point.x + (Math.random() - 0.5) * 10,
      y: point.y + (Math.random() - 0.5) * 10,
      size: Math.random() * 2.3 + 0.8,
      alpha: Math.random() * 0.45 + 0.35,
      life: 1,
      decay: Math.random() * 0.05 + 0.04,
      vx: (Math.random() - 0.5) * 1.1,
      vy: (Math.random() - 0.5) * 1.1,
      color: color || (mode === 'erasing' ? '#80d4ff' : mode === 'grab' ? '#ffd080' : currentColor)
    });
  }

  if (sparkles.length > MAX_SPARKLES) {
    sparkles = sparkles.slice(-MAX_SPARKLES);
  }
}

function drawSparkles() {
  sctx.clearRect(0, 0, sparkleCanvas.width, sparkleCanvas.height);
  sparkles = sparkles.filter(sparkle => sparkle.life > 0);

  sparkles.forEach(sparkle => {
    sctx.save();
    sctx.globalAlpha = sparkle.alpha * sparkle.life;
    sctx.fillStyle = sparkle.color;
    sctx.shadowColor = sparkle.color;
    sctx.shadowBlur = 6;
    sctx.beginPath();
    sctx.arc(sparkle.x, sparkle.y, sparkle.size, 0, Math.PI * 2);
    sctx.fill();
    sctx.restore();

    sparkle.x += sparkle.vx;
    sparkle.y += sparkle.vy;
    sparkle.life -= sparkle.decay;
  });
}

function getAccentColor(mode) {
  if (mode === 'erasing') return 'rgba(128, 212, 255, 0.95)';
  if (mode === 'drawing') return 'rgba(255, 128, 180, 0.95)';
  return 'rgba(255, 208, 128, 0.95)';
}

function drawHandOverlay() {
  tctx.clearRect(0, 0, trackingCanvas.width, trackingCanvas.height);

  handStates.forEach(state => {
    if (!state.landmarks || !state.cursorPoint) {
      return;
    }

    const width = trackingCanvas.width;
    const height = trackingCanvas.height;
    const points = state.landmarks.map(landmark => toCanvasPoint(landmark, width, height));
    const accentColor = getAccentColor(state.mode);

    tctx.save();
    tctx.lineWidth = 2;
    tctx.lineCap = 'round';
    tctx.lineJoin = 'round';
    tctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';

    HAND_CONNECTIONS.forEach(([fromIndex, toIndex]) => {
      tctx.beginPath();
      tctx.moveTo(points[fromIndex].x, points[fromIndex].y);
      tctx.lineTo(points[toIndex].x, points[toIndex].y);
      tctx.stroke();
    });

    points.forEach((point, index) => {
      tctx.beginPath();
      tctx.fillStyle = index === 8 ? accentColor : 'rgba(255, 255, 255, 0.65)';
      tctx.shadowColor = index === 8 ? accentColor : 'transparent';
      tctx.shadowBlur = index === 8 ? 10 : 0;
      tctx.arc(point.x, point.y, index === 8 ? 6 : 3.1, 0, Math.PI * 2);
      tctx.fill();
    });

    const ringRadius = state.mode === 'erasing' ? ERASE_RADIUS : thickness * 1.25 + 8;
    tctx.strokeStyle = accentColor;
    tctx.lineWidth = state.mode === 'erasing' ? 1.5 : 2;
    tctx.setLineDash(state.mode === 'erasing' ? [6, 6] : []);
    tctx.beginPath();
    tctx.arc(state.cursorPoint.x, state.cursorPoint.y, ringRadius, 0, Math.PI * 2);
    tctx.stroke();

    tctx.setLineDash([]);
    tctx.font = '600 12px "DM Sans", sans-serif';
    tctx.fillStyle = accentColor;
    tctx.fillText(state.id.toUpperCase(), points[0].x + 8, points[0].y - 8);
    tctx.restore();
  });
}

function isFingerExtended(landmarks, tipIndex, pipIndex, mcpIndex) {
  const tip = landmarks[tipIndex];
  const pip = landmarks[pipIndex];
  const mcp = landmarks[mcpIndex];
  return tip.y < pip.y - 0.015 && pip.y < mcp.y + 0.01 && tip.y < mcp.y - 0.045;
}

function detectGesture(landmarks) {
  const states = {
    index: isFingerExtended(landmarks, 8, 6, 5),
    middle: isFingerExtended(landmarks, 12, 10, 9),
    ring: isFingerExtended(landmarks, 16, 14, 13),
    pinky: isFingerExtended(landmarks, 20, 18, 17)
  };

  const openCount = Object.values(states).filter(Boolean).length;
  const palmSize = Math.max(distanceBetweenLandmarks(landmarks, 0, 9), 0.08);
  const pinchDistance = distanceBetweenLandmarks(landmarks, 4, 8) / palmSize;
  const indexLead = landmarks[8].y < landmarks[12].y - 0.055;
  const middleFolded = landmarks[12].y > landmarks[10].y - 0.008;
  const ringFolded = landmarks[16].y > landmarks[14].y - 0.008;
  const pinkyFolded = landmarks[20].y > landmarks[18].y - 0.008;
  const openPalm = openCount >= 3 && landmarks[8].y < landmarks[5].y && landmarks[12].y < landmarks[9].y;
  const drawPose = states.index && indexLead && middleFolded && ringFolded && pinkyFolded && pinchDistance > 0.28;
  const relaxedDrawPose = states.index && openCount <= 2 && indexLead && ringFolded;
  const fistPose = openCount === 0 || pinchDistance < 0.24;

  if (openPalm) return 'erasing';
  if (drawPose || relaxedDrawPose) return 'drawing';
  if (fistPose) return 'grab';
  return 'grab';
}

function stabilizeMode(state, rawMode) {
  if (rawMode === state.mode) {
    state.pendingMode = rawMode;
    state.pendingModeFrames = 0;
    return rawMode;
  }

  if (rawMode !== state.pendingMode) {
    state.pendingMode = rawMode;
    state.pendingModeFrames = 1;
    return state.mode || 'none';
  }

  state.pendingModeFrames += 1;
  const threshold = rawMode === 'drawing' ? 2 : 3;
  if (state.pendingModeFrames >= threshold) {
    state.mode = rawMode;
    state.pendingModeFrames = 0;
  }

  return state.mode || 'none';
}

function chooseGrabHand(candidates) {
  const existing = candidates.find(state => state.id === activeGrab.handId);
  return existing || candidates[0];
}

function releaseGrab() {
  activeGrab.handId = null;
  activeGrab.lastPoint = null;
}

function processGrab(grabState) {
  handStates.forEach(state => finalizeStroke(state));

  if (activeGrab.handId !== grabState.id || !activeGrab.lastPoint) {
    activeGrab.handId = grabState.id;
    activeGrab.lastPoint = { ...grabState.cursorPoint };
    return;
  }

  const deltaX = grabState.cursorPoint.x - activeGrab.lastPoint.x;
  const deltaY = grabState.cursorPoint.y - activeGrab.lastPoint.y;

  if (Math.abs(deltaX) > 0.2 || Math.abs(deltaY) > 0.2) {
    moveArtwork(deltaX, deltaY);
    spawnSparkles(grabState.cursorPoint, 'grab', '#ffd080');
  }

  activeGrab.lastPoint = { ...grabState.cursorPoint };
}

function processDrawing(state) {
  const artPoint = screenToArt(state.cursorPoint);

  if (!state.isDrawing) {
    state.isDrawing = true;
    state.currentStroke = [];
    state.currentStrokeStyle = { color: currentColor, thickness, glow: glowAmount };
    state.lastX = artPoint.x;
    state.lastY = artPoint.y;
    state.currentStroke.push({ x: artPoint.x, y: artPoint.y });
    return;
  }

  const distance = Math.hypot(artPoint.x - state.lastX, artPoint.y - state.lastY);
  if (distance >= MIN_DRAW_DISTANCE) {
    state.currentStroke.push({ x: artPoint.x, y: artPoint.y });
    const from = artToScreen({ x: state.lastX, y: state.lastY });
    const to = artToScreen(artPoint);
    drawSegment(
      from.x,
      from.y,
      to.x,
      to.y,
      state.currentStrokeStyle.color,
      state.currentStrokeStyle.thickness,
      state.currentStrokeStyle.glow
    );
    state.lastX = artPoint.x;
    state.lastY = artPoint.y;
    spawnSparkles(state.cursorPoint, 'drawing', state.currentStrokeStyle.color);
  }
}

function onResults(results) {
  const landmarksList = results.multiHandLandmarks || [];
  const handednessList = results.multiHandedness || [];
  const seenHands = new Set();

  landmarksList.forEach((landmarks, index) => {
    const handId = handednessList[index]?.label || `hand-${index + 1}`;
    const state = getHandState(handId);
    seenHands.add(handId);

    state.landmarks = smoothLandmarks(state.landmarks, landmarks);
    state.rawMode = detectGesture(state.landmarks);
    state.mode = stabilizeMode(state, state.rawMode);

    const tip = toCanvasPoint(state.landmarks[8], drawCanvas.width, drawCanvas.height);
    const smoothing = state.mode === 'drawing' ? 0.5 : CURSOR_SMOOTHING;
    state.cursorPoint = smoothPoint(state.cursorPoint, tip, smoothing);
  });

  handStates.forEach((state, handId) => {
    if (!seenHands.has(handId)) {
      resetHandState(state);
    }
  });

  const activeStates = Array.from(handStates.values()).filter(state => state.landmarks && state.cursorPoint);
  updateHud(activeStates);

  if (activeStates.length === 0) {
    releaseGrab();
    return;
  }

  const grabStates = activeStates.filter(state => state.mode === 'grab');
  if (grabStates.length > 0) {
    processGrab(chooseGrabHand(grabStates));
    return;
  }

  releaseGrab();

  activeStates.forEach(state => {
    if (state.mode !== 'drawing') {
      finalizeStroke(state);
    }
  });

  activeStates
    .filter(state => state.mode === 'erasing')
    .forEach(state => {
      eraseNear(state.cursorPoint.x, state.cursorPoint.y, ERASE_RADIUS);
      spawnSparkles(state.cursorPoint, 'erasing', '#80d4ff');
    });

  activeStates
    .filter(state => state.mode === 'drawing')
    .forEach(state => {
      processDrawing(state);
    });
}

async function processFrame() {
  if (!hands || isProcessingFrame || video.readyState < 2) {
    return;
  }

  isProcessingFrame = true;

  try {
    await hands.send({ image: video });
  } catch (error) {
    console.error(error);
    const reason = error && error.message ? error.message : String(error);
    setStartError(`Hand tracking stopped: ${reason}`);
    stopCamera();
    hands = null;
    appStarted = false;
    startScreen.classList.remove('hidden');
    setStartButtonState(false);
  } finally {
    isProcessingFrame = false;
  }
}

function stopLoop() {
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
}

function resetTracking() {
  handStates.forEach(state => resetHandState(state));
  activeGrab.handId = null;
  activeGrab.lastPoint = null;
  isProcessingFrame = false;
  tctx.clearRect(0, 0, trackingCanvas.width, trackingCanvas.height);
  sctx.clearRect(0, 0, sparkleCanvas.width, sparkleCanvas.height);
  setMode('none', 'READY');
  setTrackingState('SEARCH', 'rgba(255, 255, 255, 0.6)');
}

function loop() {
  updateFps();
  processFrame();
  drawSparkles();
  drawHandOverlay();
  animFrame = requestAnimationFrame(loop);
}

function undoLast() {
  let removedActiveStroke = false;
  handStates.forEach(state => {
    if (state.currentStroke.length > 1) {
      state.currentStroke = [];
      state.isDrawing = false;
      state.lastX = null;
      state.lastY = null;
      removedActiveStroke = true;
    }
  });

  if (!removedActiveStroke) {
    strokes.pop();
  }

  redrawStrokes();
}

function clearCanvas() {
  strokes = [];
  sparkles = [];
  artOffset = { x: 0, y: 0 };
  handStates.forEach(state => {
    state.currentStroke = [];
    state.isDrawing = false;
    state.lastX = null;
    state.lastY = null;
  });
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  sctx.clearRect(0, 0, sparkleCanvas.width, sparkleCanvas.height);
}

function stopCamera() {
  stopLoop();
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  resetTracking();
}

async function startApp() {
  if (appStarted) return;

  setStartError('');
  setStartButtonState(true);

  try {
    if (typeof Hands !== 'function') {
      throw new Error('Hand tracking library failed to load. Refresh the page and try again.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support camera access.');
    }

    hands = new Hands({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.68,
      minTrackingConfidence: 0.68
    });
    hands.onResults(onResults);

    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 960 },
        height: { ideal: 540 },
        facingMode: 'user',
        frameRate: { ideal: 30, max: 30 }
      }
    });

    video.srcObject = cameraStream;
    await video.play();

    appStarted = true;
    fps = 0;
    lastFrameStamp = performance.now();
    startScreen.classList.add('hidden');
    video.classList.add('visible');
    document.getElementById('panel').classList.add('visible');
    document.getElementById('modeBadge').classList.add('visible');
    resize();
    resetTracking();
    loop();
  } catch (error) {
    stopCamera();
    hands = null;
    appStarted = false;
    startScreen.classList.remove('hidden');
    setStartError(error.message || 'Camera access failed. Please check your browser permissions.');
  } finally {
    setStartButtonState(false);
  }
}

function resize() {
  drawCanvas.width = trackingCanvas.width = sparkleCanvas.width = window.innerWidth;
  drawCanvas.height = trackingCanvas.height = sparkleCanvas.height = window.innerHeight;
  redrawStrokes();
}

initColorPicker();
resize();
setMode('none', 'READY');

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', stopCamera);

window.startApp = startApp;
window.undoLast = undoLast;
window.clearCanvas = clearCanvas;
window.detectGesture = detectGesture;
