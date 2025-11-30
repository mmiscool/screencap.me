// -----------------------------
// State
// -----------------------------
const previewVideo = document.getElementById('preview');
const btnStartCapture = document.getElementById('btnStartCapture');
const btnStartRecording = document.getElementById('btnStartRecording');
const btnExport = document.getElementById('btnExport');
const captureStatus = document.getElementById('captureStatus');
const recordingIndicatorText = document.getElementById('recordingIndicatorText');
const clipListEl = document.getElementById('clipList');
const clipCountEl = document.getElementById('clipCount');
const statusEl = document.getElementById('status');
const downloadLink = document.getElementById('downloadLink');
const btnImportClip = document.getElementById('btnImportClip');
const btnImportProject = document.getElementById('btnImportProject');
const btnExportProject = document.getElementById('btnExportProject');
const clipFileInput = document.getElementById('clipFileInput');
const projectFileInput = document.getElementById('projectFileInput');
const btnAddTitleClip = document.getElementById('btnAddTitleClip');
const titleBgFileInput = document.getElementById('titleBgFileInput');
const btnWebcamPiP = document.getElementById('btnWebcamPiP');
const webcamPiPVideo = document.getElementById('webcamPiP');
const audioOffsetInput = document.getElementById('audioOffsetInput');
const btnApplyAudioOffset = document.getElementById('btnApplyAudioOffset');
const audioOffsetHint = document.getElementById('audioOffsetHint');
const renderOverlay = document.getElementById('renderOverlay');
const renderProgressMeter = document.getElementById('renderProgressMeter');
const renderProgressLabel = document.getElementById('renderProgressLabel');
const renderSubstatus = document.getElementById('renderSubstatus');
const renderTimeRemaining = document.getElementById('renderTimeRemaining');
const renderPreviewContainer = document.getElementById('renderPreviewContainer');
const btnCancelRender = document.getElementById('btnCancelRender');

let displayStream = null;
let micStream = null;
let combinedStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentMimeType = '';
let isRecording = false;
let stopOverlay = null;
let dragSourceClipId = null;
let webcamStream = null;
let audioOffsetMs = 120; // delays mic audio to help sync with PiP webcam
let captureAudioCtx = null;
let micSourceNode = null;
let micDelayNode = null;
let micDestNode = null;
let pendingBgTargetId = null;
let previewBaseDims = null;
let previewBaseDimsPromise = null;
let activeRenderCancel = null;
let renderStartTimeMs = 0;
let renderTotalSeconds = 0;
let renderPreviewCanvas = null;

const baseFontOptions = [
  { label: 'Sans (Inter)', value: 'Inter, system-ui, sans-serif' },
  { label: 'Serif (Georgia)', value: 'Georgia, serif' },
  { label: 'Mono (Courier New)', value: '"Courier New", monospace' }
];
let availableFontOptions = [...baseFontOptions];

const clips = []; // { id, type, blob?, url?, duration, trimStart, trimEnd, ... }

// Export pipeline (canvas + MediaRecorder)
let exportRecording = false;

// -----------------------------
// Helpers
// -----------------------------
import { fontDetectionCandidates } from './fontDetectionCandidates.js';

const sleep = ms => new Promise(res => setTimeout(res, ms));

function dedupeFontOptions(list) {
  const seen = new Set();
  const result = [];
  for (const opt of list) {
    const key = (opt.value || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(opt);
  }
  return result;
}

async function detectAvailableFonts(candidates) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  const sample = 'AaBbCcDdEeFfGg1234567890';
  const measure = (font) => {
    ctx.font = `32px ${font}`;
    return ctx.measureText(sample).width;
  };

  const baselines = {
    serif: measure('serif'),
    sans: measure('sans-serif'),
    mono: measure('monospace')
  };

  const available = [];
  for (const name of candidates) {
    const testFont = `'${name}', sans-serif`;
    const width = measure(testFont);
    if (width !== baselines.serif && width !== baselines.sans && width !== baselines.mono) {
      available.push({ label: name, value: `${name}, sans-serif` });
    }
  }
  return available;
}

function resetPreviewDimensionsCache() {
  previewBaseDims = null;
  previewBaseDimsPromise = null;
}

async function computePreviewDimensions() {
  const fallback = { width: 1280, height: 720 };
  const firstVideo = clips.find(c => c.type !== 'title' && c.url);
  if (firstVideo) {
    try {
      const meta = await loadVideoMetadata(firstVideo.url);
      if (Number.isFinite(meta.width) && Number.isFinite(meta.height)) {
        return { width: meta.width, height: meta.height };
      }
    } catch (_) {
      // ignore and fall back
    }
  }

  const firstTitleWithBg = clips.find(c => c.type === 'title' && c.bgDataUrl);
  if (firstTitleWithBg) {
    try {
      const imgMeta = await loadImageDimensions(firstTitleWithBg.bgDataUrl);
      if (Number.isFinite(imgMeta.width) && Number.isFinite(imgMeta.height)) {
        return { width: imgMeta.width, height: imgMeta.height };
      }
    } catch (_) {
      // ignore and fall back
    }
  }

  return fallback;
}

function getPreviewDimensions() {
  if (previewBaseDims) return Promise.resolve(previewBaseDims);
  if (!previewBaseDimsPromise) {
    previewBaseDimsPromise = computePreviewDimensions().then(res => {
      previewBaseDims = res;
      return res;
    }).catch(() => {
      previewBaseDims = { width: 1280, height: 720 };
      return previewBaseDims;
    });
  }
  return previewBaseDimsPromise;
}

function resetRenderPreviewContainer() {
  if (!renderPreviewContainer) return;
  renderPreviewContainer.innerHTML = '<div class="render-preview-placeholder">Preview appears here while exporting.</div>';
}

function mountRenderPreviewCanvas(canvas) {
  if (!renderPreviewContainer || !canvas) return;
  renderPreviewContainer.innerHTML = '';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  renderPreviewContainer.appendChild(canvas);
}

function showRenderOverlay(totalSeconds = 0) {
  renderTotalSeconds = Math.max(0.1, Number.isFinite(totalSeconds) ? totalSeconds : 0.1);
  renderStartTimeMs = performance.now();
  if (renderProgressMeter) renderProgressMeter.value = 0;
  if (renderProgressLabel) renderProgressLabel.textContent = '0%';
  if (renderTimeRemaining) renderTimeRemaining.textContent = 'Estimating time…';
  if (renderSubstatus) renderSubstatus.textContent = 'Preparing export pipeline…';
  if (renderOverlay) {
    renderOverlay.hidden = false;
    renderOverlay.style.display = 'flex';
    renderOverlay.classList.add('active');
    renderOverlay.setAttribute('aria-hidden', 'false');
  }
  document.body.classList.add('rendering-active');
}

function hideRenderOverlay() {
  if (renderOverlay) {
    renderOverlay.classList.remove('active');
    renderOverlay.setAttribute('aria-hidden', 'true');
    renderOverlay.style.display = 'none';
    renderOverlay.hidden = true;
  }
  document.body.classList.remove('rendering-active');
  renderStartTimeMs = 0;
  renderTotalSeconds = 0;
  activeRenderCancel = null;
  if (btnCancelRender) {
    btnCancelRender.disabled = false;
    btnCancelRender.textContent = 'Cancel';
  }
  resetRenderPreviewContainer();
  renderPreviewCanvas = null;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Estimating…';
  if (seconds >= 90) {
    return `~${Math.round(seconds / 60)}m left`;
  }
  if (seconds >= 1) {
    return `~${seconds.toFixed(1)}s left`;
  }
  return '<1s left';
}

function updateRenderProgressUI(completedSeconds, label) {
  const total = renderTotalSeconds > 0 ? renderTotalSeconds : 0;
  const clamped = Math.max(0, Math.min(total || completedSeconds, completedSeconds));
  const pct = total > 0 ? Math.min(100, Math.max(0, (clamped / total) * 100)) : 0;

  if (typeof label === 'string' && renderSubstatus) {
    renderSubstatus.textContent = label;
  }
  if (renderProgressMeter) {
    renderProgressMeter.value = pct;
  }
  if (renderProgressLabel) renderProgressLabel.textContent = `${pct.toFixed(0)}%`;

  if (renderTimeRemaining) {
    let eta = 'Estimating…';
    if (renderStartTimeMs && clamped > 0 && total > 0) {
      const elapsedSec = (performance.now() - renderStartTimeMs) / 1000;
      const rate = clamped / Math.max(0.001, elapsedSec);
      if (rate > 0) {
        const remainingSec = Math.max(0, (total - clamped) / rate);
        eta = formatEta(remainingSec);
      }
    }
    renderTimeRemaining.textContent = eta;
  }
}

function setCaptureStatus(mode) {
  // mode: 'idle' | 'live' | 'recording'
  captureStatus.innerHTML = '';
  const dot = document.createElement('span');
  if (mode === 'idle') {
    dot.className = 'status-dot-idle';
    captureStatus.appendChild(dot);
    captureStatus.appendChild(document.createTextNode(' Idle'));
  } else if (mode === 'live') {
    dot.className = 'status-dot-live';
    captureStatus.appendChild(dot);
    captureStatus.appendChild(document.createTextNode(' Capture ready'));
  } else if (mode === 'recording') {
    dot.className = 'status-dot-recording';
    captureStatus.appendChild(dot);
    captureStatus.appendChild(document.createTextNode(' Recording clip'));
  }
}

function updateRecordingIndicator() {
  recordingIndicatorText.textContent = isRecording ? 'Recording clip…' : 'Not recording';
}

function revokeClipUrls() {
  clips.forEach(c => {
    if (c.url) URL.revokeObjectURL(c.url);
  });
}

function drawImageWithFit(ctx, targetW, targetH, img, fit = 'cover') {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const targetRatio = targetW / targetH;
  const imgRatio = iw / ih;
  let drawW = targetW;
  let drawH = targetH;

  if (fit === 'contain') {
    if (imgRatio > targetRatio) {
      drawW = targetW;
      drawH = targetW / imgRatio;
    } else {
      drawH = targetH;
      drawW = targetH * imgRatio;
    }
  } else {
    if (imgRatio > targetRatio) {
      drawH = targetH;
      drawW = targetH * imgRatio;
    } else {
      drawW = targetW;
      drawH = targetW / imgRatio;
    }
  }

  const dx = (targetW - drawW) / 2;
  const dy = (targetH - drawH) / 2;
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      console.log('Data URL info:', {
        length: result.length,
        header: result.substring(0, 100),
        size: blob.size,
        type: blob.type
      });
      resolve(result);
    };
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  // Parse the data URL: data:[<mime>][;base64],<data>
  if (!dataUrl.startsWith('data:')) {
    throw new Error('Invalid data URL format');
  }
  
  // Look for ";base64," or just "," to find the split point
  let splitIndex = -1;
  let isBase64 = false;
  
  const base64Marker = ';base64,';
  const base64Index = dataUrl.indexOf(base64Marker);
  
  if (base64Index !== -1) {
    // Found ";base64," marker
    splitIndex = base64Index + base64Marker.length;
    isBase64 = true;
  } else {
    // No base64, find the first comma after "data:"
    splitIndex = dataUrl.indexOf(',', 5);
    if (splitIndex === -1) {
      throw new Error('Invalid data URL format - no comma found');
    }
    splitIndex += 1; // Move past the comma
  }
  
  const header = dataUrl.substring(0, splitIndex - 1); // -1 to exclude the comma
  const data = dataUrl.substring(splitIndex);
  
  // Extract MIME type
  let mime = 'application/octet-stream';
  if (isBase64) {
    // Remove "data:" from start and ";base64" from end
    mime = header.substring(5, header.length - 7); // 5 = "data:".length, 7 = ";base64".length
  } else {
    // Remove "data:" from start
    mime = header.substring(5);
  }
  
  console.log('Decoding data URL:', {
    mime,
    isBase64,
    dataLength: data.length,
    headerLength: header.length,
    header: header.substring(0, 100)
  });
  
  if (isBase64) {
    // Decode base64 to binary
    const binaryString = atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    console.log('Decoded first 4 bytes:', Array.from(bytes.slice(0, 4)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
    return new Blob([bytes], { type: mime });
  } else {
    // URL encoded
    const decoded = decodeURIComponent(data);
    return new Blob([decoded], { type: mime });
  }
}

const clampAudioOffset = (val) => {
  const num = Number.isFinite(val) ? val : 0;
  return Math.max(0, Math.min(1000, num));
};

function updateAudioOffsetUI() {
  if (audioOffsetInput) {
    audioOffsetInput.value = audioOffsetMs.toString();
  }
  if (audioOffsetHint) {
    audioOffsetHint.textContent = audioOffsetMs > 0
      ? `${audioOffsetMs}ms mic delay will apply when Webcam PiP is active.`
      : 'No mic delay (0ms).';
  }
}

function shouldDelayMicAudio() {
  return audioOffsetMs > 0 && (document.pictureInPictureElement === webcamPiPVideo || webcamStream);
}

function teardownCaptureAudioGraph() {
  try { if (micSourceNode) micSourceNode.disconnect(); } catch (_) {}
  try { if (micDelayNode) micDelayNode.disconnect(); } catch (_) {}
  try { if (micDestNode) micDestNode.disconnect(); } catch (_) {}
  micSourceNode = null;
  micDelayNode = null;
  micDestNode = null;
  if (captureAudioCtx) {
    captureAudioCtx.close().catch(() => {});
    captureAudioCtx = null;
  }
}

function applyMicAudioToStream(targetStream) {
  if (!micStream) return;
  const micTracks = micStream.getAudioTracks();
  if (!micTracks.length) return;

  if (shouldDelayMicAudio()) {
    teardownCaptureAudioGraph();
    captureAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micSourceNode = captureAudioCtx.createMediaStreamSource(micStream);
    micDelayNode = captureAudioCtx.createDelay(1.5);
    const delaySeconds = Math.min(audioOffsetMs / 1000, micDelayNode.delayTime.maxValue || 1.5);
    micDelayNode.delayTime.value = delaySeconds;
    micDestNode = captureAudioCtx.createMediaStreamDestination();
    micSourceNode.connect(micDelayNode).connect(micDestNode);
    if (captureAudioCtx.state === 'suspended') {
      captureAudioCtx.resume().catch(() => {});
    }
    micDestNode.stream.getAudioTracks().forEach(t => targetStream.addTrack(t));
  } else {
    teardownCaptureAudioGraph();
    micTracks.forEach(t => targetStream.addTrack(t));
  }
}

function rebuildCombinedStream() {
  if (!displayStream) return null;
  const newStream = new MediaStream();
  displayStream.getVideoTracks().forEach(t => newStream.addTrack(t));
  applyMicAudioToStream(newStream);
  combinedStream = newStream;
  previewVideo.srcObject = combinedStream;
  return combinedStream;
}

function rebuildCombinedStreamIfIdle() {
  if (!displayStream || !micStream) return;
  if (isRecording) {
    statusEl.textContent = 'Mic offset update will apply after the current recording stops.';
    return;
  }
  rebuildCombinedStream();
}

function applyAudioOffsetFromInput() {
  const nextVal = clampAudioOffset(parseFloat(audioOffsetInput.value));
  audioOffsetMs = nextVal;
  updateAudioOffsetUI();
  if (displayStream && micStream) {
    rebuildCombinedStreamIfIdle();
  }
  if (nextVal > 0) {
    if (shouldDelayMicAudio()) {
      statusEl.textContent = `Mic audio delayed ${nextVal}ms for webcam sync.`;
    } else {
      statusEl.textContent = `Mic delay set to ${nextVal}ms. Open Webcam PiP to apply it.`;
    }
  } else {
    statusEl.textContent = 'Mic delay disabled.';
  }
}

// -----------------------------
// Capture setup
// -----------------------------
async function startCapture() {
  try {
    statusEl.textContent = 'Requesting screen + microphone…';

    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true // system/tab audio if user allows
    });

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    });

    // Merge video from screen + audio from mic into one MediaStream
    const newStream = new MediaStream();
    screenStream.getVideoTracks().forEach(t => newStream.addTrack(t));
    // Use mic audio here; you could also mix system + mic audio via AudioContext
    mic.getAudioTracks().forEach(t => newStream.addTrack(t));

    displayStream = screenStream;
    micStream = mic;
    rebuildCombinedStream();

    btnStartCapture.disabled = true;
    btnStartRecording.disabled = false;

    setCaptureStatus('live');
    statusEl.textContent = 'Capture ready. Recording first clip…';
    startRecording();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed to start capture: ' + err.message;
    setCaptureStatus('idle');
  }
}

function stopAllTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
}

function stopCapture() {
  if (isRecording && mediaRecorder) {
    mediaRecorder.stop();
  }
  stopAllTracks(displayStream);
  stopAllTracks(micStream);
  stopAllTracks(combinedStream);
  teardownCaptureAudioGraph();

  displayStream = null;
  micStream = null;
  combinedStream = null;

  previewVideo.srcObject = null;

  btnStartCapture.disabled = false;
  btnStartRecording.disabled = true;

  isRecording = false;
  updateRecordingIndicator();
  setCaptureStatus('idle');
  statusEl.textContent = 'Capture stopped.';
}

function setWebcamPiPButtonState(active) {
  btnWebcamPiP.textContent = active ? 'Close Webcam PiP' : 'Webcam PiP';
}

function cleanupWebcamStream() {
  stopAllTracks(webcamStream);
  webcamStream = null;
  if (webcamPiPVideo) {
    webcamPiPVideo.srcObject = null;
  }
}

async function toggleWebcamPiP() {
  if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
    statusEl.textContent = 'Picture-in-Picture is not supported in this browser.';
    return;
  }

  btnWebcamPiP.disabled = true;
  try {
    if (document.pictureInPictureElement === webcamPiPVideo) {
      await document.exitPictureInPicture();
      cleanupWebcamStream();
      setWebcamPiPButtonState(false);
      statusEl.textContent = 'Webcam PiP closed.';
      rebuildCombinedStreamIfIdle();
      return;
    }

    if (!webcamStream) {
      statusEl.textContent = 'Requesting webcam for PiP…';
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
      webcamPiPVideo.srcObject = webcamStream;
      webcamPiPVideo.muted = true;
      await webcamPiPVideo.play();
    }

    await webcamPiPVideo.requestPictureInPicture();
    setWebcamPiPButtonState(true);
    statusEl.textContent = 'Webcam is in Picture-in-Picture.';
    rebuildCombinedStreamIfIdle();
    if (shouldDelayMicAudio() && displayStream && micStream && !isRecording) {
      statusEl.textContent = `Webcam is in Picture-in-Picture. Applied ${audioOffsetMs}ms mic delay for sync.`;
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Webcam PiP failed: ' + err.message;
    cleanupWebcamStream();
  } finally {
    btnWebcamPiP.disabled = false;
  }
}

function stopWebcamPiP() {
  if (document.pictureInPictureElement === webcamPiPVideo) {
    document.exitPictureInPicture().catch(() => {});
  }
  cleanupWebcamStream();
  setWebcamPiPButtonState(false);
  rebuildCombinedStreamIfIdle();
}

function selectMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

function startRecording() {
  if (!combinedStream && displayStream) {
    rebuildCombinedStream();
  }
  if (!combinedStream) {
    statusEl.textContent = 'Capture is not active.';
    return;
  }

  recordedChunks = [];
  currentMimeType = selectMimeType();

  try {
    mediaRecorder = currentMimeType
      ? new MediaRecorder(combinedStream, { mimeType: currentMimeType, bitsPerSecond: 4_000_000 })
      : new MediaRecorder(combinedStream);

    mediaRecorder.ondataavailable = evt => {
      if (evt.data && evt.data.size > 0) {
        recordedChunks.push(evt.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (recordedChunks.length) {
        const blob = new Blob(recordedChunks, { type: currentMimeType || 'video/webm' });
        addClip(blob);
      }
      recordedChunks = [];
    };

    mediaRecorder.start(250); // gather chunks
    isRecording = true;
    updateRecordingIndicator();
    setCaptureStatus('recording');

    btnStartRecording.disabled = true;
    statusEl.textContent = 'Recording clip…';

    // Show full-screen stop overlay
    if (!stopOverlay) {
      stopOverlay = document.createElement('div');
      stopOverlay.className = 'stop-overlay';
      stopOverlay.innerHTML = '<button class="stop-overlay-btn">Stop Recording</button>';
      document.body.appendChild(stopOverlay);
      stopOverlay.querySelector('button').addEventListener('click', stopRecording);
    }
    stopOverlay.style.display = 'flex';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed to start recording: ' + err.message;
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  mediaRecorder.stop();
  isRecording = false;
  updateRecordingIndicator();
  setCaptureStatus('live');

  btnStartRecording.disabled = false;
  if (stopOverlay) {
    stopOverlay.style.display = 'none';
  }
  statusEl.textContent = 'Clip captured. You can record another or export.';
}

// -----------------------------
// Clips
// -----------------------------
function addClip(blob, options = {}) {
  resetPreviewDimensionsCache();
  const url = URL.createObjectURL(blob);
  const defaultTitle = (typeof options.title === 'string' && options.title.trim())
    ? options.title.trim()
    : `Clip ${clips.length + 1}`;

  const clip = {
    type: 'video',
    id: options.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    blob,
    url,
    title: defaultTitle,
    duration: Number.isFinite(options.duration) ? options.duration : null,
    trimStart: Number.isFinite(options.trimStart) ? options.trimStart : 0,
    trimEnd: Number.isFinite(options.trimEnd) ? options.trimEnd : null
  };

  clips.push(clip);
  clipCountEl.textContent = clips.length.toString();
  btnExport.disabled = clips.length === 0;
  renderClipList();

  // Load metadata to determine duration (robustly)
  loadVideoMetadata(url).then(meta => {
    if (Number.isFinite(meta.duration) && meta.duration > 0) {
      clip.duration = meta.duration;
      if (clip.trimEnd === null || !Number.isFinite(clip.trimEnd)) {
        clip.trimEnd = meta.duration;
      } else {
        clip.trimEnd = Math.min(clip.trimEnd, meta.duration);
      }
      if (clip.trimEnd <= clip.trimStart) {
        clip.trimEnd = Math.min(meta.duration, clip.trimStart + 0.05);
      }
      renderClipList(); // update UI with duration
    }
  }).catch(() => {
    // ignore metadata failures
  });
}

function addTitleClip(options = {}) {
  const duration = Number.isFinite(options.duration) ? Math.max(0.1, options.duration) : 3;
  const trimStart = Number.isFinite(options.trimStart) ? Math.max(0, options.trimStart) : 0;
  const trimEnd = Number.isFinite(options.trimEnd)
    ? Math.max(trimStart + 0.01, options.trimEnd)
    : duration;
  const fallbackTitle = `Title Block ${clips.length + 1}`;
  const clip = {
    type: 'title',
    id: options.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    title: (typeof options.title === 'string' && options.title.trim()) ? options.title.trim() : fallbackTitle,
    duration,
    trimStart,
    trimEnd,
    text: typeof options.text === 'string' ? options.text : '',
    textColor: options.textColor || '#ffffff',
    textSize: Number.isFinite(options.textSize) ? Math.max(8, options.textSize) : 48,
    textAlign: options.textAlign || 'center',
    fontFamily: options.fontFamily || 'Inter, system-ui, sans-serif',
    bgDataUrl: options.bgDataUrl || null,
    bgMimeType: options.bgMimeType || null,
    backgroundFit: options.backgroundFit || 'cover'
  };

  clips.push(clip);
  clipCountEl.textContent = clips.length.toString();
  btnExport.disabled = clips.length === 0;
  renderClipList();
  statusEl.textContent = 'Added title block.';
  return clip;
}

function renderClipList() {
  clipListEl.innerHTML = '';

  if (!clips.length) {
    const empty = document.createElement('div');
    empty.style.fontSize = '11px';
    empty.style.color = 'var(--muted)';
    empty.textContent = 'No clips yet. Record, import, or add a title block to start.';
    clipListEl.appendChild(empty);
    return;
  }

  clips.forEach((clip, index) => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.dataset.id = clip.id;

    const header = document.createElement('div');
    header.className = 'clip-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'clip-header-left';

    const indexPill = document.createElement('div');
    indexPill.className = 'index-pill';
    indexPill.textContent = `#${index + 1}`;
    indexPill.draggable = true;

    const btnGroup = document.createElement('div');
    btnGroup.className = 'btn-group';

    const btnUp = document.createElement('button');
    btnUp.className = 'secondary small round';
    btnUp.type = 'button';
    btnUp.textContent = '↑';
    btnUp.disabled = index === 0;

    const btnDown = document.createElement('button');
    btnDown.className = 'secondary small round';
    btnDown.type = 'button';
    btnDown.textContent = '↓';
    btnDown.disabled = index === clips.length - 1;

    const btnDelete = document.createElement('button');
    btnDelete.className = 'danger small round';
    btnDelete.type = 'button';
    btnDelete.textContent = '×';

    btnGroup.appendChild(btnUp);
    btnGroup.appendChild(btnDown);
    btnGroup.appendChild(btnDelete);

    headerLeft.appendChild(indexPill);
    headerLeft.appendChild(btnGroup);

    const headerRight = document.createElement('div');
    headerRight.className = 'clip-header-right';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'clip-title-input';
    titleInput.placeholder = 'Clip title';
    const fallbackTitle = clip.type === 'title' ? `Title ${index + 1}` : `Clip ${index + 1}`;
    titleInput.value = clip.title && clip.title.trim() ? clip.title : fallbackTitle;
    titleInput.addEventListener('input', () => {
      const nextTitle = titleInput.value.trim();
      clip.title = nextTitle || fallbackTitle;
    });
    titleInput.addEventListener('blur', () => {
      if (!titleInput.value.trim()) {
        clip.title = fallbackTitle;
        titleInput.value = fallbackTitle;
      }
    });
    headerRight.appendChild(titleInput);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    item.appendChild(header);

    indexPill.addEventListener('dragstart', (e) => {
      dragSourceClipId = clip.id;
      item.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', clip.id);
      }
    });

    indexPill.addEventListener('dragend', () => {
      dragSourceClipId = null;
      item.classList.remove('dragging');
      document.querySelectorAll('.clip-item').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      if (!dragSourceClipId || dragSourceClipId === clip.id) return;
      e.preventDefault();
      item.classList.add('drag-over');
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!dragSourceClipId || dragSourceClipId === clip.id) return;
      const from = clips.findIndex(c => c.id === dragSourceClipId);
      const to = clips.findIndex(c => c.id === clip.id);
      if (from !== -1 && to !== -1 && from !== to) {
        const [moved] = clips.splice(from, 1);
        clips.splice(to, 0, moved);
        renderClipList();
      }
      dragSourceClipId = null;
    });

    const attachCommonControls = () => {
      btnUp.addEventListener('click', () => {
        if (index === 0) return;
        const tmp = clips[index - 1];
        clips[index - 1] = clips[index];
        clips[index] = tmp;
        renderClipList();
      });

      btnDown.addEventListener('click', () => {
        if (index === clips.length - 1) return;
        const tmp = clips[index + 1];
        clips[index + 1] = clips[index];
        clips[index] = tmp;
        renderClipList();
      });

      btnDelete.addEventListener('click', () => {
        const idx = clips.findIndex(c => c.id === clip.id);
        if (idx !== -1) {
          if (clips[idx].url) URL.revokeObjectURL(clips[idx].url);
          clips.splice(idx, 1);
        }
        resetPreviewDimensionsCache();
        clipCountEl.textContent = clips.length.toString();
        btnExport.disabled = clips.length === 0;
        renderClipList();
      });
    };

    if (clip.type === 'title') {
      const preview = document.createElement('div');
      preview.className = 'title-preview';
      preview.style.backgroundImage = 'none';
      preview.style.backgroundColor = 'var(--panel-soft)';
      //preview.style.aspectRatio = '16 / 9';

      const previewImg = document.createElement('img');
      previewImg.className = 'title-preview-img';
      preview.appendChild(previewImg);

      const previewText = document.createElement('div');
      previewText.className = 'title-preview-text';
      previewText.textContent = clip.text || '';
      previewText.style.display = 'none';
      const initialAlign = ['left', 'center', 'right'].includes(clip.textAlign)
        ? clip.textAlign
        : 'center';
      clip.textAlign = initialAlign;
      previewText.style.color = clip.textColor || '#ffffff';
      previewText.style.fontSize = `${Number.isFinite(clip.textSize) ? clip.textSize : 48}px`;
      previewText.style.textAlign = initialAlign;
      previewText.style.fontFamily = clip.fontFamily || 'Inter, system-ui, sans-serif';
      preview.appendChild(previewText);

      const refreshPreview = () => {
        renderTitlePreviewFrame(clip, preview, previewImg);
      };

      const controls = document.createElement('div');
      controls.className = 'title-controls';

      const settingsRow = document.createElement('div');
      settingsRow.className = 'title-text-settings';

      const fontLabel = document.createElement('label');
      fontLabel.textContent = 'Font';
      const fontSelect = document.createElement('select');
      const fontOptions = (() => {
        const opts = dedupeFontOptions([
          ...availableFontOptions,
          ...(clip.fontFamily ? [{ label: clip.fontFamily, value: clip.fontFamily }] : [])
        ]);
        if (!opts.length) return baseFontOptions;
        return opts;
      })();

      fontOptions.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (clip.fontFamily === opt.value) o.selected = true;
        fontSelect.appendChild(o);
      });
      if (clip.fontFamily && !Array.from(fontSelect.options).some(o => o.value === clip.fontFamily)) {
        const custom = document.createElement('option');
        custom.value = clip.fontFamily;
        custom.textContent = clip.fontFamily;
        custom.selected = true;
        fontSelect.appendChild(custom);
      }
      fontSelect.addEventListener('change', () => {
        clip.fontFamily = fontSelect.value;
        previewText.style.fontFamily = clip.fontFamily;
        refreshPreview();
      });
      fontLabel.appendChild(fontSelect);

      const sizeLabel = document.createElement('label');
      sizeLabel.textContent = 'Size (px)';
      const sizeInput = document.createElement('input');
      sizeInput.type = 'number';
      sizeInput.min = '8';
      sizeInput.step = '2';
      sizeInput.value = (Number.isFinite(clip.textSize) ? clip.textSize : 48).toString();
      sizeInput.addEventListener('change', () => {
        const next = Math.max(8, parseInt(sizeInput.value, 10) || 8);
        clip.textSize = next;
        previewText.style.fontSize = `${next}px`;
        sizeInput.value = next.toString();
        refreshPreview();
      });
      sizeLabel.appendChild(sizeInput);

      const colorLabel = document.createElement('label');
      colorLabel.textContent = 'Text color';
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      const safeColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(clip.textColor || '')
        ? clip.textColor
        : '#ffffff';
      colorInput.value = safeColor;
      clip.textColor = safeColor;
      colorInput.addEventListener('input', () => {
        clip.textColor = colorInput.value;
        previewText.style.color = clip.textColor;
        refreshPreview();
      });
      colorLabel.appendChild(colorInput);

      const alignLabel = document.createElement('label');
      alignLabel.textContent = 'Alignment';
      const alignSelect = document.createElement('select');
      ['left', 'center', 'right'].forEach(val => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        if (clip.textAlign === val) o.selected = true;
        alignSelect.appendChild(o);
      });
      const validAligns = ['left', 'center', 'right'];
      if (!validAligns.includes(clip.textAlign)) {
        clip.textAlign = 'center';
      }
      alignSelect.value = clip.textAlign;
      alignSelect.addEventListener('change', () => {
        clip.textAlign = alignSelect.value;
        previewText.style.textAlign = clip.textAlign;
        refreshPreview();
      });
      alignLabel.appendChild(alignSelect);

      settingsRow.appendChild(fontLabel);
      settingsRow.appendChild(sizeLabel);
      settingsRow.appendChild(colorLabel);
      settingsRow.appendChild(alignLabel);

      const textLabel = document.createElement('label');
      textLabel.textContent = 'Text';
      textLabel.className = 'title-textarea-wrap';
      const textArea = document.createElement('textarea');
      textArea.value = clip.text || '';
      textArea.placeholder = 'Title text';
      textArea.rows = 4;
      textArea.addEventListener('input', () => {
        clip.text = textArea.value;
        previewText.textContent = clip.text || '';
        refreshPreview();
      });
      textLabel.appendChild(textArea);

      const durationRow = document.createElement('div');
      durationRow.className = 'title-duration-row';
      const durationLabel = document.createElement('label');
      durationLabel.textContent = 'Duration (s)';
      const durationInput = document.createElement('input');
      durationInput.type = 'number';
      durationInput.min = '0.1';
      durationInput.step = '0.1';
      durationInput.value = (Number.isFinite(clip.duration) ? clip.duration : 3).toFixed(1);
      durationInput.addEventListener('change', () => {
        const next = Math.max(0.1, parseFloat(durationInput.value) || 0);
        clip.duration = next;
        clip.trimEnd = next;
        durationInput.value = next.toFixed(1);
      });
      durationLabel.appendChild(durationInput);
      durationRow.appendChild(durationLabel);

      const bgLabel = document.createElement('label');
      bgLabel.textContent = 'Background image';
      const bgButtons = document.createElement('div');
      bgButtons.className = 'title-bg-actions';
      const setBgBtn = document.createElement('button');
      setBgBtn.type = 'button';
      setBgBtn.className = 'secondary small';
      setBgBtn.textContent = clip.bgDataUrl ? 'Replace background' : 'Set background';
      setBgBtn.addEventListener('click', () => {
        pendingBgTargetId = clip.id;
        titleBgFileInput.value = '';
        titleBgFileInput.click();
      });
      const clearBgBtn = document.createElement('button');
      clearBgBtn.type = 'button';
      clearBgBtn.className = 'secondary small';
      clearBgBtn.textContent = 'Clear';
      clearBgBtn.disabled = !clip.bgDataUrl;
      clearBgBtn.addEventListener('click', () => {
        clip.bgDataUrl = null;
        clip.bgMimeType = null;
        preview.style.backgroundImage = 'none';
        clearBgBtn.disabled = true;
        setBgBtn.textContent = 'Set background';
        refreshPreview();
      });

      const fitSelect = document.createElement('select');
      ['cover', 'contain'].forEach(val => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = val.charAt(0).toUpperCase() + val.slice(1);
        if (clip.backgroundFit === val) o.selected = true;
        fitSelect.appendChild(o);
      });
      fitSelect.addEventListener('change', () => {
        clip.backgroundFit = fitSelect.value;
        refreshPreview();
      });

      bgButtons.appendChild(setBgBtn);
      bgButtons.appendChild(clearBgBtn);
      bgButtons.appendChild(fitSelect);
      bgLabel.appendChild(bgButtons);

      controls.appendChild(settingsRow);
      controls.appendChild(textLabel);
      controls.appendChild(durationRow);
      controls.appendChild(bgLabel);

      item.appendChild(preview);
      item.appendChild(controls);
      attachCommonControls();
      clipListEl.appendChild(item);
      refreshPreview();
      return;
    }

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'clip-thumbnail';
    thumb.style.position = 'relative';
    const vid = document.createElement('video');
    vid.src = clip.url;
    vid.controls = false; // hide native controls; we rely on the custom trim/time bar
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    
    // Add error handling
    vid.onerror = (e) => {
      console.error('Video element error:', {
        clipId: clip.id,
        url: clip.url,
        blobSize: clip.blob?.size,
        blobType: clip.blob?.type,
        error: e,
        videoError: vid.error
      });
    };
    
    vid.onloadedmetadata = () => {
      console.log('Video loaded successfully:', {
        clipId: clip.id,
        duration: vid.duration,
        videoWidth: vid.videoWidth,
        videoHeight: vid.videoHeight
      });
    };

    // Simple play/pause toggle so users can preview without native controls
    vid.addEventListener('click', () => {
      if (vid.paused) {
        vid.play().catch(() => {});
      } else {
        vid.pause();
      }
    });
    
    thumb.appendChild(vid);

    // Trim overlay
    const overlay = document.createElement('div');
    overlay.className = 'trim-overlay';
    const bar = document.createElement('div');
    bar.className = 'trim-bar';
    const fill = document.createElement('div');
    fill.className = 'trim-fill';
    const playhead = document.createElement('div');
    playhead.className = 'trim-playhead';
    const handleStart = document.createElement('div');
    handleStart.className = 'trim-handle trim-handle-start';
    const handleEnd = document.createElement('div');
    handleEnd.className = 'trim-handle trim-handle-end';
    bar.appendChild(fill);
    bar.appendChild(playhead);
    bar.appendChild(handleStart);
    bar.appendChild(handleEnd);
    overlay.appendChild(bar);
    thumb.appendChild(overlay);

    // Meta + controls container below the video
    const infoWrap = document.createElement('div');
    infoWrap.style.display = 'grid';
    infoWrap.style.gridTemplateColumns = '1fr 1fr';
    infoWrap.style.gap = '10px';
    infoWrap.style.alignItems = 'center';

    const meta = document.createElement('div');
    meta.className = 'clip-meta';

    const row1 = document.createElement('div');
    row1.className = 'row';
    const label1 = document.createElement('div');
    label1.className = 'label';
    label1.textContent = 'Length:';
    const value1 = document.createElement('div');
    value1.className = 'value';
    value1.textContent = clip.duration
      ? `${clip.duration.toFixed(2)}s`
      : 'Loading…';
    row1.appendChild(label1);
    row1.appendChild(value1);

    const row2 = document.createElement('div');
    row2.className = 'row';
    const label2 = document.createElement('div');
    label2.className = 'label';
    label2.textContent = 'Trimmed:';
    const value2 = document.createElement('div');
    value2.className = 'value';
    const updateTrimLabel = () => {
      if (Number.isFinite(clip.trimEnd)) {
        value2.textContent = `${clip.trimStart.toFixed(2)}s → ${clip.trimEnd.toFixed(2)}s`;
      } else {
        value2.textContent = '0.00s → ?';
      }
    };
    updateTrimLabel();
    row2.appendChild(label2);
    row2.appendChild(value2);

    meta.appendChild(row1);
    meta.appendChild(row2);

    const controls = document.createElement('div');
    controls.className = 'clip-controls';

    const labelStart = document.createElement('label');
    labelStart.textContent = 'Trim start (s)';
    const inputStart = document.createElement('input');
    inputStart.type = 'number';
    inputStart.min = '0';
    inputStart.step = '0.05';
    const startOffset = Math.max(0, Number.isFinite(clip.trimStart) ? clip.trimStart : 0);
    inputStart.value = startOffset.toFixed(2);
    labelStart.appendChild(inputStart);

    const labelEnd = document.createElement('label');
    labelEnd.textContent = 'Trim end (s)';
    const inputEnd = document.createElement('input');
    inputEnd.type = 'number';
    inputEnd.min = '0';
    inputEnd.step = '0.05';
    const endOffset = (clip.duration != null && Number.isFinite(clip.duration) && clip.trimEnd != null && Number.isFinite(clip.trimEnd))
      ? Math.max(0, clip.duration - clip.trimEnd)
      : 0;
    inputEnd.value = endOffset.toFixed(2);
    labelEnd.appendChild(inputEnd);

    controls.appendChild(labelStart);
    controls.appendChild(labelEnd);

    item.appendChild(thumb);
    infoWrap.appendChild(meta);
    infoWrap.appendChild(controls);
    item.appendChild(infoWrap);

    const refreshClipUI = () => {
      const dur = Number.isFinite(clip.duration) ? clip.duration : null;
      const startVal = Math.max(0, Number.isFinite(clip.trimStart) ? clip.trimStart : 0);
      let endVal = clip.trimEnd;
      if (dur != null && !Number.isFinite(endVal)) endVal = dur;
      inputStart.value = startVal.toFixed(2);
      const endOffsetVal = (dur != null && Number.isFinite(endVal))
        ? Math.max(0, dur - endVal)
        : 0;
      inputEnd.value = endOffsetVal.toFixed(2);
      if (dur != null && Number.isFinite(endVal)) {
        const startPct = Math.max(0, Math.min(1, startVal / dur));
        const endPct = Math.max(0, Math.min(1, endVal / dur));
        overlay.classList.remove('disabled');
        handleStart.style.left = `${startPct * 100}%`;
        handleEnd.style.left = `${endPct * 100}%`;
        const left = Math.min(startPct, endPct) * 100;
        const right = Math.max(startPct, endPct) * 100;
        fill.style.left = `${left}%`;
        fill.style.width = `${Math.max(0, right - left)}%`;
        const playPct = Math.max(0, Math.min(1, vid.currentTime / dur));
        playhead.style.left = `${playPct * 100}%`;
      } else {
        overlay.classList.add('disabled');
        handleStart.style.left = '0%';
        handleEnd.style.left = '100%';
        fill.style.left = '0%';
        fill.style.width = '100%';
        playhead.style.left = '0%';
      }
      value1.textContent = clip.duration
        ? `${clip.duration.toFixed(2)}s`
        : 'Loading…';
      const trimLabel = (Number.isFinite(clip.trimEnd))
        ? `${clip.trimStart.toFixed(2)}s → ${clip.trimEnd.toFixed(2)}s`
        : '0.00s → ?';
      value2.textContent = trimLabel;
    };

    const adjustTrimStart = (val) => {
      let startTrim = val;
      if (Number.isNaN(startTrim) || startTrim < 0) startTrim = 0;
      if (Number.isFinite(clip.duration) && startTrim >= clip.duration) {
        startTrim = Math.max(0, clip.duration - 0.05);
      }
      clip.trimStart = startTrim;
      if (Number.isFinite(clip.duration)) {
        const endOffset = parseFloat(inputEnd.value);
        const endTrim = Number.isFinite(endOffset) ? Math.max(0, endOffset) : 0;
        let newTrimEnd = clip.duration - endTrim;
        if (!Number.isFinite(newTrimEnd) || newTrimEnd <= clip.trimStart) {
          newTrimEnd = Math.min(clip.duration, clip.trimStart + 0.05);
        }
        clip.trimEnd = newTrimEnd;
      }
      refreshClipUI();
    };

    const adjustTrimEnd = (val) => {
      let endTrim = val;
      if (Number.isNaN(endTrim) || endTrim < 0) endTrim = 0;
      if (Number.isFinite(clip.duration)) {
        if (endTrim >= clip.duration) endTrim = Math.max(0, clip.duration - 0.05);
        clip.trimEnd = clip.duration - endTrim;
        if (clip.trimEnd <= clip.trimStart) {
          clip.trimEnd = Math.min(clip.duration, clip.trimStart + 0.05);
          endTrim = Math.max(0, clip.duration - clip.trimEnd);
          inputEnd.value = endTrim.toFixed(2);
        }
      }
      refreshClipUI();
    };

    inputStart.addEventListener('change', () => {
      adjustTrimStart(parseFloat(inputStart.value));
    });

    inputEnd.addEventListener('change', () => {
      adjustTrimEnd(parseFloat(inputEnd.value));
    });

    const overlayDrag = (type, clientX) => {
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      const time = pct * clip.duration;
      if (type === 'start') {
        clip.trimStart = Math.min(time, Number.isFinite(clip.trimEnd) ? clip.trimEnd - 0.05 : time);
        if (!Number.isFinite(clip.trimEnd)) clip.trimEnd = clip.duration;
        if (clip.trimStart < 0) clip.trimStart = 0;
        vid.currentTime = clip.trimStart;
      } else {
        if (!Number.isFinite(clip.trimStart)) clip.trimStart = 0;
        clip.trimEnd = Math.max(time, clip.trimStart + 0.05);
        if (clip.trimEnd > clip.duration) clip.trimEnd = clip.duration;
        vid.currentTime = clip.trimEnd;
      }
      refreshClipUI();
    };

    const startHandleDrag = (type) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev) => overlayDrag(type, ev.clientX);
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      overlayDrag(type, e.clientX);
    };

    handleStart.addEventListener('pointerdown', startHandleDrag('start'));
    handleEnd.addEventListener('pointerdown', startHandleDrag('end'));

    const seekWithinBar = (clientX) => {
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      vid.currentTime = pct * clip.duration;
      refreshClipUI();
    };

    const startPlayheadDrag = (e) => {
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev) => seekWithinBar(ev.clientX);
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      seekWithinBar(e.clientX);
    };

    bar.addEventListener('pointerdown', (e) => {
      if (e.target === handleStart || e.target === handleEnd) return;
      startPlayheadDrag(e);
    });
    playhead.addEventListener('pointerdown', startPlayheadDrag);

    // Update playhead as video plays/seeks
    const updatePlayhead = () => refreshClipUI();
    vid.addEventListener('timeupdate', updatePlayhead);
    vid.addEventListener('seeked', updatePlayhead);

    attachCommonControls();
    clipListEl.appendChild(item);

    // Initial paint for trim overlay
    refreshClipUI();
  });
}

// -----------------------------
// Clip import from local files
// -----------------------------
async function importClipFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  let imported = 0;
  let skipped = 0;

  btnImportClip.disabled = true;
  try {
    statusEl.textContent = files.length === 1
      ? `Importing clip: ${files[0].name}`
      : `Importing ${files.length} clips…`;

    for (const file of files) {
      if (!file || !(file instanceof Blob)) {
        skipped += 1;
        continue;
      }

      if (file.type && !file.type.startsWith('video/')) {
        skipped += 1;
        continue;
      }

      addClip(file, { title: file.name });
      imported += 1;
    }

    if (imported) {
      const suffix = imported === 1 ? 'clip' : 'clips';
      const skippedNote = skipped ? ` (${skipped} skipped)` : '';
      statusEl.textContent = `Imported ${imported} ${suffix}${skippedNote}.`;
    } else {
      statusEl.textContent = 'No video clips were imported.';
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Clip import failed: ' + err.message;
  } finally {
    clipFileInput.value = '';
    btnImportClip.disabled = false;
  }
}

// -----------------------------
// Project save/load
// -----------------------------
function resetDownloadLink() {
  downloadLink.style.display = 'none';
  downloadLink.removeAttribute('href');
  downloadLink.textContent = 'Download final webm';
}

async function exportProject() {
  if (!clips.length) {
    statusEl.textContent = 'No clips to export as a project.';
    return;
  }

  try {
    statusEl.textContent = 'Preparing project export…';

    const serializedClips = [];
    for (let i = 0; i < clips.length; i++) {
      statusEl.textContent = `Encoding clip ${i + 1}/${clips.length}…`;
      const clip = clips[i];

      if (clip.type === 'title') {
        serializedClips.push({
          type: 'title',
          id: clip.id,
          title: clip.title,
          duration: clip.duration,
          trimStart: clip.trimStart || 0,
          trimEnd: clip.trimEnd,
          text: clip.text,
          textColor: clip.textColor,
          textSize: clip.textSize,
          textAlign: clip.textAlign,
          fontFamily: clip.fontFamily,
          bgDataUrl: clip.bgDataUrl,
          bgMimeType: clip.bgMimeType,
          backgroundFit: clip.backgroundFit
        });
        continue;
      }
      
      // Log original blob info
      const testBytes = new Uint8Array(await clip.blob.slice(0, 4).arrayBuffer());
      console.log('Exporting clip - first 4 bytes:', {
        index: i,
        id: clip.id,
        bytes: Array.from(testBytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
        size: clip.blob.size,
        type: clip.blob.type
      });
      
      const dataUrl = await blobToDataUrl(clip.blob);
      
      console.log('Data URL being saved:', {
        index: i,
        id: clip.id,
        urlPrefix: dataUrl.substring(0, 60),
        hasBase64: dataUrl.includes(';base64'),
        endsWithBase64: dataUrl.substring(0, 100).includes(';base64')
      });

      serializedClips.push({
        type: clip.type || 'video',
        id: clip.id,
        title: clip.title,
        mimeType: clip.blob.type || 'video/webm',
        duration: clip.duration,
        trimStart: Number.isFinite(clip.trimStart) ? clip.trimStart : 0,
        trimEnd: Number.isFinite(clip.trimEnd) ? clip.trimEnd : null,
        dataUrl
      });
    }

    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      clipCount: serializedClips.length,
      clips: serializedClips
    };

    const jsonString = JSON.stringify(payload);
    console.log('JSON export check:', {
      jsonLength: jsonString.length,
      firstClipDataUrlStart: jsonString.indexOf('"dataUrl":"') > -1 
        ? jsonString.substring(jsonString.indexOf('"dataUrl":"'), jsonString.indexOf('"dataUrl":"') + 100)
        : 'not found'
    });

    const fileBlob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(fileBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'screen-recorder-project.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    statusEl.textContent = 'Project exported.';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Project export failed: ' + err.message;
  }
}

async function importProjectFile(file) {
  if (!file) return;
  try {
    statusEl.textContent = 'Loading project…';
    const text = await file.text();
    console.log('File text length:', text.length);
    console.log('First 200 chars:', text.substring(0, 200));
    
    const data = JSON.parse(text);

    if (!data || !Array.isArray(data.clips)) {
      throw new Error('Invalid project file');
    }
    
    console.log('Parsed clips:', {
      count: data.clips.length,
      firstClipDataUrlLength: data.clips[0]?.dataUrl?.length,
      firstClipDataUrlStart: data.clips[0]?.dataUrl?.substring(0, 100)
    });

    revokeClipUrls();
    clips.length = 0;
    clipCountEl.textContent = '0';
    btnExport.disabled = true;
    resetDownloadLink();
    renderClipList();
    resetPreviewDimensionsCache();

    for (let i = 0; i < data.clips.length; i++) {
      const entry = data.clips[i];
      if (!entry) continue;

      if (entry.type === 'title') {
        statusEl.textContent = `Restoring title ${i + 1}/${data.clips.length}…`;
        addTitleClip({
          id: entry.id,
          title: typeof entry.title === 'string' ? entry.title : undefined,
          duration: Number.isFinite(entry.duration) ? entry.duration : 3,
          trimStart: Number.isFinite(entry.trimStart) ? entry.trimStart : 0,
          trimEnd: Number.isFinite(entry.trimEnd) ? entry.trimEnd : undefined,
          text: typeof entry.text === 'string' ? entry.text : '',
          textColor: typeof entry.textColor === 'string' ? entry.textColor : '#ffffff',
          textSize: Number.isFinite(entry.textSize) ? entry.textSize : 48,
          textAlign: typeof entry.textAlign === 'string' ? entry.textAlign : 'center',
          fontFamily: typeof entry.fontFamily === 'string' ? entry.fontFamily : 'Inter, system-ui, sans-serif',
          bgDataUrl: typeof entry.bgDataUrl === 'string' ? entry.bgDataUrl : null,
          bgMimeType: typeof entry.bgMimeType === 'string' ? entry.bgMimeType : null,
          backgroundFit: typeof entry.backgroundFit === 'string' ? entry.backgroundFit : 'cover'
        });
        continue;
      }

      if (!entry.dataUrl) continue;
      
      statusEl.textContent = `Restoring clip ${i + 1}/${data.clips.length}…`;
      let blob = await dataUrlToBlob(entry.dataUrl);
      
      // Use the stored MIME type if available (preserves codec info)
      if (entry.mimeType && entry.mimeType !== blob.type) {
        blob = new Blob([blob], { type: entry.mimeType });
      }
      
      console.log('Imported clip blob:', {
        index: i,
        id: entry.id,
        size: blob.size,
        type: blob.type,
        storedType: entry.mimeType
      });
      
      // Test if blob is valid by checking first bytes
      const testBytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      console.log('First 4 bytes of imported blob:', Array.from(testBytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
      
      addClip(blob, {
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : undefined,
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
        trimStart: Number.isFinite(entry.trimStart) ? entry.trimStart : 0,
        trimEnd: Number.isFinite(entry.trimEnd) ? entry.trimEnd : null
      });
    }

    statusEl.textContent = `Project imported with ${clips.length} clip${clips.length === 1 ? '' : 's'}.`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Project import failed: ' + err.message;
  } finally {
    projectFileInput.value = '';
  }
}

// -----------------------------
// Export without ffmpeg (canvas + MediaRecorder)
// -----------------------------
async function loadVideoMetadata(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      v.onloadedmetadata = null;
      v.ondurationchange = null;
      v.ontimeupdate = null;
      v.onerror = null;
      v.src = '';
      try { v.removeAttribute('src'); v.load(); } catch (_) {}
    };

    const finish = (meta) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(meta);
    };

    const reportIfReady = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        finish({
          duration: v.duration,
          width: v.videoWidth || 1280,
          height: v.videoHeight || 720
        });
        return true;
      }
      return false;
    };

    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.src = url;

    v.onloadedmetadata = () => {
      if (reportIfReady()) return;
      try {
        v.currentTime = 1e9; // force seek to end to reveal duration
      } catch (_) {
        // fall back to durationchange
      }
    };

    v.ondurationchange = () => {
      reportIfReady();
    };

    v.ontimeupdate = () => {
      reportIfReady();
    };

    v.onerror = () => {
      cleanup();
      reject(new Error('Failed to load clip metadata'));
    };

    setTimeout(() => {
      if (!settled) {
        finish({
          duration: Number.isFinite(v.duration) ? v.duration : NaN,
          width: v.videoWidth || 1280,
          height: v.videoHeight || 720
        });
      }
    }, 8000);
  });
}

function loadImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width || 1280,
        height: img.naturalHeight || img.height || 720
      });
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

function getClipEffectiveDurationSeconds(clip) {
  if (!clip) return 0;
  const start = Math.max(0, Number.isFinite(clip.trimStart) ? clip.trimStart : 0);
  let end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : null;
  if ((end == null || !Number.isFinite(end)) && Number.isFinite(clip.duration)) {
    end = clip.duration;
  }
  if (!Number.isFinite(end)) return 0;
  const span = Math.max(0, end - start);
  return Number.isFinite(span) ? span : 0;
}

function getTotalRenderSeconds(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  return list.reduce((sum, clip) => sum + getClipEffectiveDurationSeconds(clip), 0);
}

async function renderTitlePreviewFrame(clip, previewEl, imgEl) {
  if (!previewEl || !imgEl) return;
  try {
    const dims = await getPreviewDimensions();
    const { width, height } = dims;
    // if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    //   previewEl.style.aspectRatio = `${width}/${height}`;
    // }

    const canvas = document.createElement('canvas');
    canvas.width = Number.isFinite(width) && width > 0 ? width : 1280;
    canvas.height = Number.isFinite(height) && height > 0 ? height : 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (clip.bgDataUrl) {
      try {
        const img = await loadImageElement(clip.bgDataUrl);
        drawImageWithFit(ctx, canvas.width, canvas.height, img, clip.backgroundFit === 'contain' ? 'contain' : 'cover');
      } catch (_) {
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const lines = (clip.text || '').split('\n');
    const fontSize = Number.isFinite(clip.textSize) ? clip.textSize : 48;
    const fontFamily = clip.fontFamily || 'Inter, system-ui, sans-serif';
    const align = ['left', 'center', 'right'].includes(clip.textAlign) ? clip.textAlign : 'center';
    const color = clip.textColor || '#ffffff';
    const lineHeight = fontSize * 1.2;

    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px ${fontFamily}`;

    const totalHeight = lines.length * lineHeight;
    const baseY = (canvas.height - totalHeight) / 2 + lineHeight / 2;
    let x = canvas.width / 2;
    if (align === 'left') x = 40;
    if (align === 'right') x = canvas.width - 40;

    lines.forEach((line, idx) => {
      ctx.fillText(line, x, baseY + idx * lineHeight);
    });

    imgEl.src = canvas.toDataURL('image/png');
  } catch (err) {
    console.error('Failed to render title preview', err);
  }
}

async function exportFinalVideo() {
  if (!clips.length) return;
  if (exportRecording) return;

  // Make sure durations + trimEnd are set
  for (const clip of clips) {
    if (clip.type === 'title') {
      if (!Number.isFinite(clip.duration)) {
        clip.duration = Number.isFinite(clip.trimEnd) ? clip.trimEnd : 3;
      }
      if (!Number.isFinite(clip.trimStart)) clip.trimStart = 0;
      if (!Number.isFinite(clip.trimEnd) || clip.trimEnd == null) {
        clip.trimEnd = clip.duration;
      }
      if (clip.trimEnd <= clip.trimStart) {
        clip.trimEnd = clip.trimStart + 0.05;
      }
      continue;
    }

    if (!Number.isFinite(clip.duration)) {
      try {
        const meta = await loadVideoMetadata(clip.url);
        if (Number.isFinite(meta.duration)) {
          clip.duration = meta.duration;
        }
      } catch (_) {
        // keep old duration
      }
    }
    if (!Number.isFinite(clip.trimEnd) || clip.trimEnd == null) {
      clip.trimEnd = Number.isFinite(clip.duration)
        ? clip.duration
        : (clip.trimStart || 0) + 0.1;
    }
    if (Number.isFinite(clip.duration) && clip.trimEnd > clip.duration) {
      clip.trimEnd = clip.duration;
    }
    if (clip.trimEnd <= clip.trimStart) {
      clip.trimEnd = clip.trimStart + 0.05;
    }
  }

  exportRecording = true;
  btnExport.disabled = true;
  statusEl.textContent = 'Exporting: preparing renderer…';
  resetDownloadLink();

  const totalRenderSeconds = Math.max(0.1, getTotalRenderSeconds(clips));
  resetRenderPreviewContainer();
  showRenderOverlay(totalRenderSeconds);
  updateRenderProgressUI(0, 'Preparing renderer…');

  const progressState = {
    totalSeconds: totalRenderSeconds,
    completedSeconds: 0,
    label: 'Preparing renderer…'
  };

  const updateProgress = (clipElapsed = 0, label) => {
    if (typeof label === 'string') {
      progressState.label = label;
    }
    const absolute = Math.min(progressState.totalSeconds, progressState.completedSeconds + Math.max(0, clipElapsed));
    updateRenderProgressUI(absolute, progressState.label);
  };

  let cancelRequested = false;
  const cancelError = new Error('Render canceled');
  cancelError.name = 'RenderCanceled';

  if (btnCancelRender) {
    btnCancelRender.disabled = false;
    btnCancelRender.textContent = 'Cancel';
  }

  activeRenderCancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    if (btnCancelRender) {
      btnCancelRender.disabled = true;
      btnCancelRender.textContent = 'Canceling…';
    }
    updateRenderProgressUI(progressState.completedSeconds, 'Canceling render…');
    statusEl.textContent = 'Canceling render…';
  };

  const checkCancel = () => cancelRequested;

  updateProgress(0, 'Sizing output canvas…');

  // Determine output dimensions from first clip
  let baseWidth = 1280;
  let baseHeight = 720;
  try {
    const firstVideo = clips.find(c => c.type !== 'title');
    if (firstVideo) {
      const meta = await loadVideoMetadata(firstVideo.url);
      baseWidth = meta.width || baseWidth;
      baseHeight = meta.height || baseHeight;
    } else {
      const firstTitleWithBg = clips.find(c => c.type === 'title' && c.bgDataUrl);
      if (firstTitleWithBg) {
        const imgMeta = await loadImageDimensions(firstTitleWithBg.bgDataUrl);
        baseWidth = imgMeta.width || baseWidth;
        baseHeight = imgMeta.height || baseHeight;
      }
    }
  } catch (_) {
    // keep defaults
  }

  // Canvas + audio graph
  const canvas = document.createElement('canvas');
  canvas.width = baseWidth;
  canvas.height = baseHeight;
  const ctx = canvas.getContext('2d');

  renderPreviewCanvas = canvas;
  mountRenderPreviewCanvas(canvas);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioDest = audioCtx.createMediaStreamDestination();

  const canvasStream = canvas.captureStream(30);
  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioDest.stream.getAudioTracks()
  ]);

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';
  const recorder = new MediaRecorder(mixedStream, { mimeType });
  const recordedChunks = [];

  recorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  const stopRecorder = () => new Promise(resolve => {
    if (!recorder || recorder.state === 'inactive') {
      resolve();
      return;
    }
    recorder.onstop = () => resolve();
    try {
      recorder.stop();
    } catch (_) {
      resolve();
    }
  });

  const renderVideoClip = (clip, { expectedDuration, onProgress } = {}) => new Promise(async (resolve, reject) => {
    const video = document.createElement('video');
    video.src = clip.url;
    video.muted = false;
    video.playsInline = true;
    video.preload = 'auto';

    const source = audioCtx.createMediaElementSource(video);
    source.connect(audioDest);

    let intervalId = null;
    let finished = false;
    let watchdog = null;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (intervalId) clearInterval(intervalId);
      if (watchdog) clearTimeout(watchdog);
      video.pause();
      video.onended = null;
      video.ontimeupdate = null;
      video.src = '';
      try { source.disconnect(); } catch (_) {}
      if (!err && typeof onProgress === 'function' && Number.isFinite(expectedDuration)) {
        onProgress(expectedDuration);
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    video.onloadedmetadata = async () => {
      const mediaDuration = Number.isFinite(video.duration)
        ? video.duration
        : (Number.isFinite(clip.duration) ? clip.duration : NaN);

      let start = Number.isFinite(clip.trimStart) ? clip.trimStart : 0;
      start = Math.max(0, start);

      let end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : null;
      if (end != null && Number.isFinite(mediaDuration)) {
        end = Math.min(end, mediaDuration);
      }

      const hasEndGuard = Number.isFinite(end);
      const effectiveEnd = hasEndGuard ? Math.max(start + 0.01, end) : Infinity;
      const clipDuration = Number.isFinite(expectedDuration)
        ? expectedDuration
        : (hasEndGuard ? Math.max(0, effectiveEnd - start) : 0);

      if (hasEndGuard && start >= effectiveEnd) {
        source.disconnect();
        resolve();
        return;
      }

      const useRVFC = typeof video.requestVideoFrameCallback === 'function';

      const watchdogMs = hasEndGuard
        ? Math.max(3000, (effectiveEnd - start + 2) * 1000)
        : 60000; // cap unknown durations to 60s safety timeout
      watchdog = setTimeout(() => finish(new Error('Clip render timed out')), watchdogMs);

      const draw = () => {
        if (finished) return;
        if (checkCancel()) {
          finish(cancelError);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (typeof onProgress === 'function') {
          const elapsed = Math.max(0, Math.min(video.currentTime, effectiveEnd) - start);
          const safeElapsed = Number.isFinite(clipDuration) && clipDuration > 0
            ? Math.min(clipDuration, elapsed)
            : elapsed;
          onProgress(safeElapsed);
        }
        if (hasEndGuard && video.currentTime >= effectiveEnd) {
          clearTimeout(watchdog);
          finish();
          return;
        }
        if (useRVFC) {
          video.requestVideoFrameCallback(draw);
        }
      };

      video.onended = () => {
        clearTimeout(watchdog);
        finish();
      };

      video.currentTime = start;
      try {
        await new Promise(res => {
          if (video.readyState >= 1 && Math.abs(video.currentTime - start) < 0.01) {
            res();
          } else {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              res();
            };
            video.addEventListener('seeked', onSeeked);
          }
        });
        await video.play();
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        if (useRVFC) {
          video.requestVideoFrameCallback(draw);
        } else {
          draw(); // kick off first paint for setInterval path
          intervalId = setInterval(draw, 33);
          video.ontimeupdate = draw;
        }
      } catch (err) {
        clearTimeout(watchdog);
        finish(err);
      }
    };

    video.onerror = () => {
      finish(new Error('Failed to play clip'));
    };
  });

  const renderTitleClip = (clip, { expectedDuration, onProgress } = {}) => new Promise(async (resolve, reject) => {
    const duration = Number.isFinite(expectedDuration)
      ? expectedDuration
      : (Number.isFinite(clip.duration)
        ? clip.duration
        : (Number.isFinite(clip.trimEnd) ? clip.trimEnd : 3));
    const effectiveDuration = Math.max(0.1, duration);

    let img = null;
    if (clip.bgDataUrl) {
      try {
        img = await loadImageElement(clip.bgDataUrl);
      } catch (_) {
        img = null;
      }
    }

    const lines = (clip.text || '').split('\n');
    const fontSize = Number.isFinite(clip.textSize) ? clip.textSize : 48;
    const fontFamily = clip.fontFamily || 'Inter, system-ui, sans-serif';
    const align = ['left', 'center', 'right'].includes(clip.textAlign) ? clip.textAlign : 'center';
    const color = clip.textColor || '#ffffff';
    const lineHeight = fontSize * 1.2;
    const startTime = performance.now();
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      if (!err && typeof onProgress === 'function') {
        onProgress(effectiveDuration);
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const drawFrame = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (img && img.complete && img.naturalWidth) {
        drawImageWithFit(ctx, canvas.width, canvas.height, img, clip.backgroundFit === 'contain' ? 'contain' : 'cover');
      } else {
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.font = `${fontSize}px ${fontFamily}`;

      const totalHeight = lines.length * lineHeight;
      const baseY = (canvas.height - totalHeight) / 2 + lineHeight / 2;
      let x = canvas.width / 2;
      if (align === 'left') x = 40;
      if (align === 'right') x = canvas.width - 40;

      lines.forEach((line, idx) => {
        ctx.fillText(line, x, baseY + idx * lineHeight);
      });
    };

    const tick = () => {
      if (done) return;
      if (checkCancel()) {
        finish(cancelError);
        return;
      }
      const elapsed = (performance.now() - startTime) / 1000;
      drawFrame();
      if (typeof onProgress === 'function') {
        onProgress(Math.min(effectiveDuration, elapsed));
      }
      if (elapsed >= effectiveDuration) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    };

    drawFrame();
    requestAnimationFrame(tick);
  });

  try {
    // Diagnostics to understand clip inputs before rendering
    const diagnostics = [];
    updateRenderProgressUI(progressState.completedSeconds, 'Analyzing clips…');
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      let meta = { duration: clip.duration, width: null, height: null };
      if (clip.type !== 'title') {
        try {
          const m = await loadVideoMetadata(clip.url);
          meta = m;
          clip.duration = Number.isFinite(m.duration) ? m.duration : clip.duration;
          if (clip.trimEnd == null || !Number.isFinite(clip.trimEnd)) {
            clip.trimEnd = clip.duration;
          }
        } catch (_) {
          // ignore metadata fetch errors; keep whatever we have
        }
      } else if (clip.trimEnd == null || !Number.isFinite(clip.trimEnd)) {
        clip.trimEnd = clip.duration;
      }

      const start = Math.max(0, Number.isFinite(clip.trimStart) ? clip.trimStart : 0);
      const endRaw = Number.isFinite(clip.trimEnd)
        ? clip.trimEnd
        : (Number.isFinite(meta.duration) ? meta.duration : null);
      const hasEndGuard = Number.isFinite(endRaw);
      const effectiveEnd = hasEndGuard
        ? Math.max(start + 0.01, Number.isFinite(meta.duration) ? Math.min(endRaw, meta.duration) : endRaw)
        : null;

      diagnostics.push({
        index: i + 1,
        type: clip.type || 'video',
        id: clip.id,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        storedDuration: clip.duration,
        metaDuration: meta.duration,
        width: meta.width,
        height: meta.height,
        start,
        endRaw,
        effectiveEnd,
        hasEndGuard,
        url: clip.url,
        hasBg: clip.bgDataUrl
      });
    }

    progressState.totalSeconds = Math.max(0.1, getTotalRenderSeconds(clips));
    renderTotalSeconds = progressState.totalSeconds;
    updateRenderProgressUI(progressState.completedSeconds, progressState.label);

    console.log('Export diagnostics', {
      clipCount: clips.length,
      mimeType,
      baseWidth,
      baseHeight,
      diagnostics
    });

    statusEl.textContent = 'Exporting: rendering clips in-browser…';
    updateRenderProgressUI(progressState.completedSeconds, 'Rendering clips…');
    recorder.start();

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipDuration = Math.max(0.01, getClipEffectiveDurationSeconds(clip));
      const label = clip.type === 'title' ? 'title block' : 'clip';
      const clipLabel = `Rendering ${label} ${i + 1}/${clips.length}…`;
      progressState.label = clipLabel;
      statusEl.textContent = clipLabel;
      updateRenderProgressUI(progressState.completedSeconds, progressState.label);

      if (checkCancel()) {
        throw cancelError;
      }

      const onProgress = (elapsedSeconds) => {
        const clampedElapsed = Math.min(clipDuration, Math.max(0, elapsedSeconds || 0));
        const absolute = Math.min(progressState.totalSeconds, progressState.completedSeconds + clampedElapsed);
        updateRenderProgressUI(absolute, progressState.label);
      };

      if (clip.type === 'title') {
        await renderTitleClip(clip, { expectedDuration: clipDuration, onProgress });
      } else {
        await renderVideoClip(clip, { expectedDuration: clipDuration, onProgress });
      }

      progressState.completedSeconds = Math.min(progressState.totalSeconds, progressState.completedSeconds + clipDuration);
      updateRenderProgressUI(progressState.completedSeconds, progressState.label);
    }

    progressState.label = 'Finalizing recording…';
    updateRenderProgressUI(progressState.totalSeconds, progressState.label);
    statusEl.textContent = 'Finalizing recording…';
    await stopRecorder();

    if (cancelRequested) {
      statusEl.textContent = 'Export canceled.';
      return;
    }

    const outputBlob = new Blob(recordedChunks, { type: recorder.mimeType });
    const url = URL.createObjectURL(outputBlob);

    downloadLink.href = url;
    downloadLink.style.display = 'inline-flex';
    downloadLink.textContent = 'Download started automatically (click to download again)';
    downloadLink.click();

    statusEl.textContent = 'Done. Final video is downloading.';
  } catch (err) {
    await stopRecorder().catch(() => {});
    if (err && err.name === 'RenderCanceled') {
      statusEl.textContent = 'Export canceled.';
    } else {
      console.error(err);
      statusEl.textContent = 'Export failed: ' + err.message;
    }
  } finally {
    exportRecording = false;
    btnExport.disabled = false;
    hideRenderOverlay();
    canvasStream.getTracks().forEach(t => t.stop());
    mixedStream.getTracks().forEach(t => t.stop());
    try { audioCtx.close(); } catch (_) {}
  }
}

// -----------------------------
// Events
// -----------------------------
if (btnCancelRender) {
  btnCancelRender.addEventListener('click', () => {
    if (activeRenderCancel) {
      activeRenderCancel();
    }
  });
}
btnStartCapture.addEventListener('click', startCapture);
btnStartRecording.addEventListener('click', startRecording);
btnExport.addEventListener('click', exportFinalVideo);
btnExportProject.addEventListener('click', exportProject);
btnImportClip.addEventListener('click', () => {
  clipFileInput.value = '';
  clipFileInput.click();
});
clipFileInput.addEventListener('change', () => {
  if (clipFileInput.files) {
    importClipFiles(clipFileInput.files);
  }
});
btnAddTitleClip.addEventListener('click', () => {
  addTitleClip();
});
titleBgFileInput.addEventListener('change', async () => {
  const targetId = pendingBgTargetId;
  pendingBgTargetId = null;
  const file = titleBgFileInput.files && titleBgFileInput.files[0];
  titleBgFileInput.value = '';
  if (!targetId || !file) return;
  const clip = clips.find(c => c.id === targetId);
  if (!clip || clip.type !== 'title') return;
  try {
    const dataUrl = await blobToDataUrl(file);
    clip.bgDataUrl = dataUrl;
    clip.bgMimeType = file.type || 'image/*';
    renderClipList();
    statusEl.textContent = 'Background image set for title block.';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Failed to load background image: ' + err.message;
  }
});
btnImportProject.addEventListener('click', () => {
  projectFileInput.value = '';
  projectFileInput.click();
});
projectFileInput.addEventListener('change', () => {
  const file = projectFileInput.files && projectFileInput.files[0];
  if (file) {
    importProjectFile(file);
  }
});
btnWebcamPiP.addEventListener('click', toggleWebcamPiP);
btnApplyAudioOffset.addEventListener('click', applyAudioOffsetFromInput);
audioOffsetInput.addEventListener('change', applyAudioOffsetFromInput);
audioOffsetInput.addEventListener('blur', () => {
  audioOffsetInput.value = clampAudioOffset(parseFloat(audioOffsetInput.value)).toString();
});
webcamPiPVideo.addEventListener('leavepictureinpicture', () => {
  cleanupWebcamStream();
  setWebcamPiPButtonState(false);
  statusEl.textContent = 'Webcam PiP closed.';
  rebuildCombinedStreamIfIdle();
});

window.addEventListener('beforeunload', () => {
  revokeClipUrls();
  stopCapture();
  stopWebcamPiP();
});

// Initial UI
renderClipList();
setCaptureStatus('idle');
updateRecordingIndicator();
setWebcamPiPButtonState(false);
updateAudioOffsetUI();

detectAvailableFonts(fontDetectionCandidates).then(found => {
  if (Array.isArray(found) && found.length) {
    availableFontOptions = dedupeFontOptions([...baseFontOptions, ...found]);
    // Refresh UI to show detected fonts
    if (clips.length) {
      renderClipList();
    }
  }
}).catch(() => {
  availableFontOptions = [...baseFontOptions];
});
