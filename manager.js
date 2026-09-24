// ---- Same connection details as the Super Admin dashboard ----
const SERVER_URL = 'https://live-capturing-d-ser.onrender.com';
const API_KEY = '10e9b1c47f0a3cc6bde4cac621c4640444c4772ca37c8fac88c9f1fab467bcf2';

// Two accepted passwords for this page - Super Admin's password is NOT
// accepted here, only on admin.html.
const ROLE_HASHES = [
  { hash: 'f85c65161bd472e5f2decbc110209f2e98448f8a17bbadeda59c17ab8450370d', role: 'manager', name: 'Manager' },
  { hash: '78977ea8acbae6c90e578d7ccf616ac52a2021bd0e4b368b4111989ff624121a', role: 'senior_manager', name: 'Senior Manager' },
];
const TOTAL_POSSIBLE_VIEWERS = 3; // Founder + Manager + Senior Manager

// What a manager may see when the admin has not saved any explicit settings.
// Matches the defaults used on the Super Admin dashboard.
const DEFAULT_VISIBILITY = { live: true, screenshot: true, camera: false, mic: false, remoteControl: false };

// ---- State ----
let socket = null;
let myRole = null;
let myName = null;
const peers = new Map();         // deviceId -> SimplePeer (screen)
const streams = new Map();       // deviceId -> MediaStream (screen)
const cameraPeers = new Map();   // deviceId -> SimplePeer (camera/mic)
const cameraStreams = new Map(); // deviceId -> MediaStream (camera/mic)
let deviceMeta = new Map();      // deviceId -> full device object from the server
let currentDeviceIds = [];       // online device IDs
let liveGroup = 'standard';      // 'standard' (default, shown first) | 'granted'
let historyGroup = 'granted';    // 'granted' | 'none'
let lastGridSig = '';
let lastHistorySig = '';
let lastOptionsSig = '';
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

// ---- Password gate ----
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function showApp() {
  $('password-screen').style.display = 'none';
  $('app').style.display = 'block';
  $('user-chip').textContent = `Signed in`;
  startApp();
}

async function tryUnlock() {
  const input = $('password-input').value;
  const hash = await sha256Hex(input);
  const match = ROLE_HASHES.find((r) => r.hash === hash);
  if (match) {
    myRole = match.role;
    myName = match.name;
    sessionStorage.setItem('unlockedRole', myRole);
    sessionStorage.setItem('unlockedName', myName);
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
  sessionStorage.removeItem('unlockedRole');
  sessionStorage.removeItem('unlockedName');
  location.reload();
};

function startApp() {
  connectSocket();
  loadDeviceList(true);
  setInterval(() => loadDeviceList(false), 15000);
}

// ---- Tabs ----
function historyTabVisible() {
  return $('history-tab').style.display !== 'none';
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('live-tab').style.display = tab === 'live' ? 'block' : 'none';
    $('history-tab').style.display = tab === 'history' ? 'block' : 'none';
    if (tab === 'history') renderHistoryGroup({ reload: true });
  };
});

document.querySelectorAll('[data-group]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-group]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    liveGroup = btn.dataset.group;
    renderLiveGrid(true);
  };
});

document.querySelectorAll('[data-hgroup]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-hgroup]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    historyGroup = btn.dataset.hgroup;
    renderHistoryGroup({ reload: true });
  };
});

$('refresh-history').onclick = () => loadHistory(true);
$('device-select').onchange = () => loadHistory(true);

// ---- Device names & access ----
function nameParts(deviceId) {
  const meta = deviceMeta.get(deviceId);
  const machine = meta?.machine_name || deviceId.slice(0, 8);
  if (meta?.employee_name) return { primary: meta.employee_name, secondary: machine };
  return { primary: machine, secondary: '' };
}

function labelFor(deviceId) {
  const { primary, secondary } = nameParts(deviceId);
  return secondary ? `${primary} (${secondary})` : primary;
}

// What the admin has shared with managers for this device.
function access(deviceId) {
  const mv = { ...DEFAULT_VISIBILITY, ...(deviceMeta.get(deviceId)?.manager_visibility || {}) };
  return {
    live: !!mv.live,
    screenshot: mv.screenshot !== false,
    camera: !!mv.camera,
    mic: !!mv.mic,
  };
}

function hasCameraOrMicAccess(deviceId) {
  const a = access(deviceId);
  return a.camera || a.mic;
}

// The camera/mic button is only useful when the admin granted access AND
// the matching input is switched on for that employee.
function canViewCamera(deviceId) {
  const a = access(deviceId);
  const d = deviceMeta.get(deviceId) || {};
  return (a.camera && !!d.camera_enabled) || (a.mic && !!d.mic_enabled);
}

function inLiveGroup(deviceId) {
  return liveGroup === 'granted' ? hasCameraOrMicAccess(deviceId) : !hasCameraOrMicAccess(deviceId);
}

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
    socket.emit('viewer:identify', { role: myRole, name: myName });
  });
  socket.on('disconnect', () => setConnStatus(false));
  socket.on('connect_error', () => setConnStatus(false));

  socket.on('viewers:update', (viewers) => {
    const names = viewers.map((v) => v.name).join(', ') || 'none';
    $('viewer-count').textContent = `${viewers.length - 1} viewing`;
  });

  socket.on('devices:update', (deviceIds) => {
    currentDeviceIds = deviceIds;
    // Drop connections for devices that went offline.
    [peers, cameraPeers].forEach((map) => {
      Array.from(map.keys()).forEach((id) => {
        if (!deviceIds.includes(id)) {
          try { map.get(id).destroy(); } catch (e) { /* already closed */ }
          map.delete(id);
        }
      });
    });
    renderLiveGrid(true);
  });

  socket.on('signal', ({ from, data, deviceId, kind }) => {
    const map = kind === 'camera' ? cameraPeers : peers;
    const peer = map.get(deviceId);
    if (!peer) return;
    peer.fromId = peer.fromId || from;
    peer.signal(data);
  });
}

// ---- Device list (includes manager_visibility permissions from Super Admin) ----
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
  deviceMeta = new Map(devices.map((d) => [d.device_id, d]));
  renderLiveGrid(force);
  renderHistoryGroup({ reload: historyTabVisible() });
}

// ---- Stream plumbing ----
// Attaches a stream to every <video> that belongs to this device + kind
// (tile, popup, ...). Works even if the grid was re-rendered meanwhile.
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

function stopCamera(deviceId) {
  const peer = cameraPeers.get(deviceId);
  cameraPeers.delete(deviceId);
  cameraStreams.delete(deviceId);
  if (peer) { try { peer.destroy(); } catch (e) { /* already closed */ } }
}

// ---- Live View ----
function renderLiveGrid(force = false) {
  const standardIds = currentDeviceIds.filter((id) => !hasCameraOrMicAccess(id));
  const grantedIds = currentDeviceIds.filter((id) => hasCameraOrMicAccess(id));
  $('count-standard').textContent = standardIds.length;
  $('count-granted').textContent = grantedIds.length;

  const ids = liveGroup === 'granted' ? grantedIds : standardIds;
  const sig = JSON.stringify([liveGroup, ids.map((id) => [id, deviceMeta.get(id) || null])]);
  if (!force && sig === lastGridSig) {
    refreshViewer();
    return;
  }
  lastGridSig = sig;

  const grid = $('live-grid');
  grid.innerHTML = '';

  if (ids.length === 0) {
    grid.innerHTML = `
      <div class="empty">
        <strong>No anyone online in this group</strong>
        ${liveGroup === 'granted'
          ? ''
          : ''}
      </div>`;
    refreshViewer();
    return;
  }

  ids.forEach((deviceId) => {
    const a = access(deviceId);
    const { primary, secondary } = nameParts(deviceId);
    const showCameraButton = a.camera || a.mic;
    const cameraReady = canViewCamera(deviceId);

    const tile = document.createElement('div');
    tile.className = 'tile';

    const screenBlock = a.live
      ? `<div class="video-wrap loading">
           <video autoplay playsinline muted data-device="${esc(deviceId)}" data-kind="screen"></video>
           <span class="live-badge">LIVE</span>
           <button class="expand-btn" type="button">Expand</button>
         </div>`
      : `<div class="locked-view">
           <strong>Live view not shared</strong>
           <span>The admin has not shared this employee's screen with you.</span>
         </div>`;

    tile.innerHTML = `
      ${screenBlock}
      <div class="tile-head">
        <div class="tile-title">
          <span class="dot online" title="Online"></span>
          <div class="tile-names">
            <strong title="${esc(primary)}">${esc(primary)}</strong>
            ${secondary ? `<small title="${esc(secondary)}">${esc(secondary)}</small>` : ''}
          </div>
        </div>
      </div>
      ${showCameraButton ? `
        <div class="tile-foot">
          <button class="view-camera-btn" type="button" ${cameraReady ? '' : 'disabled title="Camera/mic is switched off for this employee right now"'}>
            View Camera / Listen Mic
          </button>
        </div>` : ''}`;
    grid.appendChild(tile);

    if (a.live) {
      const wrap = tile.querySelector('.video-wrap');
      const video = tile.querySelector('video');
      video.addEventListener('playing', () => wrap.classList.remove('loading'));
      const expand = () => openViewer('screen', deviceId);
      video.onclick = expand;
      tile.querySelector('.expand-btn').onclick = expand;
      watchDevice(deviceId);
    }
    if (showCameraButton) {
      tile.querySelector('.view-camera-btn').onclick = () => openViewer('camera', deviceId);
    }
  });

  refreshViewer();
}

// ---- Viewer popup (screen + camera/mic) with slides and full screen ----
const viewerOverlay = $('viewer-overlay');
const viewerModal = $('viewer-modal');
const viewerVideo = $('viewer-video');
const viewer = { mode: null, list: [], index: -1, currentId: null };

function isViewerOpen() {
  return viewerOverlay.style.display !== 'none';
}

// Devices that can be flipped through in the popup: only those in the tab
// the manager is currently looking at, and only those they may open.
function viewerCandidates(mode) {
  const ids = currentDeviceIds.filter(inLiveGroup);
  return mode === 'screen' ? ids.filter((id) => access(id).live) : ids.filter(canViewCamera);
}

function openViewer(mode, deviceId) {
  const list = viewerCandidates(mode);
  if (!list.length) return;
  viewer.mode = mode;
  viewer.list = list;
  viewer.index = Math.max(0, list.indexOf(deviceId));
  viewer.currentId = null;

  viewerVideo.muted = mode === 'screen';
  $('viewer-mute').style.display = mode === 'camera' ? '' : 'none';
  $('viewer-mute').textContent = 'Mute';
  $('viewer-hint').textContent = mode === 'camera'
    ? 'Camera/mic is live. The employee sees an on-screen indicator while it is open. Closing this window stops the stream.'
    : 'Use ← → to switch employees. Press F for full screen. Drag the bottom-right corner to resize.';

  viewerOverlay.style.display = 'flex';
  renderViewer();
}

function renderViewer() {
  const id = viewer.list[viewer.index];
  if (!id) return closeViewer();

  const camera = viewer.mode === 'camera';
  const previousId = viewer.currentId;
  viewer.currentId = id;
  if (camera && previousId && previousId !== id) stopCamera(previousId);

  $('viewer-label').textContent = labelFor(id);
  $('viewer-counter').textContent = viewer.list.length > 1 ? `${viewer.index + 1} / ${viewer.list.length}` : '';
  const chip = $('viewer-mode-chip');
  chip.textContent = camera ? 'Camera / Mic' : 'Live screen';
  chip.className = 'chip' + (camera ? ' rec' : '');

  viewerVideo.dataset.device = id;
  viewerVideo.dataset.kind = camera ? 'camera' : 'screen';
  const stream = (camera ? cameraStreams : streams).get(id) || null;
  if (viewerVideo.srcObject !== stream) viewerVideo.srcObject = stream;
  $('viewer-loading').hidden = !!stream && viewerVideo.readyState >= 2 && !viewerVideo.paused;
  if (camera) watchCameraDevice(id); else watchDevice(id);

  // Slide controls only appear when there is more than one employee.
  const multi = viewer.list.length > 1;
  ['viewer-prev', 'viewer-next'].forEach((b) => { $(b).style.display = multi ? '' : 'none'; });
  ['viewer-prev-side', 'viewer-next-side'].forEach((b) => { $(b).hidden = !multi; });
  const strip = $('viewer-strip');
  strip.hidden = !multi;
  strip.innerHTML = viewer.list
    .map((deviceId, i) => `
      <button class="strip-chip ${i === viewer.index ? 'active' : ''}" type="button" data-i="${i}">
        <span class="dot online"></span>${esc(labelFor(deviceId))}
      </button>`)
    .join('');
  const active = strip.querySelector('.active');
  if (active && multi) active.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function stepViewer(delta) {
  if (viewer.list.length < 2) return;
  viewer.index = (viewer.index + delta + viewer.list.length) % viewer.list.length;
  renderViewer();
}

function closeViewer() {
  exitFullscreenIfAny();
  viewerOverlay.style.display = 'none';
  if (viewer.mode === 'camera' && viewer.currentId) stopCamera(viewer.currentId);
  viewerVideo.srcObject = null;
  delete viewerVideo.dataset.device;
  viewer.mode = null;
  viewer.list = [];
  viewer.index = -1;
  viewer.currentId = null;
}

// Keeps the popup in sync when devices go offline or access changes.
function refreshViewer() {
  if (!isViewerOpen()) return;
  const list = viewerCandidates(viewer.mode);
  if (!list.length) {
    toast('No more employees are available to view.');
    closeViewer();
    return;
  }
  const i = list.indexOf(viewer.currentId);
  viewer.list = list;
  if (i >= 0) {
    viewer.index = i;
  } else {
    toast('That employee is no longer available. Showing the next one.');
    viewer.index = Math.min(viewer.index, list.length - 1);
  }
  renderViewer();
}

viewerVideo.addEventListener('playing', () => { $('viewer-loading').hidden = true; });
$('viewer-close').onclick = closeViewer;
$('viewer-prev').onclick = () => stepViewer(-1);
$('viewer-next').onclick = () => stepViewer(1);
$('viewer-prev-side').onclick = () => stepViewer(-1);
$('viewer-next-side').onclick = () => stepViewer(1);
$('viewer-fullscreen').onclick = () => toggleFullscreen(viewerModal); // whole modal, so slides stay visible
$('viewer-mute').onclick = () => {
  viewerVideo.muted = !viewerVideo.muted;
  $('viewer-mute').textContent = viewerVideo.muted ? 'Unmute' : 'Mute';
};
$('viewer-strip').onclick = (e) => {
  const btn = e.target.closest('[data-i]');
  if (!btn) return;
  viewer.index = Number(btn.dataset.i);
  renderViewer();
};
viewerOverlay.addEventListener('click', (e) => { if (e.target === viewerOverlay) closeViewer(); });

function onFullscreenChange() {
  $('viewer-fullscreen').textContent = fullscreenElement() === viewerModal ? 'Exit full screen' : 'Full screen';
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// ---- Screenshot History (view-only - no delete for managers) ----
function hasScreenshotAccess(deviceId) {
  return access(deviceId).screenshot;
}

function renderHistoryGroup({ reload = true } = {}) {
  const allIds = Array.from(deviceMeta.keys());
  const filtered = allIds.filter((id) => (historyGroup === 'granted' ? hasScreenshotAccess(id) : !hasScreenshotAccess(id)));

  const select = $('device-select');
  const wrap = $('history-controls-wrap');
  const noAccessList = $('no-access-list');
  const gallery = $('history-gallery');

  if (historyGroup === 'none') {
    wrap.style.display = 'none';
    gallery.innerHTML = '';
    lastHistorySig = '';
    noAccessList.innerHTML = filtered.length
      ? `<div class="noaccess-grid">${filtered.map((id) => {
          const { primary, secondary } = nameParts(id);
          return `
            <div class="noaccess-card">
              <div class="tile-names"><strong>${esc(primary)}</strong>${secondary ? `<small>${esc(secondary)}</small>` : ''}</div>
              <span class="badge off">Screenshots not shared</span>
            </div>`;
        }).join('')}</div>`
      : '<div class="empty"><strong>Nothing hidden from you</strong>Screenshot access is shared with you for every employee.</div>';
    return;
  }

  wrap.style.display = 'flex';
  noAccessList.innerHTML = '';

  const optionsSig = filtered.map((id) => `${id}|${labelFor(id)}`).join('§');
  if (optionsSig !== lastOptionsSig) {
    const previousValue = select.value;
    select.innerHTML = filtered.map((id) => `<option value="${esc(id)}">${esc(labelFor(id))}</option>`).join('');
    if (filtered.includes(previousValue)) select.value = previousValue;
    lastOptionsSig = optionsSig;
  }

  if (!filtered.length) {
    gallery.innerHTML = '<div class="empty"><strong>No screenshot access yet</strong>The admin has not shared screenshots with you for any employee.</div>';
    lastHistorySig = '';
    return;
  }
  if (reload) loadHistory(false);
}

// ---- Lightbox ----
const lightbox = $('image-lightbox');
let currentShots = [];
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
  if (isViewerOpen()) {
    if (e.key === 'ArrowLeft') stepViewer(-1);
    else if (e.key === 'ArrowRight') stepViewer(1);
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen(viewerModal);
    else if (e.key === 'Escape' && !fullscreenElement()) closeViewer();
  } else if (lightbox.style.display !== 'none') {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === 'Escape') lightbox.style.display = 'none';
  }
});

async function loadHistory(force = false) {
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

  // Skip rebuilding the gallery when nothing changed (avoids flicker on auto-refresh).
  const sig = `${deviceId}:${shots.map((s) => s.id).join(',')}`;
  if (!force && sig === lastHistorySig) return;
  lastHistorySig = sig;

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
      </div>`)
    .join('');
  gallery.querySelectorAll('img[data-index]').forEach((img) => {
    img.onclick = () => openLightbox(Number(img.dataset.index));
  });
}

// ---- Bootstrap (kept at the bottom so everything above is initialised) ----
if (sessionStorage.getItem('unlockedRole')) {
  myRole = sessionStorage.getItem('unlockedRole');
  myName = sessionStorage.getItem('unlockedName');
  showApp();
}