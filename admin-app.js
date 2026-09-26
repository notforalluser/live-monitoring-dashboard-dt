// ---- Baked-in connection details (no manual entry needed) ----
// NOTE: since this is a static site with no backend of its own, anyone who
// opens browser dev tools can read these values regardless of the password
// screen below. Treat the password as a basic deterrent, not real security -
// don't share this URL publicly, and rotate the API key if you ever suspect
// it leaked.
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

// SHA-256 hash of the Super Admin password (not the password itself).
// This page (admin.html) only ever accepts this one password.
const PASSWORD_HASH = '6eb3748e9b511796ec5c0a36d816cdaf6ac425cf4c40a886e31084ab99c3519f';
const VIEWER_NAME = 'Founder (Super Admin)';
const VIEWER_ROLE = 'super_admin';

// Same TURN relay as the agent - both sides need matching config for a
// relayed connection to succeed.
const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

let socket = null;
const peers = new Map();
const streams = new Map();
const cameraPeers = new Map();
const cameraStreams = new Map();
const selectedDevices = new Set();
let showAll = true;
let currentDeviceIds = [];
let deviceMeta = new Map();
let focusIndex = -1;
let selectMode = false; // history thumbnail select mode

// ---- Password gate ----
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tryUnlock() {
  const input = document.getElementById('password-input').value;
  const hash = await sha256Hex(input);
  if (hash === PASSWORD_HASH) {
    sessionStorage.setItem('unlocked', 'true');
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

if (sessionStorage.getItem('unlocked') === 'true') {
  document.getElementById('password-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  startApp();
}

// ---- App bootstrap ----
function startApp() {
  connectSocket();
  loadDeviceList();
  setInterval(loadDeviceList, 15000);
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('live-tab').style.display = tab === 'live' ? 'block' : 'none';
    document.getElementById('history-tab').style.display = tab === 'history' ? 'block' : 'none';
    document.getElementById('activity-tab').style.display = tab === 'activity' ? 'block' : 'none';
    if (tab === 'history') loadDeviceList();
    if (tab === 'activity') loadActivityLog();
  };
});

async function loadActivityLog() {
  const res = await fetch(`${SERVER_URL}/api/activity-log`, { headers: { 'x-api-key': API_KEY } });
  const logs = await res.json();
  renderActivityLog(logs);
}

function renderActivityLog(logs) {
  const list = document.getElementById('activity-log-list');
  if (logs.length === 0) {
    list.innerHTML = '<p style="padding:20px;color:#94a3b8;">No activity recorded yet.</p>';
    return;
  }
  list.innerHTML = logs
    .map((l) => `
      <div class="activity-row">
        <span class="activity-who">${l.viewerName}</span>
        <span class="activity-what">${l.action.replace(/_/g, ' ')}</span>
        <span class="activity-where">${l.deviceLabel || ''}</span>
        <span class="activity-when">${new Date(l.at).toLocaleString()}</span>
      </div>`)
    .join('');
}

document.getElementById('refresh-history').onclick = loadHistory;
document.getElementById('device-select').onchange = loadHistory;

document.getElementById('show-all-btn').onclick = () => {
  showAll = true;
  selectedDevices.clear();
  document.getElementById('show-all-btn').classList.add('active');
  document.querySelectorAll('.check-chip').forEach((c) => c.classList.remove('checked'));
  renderLiveGrid(currentDeviceIds);
};

// ---- Tile size controls ----
document.querySelectorAll('.size-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.size-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.documentElement.style.setProperty('--tile-size', `${btn.dataset.size}px`);

    if (btn.dataset.full === 'true') {
      enterGridFullscreen();
    }
  };
});

function enterGridFullscreen() {
  const grid = document.getElementById('live-grid');
  const videos = grid.querySelectorAll('video');
  const target = videos.length === 1 ? videos[0] : grid;
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (request) request.call(target);
}

// ---- Focus overlay ----
const overlay = document.getElementById('focus-overlay');
document.getElementById('focus-close').onclick = closeFocus;
document.getElementById('focus-prev').onclick = () => stepFocus(-1);
document.getElementById('focus-next').onclick = () => stepFocus(1);
document.getElementById('focus-fullscreen').onclick = () => {
  const video = document.getElementById('focus-video');
  const request = video.requestFullscreen || video.webkitRequestFullscreen;
  if (request) request.call(video);
};

function visibleDeviceIds() {
  return showAll ? currentDeviceIds : currentDeviceIds.filter((id) => selectedDevices.has(id));
}

function labelFor(deviceId) {
  const meta = deviceMeta.get(deviceId);
  const original = meta?.machineName || deviceId.slice(0, 8);
  if (meta?.employeeName) return `${meta.employeeName} (${original})`;
  return original;
}

function openFocus(deviceId) {
  const list = visibleDeviceIds();
  focusIndex = list.indexOf(deviceId);
  renderFocus();
  overlay.style.display = 'flex';
}

function closeFocus() {
  overlay.style.display = 'none';
  focusIndex = -1;
}

function stepFocus(delta) {
  const list = visibleDeviceIds();
  if (list.length === 0) return;
  focusIndex = (focusIndex + delta + list.length) % list.length;
  renderFocus();
}

function renderFocus() {
  const list = visibleDeviceIds();
  const deviceId = list[focusIndex];
  if (!deviceId) return closeFocus();
  document.getElementById('focus-label').textContent = labelFor(deviceId);
  document.getElementById('focus-video').srcObject = streams.get(deviceId) || null;
}

// ---- Connection status dot ----
function setConnStatus(online) {
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  dot.classList.toggle('online', online);
  dot.classList.toggle('offline', !online);
  text.textContent = online ? 'Connected' : 'Disconnected';
}

// ---- Live view ----
function connectSocket() {
  socket = io(SERVER_URL, { auth: { apiKey: API_KEY } });

  socket.on('connect', () => {
    setConnStatus(true);
    socket.emit('viewer:identify', { role: VIEWER_ROLE, name: VIEWER_NAME });
  });
  socket.on('disconnect', () => setConnStatus(false));
  socket.on('connect_error', () => setConnStatus(false));

  socket.on('viewers:update', (viewers) => {
    const names = viewers.map((v) => v.name).join(', ') || 'none';
    document.getElementById('viewer-count').textContent =
      `${viewers.length} member${viewers.length === 1 ? '' : 's'} active (${names})`;
  });

  socket.on('activity:new', (entry) => {
    if (document.getElementById('activity-tab').style.display !== 'none') {
      const list = document.getElementById('activity-log-list');
      const row = document.createElement('div');
      row.className = 'activity-row';
      row.innerHTML = `
        <span class="activity-who">${entry.viewerName}</span>
        <span class="activity-what">${entry.action.replace(/_/g, ' ')}</span>
        <span class="activity-where">${entry.deviceLabel || ''}</span>
        <span class="activity-when">${new Date(entry.at).toLocaleString()}</span>`;
      list.prepend(row);
    }
  });

  socket.on('devices:update', (deviceIds) => {
    currentDeviceIds = deviceIds;
    renderChecklist(deviceIds);
    renderLiveGrid(deviceIds);
  });

  socket.on('signal', ({ from, data, deviceId, kind }) => {
    const map = kind === 'camera' ? cameraPeers : peers;
    const peer = map.get(deviceId);
    if (!peer) return;
    peer.fromId = peer.fromId || from;
    peer.signal(data);
  });

  socket.on('remote:screen-info', ({ deviceId, width, height }) => {
    if (deviceId === remoteControlDeviceId) {
      remoteScreenSize = { width, height };
    }
  });
}

function renderChecklist(deviceIds) {
  const wrap = document.getElementById('device-checklist');
  wrap.innerHTML = '';
  deviceIds.forEach((id) => {
    const chip = document.createElement('label');
    chip.className = 'check-chip' + (selectedDevices.has(id) ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" ${selectedDevices.has(id) ? 'checked' : ''}/> ${labelFor(id)}`;
    chip.querySelector('input').onchange = (e) => {
      showAll = false;
      document.getElementById('show-all-btn').classList.remove('active');
      if (e.target.checked) selectedDevices.add(id);
      else selectedDevices.delete(id);
      chip.classList.toggle('checked', e.target.checked);
      renderLiveGrid(currentDeviceIds);
    };
    wrap.appendChild(chip);
  });
}

// ---- Toggle switch helper ----
function toggleSwitchHTML(labelText, on, extraAttrs = '') {
  return `
    <button type="button" class="toggle-switch ${on ? 'on' : ''}" ${extraAttrs}>
      <span class="switch-label">${labelText}</span>
      <span class="switch-track"></span>
      <span class="switch-state">${on ? 'ON' : 'OFF'}</span>
    </button>`;
}

function renderLiveGrid(deviceIds) {
  const grid = document.getElementById('live-grid');
  grid.innerHTML = '';
  const visible = showAll ? deviceIds : deviceIds.filter((id) => selectedDevices.has(id));

  if (visible.length === 0) {
    grid.innerHTML = '<p style="color:#94a3b8;">No agents currently online (or none selected).</p>';
    return;
  }

  visible.forEach((deviceId) => {
    const meta = deviceMeta.get(deviceId) || {};
    const liveOn = meta.liveEnabled !== false;
    const shotsOn = meta.screenshotEnabled !== false;
    const interval = meta.screenshotIntervalSeconds ?? 120;
    const cameraOn = meta.cameraEnabled === true;
    const micOn = meta.micEnabled === true;
    const remoteOn = meta.remoteControlEnabled === true;
    const mv = meta.managerVisibility || { live: true, screenshot: true, camera: false, mic: false, remoteControl: false };
    const consent = meta.cameraMicConsent || 'pending';
    const consentBadge = consent === 'granted'
      ? '<span class="status-on">Employee: Granted</span>'
      : consent === 'declined'
      ? '<span class="status-off">Employee: Declined</span>'
      : '<span class="status-off">Employee: Pending</span>';
    const consentBlocksAccess = consent !== 'granted';

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label">
        <span><span class="dot online"></span>${labelFor(deviceId)}</span>
        <button class="rename-btn" type="button">Rename</button>
      </div>

      <div class="device-settings-row">
        ${toggleSwitchHTML('Live', liveOn)}
        ${toggleSwitchHTML('Shots', shotsOn)}
      </div>

      <div class="device-settings-row">
        <span class="settings-label">Interval</span>
        <input type="number" class="interval-input" min="5" value="${interval}" title="Screenshot interval (seconds)" />
        <span class="status-text">sec</span>
        <button class="save-interval-btn" type="button">Set</button>
      </div>

      <div class="device-settings-row">
        ${toggleSwitchHTML('Camera', cameraOn, consentBlocksAccess ? 'disabled' : '')}
        ${toggleSwitchHTML('Mic', micOn, consentBlocksAccess ? 'disabled' : '')}
      </div>

      <div class="device-settings-row">
        <span class="status-text">Consent: ${consentBadge}</span>
      </div>

      <div class="device-settings-row">
        <button class="view-camera-btn" type="button" ${(!cameraOn && !micOn) || consentBlocksAccess ? 'disabled title="Requires employee consent + admin permission"' : ''}>View Camera / Listen Mic</button>
      </div>

      <div class="device-settings-row">
        ${toggleSwitchHTML('Remote', remoteOn)}
      </div>

      <div class="device-settings-row">
        <button class="start-remote-btn" type="button" ${!remoteOn ? 'disabled title="Turn Remote Control on first"' : ''}>Start Remote Control</button>
      </div>

      <div class="device-settings-row manager-visibility-row">
        <span class="mv-label">Team Dashboard access for this employee</span>
        <label class="mv-check"><input type="checkbox" class="mv-live" ${mv.live ? 'checked' : ''}/> Live</label>
        <label class="mv-check"><input type="checkbox" class="mv-screenshot" ${mv.screenshot ? 'checked' : ''}/> Screenshot</label>
        <label class="mv-check"><input type="checkbox" class="mv-camera" ${mv.camera ? 'checked' : ''}/> Camera</label>
        <label class="mv-check"><input type="checkbox" class="mv-mic" ${mv.mic ? 'checked' : ''}/> Mic</label>
        <label class="mv-check"><input type="checkbox" class="mv-remote" ${mv.remoteControl ? 'checked' : ''}/> Remote</label>
      </div>`;
    grid.appendChild(tile);

    const video = tile.querySelector('video');
    video.onclick = () => openFocus(deviceId);
    tile.querySelector('.rename-btn').onclick = () => renameDevice(deviceId);

    const [liveBtn, shotsBtn] = tile.querySelectorAll('.device-settings-row')[0].querySelectorAll('.toggle-switch');
    liveBtn.onclick = () => confirmToggle(deviceId, 'liveEnabled', liveOn, 'Live Monitoring');
    shotsBtn.onclick = () => confirmToggle(deviceId, 'screenshotEnabled', shotsOn, 'Screenshot Capture');

    const [camBtn, micBtn] = tile.querySelectorAll('.device-settings-row')[2].querySelectorAll('.toggle-switch');
    camBtn.onclick = () => confirmToggle(deviceId, 'cameraEnabled', cameraOn, 'Camera Access');
    micBtn.onclick = () => confirmToggle(deviceId, 'micEnabled', micOn, 'Microphone Access');

    const remoteBtn = tile.querySelectorAll('.device-settings-row')[5].querySelector('.toggle-switch');
    remoteBtn.onclick = () => confirmToggle(deviceId, 'remoteControlEnabled', remoteOn, 'Remote Control');

    tile.querySelector('.view-camera-btn').onclick = () => openCameraModal(deviceId);
    tile.querySelector('.start-remote-btn').onclick = () => openRemoteControlModal(deviceId);
    tile.querySelector('.mv-live').onchange = (e) => updateManagerVisibility(deviceId, 'live', e.target.checked);
    tile.querySelector('.mv-screenshot').onchange = (e) => updateManagerVisibility(deviceId, 'screenshot', e.target.checked);
    tile.querySelector('.mv-camera').onchange = (e) => updateManagerVisibility(deviceId, 'camera', e.target.checked);
    tile.querySelector('.mv-mic').onchange = (e) => updateManagerVisibility(deviceId, 'mic', e.target.checked);
    tile.querySelector('.mv-remote').onchange = (e) => updateManagerVisibility(deviceId, 'remoteControl', e.target.checked);
    tile.querySelector('.save-interval-btn').onclick = () => {
      const seconds = Number(tile.querySelector('.interval-input').value);
      if (!seconds || seconds < 5) return showAlert('Enter at least 5 seconds.');
      toggleDeviceSetting(deviceId, 'screenshotIntervalSeconds', seconds);
    };
    watchDevice(deviceId, video);
  });
}

// ---- Activity logging ----
function logActivity(action, deviceId) {
  if (!socket) return;
  socket.emit('activity:log', {
    action,
    deviceId: deviceId || null,
    deviceLabel: deviceId ? labelFor(deviceId) : null,
  });
}

async function toggleDeviceSetting(deviceId, key, value) {
  await fetch(`${SERVER_URL}/api/devices/${deviceId}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ [key]: value }),
  });
  logActivity(`${value ? 'enabled' : 'disabled'}_${key}`, deviceId);
  await loadDeviceList();
  renderLiveGrid(currentDeviceIds);
}

async function updateManagerVisibility(deviceId, key, value) {
  await fetch(`${SERVER_URL}/api/devices/${deviceId}/manager-visibility`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ [key]: value }),
  });
  logActivity(`${value ? 'granted' : 'revoked'}_team_access_${key}`, deviceId);
  await loadDeviceList();
}

// ---- Confirmation popup (Cancel focused by default) ----
const confirmPopup = document.getElementById('confirm-popup');
let pendingConfirmAction = null;

function showConfirm(message, onConfirm, opts = {}) {
  document.getElementById('confirm-popup-text').textContent = message;
  const okBtn = document.getElementById('confirm-popup-ok');
  const cancelBtn = document.getElementById('confirm-popup-cancel');
  okBtn.textContent = opts.confirmText || 'Yes, Confirm';
  okBtn.classList.toggle('danger-btn', opts.danger !== false);
  okBtn.classList.toggle('secondary-btn', opts.danger === false);
  pendingConfirmAction = onConfirm;
  confirmPopup.style.display = 'flex';
  // Focus Cancel by default so accidental Enter doesn't delete.
  cancelBtn.focus();
}

function closeConfirm() {
  confirmPopup.style.display = 'none';
  pendingConfirmAction = null;
}

document.getElementById('confirm-popup-ok').onclick = () => {
  const action = pendingConfirmAction;
  closeConfirm();
  if (action) action();
};
document.getElementById('confirm-popup-cancel').onclick = closeConfirm;

// Simple alert using the same popup style (Cancel hidden, OK only)
function showAlert(message) {
  document.getElementById('confirm-popup-text').textContent = message;
  const okBtn = document.getElementById('confirm-popup-ok');
  const cancelBtn = document.getElementById('confirm-popup-cancel');
  okBtn.textContent = 'OK';
  okBtn.classList.add('secondary-btn');
  okBtn.classList.remove('danger-btn');
  cancelBtn.style.display = 'none';
  pendingConfirmAction = () => { cancelBtn.style.display = ''; };
  confirmPopup.style.display = 'flex';
  okBtn.focus();
}

function confirmToggle(deviceId, key, currentlyOn, label) {
  const action = currentlyOn ? 'Turn OFF' : 'Turn ON';
  showConfirm(`${action} ${label} for ${labelFor(deviceId)}?`, () => {
    toggleDeviceSetting(deviceId, key, !currentlyOn);
  });
}

async function renameDevice(deviceId) {
  const current = deviceMeta.get(deviceId)?.employeeName || '';
  const name = prompt('Employee name for this device:', current);
  if (name === null) return;
  await fetch(`${SERVER_URL}/api/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ employeeName: name }),
  });
  logActivity('renamed_device', deviceId);
  await loadDeviceList();
  renderLiveGrid(currentDeviceIds);
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
    if (focusIndex >= 0 && visibleDeviceIds()[focusIndex] === deviceId) {
      document.getElementById('focus-video').srcObject = stream;
    }
  });

  peer.on('close', () => {
    peers.delete(deviceId);
    streams.delete(deviceId);
  });

  socket.emit('viewer:watch', { deviceId, kind: 'screen' });
}

// ---- Camera/mic viewing ----
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
    if (activeCameraDeviceId === deviceId) {
      document.getElementById('camera-video').srcObject = stream;
    }
  });

  peer.on('close', () => {
    cameraPeers.delete(deviceId);
    cameraStreams.delete(deviceId);
  });

  socket.emit('viewer:watch', { deviceId, kind: 'camera' });
}

// ---- Remote control (mouse/keyboard) ----
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
  video.oncontextmenu = (e) => {
    e.preventDefault();
    sendRemoteClick(video, e, 'right');
  };
  document.addEventListener('keydown', onRemoteKeyDown);
}

function closeRemoteControlModal() {
  remoteOverlay.style.display = 'none';
  if (remoteControlDeviceId) {
    socket.emit('remote:stop', { deviceId: remoteControlDeviceId });
  }
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
  if (text) {
    socket.emit('remote:input', { deviceId: remoteControlDeviceId, input: { type: 'key', text } });
  }
}

// ---- History ----
async function loadDeviceList() {
  const res = await fetch(`${SERVER_URL}/api/devices`, { headers: { 'x-api-key': API_KEY } });
  const devices = await res.json();

  deviceMeta = new Map(devices.map((d) => [d.device_id, {
    employeeName: d.employee_name,
    machineName: d.machine_name,
    liveEnabled: d.live_enabled,
    screenshotEnabled: d.screenshot_enabled,
    screenshotIntervalSeconds: d.screenshot_interval_seconds,
    cameraEnabled: d.camera_enabled,
    micEnabled: d.mic_enabled,
    cameraMicConsent: d.camera_mic_consent,
    remoteControlEnabled: d.remote_control_enabled,
    managerVisibility: d.manager_visibility,
  }]));

  const select = document.getElementById('device-select');
  const previousValue = select.value;
  select.innerHTML = devices
    .map((d) => `<option value="${d.device_id}">${d.employee_name || d.machine_name || d.device_id.slice(0, 8)}</option>`)
    .join('');
  if (devices.some((d) => d.device_id === previousValue)) select.value = previousValue;

  if (currentDeviceIds.length) renderLiveGrid(currentDeviceIds);
  if (devices.length && document.getElementById('history-tab').style.display !== 'none') loadHistory();
}

// ---- Select mode ----
const selectedScreenshots = new Set();
const selectModeBtn = document.getElementById('select-mode-btn');

selectModeBtn.onclick = () => {
  selectMode = !selectMode;
  selectModeBtn.textContent = selectMode ? 'Unselect' : 'Select';
  selectModeBtn.classList.toggle('active', selectMode);
  document.getElementById('history-gallery').classList.toggle('select-mode', selectMode);
  if (!selectMode) {
    // Leaving select mode clears any selection.
    selectedScreenshots.clear();
    document.querySelectorAll('.thumb.selected').forEach((t) => t.classList.remove('selected'));
    document.querySelectorAll('.thumb-check').forEach((cb) => { cb.checked = false; });
  }
};

function enterSelectModeIfNeeded() {
  if (!selectMode) {
    selectMode = true;
    selectModeBtn.textContent = 'Unselect';
    selectModeBtn.classList.add('active');
    document.getElementById('history-gallery').classList.add('select-mode');
  }
}

// ---- Confirmed actions ----
document.getElementById('delete-selected-btn').onclick = () => {
  if (selectedScreenshots.size === 0) return showAlert('No screenshots selected.');
  showConfirm(`Delete ${selectedScreenshots.size} selected screenshot(s)? This cannot be undone.`, async () => {
    await fetch(`${SERVER_URL}/api/screenshots/delete-many`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ ids: Array.from(selectedScreenshots) }),
    });
    logActivity(`deleted_${selectedScreenshots.size}_screenshots`, document.getElementById('device-select').value);
    selectedScreenshots.clear();
    loadHistory();
  });
};

async function setSelectedVisibility(hidden) {
  if (selectedScreenshots.size === 0) return showAlert('No screenshots selected.');
  const verb = hidden ? 'Hide' : 'Show';
  showConfirm(`${verb} ${selectedScreenshots.size} selected screenshot(s) ${hidden ? 'from' : 'to'} the team?`, async () => {
    await fetch(`${SERVER_URL}/api/screenshots/hide-many`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ ids: Array.from(selectedScreenshots), hidden }),
    });
    logActivity(`${hidden ? 'hid' : 'unhid'}_${selectedScreenshots.size}_screenshots_from_team`, document.getElementById('device-select').value);
    selectedScreenshots.clear();
    loadHistory();
  }, { danger: false });
}

document.getElementById('hide-selected-btn').onclick = () => setSelectedVisibility(true);
document.getElementById('unhide-selected-btn').onclick = () => setSelectedVisibility(false);

async function deleteOneScreenshot(id) {
  return new Promise((resolve) => {
    showConfirm('Delete this screenshot? This cannot be undone.', async () => {
      await fetch(`${SERVER_URL}/api/screenshots/${id}`, {
        method: 'DELETE',
        headers: { 'x-api-key': API_KEY },
      });
      logActivity('deleted_screenshot', document.getElementById('device-select').value);
      selectedScreenshots.delete(id);
      loadHistory();
      resolve(true);
    });
    // If user cancels, the promise never resolves — acceptable for this UI,
    // since the lightbox just stays open. We resolve false via the cancel hook.
    const origCancel = document.getElementById('confirm-popup-cancel').onclick;
    document.getElementById('confirm-popup-cancel').onclick = () => {
      closeConfirm();
      resolve(false);
      // restore the standard cancel handler
      document.getElementById('confirm-popup-cancel').onclick = origCancel;
    };
  });
}

async function toggleOneVisibility(id, hidden) {
  await fetch(`${SERVER_URL}/api/screenshots/${id}/visibility`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ hidden }),
  });
  logActivity(`${hidden ? 'hid' : 'unhid'}_screenshot_from_team`, document.getElementById('device-select').value);
  loadHistory();
}

// ---- Screenshot lightbox ----
const lightbox = document.getElementById('image-lightbox');
let currentShots = [];
let lightboxIndex = -1;
let historyColumns = Number(localStorage.getItem('historyColumns')) || 8;

document.getElementById('lightbox-close').onclick = () => { lightbox.style.display = 'none'; };
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.style.display = 'none'; };
document.getElementById('lightbox-prev').onclick = () => stepLightbox(-1);
document.getElementById('lightbox-next').onclick = () => stepLightbox(1);

// Keyboard arrows: no wrap-around.
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

  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  prevBtn.disabled = lightboxIndex === 0;
  nextBtn.disabled = lightboxIndex === currentShots.length - 1;

  const hideBtn = document.getElementById('lightbox-hide-btn');
  hideBtn.textContent = shot.hidden ? 'Show to Team' : 'Hide from Team';
  hideBtn.onclick = async () => {
    await toggleOneVisibility(shot.id, !shot.hidden);
    shot.hidden = !shot.hidden;
    hideBtn.textContent = shot.hidden ? 'Show to Team' : 'Hide from Team';
  };

  document.getElementById('lightbox-delete-btn').onclick = async () => {
    const deleted = await deleteOneScreenshot(shot.id);
    if (deleted) lightbox.style.display = 'none';
  };
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
  const res = await fetch(`${SERVER_URL}/api/screenshots/${deviceId}?limit=all`, {
    headers: { 'x-api-key': API_KEY },
  });
  const shots = await res.json();

  currentShots = shots.map((s) => ({
    id: s.id,
    url: `${SERVER_URL}/api/screenshot-image/${s.id}?apiKey=${API_KEY}`,
    capturedAt: s.captured_at,
    hidden: s.hidden_from_team,
  }));

  const gallery = document.getElementById('history-gallery');

  if (currentShots.length === 0) {
    gallery.innerHTML = '<p style="color:#94a3b8;">No screenshots yet for this device.</p>';
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
            <div class="thumb ${shot.hidden ? 'hidden-from-team' : ''} ${selectedScreenshots.has(shot.id) ? 'selected' : ''}" data-id="${shot.id}">
              ${shot.hidden ? '<span class="hidden-dot" title="Hidden from team"></span>' : ''}
              <input type="checkbox" class="thumb-check select-shot" data-id="${shot.id}" ${selectedScreenshots.has(shot.id) ? 'checked' : ''} />
              <img src="${shot.url}" loading="lazy" data-index="${flatIndex}" data-id="${shot.id}" />
            </div>`).join('')}
        </div>
      </div>`)
    .join('');

  // Reapply select-mode class after re-render.
  if (selectMode) gallery.classList.add('select-mode');

  gallery.querySelectorAll('img[data-index]').forEach((img) => {
    img.onclick = (e) => {
      const id = img.dataset.id;
      const thumb = img.closest('.thumb');
      // Ctrl/Cmd+click toggles selection and auto-enters select mode.
      if (e.ctrlKey || e.metaKey) {
        enterSelectModeIfNeeded();
        if (selectedScreenshots.has(id)) selectedScreenshots.delete(id);
        else selectedScreenshots.add(id);
        thumb.classList.toggle('selected', selectedScreenshots.has(id));
        thumb.querySelector('.select-shot').checked = selectedScreenshots.has(id);
      } else if (selectMode) {
        // In select mode, a normal click toggles selection instead of opening.
        if (selectedScreenshots.has(id)) selectedScreenshots.delete(id);
        else selectedScreenshots.add(id);
        thumb.classList.toggle('selected', selectedScreenshots.has(id));
        thumb.querySelector('.select-shot').checked = selectedScreenshots.has(id);
      } else {
        openLightbox(Number(img.dataset.index));
      }
    };
  });

  gallery.querySelectorAll('.select-shot').forEach((cb) => {
    cb.onchange = (e) => {
      if (e.target.checked) selectedScreenshots.add(cb.dataset.id);
      else selectedScreenshots.delete(cb.dataset.id);
      cb.closest('.thumb').classList.toggle('selected', e.target.checked);
    };
  });
}