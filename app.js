// ---- Baked-in connection details (no manual entry needed) ----
// NOTE: since this is a static site with no backend of its own, anyone who
// opens browser dev tools can read these values regardless of the password
// screen below. Treat the password as a basic deterrent, not real security -
// don't share this URL publicly, and rotate the API key if you ever suspect
// it leaked.
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

// SHA-256 hash of the dashboard password (not the password itself).
const PASSWORD_HASH = 'cf28d56f01623c011bf817b6cbc103fc0eff415f446ac1fb05baf76e633bb016';

let socket = null;
const peers = new Map(); // deviceId -> SimplePeer
const streams = new Map(); // deviceId -> MediaStream
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
  };
});

// ---- Focus overlay ----
const overlay = document.getElementById('focus-overlay');
document.getElementById('focus-close').onclick = closeFocus;
document.getElementById('focus-prev').onclick = () => stepFocus(-1);
document.getElementById('focus-next').onclick = () => stepFocus(1);

function visibleDeviceIds() {
  return showAll ? currentDeviceIds : currentDeviceIds.filter((id) => selectedDevices.has(id));
}

function labelFor(deviceId) {
  const meta = deviceMeta.get(deviceId);
  if (meta?.employeeName) return meta.employeeName;
  if (meta?.machineName) return meta.machineName;
  return deviceId.slice(0, 8);
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

  socket.on('connect', () => setConnStatus(true));
  socket.on('disconnect', () => setConnStatus(false));
  socket.on('connect_error', () => setConnStatus(false));

  socket.on('devices:update', (deviceIds) => {
    currentDeviceIds = deviceIds;
    renderChecklist(deviceIds);
    renderLiveGrid(deviceIds);
  });

  socket.on('signal', ({ from, data, deviceId }) => {
    const peer = peers.get(deviceId);
    if (!peer) return;
    peer.fromId = peer.fromId || from;
    peer.signal(data);
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
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label">
        <span><span class="dot online"></span>${labelFor(deviceId)}</span>
        <button class="rename-btn" type="button" style="padding:2px 8px;font-size:11px;">Rename</button>
      </div>`;
    grid.appendChild(tile);

    const video = tile.querySelector('video');
    video.onclick = () => openFocus(deviceId);
    tile.querySelector('.rename-btn').onclick = () => renameDevice(deviceId);
    watchDevice(deviceId, video);
  });
}

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
    socket.emit('signal', { to: peer.fromId, data, deviceId });
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

  socket.emit('viewer:watch', { deviceId });
}

// ---- History ----
async function loadDeviceList() {
  const res = await fetch(`${SERVER_URL}/api/devices`, { headers: { 'x-api-key': API_KEY } });
  const devices = await res.json();

  deviceMeta = new Map(devices.map((d) => [d.device_id, { employeeName: d.employee_name, machineName: d.machine_name }]));

  const select = document.getElementById('device-select');
  const previousValue = select.value;
  select.innerHTML = devices
    .map((d) => `<option value="${d.device_id}">${d.employee_name || d.machine_name || d.device_id.slice(0, 8)}</option>`)
    .join('');
  if (devices.some((d) => d.device_id === previousValue)) select.value = previousValue;

  if (currentDeviceIds.length) renderLiveGrid(currentDeviceIds); // refresh labels
  if (devices.length && document.getElementById('history-tab').style.display !== 'none') loadHistory();
}

async function loadHistory() {
  const deviceId = document.getElementById('device-select').value;
  if (!deviceId) return;
  const res = await fetch(`${SERVER_URL}/api/screenshots/${deviceId}?limit=60`, {
    headers: { 'x-api-key': API_KEY },
  });
  const shots = await res.json();
  const gallery = document.getElementById('history-gallery');
  gallery.innerHTML = shots
    .map(
      (s) => `
      <div class="tile">
        <img src="${SERVER_URL}/api/screenshot-image/${s.id}?apiKey=${API_KEY}" loading="lazy" />
        <div class="tile-label"><span>${new Date(s.captured_at).toLocaleString()}</span></div>
      </div>`
    )
    .join('');
  if (shots.length === 0) gallery.innerHTML = '<p>No screenshots yet for this device.</p>';
}