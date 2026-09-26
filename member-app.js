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
let liveGroup = 'standard';
// History tab no longer has a sub-nav — always show granted-access devices.
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

// History sub-nav removed — no [data-hgroup] handlers needed.

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
  const filtered = allIds.filter((id) => hasScreenshotAccess(id));

  const select = document.getElementById('device-select');
  const wrap = document.getElementById('history-controls-wrap');
  const gallery = document.getElementById('history-gallery');

  wrap.style.display = 'flex';
  const previousValue = select.value;
  select.innerHTML = filtered.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join('');
  if (filtered.includes(previousValue)) select.value = previousValue;
  if (filtered.length) loadHistory();
  else gallery.innerHTML = '<p>No employees with screenshot access shared yet.</p>';
}

const lightbox = document.getElementById('image-lightbox');
let currentShots = [];
let lightboxIndex = -1;
let historyColumns = Number(localStorage.getItem('historyColumns')) || 8;

document.getElementById('lightbox-close').onclick = () => { lightbox.style.display = 'none'; };
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.style.display = 'none'; };
document.getElementById('lightbox-prev').onclick = () => stepLightbox(-1);
document.getElementById('lightbox-next').onclick = () => stepLightbox(1);

// Keyboard arrows respect boundaries (no wrap-around).
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
  // Clamp — do NOT wrap around. First image blocks Prev, last blocks Next.
  if (next < 0 || next >= currentShots.length) return;
  lightboxIndex = next;
  renderLightbox();
}

function renderLightbox() {
  const shot = currentShots[lightboxIndex];
  if (!shot) return;
  document.getElementById('lightbox-img').src = shot.url;
  document.getElementById('lightbox-caption').textContent = new Date(shot.capturedAt).toLocaleString();

  // Disable arrows at the boundaries so it's obvious there's no loop.
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');
  prevBtn.disabled = lightboxIndex === 0;
  nextBtn.disabled = lightboxIndex === currentShots.length - 1;
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