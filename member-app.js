// ---- Shared backend used by this dashboard. ----
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

// SHA-256 hash of the single shared Team password (Tanmay@2026).
// Anyone with this password gets equal access - permissions are set
// per-employee from the settings each employee shows here.
const PASSWORD_HASH = 'f85c65161bd472e5f2decbc110209f2e98448f8a17bbadeda59c17ab8450370d';

const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

let socket = null;
let myClientTag = null;
const peers = new Map();
const streams = new Map();
const cameraPeers = new Map();
const cameraStreams = new Map();
let deviceMeta = new Map();
let currentDeviceIds = [];
let liveGroup = 'granted';
let historyGroup = 'granted';

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getOrCreateClientTag() {
  let tag = localStorage.getItem('memberClientTag');
  if (!tag) {
    tag = Math.random().toString(36).slice(2, 8);
    localStorage.setItem('memberClientTag', tag);
  }
  return tag;
}

async function tryUnlock() {
  const password = document.getElementById('password-input').value;
  const hash = await sha256Hex(password);

  if (hash === PASSWORD_HASH) {
    myClientTag = getOrCreateClientTag();
    sessionStorage.setItem('memberUnlocked', 'true');
    document.getElementById('password-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    startApp();
  } else {
    document.getElementById('password-error').style.display = 'block';
  }
}

document.getElementById('password-submit').onclick = tryUnlock;
document.getElementById('password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryUnlock();
});

if (sessionStorage.getItem('memberUnlocked') === 'true') {
  myClientTag = getOrCreateClientTag();
  document.getElementById('password-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  startApp();
}

function startApp() {
  connectSocket();
  loadDeviceList();
  setInterval(loadDeviceList, 15000);
}

function logActivity(action, deviceId) {
  if (!socket) return;
  socket.emit('activity:log', {
    action,
    deviceId: deviceId || null,
    deviceLabel: deviceId ? labelFor(deviceId) : null,
  });
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('live-tab').style.display = tab === 'live' ? 'block' : 'none';
    document.getElementById('history-tab').style.display = tab === 'history' ? 'block' : 'none';
    if (tab === 'history') renderHistoryGroup();
  };
});

document.querySelectorAll('[data-group]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-group]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    liveGroup = btn.dataset.group;
    renderLiveGrid();
  };
});

document.querySelectorAll('[data-hgroup]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-hgroup]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    historyGroup = btn.dataset.hgroup;
    renderHistoryGroup();
  };
});

document.getElementById('refresh-history').onclick = loadHistory;
document.getElementById('device-select').onchange = loadHistory;

function labelFor(deviceId) {
  const meta = deviceMeta.get(deviceId);
  const original = meta?.machine_name || deviceId.slice(0, 8);
  if (meta?.employee_name) return `${meta.employee_name} (${original})`;
  return original;
}

function setConnStatus(online) {
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  dot.classList.toggle('online', online);
  dot.classList.toggle('offline', !online);
  text.textContent = online ? 'Connected' : 'Disconnected';
}

function connectSocket() {
  socket = io(SERVER_URL, { auth: { apiKey: API_KEY } });

  socket.on('connect', () => {
    setConnStatus(true);
    socket.emit('viewer:identify', { role: 'member', clientTag: myClientTag });
  });
  socket.on('disconnect', () => setConnStatus(false));
  socket.on('connect_error', () => setConnStatus(false));

  socket.on('viewers:update', (viewers) => {
    const names = viewers.map((v) => v.name).join(', ') || 'none';
    document.getElementById('viewer-count').textContent =
      `${viewers.length} member${viewers.length === 1 ? '' : 's'} active (${names})`;
  });

  socket.on('devices:update', (deviceIds) => {
    currentDeviceIds = deviceIds;
    renderLiveGrid();
  });

  socket.on('signal', ({ from, data, deviceId, kind }) => {
    const map = kind === 'camera' ? cameraPeers : peers;
    const peer = map.get(deviceId);
    if (!peer) return;
    peer.fromId = peer.fromId || from;
    peer.signal(data);
  });

  socket.on('remote:screen-info', ({ deviceId, width, height }) => {
    if (deviceId === remoteControlDeviceId) remoteScreenSize = { width, height };
  });
}

async function loadDeviceList() {
  const res = await fetch(`${SERVER_URL}/api/devices`, { headers: { 'x-api-key': API_KEY } });
  const devices = await res.json();
  deviceMeta = new Map(devices.map((d) => [d.device_id, d]));
  renderLiveGrid();
  renderHistoryGroup();
}

function mv(deviceId) {
  return deviceMeta.get(deviceId)?.manager_visibility || { live: true, screenshot: true, camera: false, mic: false, remoteControl: false };
}

function hasExtraAccess(deviceId) {
  const v = mv(deviceId);
  return !!(v.camera || v.mic || v.remoteControl);
}

const confirmPopup = document.getElementById('confirm-popup');
let pendingConfirmAction = null;

function confirmToggle(deviceId, key, currentlyOn, label) {
  const action = currentlyOn ? 'Turn OFF' : 'Turn ON';
  document.getElementById('confirm-popup-text').textContent = `${action} ${label} for ${labelFor(deviceId)}?`;
  pendingConfirmAction = () => toggleDeviceSetting(deviceId, key, !currentlyOn);
  confirmPopup.style.display = 'flex';
}

document.getElementById('confirm-popup-ok').onclick = () => {
  confirmPopup.style.display = 'none';
  if (pendingConfirmAction) pendingConfirmAction();
  pendingConfirmAction = null;
};
document.getElementById('confirm-popup-cancel').onclick = () => {
  confirmPopup.style.display = 'none';
  pendingConfirmAction = null;
};

async function toggleDeviceSetting(deviceId, key, value) {
  await fetch(`${SERVER_URL}/api/devices/${deviceId}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ [key]: value }),
  });
  logActivity(`${value ? 'enabled' : 'disabled'}_${key}`, deviceId);
  await loadDeviceList();
}

function renderLiveGrid() {
  const grid = document.getElementById('live-grid');
  grid.innerHTML = '';

  const filtered = currentDeviceIds.filter((id) =>
    liveGroup === 'granted' ? hasExtraAccess(id) : !hasExtraAccess(id)
  );

  if (filtered.length === 0) {
    grid.innerHTML = '<p>No employees in this category right now.</p>';
    return;
  }

  filtered.forEach((deviceId) => {
    const d = deviceMeta.get(deviceId) || {};
    const v = mv(deviceId);
    const tile = document.createElement('div');
    tile.className = 'tile';

    let rows = '';

    if (v.live) {
      rows += `<div class="device-settings-row">
        <span class="status-text">Live: <b class="${d.live_enabled ? 'status-on' : 'status-off'}">${d.live_enabled ? 'ON' : 'OFF'}</b></span>
        <button class="tg" data-key="liveEnabled" data-val="${!d.live_enabled}">${d.live_enabled ? 'Turn Off' : 'Turn On'}</button>
      </div>`;
    }
    if (v.screenshot) {
      rows += `<div class="device-settings-row">
        <span class="status-text">Screenshot: <b class="${d.screenshot_enabled ? 'status-on' : 'status-off'}">${d.screenshot_enabled ? 'ON' : 'OFF'}</b></span>
        <button class="tg" data-key="screenshotEnabled" data-val="${!d.screenshot_enabled}">${d.screenshot_enabled ? 'Turn Off' : 'Turn On'}</button>
      </div>`;
    }
    if (v.camera) {
      rows += `<div class="device-settings-row">
        <span class="status-text">Camera: <b class="${d.camera_enabled ? 'status-on' : 'status-off'}">${d.camera_enabled ? 'ON' : 'OFF'}</b></span>
        <button class="tg" data-key="cameraEnabled" data-val="${!d.camera_enabled}">${d.camera_enabled ? 'Turn Off' : 'Turn On'}</button>
      </div>`;
    }
    if (v.mic) {
      rows += `<div class="device-settings-row">
        <span class="status-text">Mic: <b class="${d.mic_enabled ? 'status-on' : 'status-off'}">${d.mic_enabled ? 'ON' : 'OFF'}</b></span>
        <button class="tg" data-key="micEnabled" data-val="${!d.mic_enabled}">${d.mic_enabled ? 'Turn Off' : 'Turn On'}</button>
      </div>`;
    }
    if (v.camera || v.mic) {
      const canView = d.camera_enabled || d.mic_enabled;
      rows += `<div class="device-settings-row">
        <button class="view-camera-btn" ${!canView ? 'disabled title="Turn Camera or Mic on first"' : ''}>View Camera / Listen Mic</button>
      </div>`;
    }
    if (v.remoteControl) {
      rows += `<div class="device-settings-row">
        <span class="status-text">Remote Control: <b class="${d.remote_control_enabled ? 'status-on' : 'status-off'}">${d.remote_control_enabled ? 'ON' : 'OFF'}</b></span>
        <button class="tg" data-key="remoteControlEnabled" data-val="${!d.remote_control_enabled}">${d.remote_control_enabled ? 'Turn Off' : 'Turn On'}</button>
      </div>
      <div class="device-settings-row">
        <button class="start-remote-btn" ${!d.remote_control_enabled ? 'disabled title="Turn Remote Control on first"' : ''}>Start Remote Control</button>
      </div>`;
    }

    if (!v.live) {
      tile.innerHTML = `
        <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:#f4f6f9;color:#9ca3af;font-size:13px;">
          Live monitoring not shared with you for this employee
        </div>
        <div class="tile-label"><span>${labelFor(deviceId)}</span></div>
        ${rows}`;
      grid.appendChild(tile);
      wireTileButtons(tile, deviceId);
      return;
    }

    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label"><span><span class="dot online"></span>${labelFor(deviceId)}</span></div>
      ${rows}`;
    grid.appendChild(tile);

    const video = tile.querySelector('video');
    watchDevice(deviceId, video);

    // Click any live tile's video to open it in the unified media focus overlay
    // (popup -> Fullscreen button -> arrow-key navigation across live tiles).
    video.style.cursor = 'zoom-in';
    video.onclick = () => openLiveMediaFocus(deviceId);

    wireTileButtons(tile, deviceId);
  });
}

function wireTileButtons(tile, deviceId) {
  tile.querySelectorAll('.tg').forEach((btn) => {
    const key = btn.dataset.key;
    const val = btn.dataset.val === 'true';
    const currentOn = !val;
    const labelMap = {
      liveEnabled: 'Live Monitoring', screenshotEnabled: 'Screenshot Capture',
      cameraEnabled: 'Camera Access', micEnabled: 'Microphone Access', remoteControlEnabled: 'Remote Control',
    };
    btn.onclick = () => confirmToggle(deviceId, key, currentOn, labelMap[key] || key);
  });
  const viewBtn = tile.querySelector('.view-camera-btn');
  if (viewBtn) viewBtn.onclick = () => openCameraModal(deviceId);
  const remoteBtn = tile.querySelector('.start-remote-btn');
  if (remoteBtn) remoteBtn.onclick = () => openRemoteControlModal(deviceId);
}

function watchDevice(deviceId, videoEl) {
  if (peers.has(deviceId)) {
    if (streams.has(deviceId)) videoEl.srcObject = streams.get(deviceId);
    return;
  }
  const peer = new SimplePeer({ initiator: false, trickle: true, config: { iceServers: ICE_SERVERS } });
  peers.set(deviceId, peer);
  peer.on('signal', (data) => {
    if (!peer.fromId) return;
    socket.emit('signal', { to: peer.fromId, data, deviceId, kind: 'screen' });
  });
  peer.on('stream', (stream) => {
    streams.set(deviceId, stream);
    videoEl.srcObject = stream;
    // If this device is currently open in the media focus overlay, keep it in sync.
    if (mediaContext === 'live' && mediaList[mediaIndex] === deviceId) {
      mediaVideo.srcObject = stream;
    }
  });
  peer.on('close', () => { peers.delete(deviceId); streams.delete(deviceId); });
  socket.emit('viewer:watch', { deviceId, kind: 'screen' });
}

const cameraOverlay = document.getElementById('camera-overlay');
let activeCameraDeviceId = null;
document.getElementById('camera-close').onclick = closeCameraModal;

function openCameraModal(deviceId) {
  activeCameraDeviceId = deviceId;
  document.getElementById('camera-label').textContent = `${labelFor(deviceId)} — Camera/Mic`;
  document.getElementById('camera-video').srcObject = cameraStreams.get(deviceId) || null;
  cameraOverlay.style.display = 'flex';
  watchCameraDevice(deviceId);
  logActivity('viewed_camera_mic', deviceId);
}

function closeCameraModal() {
  cameraOverlay.style.display = 'none';
  if (activeCameraDeviceId && cameraPeers.has(activeCameraDeviceId)) {
    cameraPeers.get(activeCameraDeviceId).destroy();
    cameraPeers.delete(activeCameraDeviceId);
    cameraStreams.delete(activeCameraDeviceId);
  }
  activeCameraDeviceId = null;
}

function watchCameraDevice(deviceId) {
  if (cameraPeers.has(deviceId)) {
    const existing = cameraStreams.get(deviceId);
    if (existing) document.getElementById('camera-video').srcObject = existing;
    return;
  }
  const peer = new SimplePeer({ initiator: false, trickle: true, config: { iceServers: ICE_SERVERS } });
  cameraPeers.set(deviceId, peer);
  peer.on('signal', (data) => {
    if (!peer.fromId) return;
    socket.emit('signal', { to: peer.fromId, data, deviceId, kind: 'camera' });
  });
  peer.on('stream', (stream) => {
    cameraStreams.set(deviceId, stream);
    if (activeCameraDeviceId === deviceId) document.getElementById('camera-video').srcObject = stream;
  });
  peer.on('close', () => { cameraPeers.delete(deviceId); cameraStreams.delete(deviceId); });
  socket.emit('viewer:watch', { deviceId, kind: 'camera' });
}

const remoteOverlay = document.getElementById('remote-overlay');
let remoteControlDeviceId = null;
let remoteScreenSize = { width: 1920, height: 1080 };
document.getElementById('remote-close').onclick = closeRemoteControlModal;

function openRemoteControlModal(deviceId) {
  remoteControlDeviceId = deviceId;
  document.getElementById('remote-label').textContent = `${labelFor(deviceId)} — Remote Control`;
  const video = document.getElementById('remote-video');
  video.srcObject = streams.get(deviceId) || null;
  remoteOverlay.style.display = 'flex';
  watchDevice(deviceId, video);
  socket.emit('remote:start', { deviceId });
  logActivity('started_remote_control', deviceId);

  video.onclick = (e) => sendRemoteClick(video, e, 'left');
  video.oncontextmenu = (e) => { e.preventDefault(); sendRemoteClick(video, e, 'right'); };
  document.addEventListener('keydown', onRemoteKeyDown);
}

function closeRemoteControlModal() {
  remoteOverlay.style.display = 'none';
  if (remoteControlDeviceId) socket.emit('remote:stop', { deviceId: remoteControlDeviceId });
  document.removeEventListener('keydown', onRemoteKeyDown);
  remoteControlDeviceId = null;
}

function sendRemoteClick(video, e, button) {
  if (!remoteControlDeviceId) return;
  const rect = video.getBoundingClientRect();
  const scaleX = remoteScreenSize.width / rect.width;
  const scaleY = remoteScreenSize.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  socket.emit('remote:input', { deviceId: remoteControlDeviceId, input: { type: 'click', x, y, button } });
}

const KEY_MAP = {
  Enter: '{ENTER}', Backspace: '{BACKSPACE}', Tab: '{TAB}', Escape: '{ESC}',
  ArrowLeft: '{LEFT}', ArrowRight: '{RIGHT}', ArrowUp: '{UP}', ArrowDown: '{DOWN}',
  Delete: '{DELETE}', Home: '{HOME}', End: '{END}', PageUp: '{PGUP}', PageDown: '{PGDN}',
};

function onRemoteKeyDown(e) {
  if (!remoteControlDeviceId) return;
  e.preventDefault();
  const text = KEY_MAP[e.key] || (e.key.length === 1 ? e.key : null);
  if (text) socket.emit('remote:input', { deviceId: remoteControlDeviceId, input: { type: 'key', text } });
}

function hasScreenshotAccess(deviceId) {
  return mv(deviceId).screenshot !== false;
}

function renderHistoryGroup() {
  const allIds = Array.from(deviceMeta.keys());
  const filtered = allIds.filter((id) => historyGroup === 'granted' ? hasScreenshotAccess(id) : !hasScreenshotAccess(id));

  const select = document.getElementById('device-select');
  const wrap = document.getElementById('history-controls-wrap');
  const noAccessList = document.getElementById('no-access-list');
  const gallery = document.getElementById('history-gallery');

  if (historyGroup === 'none') {
    wrap.style.display = 'none';
    gallery.innerHTML = '';
    noAccessList.innerHTML = filtered.length
      ? `<p>Screenshot access not shared with you for: ${filtered.map(labelFor).join(', ')}</p>`
      : '<p>Everyone has screenshot access shared with you.</p>';
    return;
  }

  wrap.style.display = 'flex';
  noAccessList.innerHTML = '';
  const previousValue = select.value;
  select.innerHTML = filtered.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join('');
  if (filtered.includes(previousValue)) select.value = previousValue;
  if (filtered.length) loadHistory(); else gallery.innerHTML = '<p>No employees with screenshot access shared yet.</p>';
}

async function loadHistory() {
  const deviceId = document.getElementById('device-select').value;
  if (!deviceId) return;
  const res = await fetch(`${SERVER_URL}/api/screenshots/${deviceId}?limit=60`, {
    headers: { 'x-api-key': API_KEY },
  });
  const shots = await res.json();
  currentShots = shots.map((s) => ({
    id: s.id,
    url: `${SERVER_URL}/api/screenshot-image/${s.id}?apiKey=${API_KEY}`,
    capturedAt: s.captured_at,
  }));
  const gallery = document.getElementById('history-gallery');
  gallery.innerHTML = currentShots
    .map((s, i) => `
      <div class="tile">
        <img src="${s.url}" loading="lazy" data-index="${i}" />
        <div class="tile-label"><span>${new Date(s.capturedAt).toLocaleString()}</span></div>
      </div>`)
    .join('');
  if (currentShots.length === 0) gallery.innerHTML = '<p>No screenshots yet for this device.</p>';
  gallery.querySelectorAll('img[data-index]').forEach((img) => {
    // Click any screenshot thumbnail to open it in the unified media focus overlay
    // (popup -> Fullscreen button -> arrow-key navigation across this device's shots).
    img.onclick = () => openHistoryMediaFocus(Number(img.dataset.index));
  });
}

// =====================================================================
// Unified media focus overlay (live tiles + screenshot history)
//
// Handles: click-to-open popup (sized/styled like the existing focus
// modals), a Fullscreen button using the real browser Fullscreen API,
// and Left/Right arrow-key navigation that works identically whether
// the overlay is a small popup or in true fullscreen.
// =====================================================================

let mediaContext = null;   // 'live' | 'history'
let mediaList = [];        // array of deviceIds (live) or shot objects (history)
let mediaIndex = -1;
let currentShots = [];     // populated by loadHistory(); source list for history mode

const mediaOverlay = document.getElementById('media-overlay');
const mediaModal = document.getElementById('media-modal');
const mediaVideo = document.getElementById('media-video');
const mediaImage = document.getElementById('media-image');
const mediaLabel = document.getElementById('media-label');

document.getElementById('media-close').onclick = closeMediaOverlay;
document.getElementById('media-prev').onclick = () => stepMedia(-1);
document.getElementById('media-next').onclick = () => stepMedia(1);
document.getElementById('media-fullscreen').onclick = toggleMediaFullscreen;

// Click the dark backdrop (not the modal itself) to close.
mediaOverlay.onclick = (e) => { if (e.target === mediaOverlay) closeMediaOverlay(); };

function buildLiveMediaList() {
  // Same filter renderLiveGrid() uses, restricted to devices whose video is
  // actually shown (live monitoring shared with this viewer).
  return currentDeviceIds.filter((id) =>
    (liveGroup === 'granted' ? hasExtraAccess(id) : !hasExtraAccess(id)) && mv(id).live
  );
}

function openLiveMediaFocus(deviceId) {
  mediaContext = 'live';
  mediaList = buildLiveMediaList();
  mediaIndex = mediaList.indexOf(deviceId);
  if (mediaIndex === -1) return;
  showMediaAtIndex();
  mediaOverlay.style.display = 'flex';
}

function openHistoryMediaFocus(index) {
  mediaContext = 'history';
  mediaList = currentShots;
  mediaIndex = index;
  if (!mediaList[mediaIndex]) return;
  showMediaAtIndex();
  mediaOverlay.style.display = 'flex';
}

function showMediaAtIndex() {
  if (mediaContext === 'live') {
    const deviceId = mediaList[mediaIndex];
    if (!deviceId) return;
    mediaLabel.textContent = labelFor(deviceId);
    mediaImage.style.display = 'none';
    mediaImage.src = '';
    mediaVideo.style.display = 'block';
    mediaVideo.srcObject = streams.get(deviceId) || null;
    watchDevice(deviceId, mediaVideo);
  } else {
    const shot = mediaList[mediaIndex];
    if (!shot) return;
    mediaLabel.textContent = new Date(shot.capturedAt).toLocaleString();
    mediaVideo.style.display = 'none';
    mediaVideo.srcObject = null;
    mediaImage.style.display = 'block';
    mediaImage.src = shot.url;
  }
}

function stepMedia(delta) {
  if (mediaList.length === 0) return;
  mediaIndex = (mediaIndex + delta + mediaList.length) % mediaList.length;
  showMediaAtIndex();
}

function closeMediaOverlay() {
  if (document.fullscreenElement) document.exitFullscreen();
  mediaOverlay.style.display = 'none';
  mediaVideo.srcObject = null;
  mediaImage.src = '';
  mediaContext = null;
  mediaList = [];
  mediaIndex = -1;
}

function toggleMediaFullscreen() {
  if (!document.fullscreenElement) {
    mediaModal.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}

// Arrow-key navigation: works the same whether the overlay is a normal
// popup or the browser's true fullscreen, since fullscreen keeps this
// same document's keydown listener active.
document.addEventListener('keydown', (e) => {
  if (mediaOverlay.style.display !== 'flex') return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepMedia(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepMedia(1);
  } else if (e.key === 'Escape' && !document.fullscreenElement) {
    // Let the browser handle Escape natively when in fullscreen (it exits
    // fullscreen first); otherwise Escape closes the popup.
    closeMediaOverlay();
  }
});