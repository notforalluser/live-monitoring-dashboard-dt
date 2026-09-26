// ---- Shared backend used by this dashboard. ----
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

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
let liveGroup = 'standard';
const historyGroup = 'granted';

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

// ---- Logout ----
function logout() {
  sessionStorage.removeItem('memberUnlocked');
  exitFullscreenIfActive().finally(() => {
    document.querySelectorAll('.focus-overlay, .lightbox').forEach((el) => { el.style.display = 'none'; });
    document.getElementById('app').style.display = 'none';
    document.getElementById('password-screen').style.display = 'flex';
    document.getElementById('password-input').value = '';
    document.getElementById('password-error').style.display = 'none';
    document.getElementById('password-input').focus();
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    peers.forEach((p) => { try { p.destroy(); } catch (e) {} });
    cameraPeers.forEach((p) => { try { p.destroy(); } catch (e) {} });
    peers.clear(); streams.clear(); cameraPeers.clear(); cameraStreams.clear();
  });
}
document.getElementById('logout-btn').onclick = logout;

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

// Refresh with spinner
async function handleRefresh() {
  const btn = document.getElementById('refresh-history');
  if (btn.classList.contains('loading')) return;
  const label = btn.querySelector('span');
  btn.classList.add('loading');
  if (label) label.textContent = 'Refreshing…';
  try {
    await loadHistory();
    await loadDeviceList();
  } finally {
    setTimeout(() => {
      btn.classList.remove('loading');
      if (label) label.textContent = 'Refresh';
    }, 400);
  }
}
document.getElementById('refresh-history').onclick = handleRefresh;
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
  if (socket) return;
  socket = io(SERVER_URL, { auth: { apiKey: API_KEY } });

  socket.on('connect', () => {
    setConnStatus(true);
    socket.emit('viewer:identify', { role: 'member', clientTag: myClientTag });
  });
  socket.on('disconnect', () => setConnStatus(false));
  socket.on('connect_error', () => setConnStatus(false));

  socket.on('viewers:update', (viewers) => {
    document.getElementById('viewer-count').textContent =
      `${viewers.length} member${viewers.length === 1 ? '' : 's'} active`;
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

// ---- Confirm popup ----
const confirmPopup = document.getElementById('confirm-popup');
let pendingConfirmAction = null;

function confirmToggle(deviceId, key, currentlyOn, label) {
  const action = currentlyOn ? 'Turn OFF' : 'Turn ON';
  document.getElementById('confirm-popup-text').textContent =
    `${action} ${label} for ${labelFor(deviceId)}?`;
  pendingConfirmAction = () => toggleDeviceSetting(deviceId, key, !currentlyOn);
  confirmPopup.style.display = 'flex';
  document.getElementById('confirm-popup-cancel').focus();
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

function toggleSwitchHTML(labelText, on, extraAttrs = '') {
  return `
    <button type="button" class="toggle-switch ${on ? 'on' : ''}" ${extraAttrs}>
      <span class="switch-label">${labelText}</span>
      <span class="switch-track"></span>
      <span class="switch-state">${on ? 'ON' : 'OFF'}</span>
    </button>`;
}

// ---- Live grid ----
function renderLiveGrid() {
  const grid = document.getElementById('live-grid');
  grid.innerHTML = '';

  const filtered = currentDeviceIds.filter((id) =>
    liveGroup === 'granted' ? hasExtraAccess(id) : !hasExtraAccess(id)
  );

  const liveVisible = filtered.filter((id) => mv(id).live);

  if (liveVisible.length === 0) {
    const msg = filtered.length === 0
      ? 'No devices in this category right now.'
      : (liveGroup === 'granted'
          ? 'No devices with Camera/Mic access are live right now.'
          : 'No devices are live right now.');
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-video-slash"></i>
        <div>${msg}</div>
      </div>`;
    return;
  }

  liveVisible.forEach((deviceId) => {
    const d = deviceMeta.get(deviceId) || {};
    const v = mv(deviceId);
    const tile = document.createElement('div');
    tile.className = 'tile';

    let rows = '';
    if (v.screenshot) rows += `<div class="device-settings-row">${toggleSwitchHTML('Shots', d.screenshot_enabled)}</div>`;
    if (v.camera)     rows += `<div class="device-settings-row">${toggleSwitchHTML('Camera', d.camera_enabled)}</div>`;
    if (v.mic)        rows += `<div class="device-settings-row">${toggleSwitchHTML('Mic', d.mic_enabled)}</div>`;

    // === FIX: The button label depends on what the ADMIN actually granted ===
    if (v.camera || v.mic) {
      const camGranted = v.camera === true;
      const micGranted = v.mic === true;
      const camOn = camGranted && d.camera_enabled === true;
      const micOn = micGranted && d.mic_enabled === true;

      let label, icon;
      if (camGranted && micGranted) {
        label = (camOn && micOn) ? 'View Camera / Listen Mic'
              : camOn             ? 'View Camera'
              : micOn             ? 'Listen Mic'
              :                     'View Camera / Listen Mic';
        icon = (camOn && micOn) ? 'fa-camera'
             : camOn             ? 'fa-camera'
             : micOn             ? 'fa-microphone'
             :                     'fa-camera';
      } else if (camGranted) {
        label = camOn ? 'View Camera' : 'View Camera';
        icon = 'fa-camera';
      } else if (micGranted) {
        label = micOn ? 'Listen Mic' : 'Listen Mic';
        icon = 'fa-microphone';
      }

      const canOpen = camOn || micOn;
      rows += `<div class="device-settings-row">
        <button class="view-camera-btn" ${!canOpen ? 'disabled title="Nothing shared yet"' : ''}>
          <i class="fas ${icon}"></i> ${label}
        </button>
      </div>`;
    }

    if (v.remoteControl) {
      rows += `<div class="device-settings-row">${toggleSwitchHTML('Remote', d.remote_control_enabled)}</div>
      <div class="device-settings-row">
        <button class="start-remote-btn" ${!d.remote_control_enabled ? 'disabled title="Turn Remote Control on first"' : ''}>
          <i class="fas fa-mouse-pointer"></i> Start Remote Control
        </button>
      </div>`;
    }

    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label">
        <span><span class="dot online"></span>${labelFor(deviceId)}</span>
        <span class="status-text"><i class="fas fa-circle status-on" style="font-size:8px;"></i> Live</span>
      </div>
      <div class="device-settings-row">${toggleSwitchHTML('Live', d.live_enabled)}</div>
      ${rows}`;
    grid.appendChild(tile);

    const video = tile.querySelector('video');
    video.addEventListener('click', () => openFocus(deviceId));
    watchDevice(deviceId, video);
    wireTileButtons(tile, deviceId);
  });
}

function wireTileButtons(tile, deviceId) {
  const d = deviceMeta.get(deviceId) || {};
  tile.querySelectorAll('.toggle-switch').forEach((sw) => {
    const labelText = sw.querySelector('.switch-label').textContent.trim();
    const map = {
      'Live':   { key: 'liveEnabled',          current: d.live_enabled,           pretty: 'Live Monitoring' },
      'Shots':  { key: 'screenshotEnabled',    current: d.screenshot_enabled,     pretty: 'Screenshot Capture' },
      'Camera': { key: 'cameraEnabled',        current: d.camera_enabled,         pretty: 'Camera Access' },
      'Mic':    { key: 'micEnabled',           current: d.mic_enabled,            pretty: 'Microphone Access' },
      'Remote': { key: 'remoteControlEnabled', current: d.remote_control_enabled, pretty: 'Remote Control' },
    };
    const meta = map[labelText];
    if (!meta) return;
    sw.onclick = () => confirmToggle(deviceId, meta.key, !!meta.current, meta.pretty);
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
    if (focusIndex >= 0 && visibleLiveIds()[focusIndex] === deviceId) {
      document.getElementById('focus-video').srcObject = stream;
    }
  });
  peer.on('close', () => { peers.delete(deviceId); streams.delete(deviceId); });
  socket.emit('viewer:watch', { deviceId, kind: 'screen' });
}

// ============================================================
// Auto-hide UI
// ============================================================
const AUTO_HIDE_MS = 2000;
const hideTimers = new WeakMap();

function wireAutoHide(modal) {
  const ui = modal.querySelector('.focus-ui');
  if (!ui) return;
  const show = () => {
    ui.classList.remove('hidden');
    modal.classList.remove('ui-hidden');
    resetTimer();
  };
  const resetTimer = () => {
    const prev = hideTimers.get(modal);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      ui.classList.add('hidden');
      if (isFullscreen()) modal.classList.add('ui-hidden');
    }, AUTO_HIDE_MS);
    hideTimers.set(modal, t);
  };
  if (!modal._autohideWired) {
    modal._autohideWired = true;
    modal.addEventListener('mousemove', show, { passive: true });
    modal.addEventListener('mouseenter', show, { passive: true });
    modal.addEventListener('touchstart', show, { passive: true });
    modal.addEventListener('touchmove', show, { passive: true });
  }
  resetTimer();
}

// ============================================================
// FOCUS (live popup)
// ============================================================
const focusOverlay = document.getElementById('focus-overlay');
const focusModal = document.getElementById('focus-modal');
let focusIndex = -1;

document.getElementById('focus-close').onclick = closeFocus;
document.getElementById('focus-prev').onclick = () => stepFocus(-1);
document.getElementById('focus-next').onclick = () => stepFocus(1);
document.getElementById('focus-fullscreen').onclick = () => toggleFullscreen(focusModal);

function visibleLiveIds() {
  return currentDeviceIds.filter((id) => {
    const v = mv(id);
    if (!v.live) return false;
    return liveGroup === 'granted' ? hasExtraAccess(id) : !hasExtraAccess(id);
  });
}

function openFocus(deviceId) {
  const list = visibleLiveIds();
  focusIndex = list.indexOf(deviceId);
  if (focusIndex < 0) focusIndex = 0;
  renderFocus();
  focusOverlay.style.display = 'flex';
  document.addEventListener('keydown', onFocusKeyDown);
  wireAutoHide(focusModal);
}

function closeFocus() {
  exitFullscreenIfActive().finally(() => {
    focusOverlay.style.display = 'none';
    focusIndex = -1;
    document.removeEventListener('keydown', onFocusKeyDown);
  });
}

function stepFocus(delta) {
  const list = visibleLiveIds();
  if (list.length === 0) return;
  const next = focusIndex + delta;
  if (next < 0 || next >= list.length) return;
  focusIndex = next;
  renderFocus();
}

function renderFocus() {
  const list = visibleLiveIds();
  const deviceId = list[focusIndex];
  if (!deviceId) return closeFocus();
  document.getElementById('focus-label').innerHTML =
    `<i class="fas fa-tv"></i> ${labelFor(deviceId)}`;
  document.getElementById('focus-video').srcObject = streams.get(deviceId) || null;
  document.getElementById('focus-prev').disabled = focusIndex === 0;
  document.getElementById('focus-next').disabled = focusIndex === list.length - 1;
}

function onFocusKeyDown(e) {
  if (focusOverlay.style.display !== 'flex') return;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); stepFocus(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepFocus(1);  }
  if (e.key === 'Escape') { if (!isFullscreen()) closeFocus(); }
}

// ---- Fullscreen helpers ----
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}
function exitFullscreenIfActive() {
  return new Promise((resolve) => {
    if (!isFullscreen()) return resolve();
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (!exit) return resolve();
    Promise.resolve(exit.call(document)).then(resolve).catch(resolve);
  });
}
function toggleFullscreen(el) {
  if (!isFullscreen()) {
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) req.call(el);
  } else {
    exitFullscreenIfActive();
  }
}
function updateFullscreenButtons() {
  const isFs = isFullscreen();
  document.querySelectorAll('#focus-fullscreen, #camera-fullscreen, #remote-fullscreen').forEach((btn) => {
    btn.innerHTML = isFs
      ? '<i class="fas fa-compress"></i> Exit Fullscreen'
      : '<i class="fas fa-expand"></i> Fullscreen';
  });
  if (!isFs) {
    [focusModal, cameraModal, remoteModal].forEach((m) => {
      if (!m) return;
      const ui = m.querySelector('.focus-ui');
      if (ui) ui.classList.remove('hidden');
      m.classList.remove('ui-hidden');
    });
  } else {
    [focusModal, cameraModal, remoteModal].forEach((m) => {
      if (!m) return;
      const ui = m.querySelector('.focus-ui');
      if (ui) {
        ui.classList.remove('hidden');
        m.classList.remove('ui-hidden');
        const prev = hideTimers.get(m);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
          ui.classList.add('hidden');
          m.classList.add('ui-hidden');
        }, AUTO_HIDE_MS);
        hideTimers.set(m, t);
      }
    });
  }
}
document.addEventListener('fullscreenchange', updateFullscreenButtons);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtons);

// ============================================================
// CAMERA MODAL — camera & mic are INDEPENDENT
// The header and hint reflect only what the admin granted.
// ============================================================
const cameraOverlay = document.getElementById('camera-overlay');
const cameraModal = document.getElementById('camera-modal');
let activeCameraDeviceId = null;
document.getElementById('camera-close').onclick = closeCameraModal;
document.getElementById('camera-fullscreen').onclick = () => toggleFullscreen(cameraModal);

function openCameraModal(deviceId) {
  activeCameraDeviceId = deviceId;
  const v = mv(deviceId);
  const meta = deviceMeta.get(deviceId) || {};

  // What did the ADMIN grant?
  const camGranted = v.camera === true;
  const micGranted = v.mic === true;
  // And is the setting currently enabled?
  const camOn = camGranted && meta.camera_enabled === true;
  const micOn = micGranted && meta.mic_enabled === true;

  // Choose label + icon based on what is actually granted + on.
  let headerLabel, headerIcon;
  if (camOn && micOn)      { headerLabel = 'Camera & Microphone'; headerIcon = 'fa-camera'; }
  else if (camOn)          { headerLabel = 'Camera';              headerIcon = 'fa-camera'; }
  else if (micOn)          { headerLabel = 'Microphone';          headerIcon = 'fa-microphone'; }
  else                     { headerLabel = 'Nothing Shared';      headerIcon = 'fa-ban'; }

  document.getElementById('camera-label').innerHTML =
    `<i class="fas ${headerIcon}"></i> ${labelFor(deviceId)} — ${headerLabel}`;

  // Adapt hint text.
  const hint = document.getElementById('camera-hint');
  if (camOn && micOn)      hint.innerHTML = '<i class="fas fa-info-circle"></i> Camera and microphone stream. Move the mouse to show controls.';
  else if (camOn)          hint.innerHTML = '<i class="fas fa-info-circle"></i> Camera-only stream. Move the mouse to show controls.';
  else if (micOn)          hint.innerHTML = '<i class="fas fa-info-circle"></i> Microphone-only stream. Move the mouse to show controls.';
  else                     hint.innerHTML = '<i class="fas fa-info-circle"></i> Nothing shared by this device.';

  document.getElementById('camera-video').srcObject = cameraStreams.get(deviceId) || null;
  cameraOverlay.style.display = 'flex';
  watchCameraDevice(deviceId);
  logActivity(
    camOn && micOn ? 'viewed_camera_mic'
    : camOn        ? 'viewed_camera'
    : micOn        ? 'listened_mic'
    :                'viewed_camera_modal',
    deviceId
  );
  wireAutoHide(cameraModal);
}

function closeCameraModal() {
  exitFullscreenIfActive().finally(() => {
    cameraOverlay.style.display = 'none';
    if (activeCameraDeviceId && cameraPeers.has(activeCameraDeviceId)) {
      cameraPeers.get(activeCameraDeviceId).destroy();
      cameraPeers.delete(activeCameraDeviceId);
      cameraStreams.delete(activeCameraDeviceId);
    }
    activeCameraDeviceId = null;
  });
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

// ---- Remote modal ----
const remoteOverlay = document.getElementById('remote-overlay');
const remoteModal = document.getElementById('remote-modal');
let remoteControlDeviceId = null;
let remoteScreenSize = { width: 1920, height: 1080 };
document.getElementById('remote-close').onclick = closeRemoteControlModal;
document.getElementById('remote-fullscreen').onclick = () => toggleFullscreen(remoteModal);

function openRemoteControlModal(deviceId) {
  remoteControlDeviceId = deviceId;
  document.getElementById('remote-label').innerHTML =
    `<i class="fas fa-mouse-pointer"></i> ${labelFor(deviceId)} — Remote Control`;
  const video = document.getElementById('remote-video');
  video.srcObject = streams.get(deviceId) || null;
  remoteOverlay.style.display = 'flex';
  watchDevice(deviceId, video);
  socket.emit('remote:start', { deviceId });
  logActivity('started_remote_control', deviceId);
  video.onclick = (e) => sendRemoteClick(video, e, 'left');
  video.oncontextmenu = (e) => { e.preventDefault(); sendRemoteClick(video, e, 'right'); };
  document.addEventListener('keydown', onRemoteKeyDown);
  wireAutoHide(remoteModal);
}

function closeRemoteControlModal() {
  exitFullscreenIfActive().finally(() => {
    remoteOverlay.style.display = 'none';
    if (remoteControlDeviceId) socket.emit('remote:stop', { deviceId: remoteControlDeviceId });
    document.removeEventListener('keydown', onRemoteKeyDown);
    remoteControlDeviceId = null;
  });
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

// ---- History ----
function hasScreenshotAccess(deviceId) {
  return mv(deviceId).screenshot !== false;
}

function renderHistoryGroup() {
  const allIds = Array.from(deviceMeta.keys());
  const filtered = allIds.filter((id) => hasScreenshotAccess(id));
  const select = document.getElementById('device-select');
  const wrap = document.getElementById('history-controls-wrap');
  const gallery = document.getElementById('history-gallery');
  wrap.style.display = 'flex';
  const previousValue = select.value;
  select.innerHTML = filtered.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join('');
  if (filtered.includes(previousValue)) select.value = previousValue;
  if (filtered.length) loadHistory();
  else gallery.innerHTML = '<p>No devices with screenshot access shared yet.</p>';
}

const lightbox = document.getElementById('image-lightbox');
let currentShots = [];
let lightboxIndex = -1;
let historyColumns = Number(localStorage.getItem('historyColumns')) || 8;

document.getElementById('lightbox-close').onclick = () => { lightbox.style.display = 'none'; };
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.style.display = 'none'; };
document.getElementById('lightbox-prev').onclick = () => stepLightbox(-1);
document.getElementById('lightbox-next').onclick = () => stepLightbox(1);

document.addEventListener('keydown', (e) => {
  if (lightbox.style.display !== 'flex') return;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); stepLightbox(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1);  }
  if (e.key === 'Escape')     { lightbox.style.display = 'none'; }
});

document.querySelectorAll('.col-btn').forEach((btn) => {
  if (Number(btn.dataset.cols) === historyColumns) btn.classList.add('active');
  btn.onclick = () => {
    document.querySelectorAll('.col-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    historyColumns = Number(btn.dataset.cols);
    localStorage.setItem('historyColumns', historyColumns);
    document.documentElement.style.setProperty('--history-cols', historyColumns);
  };
});
document.documentElement.style.setProperty('--history-cols', historyColumns);

function openLightbox(index) {
  lightboxIndex = index;
  renderLightbox();
  lightbox.style.display = 'flex';
}

function stepLightbox(delta) {
  if (currentShots.length === 0) return;
  const next = lightboxIndex + delta;
  if (next < 0 || next >= currentShots.length) return;
  lightboxIndex = next;
  renderLightbox();
}

function renderLightbox() {
  const shot = currentShots[lightboxIndex];
  if (!shot) return;
  document.getElementById('lightbox-img').src = shot.url;
  document.getElementById('lightbox-caption').textContent = new Date(shot.capturedAt).toLocaleString();
  document.getElementById('lightbox-prev').disabled = lightboxIndex === 0;
  document.getElementById('lightbox-next').disabled = lightboxIndex === currentShots.length - 1;
}

function dateGroupLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

async function loadHistory() {
  const deviceId = document.getElementById('device-select').value;
  if (!deviceId) return;
  const res = await fetch(`${SERVER_URL}/api/screenshots/${deviceId}?limit=all&forTeam=true`, {
    headers: { 'x-api-key': API_KEY },
  });
  const shots = await res.json();
  currentShots = shots.map((s) => ({
    id: s.id,
    url: `${SERVER_URL}/api/screenshot-image/${s.id}?apiKey=${API_KEY}`,
    capturedAt: s.captured_at,
  }));

  const gallery = document.getElementById('history-gallery');
  if (currentShots.length === 0) {
    gallery.innerHTML = '<p>No screenshots yet for this device.</p>';
    return;
  }

  const groups = new Map();
  currentShots.forEach((shot, flatIndex) => {
    const label = dateGroupLabel(new Date(shot.capturedAt));
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ shot, flatIndex });
  });

  gallery.innerHTML = Array.from(groups.entries())
    .map(([label, items]) => `
      <div class="date-group">
        <h3 class="date-heading">${label}</h3>
        <div class="date-grid">
          ${items.map(({ shot, flatIndex }) => `
            <div class="thumb">
              <img src="${shot.url}" loading="lazy" data-index="${flatIndex}" />
            </div>`).join('')}
        </div>
      </div>`)
    .join('');

  gallery.querySelectorAll('img[data-index]').forEach((img) => {
    img.onclick = () => openLightbox(Number(img.dataset.index));
  });
}