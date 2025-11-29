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

let displayStream = null;
let micStream = null;
let combinedStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentMimeType = '';
let isRecording = false;
let stopOverlay = null;

const clips = []; // { id, blob, url, duration, trimStart, trimEnd }

// Export pipeline (canvas + MediaRecorder)
let exportRecording = false;

// -----------------------------
// Helpers
// -----------------------------
const sleep = ms => new Promise(res => setTimeout(res, ms));

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
    combinedStream = newStream;

    previewVideo.srcObject = combinedStream;

    btnStartCapture.disabled = true;
    btnStartRecording.disabled = false;

    setCaptureStatus('live');
    statusEl.textContent = 'Capture ready. Hit “Start Clip” to record.';
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
function addClip(blob) {
  const url = URL.createObjectURL(blob);
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const clip = {
    id,
    blob,
    url,
    duration: null,
    trimStart: 0,
    trimEnd: null
  };

  clips.push(clip);
  clipCountEl.textContent = clips.length.toString();
  renderClipList();
  btnExport.disabled = clips.length === 0;

  // Load metadata to determine duration (robustly)
  loadVideoMetadata(url).then(meta => {
    if (Number.isFinite(meta.duration) && meta.duration > 0) {
      clip.duration = meta.duration;
      if (clip.trimEnd === null || !Number.isFinite(clip.trimEnd)) {
        clip.trimEnd = meta.duration;
      } else {
        clip.trimEnd = Math.min(clip.trimEnd, meta.duration);
      }
      renderClipList(); // update UI with duration
    }
  }).catch(() => {
    // ignore metadata failures
  });
}

function renderClipList() {
  clipListEl.innerHTML = '';

  if (!clips.length) {
    const empty = document.createElement('div');
    empty.style.fontSize = '11px';
    empty.style.color = 'var(--muted)';
    empty.textContent = 'No clips yet. Record at least one clip to edit.';
    clipListEl.appendChild(empty);
    return;
  }

  clips.forEach((clip, index) => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.dataset.id = clip.id;

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'clip-thumbnail';
    thumb.style.position = 'relative';
    const vid = document.createElement('video');
    vid.src = clip.url;
    vid.controls = true;
    vid.muted = true;
    vid.playsInline = true;
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
    handleStart.className = 'trim-handle';
    const handleEnd = document.createElement('div');
    handleEnd.className = 'trim-handle';
    bar.appendChild(fill);
    bar.appendChild(playhead);
    bar.appendChild(handleStart);
    bar.appendChild(handleEnd);
    overlay.appendChild(bar);
    thumb.appendChild(overlay);

    // Meta + controls container below the video
    const infoWrap = document.createElement('div');
    infoWrap.style.display = 'grid';
    infoWrap.style.gridTemplateColumns = '1fr 1fr 1fr';
    infoWrap.style.gap = '10px';
    infoWrap.style.alignItems = 'center';

    const meta = document.createElement('div');
    meta.className = 'clip-meta';

    const row1 = document.createElement('div');
    row1.className = 'row';
    const label1 = document.createElement('div');
    label1.className = 'label';
    label1.textContent = `Clip ${index + 1}`;
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

    // Actions section moved to bottom
    const actions = document.createElement('div');
    actions.className = 'clip-actions';

    const indexPill = document.createElement('div');
    indexPill.className = 'index-pill';
    indexPill.textContent = `#${index + 1}`;
    actions.appendChild(indexPill);

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
    actions.appendChild(btnGroup);

    item.appendChild(thumb);
    infoWrap.appendChild(meta);
    infoWrap.appendChild(controls);
    item.appendChild(infoWrap);
    item.appendChild(actions);

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

    // Update playhead as video plays/seeks
    const updatePlayhead = () => refreshClipUI();
    vid.addEventListener('timeupdate', updatePlayhead);
    vid.addEventListener('seeked', updatePlayhead);

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
        URL.revokeObjectURL(clips[idx].url);
        clips.splice(idx, 1);
      }
      clipCountEl.textContent = clips.length.toString();
      btnExport.disabled = clips.length === 0;
      renderClipList();
    });

    clipListEl.appendChild(item);

    // Initial paint for trim overlay
    refreshClipUI();
  });
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

async function exportFinalVideo() {
  if (!clips.length) return;
  if (exportRecording) return;

  // Make sure durations + trimEnd are set
  for (const clip of clips) {
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

  // Determine output dimensions from first clip
  let baseWidth = 1280;
  let baseHeight = 720;
  try {
    const meta = await loadVideoMetadata(clips[0].url);
    baseWidth = meta.width || baseWidth;
    baseHeight = meta.height || baseHeight;
  } catch (_) {
    // keep defaults
  }

  // Canvas + audio graph
  const canvas = document.createElement('canvas');
  canvas.width = baseWidth;
  canvas.height = baseHeight;
  const ctx = canvas.getContext('2d');

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

  const renderClip = clip => new Promise(async (resolve, reject) => {
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
    const cleanup = (err) => {
      if (finished) return;
      finished = true;
      if (intervalId) clearInterval(intervalId);
      if (watchdog) clearTimeout(watchdog);
      video.pause();
      video.onended = null;
      video.ontimeupdate = null;
      video.src = '';
      try { source.disconnect(); } catch (_) {}
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
      if (hasEndGuard && start >= effectiveEnd) {
        source.disconnect();
        resolve();
        return;
      }

      const useRVFC = typeof video.requestVideoFrameCallback === 'function';

      const watchdogMs = hasEndGuard
        ? Math.max(3000, (effectiveEnd - start + 2) * 1000)
        : 60000; // cap unknown durations to 60s safety timeout
      watchdog = setTimeout(() => cleanup(new Error('Clip render timed out')), watchdogMs);

      const draw = () => {
        if (finished) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (hasEndGuard && video.currentTime >= effectiveEnd) {
          clearTimeout(watchdog);
          cleanup();
          return;
        }
        if (useRVFC) {
          video.requestVideoFrameCallback(draw);
        }
      };

      video.onended = () => {
        clearTimeout(watchdog);
        cleanup();
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
        cleanup(err);
      }
    };

    video.onerror = () => {
      cleanup(new Error('Failed to play clip'));
    };
  });

  try {
    // Diagnostics to understand clip inputs before rendering
    const diagnostics = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      let meta = { duration: clip.duration, width: null, height: null };
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
        url: clip.url
      });
    }

    console.log('Export diagnostics', {
      clipCount: clips.length,
      mimeType,
      baseWidth,
      baseHeight,
      diagnostics
    });

    statusEl.textContent = 'Exporting: rendering clips in-browser…';
    recorder.start();

    for (let i = 0; i < clips.length; i++) {
      statusEl.textContent = `Rendering clip ${i + 1}/${clips.length}…`;
      await renderClip(clips[i]);
    }

    statusEl.textContent = 'Finalizing recording…';
    await new Promise(resolve => {
      recorder.onstop = resolve;
      recorder.stop();
    });

    const outputBlob = new Blob(recordedChunks, { type: recorder.mimeType });
    const url = URL.createObjectURL(outputBlob);

    downloadLink.href = url;
    downloadLink.style.display = 'inline-flex';
    downloadLink.textContent = 'Download final webm';

    statusEl.textContent = 'Done. Download your final video.';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Export failed: ' + err.message;
  } finally {
    exportRecording = false;
    btnExport.disabled = false;
    canvasStream.getTracks().forEach(t => t.stop());
    mixedStream.getTracks().forEach(t => t.stop());
    try { audioCtx.close(); } catch (_) {}
  }
}

// -----------------------------
// Events
// -----------------------------
btnStartCapture.addEventListener('click', startCapture);
btnStartRecording.addEventListener('click', startRecording);
btnExport.addEventListener('click', exportFinalVideo);

window.addEventListener('beforeunload', () => {
  revokeClipUrls();
  stopCapture();
});

// Initial UI
renderClipList();
setCaptureStatus('idle');
updateRecordingIndicator();
