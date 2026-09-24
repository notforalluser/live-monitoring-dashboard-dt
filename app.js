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

const DEFAULT_MV = { live: true, screenshot: true, camera: false, mic: false, remoteControl: false };

// ---- State ----
let socket = null;
const peers = new Map();         // deviceId -> SimplePeer (screen)
const streams = new Map();       // deviceId -> MediaStream (screen)
const cameraPeers = new Map();   // deviceId -> SimplePeer (camera/mic)
const cameraStreams = new Map(); // deviceId -> MediaStream (camera/mic)
const selectedDevices = new Set();
const collapsedTiles = new Set(); // tiles whose control panel is folded away
let showAll = true;
let currentDeviceIds = [];
let deviceMeta = new Map();      // deviceId -> { employeeName, machineName, ... }
let focusIndex = -1;
let lastGridSig = '';
let listErrorShown = false;

// ---- Small helpers ----
const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function toggleFullscreen(el) {
  if (fullscreenElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (request) request.call(el);
  }
}
function exitFullscreenIfAny() {
  if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
}

async function apiPut(path, body) {
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    toast('Could not save that change. Please try again.', 'error');
    return false;
  }
}

// ---- Password gate ----
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function showApp() {
  $('password-screen').style.display = 'none';
  $('app').style.display = 'block';
  startApp();
}

async function tryUnlock() {
  const input = $('password-input').value;
  const hash = await sha256Hex(input);
  if (hash === PASSWORD_HASH) {
    sessionStorage.setItem('unlocked', 'true');
    showApp();
  } else {
    $('password-error').style.display = 'block';
  }
}

$('password-submit').onclick = tryUnlock;
$('password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryUnlock();
});
$('logout-btn').onclick = () => {
  sessionStorage.removeItem('unlocked');
  location.reload();
};

// ---- App bootstrap ----
function startApp() {
  connectSocket();
  loadDeviceList();
  setInterval(loadDeviceList, 15000); // keep labels and settings fresh
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('live-tab').style.display = tab === 'live' ? 'block' : 'none';
    $('history-tab').style.display = tab === 'history' ? 'block' : 'none';
    if (tab === 'history') loadHistory();
  };
});

$('refresh-history').onclick = () => loadHistory();
$('device-select').onchange = () => loadHistory();

$('show-all-btn').onclick = () => {
  showAll = true;
  selectedDevices.clear();
  $('show-all-btn').classList.add('active');
  document.querySelectorAll('.check-chip').forEach((c) => {
    c.classList.remove('checked');
    c.querySelector('input').checked = false;
  });
  renderLiveGrid(currentDeviceIds);
};

// ---- Tile size controls ----
document.querySelectorAll('.size-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.size-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.documentElement.style.setProperty('--tile-size', `${btn.dataset.size}px`);
    if (btn.dataset.full === 'true') enterGridFullscreen();
  };
});

function enterGridFullscreen() {
  const grid = $('live-grid');
  const videos = grid.querySelectorAll('video');
  // Exactly one laptop showing: fullscreen that video. Otherwise fullscreen
  // the whole grid so all visible tiles fill the screen together.
  const target = videos.length === 1 ? videos[0] : grid;
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (request) request.call(target);
}

// ---- Names ----
function nameParts(deviceId) {
  const meta = deviceMeta.get(deviceId);
  const machine = meta?.machineName || deviceId.slice(0, 8);
  if (meta?.employeeName) return { primary: meta.employeeName, secondary: machine };
  return { primary: machine, secondary: '' };
}

function labelFor(deviceId) {
  const { primary, secondary } = nameParts(deviceId);
  return secondary ? `${primary} (${secondary})` : primary;
}

function visibleDeviceIds() {
  return showAll ? currentDeviceIds : currentDeviceIds.filter((id) => selectedDevices.has(id));
}

// ---- Stream plumbing ----
// Attaches a stream to every <video> that belongs to this device + kind
// (tile, focus popup, remote popup, ...), even after the grid re-renders.
function applyStream(kind, deviceId) {
  const stream = (kind === 'camera' ? cameraStreams : streams).get(deviceId);
  if (!stream) return;
  document.querySelectorAll('video[data-device]').forEach((v) => {
    if (v.dataset.device === deviceId && (v.dataset.kind || 'screen') === kind && v.srcObject !== stream) {
      v.srcObject = stream;
    }
  });
}

function watchDevice(deviceId) {
  if (peers.has(deviceId)) {
    applyStream('screen', deviceId);
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
    applyStream('screen', deviceId);
  });
  const cleanup = () => {
    if (peers.get(deviceId) === peer) { peers.delete(deviceId); streams.delete(deviceId); }
  };
  peer.on('close', cleanup);
  peer.on('error', cleanup);
  socket.emit('viewer:watch', { deviceId, kind: 'screen' });
}

function watchCameraDevice(deviceId) {
  if (cameraPeers.has(deviceId)) {
    applyStream('camera', deviceId);
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
    applyStream('camera', deviceId);
  });
  const cleanup = () => {
    if (cameraPeers.get(deviceId) === peer) { cameraPeers.delete(deviceId); cameraStreams.delete(deviceId); }
  };
  peer.on('close', cleanup);
  peer.on('error', cleanup);
  socket.emit('viewer:watch', { deviceId, kind: 'camera' });
}

// ---- Connection status ----
function setConnStatus(online) {
  const dot = $('conn-dot');
  dot.classList.toggle('online', online);
  dot.classList.toggle('offline', !online);
  $('conn-text').textContent = online ? 'Connected' : 'Disconnected';
}

// ---- Socket ----
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
    $('viewer-count').textContent = `${viewers.length}/${TOTAL_POSSIBLE_VIEWERS} viewing (${names})`;
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
    if (deviceId === remoteControlDeviceId) remoteScreenSize = { width, height };
  });
}

function renderChecklist(deviceIds) {
  const wrap = $('device-checklist');
  wrap.innerHTML = '';
  deviceIds.forEach((id) => {
    const chip = document.createElement('label');
    chip.className = 'check-chip' + (selectedDevices.has(id) ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" ${selectedDevices.has(id) ? 'checked' : ''}/> ${esc(labelFor(id))}`;
    chip.querySelector('input').onchange = (e) => {
      showAll = false;
      $('show-all-btn').classList.remove('active');
      if (e.target.checked) selectedDevices.add(id);
      else selectedDevices.delete(id);
      chip.classList.toggle('checked', e.target.checked);
      renderLiveGrid(currentDeviceIds);
    };
    wrap.appendChild(chip);
  });
}

// ---- Live grid ----
function gridSig(visible) {
  return JSON.stringify([visible, visible.map((id) => deviceMeta.get(id) || null)]);
}

// A switch (toggle). `cls` lets us find the input afterwards.
function switchHTML(cls, checked, { disabled = false, title = '', label = '' } = {}) {
  return `<label class="switch"${title ? ` title="${esc(title)}"` : ''}>
    <input type="checkbox" class="${cls}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(label)}" />
    <span class="slider"></span>
  </label>`;
}

function renderLiveGrid(deviceIds, force = false) {
  const visible = showAll ? deviceIds : deviceIds.filter((id) => selectedDevices.has(id));
  const sig = gridSig(visible);
  if (!force && sig === lastGridSig) return;
  lastGridSig = sig;

  const grid = $('live-grid');
  grid.innerHTML = '';

  if (visible.length === 0) {
    grid.innerHTML = `
      <div class="empty">
        <strong>No employees to show</strong>
        No agents are online right now, or none are selected above.
      </div>`;
    return;
  }

  visible.forEach((deviceId) => {
    const meta = deviceMeta.get(deviceId) || {};
    const { primary, secondary } = nameParts(deviceId);
    const liveOn = meta.liveEnabled !== false;
    const shotsOn = meta.screenshotEnabled !== false;
    const interval = meta.screenshotIntervalSeconds ?? 120;
    const cameraOn = meta.cameraEnabled === true;
    const micOn = meta.micEnabled === true;
    const remoteOn = meta.remoteControlEnabled === true;
    const mv = { ...DEFAULT_MV, ...(meta.managerVisibility || {}) };
    const consent = meta.cameraMicConsent || 'pending';
    const consentBlocksAccess = consent !== 'granted';
    const consentPill = consent === 'granted'
      ? '<span class="state-pill ok">Granted</span>'
      : consent === 'declined'
      ? '<span class="state-pill no">Declined</span>'
      : '<span class="state-pill wait">Pending</span>';
    const collapsed = collapsedTiles.has(deviceId);

    const tile = document.createElement('div');
    tile.className = 'tile' + (collapsed ? ' collapsed' : '');
    tile.innerHTML = `
      <div class="video-wrap loading">
        <video autoplay playsinline muted data-device="${esc(deviceId)}" data-kind="screen"></video>
        ${liveOn ? '<span class="live-badge">LIVE</span>' : ''}
        <button class="expand-btn" type="button">Expand</button>
      </div>

      <div class="tile-head">
        <div class="tile-title">
          <span class="dot online" title="Online"></span>
          <div class="tile-names">
            <strong title="${esc(primary)}">${esc(primary)}</strong>
            ${secondary ? `<small title="${esc(secondary)}">${esc(secondary)}</small>` : ''}
          </div>
        </div>
        <div class="tile-actions">
          <button class="rename-btn btn-ghost btn-sm" type="button">Rename</button>
          <button class="collapse-btn btn-ghost btn-sm" type="button" title="Show or hide controls" aria-label="Show or hide controls"><span class="chev">▾</span></button>
        </div>
      </div>

      <div class="tile-controls">
        <section class="ctl-section">
          <div class="ctl-title"><span class="step">1</span>Monitoring</div>
          <div class="ctl-row">
            <div class="ctl-label">Live monitoring<small>Stream this screen to viewers</small></div>
            ${switchHTML('sw-live', liveOn, { label: 'Live monitoring' })}
          </div>
          <div class="ctl-row">
            <div class="ctl-label">Screenshot capture<small>Save screenshots automatically</small></div>
            ${switchHTML('sw-shots', shotsOn, { label: 'Screenshot capture' })}
          </div>
          <div class="ctl-inline">
            <span class="ctl-label"><small>Capture every</small></span>
            <input type="number" class="interval-input" min="5" value="${esc(interval)}" aria-label="Screenshot interval in seconds" />
            <span class="ctl-label"><small>seconds</small></span>
            <button class="save-interval-btn btn-subtle btn-sm" type="button">Set</button>
          </div>
        </section>

        <section class="ctl-section">
          <div class="ctl-title"><span class="step">2</span>Camera and microphone</div>
          <div class="ctl-row">
            <div class="ctl-label">Employee consent<small>Required before camera or mic</small></div>
            ${consentPill}
          </div>
          <div class="ctl-row">
            <div class="ctl-label">Camera</div>
            ${switchHTML('sw-camera', cameraOn, { disabled: consentBlocksAccess, title: consentBlocksAccess ? 'Needs employee consent first' : '', label: 'Camera' })}
          </div>
          <div class="ctl-row">
            <div class="ctl-label">Microphone</div>
            ${switchHTML('sw-mic', micOn, { disabled: consentBlocksAccess, title: consentBlocksAccess ? 'Needs employee consent first' : '', label: 'Microphone' })}
          </div>
          <div class="ctl-actions">
            <button class="view-camera-btn btn-subtle" type="button" ${(!cameraOn && !micOn) || consentBlocksAccess ? 'disabled title="Needs employee consent and camera or mic switched on"' : ''}>View Camera / Listen Mic</button>
          </div>
        </section>

        <section class="ctl-section">
          <div class="ctl-title"><span class="step">3</span>Remote control</div>
          <div class="ctl-row">
            <div class="ctl-label">Allow remote control<small>Mouse and keyboard</small></div>
            ${switchHTML('sw-remote', remoteOn, { label: 'Remote control' })}
          </div>
          <div class="ctl-actions">
            <button class="start-remote-btn btn-subtle" type="button" ${!remoteOn ? 'disabled title="Turn remote control on first"' : ''}>Start Remote Control</button>
          </div>
        </section>

        <section class="ctl-section">
          <div class="ctl-title"><span class="step">4</span>Manager access</div>
          <small>Managers only see what you switch on here.</small>
          <div class="mv-grid">
            <div class="mv-check"><span>Live</span> ${switchHTML('mv-live', mv.live, { label: 'Manager can see live' })}</div>
            <div class="mv-check"><span>Screenshots</span> ${switchHTML('mv-screenshot', mv.screenshot, { label: 'Manager can see screenshots' })}</div>
            <div class="mv-check"><span>Camera</span> ${switchHTML('mv-camera', mv.camera, { label: 'Manager can see camera' })}</div>
            <div class="mv-check"><span>Mic</span> ${switchHTML('mv-mic', mv.mic, { label: 'Manager can hear mic' })}</div>
            <div class="mv-check"><span>Remote</span> ${switchHTML('mv-remote', mv.remoteControl, { label: 'Manager remote control' })}</div>
          </div>
        </section>
      </div>`;
    grid.appendChild(tile);

    const wrap = tile.querySelector('.video-wrap');
    const video = tile.querySelector('video');
    video.addEventListener('playing', () => wrap.classList.remove('loading'));
    video.onclick = () => openFocus(deviceId);
    tile.querySelector('.expand-btn').onclick = () => openFocus(deviceId);

    tile.querySelector('.rename-btn').onclick = () => renameDevice(deviceId);
    tile.querySelector('.collapse-btn').onclick = () => {
      const nowCollapsed = tile.classList.toggle('collapsed');
      if (nowCollapsed) collapsedTiles.add(deviceId); else collapsedTiles.delete(deviceId);
    };

    // Switches that need a confirmation first: block the instant flip, ask, then apply.
    const guarded = (selector, key, isOn, label) => {
      tile.querySelector(selector).onclick = (e) => {
        e.preventDefault();
        confirmToggle(deviceId, key, isOn, label);
      };
    };
    guarded('.sw-live', 'liveEnabled', liveOn, 'Live Monitoring');
    guarded('.sw-shots', 'screenshotEnabled', shotsOn, 'Screenshot Capture');
    guarded('.sw-camera', 'cameraEnabled', cameraOn, 'Camera Access');
    guarded('.sw-mic', 'micEnabled', micOn, 'Microphone Access');
    guarded('.sw-remote', 'remoteControlEnabled', remoteOn, 'Remote Control');

    tile.querySelector('.view-camera-btn').onclick = () => openCameraModal(deviceId);
    tile.querySelector('.start-remote-btn').onclick = () => openRemoteControlModal(deviceId);
    tile.querySelector('.save-interval-btn').onclick = () => {
      const seconds = Number(tile.querySelector('.interval-input').value);
      if (!seconds || seconds < 5) return toast('Enter at least 5 seconds.', 'error');
      toggleDeviceSetting(deviceId, 'screenshotIntervalSeconds', seconds, 'Screenshot interval saved');
    };

    // Manager access switches apply straight away.
    tile.querySelector('.mv-live').onchange = (e) => updateManagerVisibility(deviceId, 'live', e.target.checked);
    tile.querySelector('.mv-screenshot').onchange = (e) => updateManagerVisibility(deviceId, 'screenshot', e.target.checked);
    tile.querySelector('.mv-camera').onchange = (e) => updateManagerVisibility(deviceId, 'camera', e.target.checked);
    tile.querySelector('.mv-mic').onchange = (e) => updateManagerVisibility(deviceId, 'mic', e.target.checked);
    tile.querySelector('.mv-remote').onchange = (e) => updateManagerVisibility(deviceId, 'remoteControl', e.target.checked);

    watchDevice(deviceId);
  });
}

async function toggleDeviceSetting(deviceId, key, value, successMessage = 'Setting saved') {
  const ok = await apiPut(`/api/devices/${deviceId}/settings`, { [key]: value });
  if (ok) toast(successMessage, 'success');
  await loadDeviceList(true);
}

async function updateManagerVisibility(deviceId, key, value) {
  // Update locally first so the switch feels instant.
  const meta = deviceMeta.get(deviceId);
  if (meta) {
    meta.managerVisibility = { ...DEFAULT_MV, ...(meta.managerVisibility || {}), [key]: value };
    lastGridSig = gridSig(visibleDeviceIds());
  }
  const ok = await apiPut(`/api/devices/${deviceId}/manager-visibility`, { [key]: value });
  if (ok) toast('Manager access updated', 'success');
  await loadDeviceList(!ok); // if saving failed, re-render to put the switch back
}

// ---- Confirm popup before turning a setting off/on ----
const confirmPopup = $('confirm-popup');
let pendingConfirmAction = null;

function confirmToggle(deviceId, key, currentlyOn, label) {
  const action = currentlyOn ? 'Turn off' : 'Turn on';
  $('confirm-popup-text').textContent = `${action} ${label} for ${labelFor(deviceId)}?`;
  pendingConfirmAction = () => toggleDeviceSetting(deviceId, key, !currentlyOn, `${label} ${currentlyOn ? 'turned off' : 'turned on'}`);
  confirmPopup.style.display = 'flex';
}

$('confirm-popup-ok').onclick = () => {
  confirmPopup.style.display = 'none';
  if (pendingConfirmAction) pendingConfirmAction();
  pendingConfirmAction = null;
};
$('confirm-popup-cancel').onclick = () => {
  confirmPopup.style.display = 'none';
  pendingConfirmAction = null;
};

async function renameDevice(deviceId) {
  const current = deviceMeta.get(deviceId)?.employeeName || '';
  const name = prompt('Employee name for this device:', current);
  if (name === null) return; // cancelled
  const ok = await apiPut(`/api/devices/${deviceId}`, { employeeName: name });
  if (ok) toast('Name saved', 'success');
  await loadDeviceList(true);
  renderChecklist(currentDeviceIds);
}

// ---- Focus popup (slides across visible employees + full screen) ----
const focusOverlay = $('focus-overlay');
const focusModal = $('focus-modal');
const focusVideo = $('focus-video');

$('focus-close').onclick = closeFocus;
$('focus-prev').onclick = () => stepFocus(-1);
$('focus-next').onclick = () => stepFocus(1);
$('focus-fullscreen').onclick = () => toggleFullscreen(focusModal); // whole modal so Prev/Next stay usable
focusOverlay.addEventListener('click', (e) => { if (e.target === focusOverlay) closeFocus(); });

function openFocus(deviceId) {
  focusIndex = visibleDeviceIds().indexOf(deviceId);
  renderFocus();
  focusOverlay.style.display = 'flex';
}

function closeFocus() {
  exitFullscreenIfAny();
  focusOverlay.style.display = 'none';
  focusVideo.srcObject = null;
  delete focusVideo.dataset.device;
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
  $('focus-label').textContent = labelFor(deviceId);
  $('focus-counter').textContent = list.length > 1 ? `${focusIndex + 1} / ${list.length}` : '';
  $('focus-prev').style.display = list.length > 1 ? '' : 'none';
  $('focus-next').style.display = list.length > 1 ? '' : 'none';
  focusVideo.dataset.device = deviceId;
  focusVideo.srcObject = streams.get(deviceId) || null;
  watchDevice(deviceId);
}

// ---- Camera/mic viewing ----
const cameraOverlay = $('camera-overlay');
const cameraModal = $('camera-modal');
let activeCameraDeviceId = null;

$('camera-close').onclick = closeCameraModal;
$('camera-fullscreen').onclick = () => toggleFullscreen(cameraModal);
cameraOverlay.addEventListener('click', (e) => { if (e.target === cameraOverlay) closeCameraModal(); });

function openCameraModal(deviceId) {
  activeCameraDeviceId = deviceId;
  $('camera-label').textContent = labelFor(deviceId);
  const video = $('camera-video');
  video.dataset.device = deviceId;
  video.srcObject = cameraStreams.get(deviceId) || null;
  cameraOverlay.style.display = 'flex';
  watchCameraDevice(deviceId);
}

function closeCameraModal() {
  exitFullscreenIfAny();
  cameraOverlay.style.display = 'none';
  if (activeCameraDeviceId && cameraPeers.has(activeCameraDeviceId)) {
    const peer = cameraPeers.get(activeCameraDeviceId);
    cameraPeers.delete(activeCameraDeviceId);
    cameraStreams.delete(activeCameraDeviceId);
    try { peer.destroy(); } catch (e) { /* already closed */ }
  }
  $('camera-video').srcObject = null;
  activeCameraDeviceId = null;
}

// ---- Remote control (mouse/keyboard) ----
const remoteOverlay = $('remote-overlay');
const remoteModal = $('remote-modal');
const remoteStage = $('remote-stage');
const remoteVideo = $('remote-video');
let remoteControlDeviceId = null;
let remoteScreenSize = null; // real laptop resolution once the agent reports it

$('remote-close').onclick = closeRemoteControlModal;
$('remote-fullscreen').onclick = () => {
  toggleFullscreen(remoteModal); // fullscreen the modal so the whole remote screen fills the display
  remoteStage.focus();
};
remoteVideo.addEventListener('playing', () => { $('remote-loading').hidden = true; });

function openRemoteControlModal(deviceId) {
  remoteControlDeviceId = deviceId;
  remoteScreenSize = null;
  $('remote-label').textContent = labelFor(deviceId);

  remoteVideo.dataset.device = deviceId;
  remoteVideo.srcObject = streams.get(deviceId) || null; // reuse the screen stream if we already have it
  $('remote-loading').hidden = !!remoteVideo.srcObject && remoteVideo.readyState >= 2 && !remoteVideo.paused;
  remoteOverlay.style.display = 'flex';
  watchDevice(deviceId);

  socket.emit('remote:start', { deviceId });

  remoteVideo.onclick = (e) => sendRemoteClick(e, 'left');
  remoteVideo.oncontextmenu = (e) => {
    e.preventDefault();
    sendRemoteClick(e, 'right');
  };
  document.addEventListener('keydown', onRemoteKeyDown);
  remoteStage.focus();
}

function closeRemoteControlModal() {
  exitFullscreenIfAny();
  remoteOverlay.style.display = 'none';
  if (remoteControlDeviceId) socket.emit('remote:stop', { deviceId: remoteControlDeviceId });
  document.removeEventListener('keydown', onRemoteKeyDown);
  remoteVideo.srcObject = null;
  delete remoteVideo.dataset.device;
  remoteControlDeviceId = null;
}

// The video is letterboxed inside its box (object-fit: contain), so work out
// where the real picture sits and map clicks against that area only.
function videoContentRect(video) {
  const box = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return box;
  const scale = Math.min(box.width / vw, box.height / vh);
  const width = vw * scale;
  const height = vh * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

function sendRemoteClick(e, button) {
  if (!remoteControlDeviceId) return;
  const rect = videoContentRect(remoteVideo);
  const inside = e.clientX >= rect.left && e.clientX <= rect.left + rect.width
    && e.clientY >= rect.top && e.clientY <= rect.top + rect.height;
  if (!inside) return; // clicked the black bars, not the laptop screen

  const screen = remoteScreenSize || {
    width: remoteVideo.videoWidth || 1920,
    height: remoteVideo.videoHeight || 1080,
  };
  const x = ((e.clientX - rect.left) / rect.width) * screen.width;
  const y = ((e.clientY - rect.top) / rect.height) * screen.height;
  socket.emit('remote:input', { deviceId: remoteControlDeviceId, input: { type: 'click', x, y, button } });

  // Small ripple so the click feels acknowledged.
  const stageBox = remoteStage.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.left = `${e.clientX - stageBox.left}px`;
  ripple.style.top = `${e.clientY - stageBox.top}px`;
  remoteStage.appendChild(ripple);
  setTimeout(() => ripple.remove(), 650);
}

const KEY_MAP = {
  Enter: '{ENTER}', Backspace: '{BACKSPACE}', Tab: '{TAB}', Escape: '{ESC}',
  ArrowLeft: '{LEFT}', ArrowRight: '{RIGHT}', ArrowUp: '{UP}', ArrowDown: '{DOWN}',
  Delete: '{DELETE}', Home: '{HOME}', End: '{END}', PageUp: '{PGUP}', PageDown: '{PGDN}',
};

function onRemoteKeyDown(e) {
  if (!remoteControlDeviceId) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
  e.preventDefault();
  const text = KEY_MAP[e.key] || (e.key.length === 1 ? e.key : null);
  if (text) {
    socket.emit('remote:input', { deviceId: remoteControlDeviceId, input: { type: 'key', text } });
  }
}

// ---- Full screen button labels ----
function onFullscreenChange() {
  const current = fullscreenElement();
  $('focus-fullscreen').textContent = current === focusModal ? 'Exit full screen' : 'Full screen';
  $('remote-fullscreen').textContent = current === remoteModal ? 'Exit full screen' : 'Full screen';
  $('camera-fullscreen').textContent = current === cameraModal ? 'Exit full screen' : 'Full screen';
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// ---- Device list ----
async function loadDeviceList(force = false) {
  let devices;
  try {
    const res = await fetch(`${SERVER_URL}/api/devices`, { headers: { 'x-api-key': API_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    devices = await res.json();
    listErrorShown = false;
  } catch (err) {
    if (!listErrorShown) toast('Could not refresh the device list. Retrying automatically.', 'error');
    listErrorShown = true;
    return;
  }

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

  const select = $('device-select');
  const previousValue = select.value;
  select.innerHTML = devices
    .map((d) => `<option value="${esc(d.device_id)}">${esc(d.employee_name || d.machine_name || d.device_id.slice(0, 8))}</option>`)
    .join('');
  if (devices.some((d) => d.device_id === previousValue)) select.value = previousValue;

  if (currentDeviceIds.length) renderLiveGrid(currentDeviceIds, force); // refresh labels/settings only if changed
  if (devices.length && $('history-tab').style.display !== 'none') loadHistory();
}

// ---- Screenshot history ----
const selectedScreenshots = new Set();

$('delete-selected-btn').onclick = async () => {
  if (selectedScreenshots.size === 0) return toast('No screenshots selected.');
  if (!confirm(`Delete ${selectedScreenshots.size} selected screenshot(s)? This cannot be undone.`)) return;

  try {
    const res = await fetch(`${SERVER_URL}/api/screenshots/delete-many`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ ids: Array.from(selectedScreenshots) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('Screenshots deleted', 'success');
  } catch (err) {
    toast('Could not delete the selected screenshots.', 'error');
    return;
  }
  selectedScreenshots.clear();
  loadHistory();
};

async function deleteOneScreenshot(id) {
  if (!confirm('Delete this screenshot? This cannot be undone.')) return;
  try {
    const res = await fetch(`${SERVER_URL}/api/screenshots/${id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': API_KEY },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('Screenshot deleted', 'success');
  } catch (err) {
    toast('Could not delete that screenshot.', 'error');
    return;
  }
  selectedScreenshots.delete(id);
  loadHistory();
}

// ---- Screenshot lightbox (larger view of one stored screenshot, with Prev/Next) ----
const lightbox = $('image-lightbox');
let currentShots = []; // [{ id, url, capturedAt }] for the currently loaded device
let lightboxIndex = -1;

$('lightbox-close').onclick = () => { lightbox.style.display = 'none'; };
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.style.display = 'none'; };
$('lightbox-prev').onclick = () => stepLightbox(-1);
$('lightbox-next').onclick = () => stepLightbox(1);

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
  $('lightbox-img').src = shot.url;
  $('lightbox-caption').textContent = `${new Date(shot.capturedAt).toLocaleString()}  ·  ${lightboxIndex + 1} / ${currentShots.length}`;
}

// Keyboard shortcuts for popups
document.addEventListener('keydown', (e) => {
  if (remoteControlDeviceId) return; // keys belong to the remote laptop while controlling it
  if (focusOverlay.style.display !== 'none') {
    if (e.key === 'ArrowLeft') stepFocus(-1);
    else if (e.key === 'ArrowRight') stepFocus(1);
    else if (e.key === 'Escape' && !fullscreenElement()) closeFocus();
  } else if (lightbox.style.display !== 'none') {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === 'Escape') lightbox.style.display = 'none';
  } else if (cameraOverlay.style.display !== 'none' && e.key === 'Escape' && !fullscreenElement()) {
    closeCameraModal();
  }
});

async function loadHistory() {
  const deviceId = $('device-select').value;
  if (!deviceId) return;
  let shots;
  try {
    const res = await fetch(`${SERVER_URL}/api/screenshots/${deviceId}?limit=60`, {
      headers: { 'x-api-key': API_KEY },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    shots = await res.json();
  } catch (err) {
    toast('Could not load screenshots.', 'error');
    return;
  }

  currentShots = shots.map((s) => ({
    id: s.id,
    url: `${SERVER_URL}/api/screenshot-image/${s.id}?apiKey=${API_KEY}`,
    capturedAt: s.captured_at,
  }));

  const gallery = $('history-gallery');
  if (currentShots.length === 0) {
    gallery.innerHTML = '<div class="empty"><strong>No screenshots yet</strong>Nothing has been captured for this device.</div>';
    return;
  }
  gallery.innerHTML = currentShots
    .map((s, i) => `
      <div class="tile">
        <img src="${esc(s.url)}" loading="lazy" data-index="${i}" alt="Screenshot" />
        <div class="tile-label"><span>${esc(new Date(s.capturedAt).toLocaleString())}</span></div>
        <div class="history-tile-controls">
          <label><input type="checkbox" class="select-shot" data-id="${esc(s.id)}" ${selectedScreenshots.has(String(s.id)) ? 'checked' : ''}/> Select</label>
          <button class="danger-btn del-one-btn" data-id="${esc(s.id)}" type="button">Delete</button>
        </div>
      </div>`)
    .join('');

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

// ---- Bootstrap (kept at the bottom so everything above is initialised) ----
if (sessionStorage.getItem('unlocked') === 'true') showApp();