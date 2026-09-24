// ---- Baked-in connection details (no manual entry needed) ----
// NOTE: since this is a static site with no backend of its own, anyone who
// opens browser dev tools can read these values regardless of the password
// screen below. Treat the password as a basic deterrent, not real security -
// don't share this URL publicly, and rotate the API key if you ever suspect
// it leaked.
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

// SHA-256 hash of the Super Admin password (not the password itself).
// This page (admin.html) only ever accepts this one password - Manager/
// Senior Manager passwords live separately in manager.js for index.html.
const PASSWORD_HASH = 'cf28d56f01623c011bf817b6cbc103fc0eff415f446ac1fb05baf76e633bb016';
const VIEWER_NAME = 'Founder (Super Admin)';
const VIEWER_ROLE = 'super_admin';
const TOTAL_POSSIBLE_VIEWERS = 3; // Founder + Manager + Senior Manager

let socket = null;
const peers = new Map(); // deviceId -> SimplePeer (screen)
const streams = new Map(); // deviceId -> MediaStream (screen)
const cameraPeers = new Map(); // deviceId -> SimplePeer (camera/mic)
const cameraStreams = new Map(); // deviceId -> MediaStream (camera/mic)
const selectedDevices = new Set();
let showAll = true;
let currentDeviceIds = [];
let deviceMeta = new Map(); // deviceId -> { employeeName, machineName }
let focusIndex = -1;

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
  setInterval(loadDeviceList, 15000); // keep employee-name labels fresh
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('live-tab').style.display = tab === 'live' ? 'block' : 'none';
    document.getElementById('history-tab').style.display = tab === 'history' ? 'block' : 'none';
    if (tab === 'history') loadDeviceList();
  };
});

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
  // If exactly one laptop is showing, go fullscreen on that video directly
  // (true F11-style fullscreen); otherwise fullscreen the whole grid so all
  // visible tiles fill the screen together.
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
      `${viewers.length}/${TOTAL_POSSIBLE_VIEWERS} viewing (${names})`;
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

function renderLiveGrid(deviceIds) {
  const grid = document.getElementById('live-grid');
  grid.innerHTML = '';
  const visible = showAll ? deviceIds : deviceIds.filter((id) => selectedDevices.has(id));

  if (visible.length === 0) {
    grid.innerHTML = '<p>No agents currently online (or none selected).</p>';
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
      ? '<span class="status-on">(Employee: Granted)</span>'
      : consent === 'declined'
      ? '<span class="status-off">(Employee: Declined)</span>'
      : '<span class="status-off">(Employee: Pending)</span>';
    const consentBlocksAccess = consent !== 'granted';

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label">
        <span><span class="dot online"></span>${labelFor(deviceId)}</span>
        <button class="rename-btn" type="button" style="padding:2px 8px;font-size:11px;">Rename</button>
      </div>
      <div class="device-settings-row">
        <span class="status-text">Live: <b class="${liveOn ? 'status-on' : 'status-off'}">${liveOn ? 'ON' : 'OFF'}</b></span>
        <button class="toggle-live-btn" type="button">${liveOn ? 'Turn Off' : 'Turn On'}</button>
        <span class="status-text">Shots: <b class="${shotsOn ? 'status-on' : 'status-off'}">${shotsOn ? 'ON' : 'OFF'}</b></span>
        <button class="toggle-shots-btn" type="button">${shotsOn ? 'Turn Off' : 'Turn On'}</button>
      </div>
      <div class="device-settings-row">
        <input type="number" class="interval-input" min="5" value="${interval}" title="Screenshot interval (seconds)" />
        <span class="status-text">sec interval</span>
        <button class="save-interval-btn" type="button">Set</button>
      </div>
      <div class="device-settings-row">
        <span class="status-text">Camera: <b class="${cameraOn ? 'status-on' : 'status-off'}">${cameraOn ? 'ON' : 'OFF'}</b></span>
        <button class="toggle-camera-btn" type="button" ${consentBlocksAccess ? 'disabled' : ''}>${cameraOn ? 'Turn Off' : 'Turn On'}</button>
        <span class="status-text">Mic: <b class="${micOn ? 'status-on' : 'status-off'}">${micOn ? 'ON' : 'OFF'}</b></span>
        <button class="toggle-mic-btn" type="button" ${consentBlocksAccess ? 'disabled' : ''}>${micOn ? 'Turn Off' : 'Turn On'}</button>
      </div>
      <div class="device-settings-row">
        <span class="status-text">${consentBadge}</span>
      </div>
      <div class="device-settings-row">
        <button class="view-camera-btn" type="button" ${(!cameraOn && !micOn) || consentBlocksAccess ? 'disabled title="Requires employee consent + admin permission"' : ''}>View Camera / Listen Mic</button>
      </div>
      <div class="device-settings-row">
        <span class="status-text">Remote Control: <b class="${remoteOn ? 'status-on' : 'status-off'}">${remoteOn ? 'ON' : 'OFF'}</b></span>
        <button class="toggle-remote-btn" type="button">${remoteOn ? 'Turn Off' : 'Turn On'}</button>
      </div>
      <div class="device-settings-row">
        <button class="start-remote-btn" type="button" ${!remoteOn ? 'disabled title="Turn Remote Control on first"' : ''}>Start Remote Control</button>
      </div>
      <div class="device-settings-row manager-visibility-row">
        <span class="status-text" style="width:100%;font-weight:600;">Manager Dashboard can see:</span>
      </div>
      <div class="device-settings-row manager-visibility-row">
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
    tile.querySelector('.toggle-live-btn').onclick = () => confirmToggle(deviceId, 'liveEnabled', liveOn, 'Live Monitoring');
    tile.querySelector('.toggle-shots-btn').onclick = () => confirmToggle(deviceId, 'screenshotEnabled', shotsOn, 'Screenshot Capture');
    tile.querySelector('.toggle-camera-btn').onclick = () => confirmToggle(deviceId, 'cameraEnabled', cameraOn, 'Camera Access');
    tile.querySelector('.toggle-mic-btn').onclick = () => confirmToggle(deviceId, 'micEnabled', micOn, 'Microphone Access');
    tile.querySelector('.toggle-remote-btn').onclick = () => confirmToggle(deviceId, 'remoteControlEnabled', remoteOn, 'Remote Control');
    tile.querySelector('.view-camera-btn').onclick = () => openCameraModal(deviceId);
    tile.querySelector('.start-remote-btn').onclick = () => openRemoteControlModal(deviceId);
    tile.querySelector('.mv-live').onchange = (e) => updateManagerVisibility(deviceId, 'live', e.target.checked);
    tile.querySelector('.mv-screenshot').onchange = (e) => updateManagerVisibility(deviceId, 'screenshot', e.target.checked);
    tile.querySelector('.mv-camera').onchange = (e) => updateManagerVisibility(deviceId, 'camera', e.target.checked);
    tile.querySelector('.mv-mic').onchange = (e) => updateManagerVisibility(deviceId, 'mic', e.target.checked);
    tile.querySelector('.mv-remote').onchange = (e) => updateManagerVisibility(deviceId, 'remoteControl', e.target.checked);
    tile.querySelector('.save-interval-btn').onclick = () => {
      const seconds = Number(tile.querySelector('.interval-input').value);
      if (!seconds || seconds < 5) return alert('Enter at least 5 seconds.');
      toggleDeviceSetting(deviceId, 'screenshotIntervalSeconds', seconds);
    };
    watchDevice(deviceId, video);
  });
}

async function toggleDeviceSetting(deviceId, key, value) {
  await fetch(`${SERVER_URL}/api/devices/${deviceId}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ [key]: value }),
  });
  await loadDeviceList();
  renderLiveGrid(currentDeviceIds);
}

async function updateManagerVisibility(deviceId, key, value) {
  await fetch(`${SERVER_URL}/api/devices/${deviceId}/manager-visibility`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ [key]: value }),
  });
  await loadDeviceList();
}

// ---- Confirm popup before turning a setting off/on ----
const confirmPopup = document.getElementById('confirm-popup');
let pendingConfirmAction = null;

function confirmToggle(deviceId, key, currentlyOn, label) {
  const action = currentlyOn ? 'Turn OFF' : 'Turn ON';
  document.getElementById('confirm-popup-text').textContent =
    `${action} ${label} for ${labelFor(deviceId)}?`;
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

async function renameDevice(deviceId) {
  const current = deviceMeta.get(deviceId)?.employeeName || '';
  const name = prompt('Employee name for this device:', current);
  if (name === null) return; // cancelled
  await fetch(`${SERVER_URL}/api/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ employeeName: name }),
  });
  await loadDeviceList();
  renderLiveGrid(currentDeviceIds);
}

function watchDevice(deviceId, videoEl) {
  if (peers.has(deviceId)) {
    if (streams.has(deviceId)) videoEl.srcObject = streams.get(deviceId);
    return;
  }

  const peer = new SimplePeer({ initiator: false, trickle: true });
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

  const peer = new SimplePeer({ initiator: false, trickle: true });
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
let remoteScreenSize = { width: 1920, height: 1080 }; // fallback until agent reports real size

document.getElementById('remote-close').onclick = closeRemoteControlModal;

function openRemoteControlModal(deviceId) {
  remoteControlDeviceId = deviceId;
  document.getElementById('remote-label').textContent = `${labelFor(deviceId)} — Remote Control`;

  const video = document.getElementById('remote-video');
  video.srcObject = streams.get(deviceId) || null; // reuse the screen stream if already watching
  remoteOverlay.style.display = 'flex';
  watchDevice(deviceId, video); // ensures the screen peer exists and feeds this video too

  socket.emit('remote:start', { deviceId });

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
  // Proportional scaling from the displayed video size to the laptop's
  // real screen resolution. Note: if the video letterboxes (aspect ratio
  // mismatch), clicks very near the edges may be slightly off - a known
  // limitation of this first version.
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

  if (currentDeviceIds.length) renderLiveGrid(currentDeviceIds); // refresh labels
  if (devices.length && document.getElementById('history-tab').style.display !== 'none') loadHistory();
}

const selectedScreenshots = new Set();

document.getElementById('delete-selected-btn').onclick = async () => {
  if (selectedScreenshots.size === 0) return alert('No screenshots selected.');
  if (!confirm(`Delete ${selectedScreenshots.size} selected screenshot(s)? This cannot be undone.`)) return;

  await fetch(`${SERVER_URL}/api/screenshots/delete-many`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ ids: Array.from(selectedScreenshots) }),
  });
  selectedScreenshots.clear();
  loadHistory();
};

async function deleteOneScreenshot(id) {
  if (!confirm('Delete this screenshot? This cannot be undone.')) return;
  await fetch(`${SERVER_URL}/api/screenshots/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': API_KEY },
  });
  selectedScreenshots.delete(id);
  loadHistory();
}

// ---- Screenshot lightbox (larger view of one stored screenshot, with Prev/Next) ----
const lightbox = document.getElementById('image-lightbox');
let currentShots = []; // [{ url, capturedAt }] for the currently loaded device
let lightboxIndex = -1;

document.getElementById('lightbox-close').onclick = () => { lightbox.style.display = 'none'; };
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.style.display = 'none'; };
document.getElementById('lightbox-prev').onclick = () => stepLightbox(-1);
document.getElementById('lightbox-next').onclick = () => stepLightbox(1);

function openLightbox(index) {
  lightboxIndex = index;
  renderLightbox();
  lightbox.style.display = 'flex';
}

function stepLightbox(delta) {
  if (currentShots.length === 0) return;
  lightboxIndex = (lightboxIndex + delta + currentShots.length) % currentShots.length;
  renderLightbox();
}

function renderLightbox() {
  const shot = currentShots[lightboxIndex];
  if (!shot) return;
  document.getElementById('lightbox-img').src = shot.url;
  document.getElementById('lightbox-caption').textContent = new Date(shot.capturedAt).toLocaleString();
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
    .map(
      (s, i) => `
      <div class="tile">
        <img src="${s.url}" loading="lazy" data-index="${i}" />
        <div class="tile-label"><span>${new Date(s.capturedAt).toLocaleString()}</span></div>
        <div class="history-tile-controls">
          <label><input type="checkbox" class="select-shot" data-id="${s.id}" ${selectedScreenshots.has(s.id) ? 'checked' : ''}/> Select</label>
          <button class="danger-btn del-one-btn" data-id="${s.id}" type="button">Delete</button>
        </div>
      </div>`
    )
    .join('');
  if (currentShots.length === 0) gallery.innerHTML = '<p>No screenshots yet for this device.</p>';

  gallery.querySelectorAll('img[data-index]').forEach((img) => {
    img.onclick = () => openLightbox(Number(img.dataset.index));
  });
  gallery.querySelectorAll('.select-shot').forEach((cb) => {
    cb.onchange = (e) => {
      if (e.target.checked) selectedScreenshots.add(cb.dataset.id);
      else selectedScreenshots.delete(cb.dataset.id);
    };
  });
  gallery.querySelectorAll('.del-one-btn').forEach((btn) => {
    btn.onclick = () => deleteOneScreenshot(btn.dataset.id);
  });
}
