// Hive renderer — wires the dashboard to the main process via window.hive.

const AGENTS = [
  { id: 'W1', row: 0, col: 0 },
  { id: 'W2', row: 0, col: 1 },
  { id: 'W3', row: 0, col: 2 },
  { id: 'W4', row: 1, col: 0 },
  { id: 'M',  row: 1, col: 1 },
  { id: 'W5', row: 1, col: 2 },
  { id: 'W6', row: 2, col: 0 },
  { id: 'W7', row: 2, col: 1 },
  { id: 'W8', row: 2, col: 2 },
];

const grid = document.getElementById('grid');
const cells = new Map();

for (const a of AGENTS) {
  const isManager = a.id === 'M';
  const cell = document.createElement('div');
  cell.className = 'cell' + (isManager ? ' manager' : '');
  cell.dataset.id = a.id;
  cell.innerHTML = `
    <div class="head">
      <div class="id">${isManager ? '◆ MANAGER' : a.id}<span class="tag">${isManager ? 'orchestrator' : 'worker'}</span></div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${isManager ? '' : `<a href="#" class="cancel-btn" data-id="${a.id}" style="display:none;color:var(--error);font-size:11px;text-decoration:none;">⏹ cancel</a>`}
        <div class="status s-idle"><span class="dot"></span><span class="status-text">idle</span></div>
      </div>
    </div>
    <div class="task empty">— waiting for task —</div>
    <div class="log">ready</div>
    <div class="footstats"><span>worktree: <b>${isManager ? '—' : 'wt-' + a.id.slice(1)}</b></span><span><span class="tokens">0</span> tok</span></div>
  `;
  grid.appendChild(cell);
  cells.set(a.id, {
    el: cell,
    statusEl: cell.querySelector('.status'),
    statusText: cell.querySelector('.status-text'),
    taskEl: cell.querySelector('.task'),
    logEl: cell.querySelector('.log'),
    tokensEl: cell.querySelector('.tokens'),
    cancelEl: cell.querySelector('.cancel-btn'),
    log: [],
    tokens: 0,
    status: 'idle',
  });

  const cancelBtn = cell.querySelector('.cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.hive.cancelWorker(a.id);
    });
  }
}

function setStatus(id, status) {
  const c = cells.get(id); if (!c) return;
  c.statusEl.className = 'status s-' + status;
  c.statusText.textContent = status;
  c.status = status;
  if (c.cancelEl) c.cancelEl.style.display = status === 'working' ? 'inline' : 'none';
  updatePowerLines();
}
function setTask(id, task) {
  const c = cells.get(id); if (!c) return;
  if (task) {
    c.taskEl.classList.remove('empty');
    c.taskEl.textContent = task;
  } else {
    c.taskEl.classList.add('empty');
    c.taskEl.textContent = '— waiting for task —';
  }
}
function appendLog(id, line) {
  const c = cells.get(id); if (!c) return;
  c.log.push(line);
  if (c.log.length > 6) c.log.shift();
  c.logEl.textContent = c.log.join('\n');
}
function addTokens(id, delta) {
  const c = cells.get(id); if (!c) return;
  c.tokens += delta;
  c.tokensEl.textContent = c.tokens.toLocaleString();
}

// ---- power links: plugs at edges, cables only when active ----
// Each worker plug sits on the cell edge facing the Manager. The matching
// Manager plug sits on the Manager edge facing the worker. Cables run from
// worker plug → Manager plug, traversing the gap between cells (never the
// cell interiors). Plugs are visible all the time (subtle); cables only
// render while a worker is in 'working' status.
const powerSvg = document.getElementById('power-svg');
const SVG_NS = 'http://www.w3.org/2000/svg';

const LINKS = {
  W1: { plugX: 'right',  plugY: 'bottom', mAttachX: 'left',   mAttachY: 'top'    },
  W2: { plugX: 'center', plugY: 'bottom', mAttachX: 'center', mAttachY: 'top'    },
  W3: { plugX: 'left',   plugY: 'bottom', mAttachX: 'right',  mAttachY: 'top'    },
  W4: { plugX: 'right',  plugY: 'center', mAttachX: 'left',   mAttachY: 'center' },
  W5: { plugX: 'left',   plugY: 'center', mAttachX: 'right',  mAttachY: 'center' },
  W6: { plugX: 'right',  plugY: 'top',    mAttachX: 'left',   mAttachY: 'bottom' },
  W7: { plugX: 'center', plugY: 'top',    mAttachX: 'center', mAttachY: 'bottom' },
  W8: { plugX: 'left',   plugY: 'top',    mAttachX: 'right',  mAttachY: 'bottom' },
};

const idlePlugs = new Map();    // workerId -> { wPlug, mPlug }
const activeLinks = new Map();  // workerId -> { line, wPulse, mPulse }

function ptOf(rect, xPos, yPos) {
  const x = xPos === 'left' ? rect.left : xPos === 'right' ? rect.right : (rect.left + rect.right) / 2;
  const y = yPos === 'top'  ? rect.top  : yPos === 'bottom' ? rect.bottom : (rect.top + rect.bottom) / 2;
  return { x, y };
}

function ensureIdlePlugs() {
  for (const id of Object.keys(LINKS)) {
    if (idlePlugs.has(id)) continue;
    const wPlug = document.createElementNS(SVG_NS, 'circle');
    wPlug.classList.add('plug-idle');
    wPlug.setAttribute('r', '3');
    const mPlug = document.createElementNS(SVG_NS, 'circle');
    mPlug.classList.add('plug-idle');
    mPlug.setAttribute('r', '3');
    powerSvg.appendChild(wPlug);
    powerSvg.appendChild(mPlug);
    idlePlugs.set(id, { wPlug, mPlug });
  }
}

function updatePowerLines() {
  ensureIdlePlugs();
  const m = cells.get('M');
  if (!m) return;
  const mr = m.el.getBoundingClientRect();

  for (const [id, link] of Object.entries(LINKS)) {
    const c = cells.get(id);
    if (!c) continue;
    const wr = c.el.getBoundingClientRect();
    const wPt = ptOf(wr, link.plugX, link.plugY);
    const mPt = ptOf(mr, link.mAttachX, link.mAttachY);

    const idle = idlePlugs.get(id);
    idle.wPlug.setAttribute('cx', wPt.x);
    idle.wPlug.setAttribute('cy', wPt.y);
    idle.mPlug.setAttribute('cx', mPt.x);
    idle.mPlug.setAttribute('cy', mPt.y);

    const active = c.status === 'working';
    let entry = activeLinks.get(id);

    if (active) {
      if (!entry) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.classList.add('power-line');
        const wPulse = document.createElementNS(SVG_NS, 'circle');
        wPulse.classList.add('plug-active');
        wPulse.setAttribute('r', '5');
        const mPulse = document.createElementNS(SVG_NS, 'circle');
        mPulse.classList.add('plug-active');
        mPulse.setAttribute('r', '5');
        powerSvg.appendChild(line);
        powerSvg.appendChild(wPulse);
        powerSvg.appendChild(mPulse);
        entry = { line, wPulse, mPulse };
        activeLinks.set(id, entry);
      }
      entry.line.setAttribute('x1', wPt.x);
      entry.line.setAttribute('y1', wPt.y);
      entry.line.setAttribute('x2', mPt.x);
      entry.line.setAttribute('y2', mPt.y);
      entry.wPulse.setAttribute('cx', wPt.x);
      entry.wPulse.setAttribute('cy', wPt.y);
      entry.mPulse.setAttribute('cx', mPt.x);
      entry.mPulse.setAttribute('cy', mPt.y);
    } else if (entry) {
      entry.line.remove();
      entry.wPulse.remove();
      entry.mPulse.remove();
      activeLinks.delete(id);
    }
  }
}

window.addEventListener('resize', updatePowerLines);
// First paint after layout settles.
requestAnimationFrame(() => requestAnimationFrame(updatePowerLines));

// ---- drawer: activity stream + preview pane ----
const drawer = document.getElementById('drawer');
const drawerToggle = document.getElementById('drawer-toggle');
const cancelAllLink = document.getElementById('cancel-all-link');
const activityPane = document.getElementById('activity-pane');
const previewPane = document.getElementById('preview-pane');
const previewFrame = document.getElementById('preview-frame');
const previewSource = document.getElementById('preview-source');

function setDrawerExpanded(expanded) {
  drawer.classList.toggle('collapsed', !expanded);
  drawerToggle.textContent = expanded ? '▼ collapse' : '▲ expand';
}
drawerToggle.addEventListener('click', (e) => {
  e.preventDefault();
  setDrawerExpanded(drawer.classList.contains('collapsed'));
});

document.querySelectorAll('.dtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.dpane').forEach(p => p.classList.remove('active'));
    document.getElementById(btn.dataset.tab + '-pane').classList.add('active');
    setDrawerExpanded(true);
    if (btn.dataset.tab === 'preview') {
      previewSource.style.display = 'inline-block';
      document.getElementById('preview-popout').style.display = 'inline';
      refreshPreviewSources();
    } else {
      previewSource.style.display = 'none';
      document.getElementById('preview-popout').style.display = 'none';
    }
  });
});

document.getElementById('preview-popout').addEventListener('click', async (e) => {
  e.preventDefault();
  await window.hive.openPreviewWindow();
  // Push current iframe content immediately so the new window isn't blank
  if (previewFrame.srcdoc) await window.hive.pushPreviewHtml(previewFrame.srcdoc);
});

cancelAllLink.addEventListener('click', async (e) => {
  e.preventDefault();
  const n = await window.hive.cancelAll();
  appendActivity('M', `⏹ stopped ${n} worker${n === 1 ? '' : 's'}`);
});

function appendActivity(id, line) {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.innerHTML = `<span class="a-time">${t}</span><span class="a-id ${id === 'M' ? 'M' : ''}">${id}</span><span class="a-line"></span>`;
  row.querySelector('.a-line').textContent = line;
  row.addEventListener('click', () => focusCell(id));
  activityPane.appendChild(row);
  // cap to last 200 rows
  while (activityPane.childElementCount > 200) activityPane.removeChild(activityPane.firstChild);
  activityPane.scrollTop = activityPane.scrollHeight;
}

// ---- preview pane (auto-load latest html from any worktree) ----
let previewWorker = 'auto'; // 'auto' = whichever worker has most recent file
let previewInterval = null;

async function refreshPreviewSources() {
  // Build dropdown options from worker list + auto.
  const ids = ['auto', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];
  if (previewSource.options.length !== ids.length) {
    previewSource.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
    previewSource.value = previewWorker;
    previewSource.addEventListener('change', () => { previewWorker = previewSource.value; refreshPreview(); });
  }
  refreshPreview();
  if (!previewInterval) previewInterval = setInterval(refreshPreview, 2000);
}

let lastPreviewKey = '';   // `${worker}:${path}:${mtime}` — skips refresh when unchanged
let lastPreviewContent = '';

async function refreshPreview() {
  if (!previewPane.classList.contains('active')) return;
  const ids = previewWorker === 'auto'
    ? ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']
    : [previewWorker];

  let best = null;
  for (const id of ids) {
    const res = await window.hive.listWorktreeFiles(id);
    if (!res.ok) continue;
    const html = res.files.find(f => f.path.endsWith('.html'));
    if (html && (!best || html.mtime > best.mtime)) {
      best = { id, path: html.path, mtime: html.mtime };
    }
  }
  if (!best) {
    const empty = '<body style="font-family:monospace;padding:24px;color:#888;">no .html files in worktrees yet</body>';
    if (lastPreviewKey !== 'empty') {
      previewFrame.srcdoc = empty;
      lastPreviewKey = 'empty';
      lastPreviewContent = empty;
    }
    return;
  }

  const key = `${best.id}:${best.path}:${best.mtime}`;
  if (key === lastPreviewKey) return; // unchanged — no reload, no flash

  const r = await window.hive.readWorktreeFile(best.id, best.path);
  if (!r.ok || r.content === lastPreviewContent) return;

  previewFrame.srcdoc = r.content;
  lastPreviewKey = key;
  lastPreviewContent = r.content;
  window.hive.pushPreviewHtml(r.content).catch(() => {});
}

// ---- live event subscription ----
let totalTokens = 0;
window.hive.onAgentEvent((evt) => {
  if (evt.type === 'status') setStatus(evt.id, evt.status);
  else if (evt.type === 'task') {
    setTask(evt.id, evt.task);
    if (evt.task) appendActivity(evt.id, '⇢ ' + evt.task);
  }
  else if (evt.type === 'log') {
    appendLog(evt.id, evt.line);
    appendActivity(evt.id, evt.line);
  }
  else if (evt.type === 'tokens') {
    addTokens(evt.id, evt.delta);
    totalTokens += evt.delta;
    document.getElementById('meta-tokens').textContent = totalTokens.toLocaleString();
  }
});

// ---- task input ----
const taskInput = document.getElementById('task-input');
const taskRun = document.getElementById('task-run');
const liveBadge = document.getElementById('live-badge');

async function runTask() {
  const task = taskInput.value.trim();
  if (!task) return;
  document.getElementById('meta-task').textContent = task.slice(0, 50) + (task.length > 50 ? '…' : '');
  liveBadge.textContent = '● running';
  startRuntime();
  const imgUrl = attachedImage;
  // Don't disable the Run button — runTask now returns as soon as Manager
  // dispatches; user must remain free to fire follow-ups while workers run.
  taskInput.value = '';
  micStatus.textContent = '🐝 Manager is thinking…';
  try {
    const res = await window.hive.runTask(task, imgUrl);
    if (!res.ok) appendLog('M', '✗ ' + res.error);
    micStatus.textContent = '';
  } finally {
    clearAttachment();
  }
}
taskRun.addEventListener('click', runTask);
taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runTask();
});

// ---- runtime clock ----
let runtimeStart = 0;
let runtimeInterval = null;
function startRuntime() {
  runtimeStart = Date.now();
  if (runtimeInterval) clearInterval(runtimeInterval);
  runtimeInterval = setInterval(() => {
    const ms = Date.now() - runtimeStart;
    const s = Math.floor(ms / 1000);
    document.getElementById('meta-runtime').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

// ---- screenshot attach ----
const snapBtn = document.getElementById('snap-btn');
const attachRow = document.getElementById('attach-row');
const attachThumb = document.getElementById('attach-thumb');
const attachInfo = document.getElementById('attach-info');
const attachClear = document.getElementById('attach-clear');
let attachedImage = null;

function clearAttachment() {
  attachedImage = null;
  attachThumb.src = '';
  attachInfo.textContent = '';
  // If watch mode is on, the next 3s tick repopulates. Don't hide the row —
  // refreshWatchFrame will fill it again. If not watching, hide it.
  if (!watchInterval) attachRow.style.display = 'none';
}

function applyAttach(res) {
  if (!res || !res.ok) {
    if (res?.error) micStatus.textContent = '✗ snip: ' + res.error;
    return;
  }
  attachedImage = res.dataUrl;
  attachThumb.src = res.dataUrl;
  attachInfo.textContent = `screenshot ${res.width}×${res.height} attached — describe what to do with it`;
  attachRow.style.display = 'flex';
  taskInput.focus();
}

async function snipNow() {
  snapBtn.disabled = true;
  snapBtn.textContent = '⋯ drag a region';
  micStatus.textContent = 'Snip & Sketch is open — drag a region or press Esc';
  try {
    const res = await window.hive.snipRegion();
    applyAttach(res);
    if (res.ok) micStatus.textContent = '';
  } finally {
    snapBtn.disabled = false;
    snapBtn.textContent = '📸 Snap';
  }
}

snapBtn.addEventListener('click', snipNow);
attachClear.addEventListener('click', (e) => { e.preventDefault(); clearAttachment(); });

// Receive snips triggered by the GLOBAL Ctrl+Shift+H hotkey (works even when
// Hive isn't focused). Main process brings the window to front automatically.
window.hive.onSnipResult?.((res) => applyAttach(res));

// ---- watch mode (auto-attach latest screen frame every 3s) ----
const watchBtn = document.getElementById('watch-btn');
let watchInterval = null;

async function refreshWatchFrame() {
  try {
    const res = await window.hive.captureScreen();
    if (!res.ok) return;
    attachedImage = res.dataUrl;
    attachThumb.src = res.dataUrl;
    attachInfo.innerHTML = `<span style="color:var(--working);">● watching</span> — latest frame ${res.width}×${res.height} auto-attaches on next task`;
    attachRow.style.display = 'flex';
  } catch { /* ignore single-frame failures */ }
}

function startWatch() {
  if (watchInterval) return;
  watchBtn.style.background = 'var(--working)';
  watchBtn.textContent = '👁 Watching';
  refreshWatchFrame();
  watchInterval = setInterval(refreshWatchFrame, 3000);
}

function stopWatch() {
  if (!watchInterval) return;
  clearInterval(watchInterval);
  watchInterval = null;
  watchBtn.style.background = '';
  watchBtn.textContent = '👁 Watch';
  // Keep current frame attached so user can still send it once. Next clearAttachment removes it.
  if (attachedImage) {
    attachInfo.textContent = `last watched frame still attached — describe what to do`;
  }
}

function toggleWatch() { watchInterval ? stopWatch() : startWatch(); }

watchBtn.addEventListener('click', toggleWatch);
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault();
    toggleWatch();
  }
});

// ---- TTS playback (Manager speaks) ----
window.hive.onManagerSpoke?.(async (text) => {
  try {
    const res = await window.hive.speak(text);
    if (!res.ok || !res.bytes) return;
    const blob = new Blob([res.bytes], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch(() => {});
    audio.onended = () => URL.revokeObjectURL(url);
  } catch { /* ignore */ }
});

// ---- voice (push-to-talk via Whisper) ----
const micBtn = document.getElementById('mic-btn');
const micStatus = document.getElementById('mic-status');
let mediaRecorder = null;
let audioChunks = [];
let micStream = null;
let isRecording = false;

async function startRecording() {
  if (isRecording) return;
  try {
    micStatus.textContent = '● requesting mic…';
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();
    isRecording = true;
    micBtn.style.background = 'var(--error)';
    micBtn.textContent = '● recording…';
    micStatus.textContent = '● listening — release to send';
  } catch (err) {
    micStatus.textContent = '✗ mic blocked: ' + err.message;
    isRecording = false;
  }
}

async function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  micBtn.style.background = '';
  micBtn.textContent = '🎤 Talk';
  micStatus.textContent = '⋯ transcribing via Whisper…';
  mediaRecorder.stop();
  micStream.getTracks().forEach(t => t.stop());
}

async function handleRecordingStop() {
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  if (blob.size < 1000) {
    micStatus.textContent = '(empty — hold space longer next time)';
    return;
  }
  try {
    const buf = await blob.arrayBuffer();
    const res = await window.hive.transcribeAudio(buf, 'audio/webm');
    if (res.ok && res.text) {
      micStatus.textContent = '✓ ' + res.text;
      taskInput.value = res.text;
      runTask();
    } else {
      micStatus.textContent = '✗ ' + (res.error ?? 'no transcript');
    }
  } catch (err) {
    micStatus.textContent = '✗ ' + err.message;
  }
}

micBtn.addEventListener('mousedown', startRecording);
micBtn.addEventListener('mouseup', stopRecording);
micBtn.addEventListener('mouseleave', () => { if (isRecording) stopRecording(); });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== taskInput && !isRecording && !e.repeat) {
    e.preventDefault();
    startRecording();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && isRecording) {
    e.preventDefault();
    stopRecording();
  }
});

// ---- focus / keybindings ----
let focused = null;
function focusCell(id) {
  for (const [, c] of cells) c.el.classList.remove('focused');
  if (id && cells.get(id)) {
    cells.get(id).el.classList.add('focused');
    focused = id;
  } else {
    focused = null;
  }
}
window.addEventListener('keydown', (e) => {
  if (document.activeElement === taskInput) return;
  if (e.key >= '1' && e.key <= '8') focusCell('W' + e.key);
  else if (e.key.toLowerCase() === 'm') focusCell('M');
  else if (e.key === 'Escape') focusCell(null);
});

// ---- settings modal (model swap) ----
const settingsModal = document.getElementById('settings-modal');
const settingsRows = document.getElementById('settings-rows');

const PROVIDERS = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4o'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

function buildSettingsRows(config) {
  settingsRows.innerHTML = '';
  for (const id of ['M', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:60px 110px 1fr;gap:8px;align-items:center;margin-bottom:6px;';
    const c = config[id] || { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    row.innerHTML = `
      <strong style="color:${id === 'M' ? 'var(--manager)' : 'var(--text)'};">${id}</strong>
      <select data-agent="${id}" data-field="provider" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border-strong);padding:4px;border-radius:3px;font-family:inherit;">
        ${Object.keys(PROVIDERS).map(p => `<option value="${p}" ${p === c.provider ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <select data-agent="${id}" data-field="model" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border-strong);padding:4px;border-radius:3px;font-family:inherit;">
        ${PROVIDERS[c.provider].map(m => `<option value="${m}" ${m === c.model ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
    `;
    settingsRows.appendChild(row);
  }
  // re-populate model list when provider changes
  settingsRows.querySelectorAll('select[data-field="provider"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.agent;
      const modelSel = settingsRows.querySelector(`select[data-agent="${id}"][data-field="model"]`);
      const models = PROVIDERS[sel.value];
      modelSel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    });
  });
}

document.getElementById('open-settings').addEventListener('click', async (e) => {
  e.preventDefault();
  const config = await window.hive.getModelConfig();
  buildSettingsRows(config);
  settingsModal.style.display = 'flex';
});
document.getElementById('close-settings').addEventListener('click', (e) => {
  e.preventDefault();
  settingsModal.style.display = 'none';
});
document.getElementById('settings-save').addEventListener('click', async () => {
  const config = {};
  for (const id of ['M', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']) {
    const provider = settingsRows.querySelector(`select[data-agent="${id}"][data-field="provider"]`).value;
    const model = settingsRows.querySelector(`select[data-agent="${id}"][data-field="model"]`).value;
    config[id] = { provider, model };
  }
  await window.hive.setModelConfig(config);
  settingsModal.style.display = 'none';
});
