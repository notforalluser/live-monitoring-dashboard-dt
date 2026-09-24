// ---- Same connection details as the Super Admin dashboard ----
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

// Two accepted passwords for this page - Super Admin's password is NOT
// accepted here, only on admin.html. Change these via app.js's password
// generator pattern if you want different ones.
const ROLE_HASHES = [
  { hash: 'f85c65161bd472e5f2decbc110209f2e98448f8a17bbadeda59c17ab8450370d', role: 'manager', name: 'Manager' },
  { hash: '78977ea8acbae6c90e578d7ccf616ac52a2021bd0e4b368b4111989ff624121a', role: 'senior_manager', name: 'Senior Manager' },
];
const TOTAL_POSSIBLE_VIEWERS = 3; // Founder + Manager + Senior Manager

let socket = null;
let myRole = null;
let myName = null;
const peers = new Map(); // deviceId -> SimplePeer (screen)
const streams = new Map(); // deviceId -> MediaStream (screen)
const cameraPeers = new Map();
const cameraStreams = new Map();
let deviceMeta = new Map(); // deviceId -> full device object
let currentDeviceIds = []; // online device IDs
let liveGroup = 'granted'; // 'granted' | 'standard'
let historyGroup = 'granted'; // 'granted' | 'none'

// ---- Password gate ----
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tryUnlock() {
  const input = document.getElementById('password-input').value;
  const hash = await sha256Hex(input);
  const match = ROLE_HASHES.find((r) => r.hash === hash);
  if (match) {
    myRole = match.role;
    myName = match.name;
    sessionStorage.setItem('unlockedRole', myRole);
    sessionStorage.setItem('unlockedName', myName);
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

if (sessionStorage.getItem('unlockedRole')) {
  myRole = sessionStorage.getItem('unlockedRole');
  myName = sessionStorage.getItem('unlockedName');
  document.getElementById('password-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  startApp();
}

function startApp() {
  connectSocket();
  loadDeviceList();
  setInterval(loadDeviceList, 15000);
}

// ---- Tabs ----
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

// ---- Socket ----
function connectSocket() {
  socket = io(SERVER_URL, { auth: { apiKey: API_KEY } });

  socket.on('connect', () => {
    setConnStatus(true);
    socket.emit('viewer:identify', { role: myRole, name: myName });
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
    renderLiveGrid();
  });

  socket.on('signal', ({ from, data, deviceId, kind }) => {
    const map = kind === 'camera' ? cameraPeers : peers;
    const peer = map.get(deviceId);
    if (!peer) return;
    peer.fromId = peer.fromId || from;
    peer.signal(data);
  });
}

// ---- Device list (with manager_visibility permissions from Super Admin) ----
async function loadDeviceList() {
  const res = await fetch(`${SERVER_URL}/api/devices`, { headers: { 'x-api-key': API_KEY } });
  const devices = await res.json();
  deviceMeta = new Map(devices.map((d) => [d.device_id, d]));
  renderLiveGrid();
  populateDeviceSelect();
}

function hasCameraOrMicAccess(deviceId) {
  const mv = deviceMeta.get(deviceId)?.manager_visibility;
  return !!(mv?.camera || mv?.mic);
}

// ---- Live View ----
function renderLiveGrid() {
  const grid = document.getElementById('live-grid');
  grid.innerHTML = '';

  const filtered = currentDeviceIds.filter((id) =>
    liveGroup === 'granted' ? hasCameraOrMicAccess(id) : !hasCameraOrMicAccess(id)
  );

  if (filtered.length === 0) {
    grid.innerHTML = '<p>No employees in this category right now.</p>';
    return;
  }

  filtered.forEach((deviceId) => {
    const d = deviceMeta.get(deviceId) || {};
    const mv = d.manager_visibility || {};
    const tile = document.createElement('div');
    tile.className = 'tile';

    if (!mv.live) {
      tile.innerHTML = `
        <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:#f4f6f9;color:#9ca3af;font-size:13px;">
          Live monitoring not shared with you for this employee
        </div>
        <div class="tile-label"><span>${labelFor(deviceId)}</span></div>`;
      grid.appendChild(tile);
      return;
    }

    const canViewCamera = hasCameraOrMicAccess(deviceId) && (d.camera_enabled || d.mic_enabled);
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label"><span><span class="dot online"></span>${labelFor(deviceId)}</span></div>
      <div class="device-settings-row">
        <button class="view-camera-btn" type="button" ${!canViewCamera ? 'disabled title="Not enabled/shared for this employee"' : ''}>View Camera / Listen Mic</button>
      </div>`;
    grid.appendChild(tile);

    const video = tile.querySelector('video');
    watchDevice(deviceId, video);
    tile.querySelector('.view-camera-btn').onclick = () => openCameraModal(deviceId);
  });
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
  });
  peer.on('close', () => { peers.delete(deviceId); streams.delete(deviceId); });
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
    if (activeCameraDeviceId === deviceId) document.getElementById('camera-video').srcObject = stream;
  });
  peer.on('close', () => { cameraPeers.delete(deviceId); cameraStreams.delete(deviceId); });
  socket.emit('viewer:watch', { deviceId, kind: 'camera' });
}

// ---- Screenshot History (view-only - no delete for managers) ----
function hasScreenshotAccess(deviceId) {
  return deviceMeta.get(deviceId)?.manager_visibility?.screenshot !== false;
}

function populateDeviceSelect() {
  renderHistoryGroup();
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

// ---- Lightbox ----
const lightbox = document.getElementById('image-lightbox');
let currentShots = [];
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
    .map((s, i) => `
      <div class="tile">
        <img src="${s.url}" loading="lazy" data-index="${i}" />
        <div class="tile-label"><span>${new Date(s.capturedAt).toLocaleString()}</span></div>
      </div>`)
    .join('');
  if (currentShots.length === 0) gallery.innerHTML = '<p>No screenshots yet for this device.</p>';
  gallery.querySelectorAll('img[data-index]').forEach((img) => {
    img.onclick = () => openLightbox(Number(img.dataset.index));
  });
}
