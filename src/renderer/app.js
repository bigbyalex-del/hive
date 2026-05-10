// Hive renderer — wires the dashboard to the main process via window.hive.
//
// FXV ADVISOR MODE — the 9 grid cells are domain specialists (8 workers +
// Programme Lead in the centre). Cells are chat surfaces, not code workers.
// Clicking any cell opens that specialist's chat.

// Cell → persona id mapping. Owns the visible layout of the dashboard.
const CELL_TO_PERSONA = {
  W1: 'fxv:aerobic',
  W2: 'fxv:strength',
  W3: 'fxv:concurrent',
  W4: 'fxv:load',
  M:  'fxv:manager',
  W5: 'fxv:readiness',
  W6: 'fxv:coach',
  W7: 'fxv:uiux',
  W8: 'fxv:marketing',
};

// Per-persona accent colour. Picked so each cell + chat header is visually
// distinct without colliding with existing chrome (cyan accent, error red).
const PERSONA_COLOR = {
  'fxv:aerobic':    '#38bdf8',  // sky-blue (breath / endurance)
  'fxv:strength':   '#f59e0b',  // amber (heavy iron)
  'fxv:concurrent': '#a78bfa',  // soft violet (hybrid)
  'fxv:load':       '#2dd4bf',  // teal (measurement / lab)
  'fxv:readiness':  '#4ade80',  // green (recovery)
  'fxv:coach':      '#fbbf24',  // honey (warm voice)
  'fxv:uiux':       '#f472b6',  // pink (design)
  'fxv:marketing':  '#fb923c',  // orange (growth / attention)
  'fxv:manager':    '#c084fc',  // violet (synthesis — matches existing manager hue)
  // Page-specific sub-agents — pastels so they read as a separate tier.
  'fxv:page-today':     '#93c5fd',  // pale blue
  'fxv:page-programme': '#c4b5fd',  // pale violet
  'fxv:page-coach':     '#fcd34d',  // pale gold
  'fxv:page-health':    '#fca5a5',  // pale coral
};

// Page agents render as a strip across the top, in this order.
const PAGE_AGENTS_ORDER = [
  'fxv:page-today',
  'fxv:page-programme',
  'fxv:page-coach',
  'fxv:page-health',
];

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
        ${isManager ? '' : `<a href="#" class="diff-btn" data-id="${a.id}" style="display:none;color:var(--muted);font-size:11px;text-decoration:none;" title="Show patch for this worker's branch">diff</a>`}
        ${isManager ? '' : `<a href="#" class="cancel-btn" data-id="${a.id}" style="display:none;color:var(--error);font-size:11px;text-decoration:none;">⏹ cancel</a>`}
        ${isManager ? '' : `<a href="#" class="override-btn" data-id="${a.id}" style="display:none;color:var(--accent,#7CFFB2);font-size:11px;text-decoration:none;" title="Force-merge despite reviewer NEEDS_FIX">✓ force merge</a>`}
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
    overrideEl: cell.querySelector('.override-btn'),
    diffEl: cell.querySelector('.diff-btn'),
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
  const overrideBtn = cell.querySelector('.override-btn');
  if (overrideBtn) {
    overrideBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      overrideBtn.style.opacity = '0.5';
      try {
        const res = await window.hive.overrideReview(a.id);
        if (res && res.ok === false && res.error) {
          appendLog(a.id, `✗ override: ${res.error}`);
        }
      } finally {
        overrideBtn.style.opacity = '1';
      }
    });
  }
  const diffBtn = cell.querySelector('.diff-btn');
  if (diffBtn) {
    diffBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      openDiffModal(a.id);
    });
  }
}

function setStatus(id, status) {
  const c = cells.get(id); if (!c) return;
  c.statusEl.className = 'status s-' + status;
  c.statusText.textContent = status;
  c.status = status;
  // Mirror status onto the cell itself so the Premium theme can drive a
  // per-status ambient glow without needing JS in the stylesheet.
  c.el.classList.remove('cell-idle', 'cell-working', 'cell-done', 'cell-error', 'cell-review');
  c.el.classList.add('cell-' + status);
  if (c.cancelEl) c.cancelEl.style.display = status === 'working' ? 'inline' : 'none';
  if (c.overrideEl) c.overrideEl.style.display = status === 'review' ? 'inline' : 'none';
  // Diff link is meaningful any time the worker has produced changes — show
  // for anything except idle (when the branch wouldn't exist yet).
  if (c.diffEl) c.diffEl.style.display = (status === 'done' || status === 'review' || status === 'error') ? 'inline' : 'none';
  updatePowerLines();
}

// ---- project picker (titlebar) ----
const projectPicker = document.getElementById('project-picker');
const projectPickerName = document.getElementById('project-picker-name');
const projectMenu = document.getElementById('project-menu');
const projectMenuList = document.getElementById('project-menu-list');
const projectMenuStatus = document.getElementById('project-menu-status');
const projectNewName = document.getElementById('project-new-name');
const projectNewBtn = document.getElementById('project-new-btn');
let activeProjectId = null;

function setProjectStatus(msg, isError) {
  projectMenuStatus.textContent = msg || '';
  projectMenuStatus.classList.toggle('error', !!isError);
}

async function refreshProjectMenu() {
  const res = await window.hive.listProjects();
  if (!res || !res.ok) { projectMenuList.innerHTML = '<div class="project-menu-status error">failed to load</div>'; return; }
  activeProjectId = res.activeId;
  projectMenuList.innerHTML = '';
  for (const p of res.projects) {
    const row = document.createElement('div');
    row.className = 'project-menu-row' + (p.id === activeProjectId ? ' active' : '');
    row.innerHTML = `<span class="pm-name"></span><span class="pm-delete" title="Delete project history">✕</span>`;
    row.querySelector('.pm-name').textContent = p.name;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.pm-delete')) return;
      if (p.id === activeProjectId) { closeProjectMenu(); return; }
      setProjectStatus('switching…');
      const r = await window.hive.switchProject(p.id);
      if (!r.ok) { setProjectStatus(r.error || 'switch failed', true); return; }
      activeProjectId = p.id;
      projectPickerName.textContent = p.name;
      setProjectStatus('');
      closeProjectMenu();
      // Reset preview + activity since they belong to the prior project.
      lastPreviewKey = ''; lastPreviewContent = '';
      activityPane.innerHTML = '';
      appendActivity('M', `→ switched to ${p.name}`);
    });
    if (p.id !== 1) {
      row.querySelector('.pm-delete').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete project "${p.name}"? History + memory will be wiped (files on disk are kept).`)) return;
        const r = await window.hive.deleteProject(p.id);
        if (!r.ok) { setProjectStatus(r.error || 'delete failed', true); return; }
        await refreshProjectMenu();
      });
    } else {
      row.querySelector('.pm-delete').remove(); // can't delete default
    }
    projectMenuList.appendChild(row);
  }
}

async function refreshActiveProjectName() {
  const r = await window.hive.getActiveProject();
  if (r && r.ok && r.project) {
    projectPickerName.textContent = r.project.name;
    activeProjectId = r.project.id;
  } else {
    projectPickerName.textContent = 'Default';
  }
}

function openProjectMenu() {
  projectMenu.style.display = 'block';
  refreshProjectMenu();
  setTimeout(() => projectNewName.focus(), 60);
}
function closeProjectMenu() {
  projectMenu.style.display = 'none';
  setProjectStatus('');
  projectNewName.value = '';
}
projectPicker.addEventListener('click', (e) => {
  e.stopPropagation();
  if (projectMenu.style.display === 'block') closeProjectMenu();
  else openProjectMenu();
});
document.addEventListener('click', (e) => {
  if (projectMenu.style.display !== 'block') return;
  if (projectMenu.contains(e.target) || projectPicker.contains(e.target)) return;
  closeProjectMenu();
});
projectNewBtn.addEventListener('click', async () => {
  const name = projectNewName.value.trim();
  const gitUrl = (document.getElementById('project-new-git')?.value || '').trim();
  if (!name) { setProjectStatus('name required', true); return; }
  setProjectStatus(gitUrl ? 'cloning…' : 'creating…');
  const payload = gitUrl ? { name, gitUrl } : name;
  const created = await window.hive.createProject(payload);
  if (!created.ok) { setProjectStatus(created.error || 'create failed', true); return; }
  // Auto-switch to the new project.
  const sw = await window.hive.switchProject(created.project.id);
  if (!sw.ok) { setProjectStatus(sw.error || 'switch failed', true); return; }
  projectPickerName.textContent = created.project.name;
  activeProjectId = created.project.id;
  projectNewName.value = '';
  closeProjectMenu();
  lastPreviewKey = ''; lastPreviewContent = '';
  activityPane.innerHTML = '';
  appendActivity('M', `→ created + switched to ${created.project.name}`);
});
projectNewName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') projectNewBtn.click();
  if (e.key === 'Escape') closeProjectMenu();
});
refreshActiveProjectName();

// ---- theme toggle (Lab default / Premium glass + honeycomb) ----
(function initTheme() {
  const saved = (() => { try { return localStorage.getItem('hive-theme'); } catch { return null; } })();
  applyTheme(saved === 'premium' ? 'premium' : 'lab');
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    applyTheme(btn.dataset.theme);
  });
})();
function applyTheme(name) {
  const isPremium = name === 'premium';
  document.body.classList.toggle('theme-premium', isPremium);
  document.body.classList.toggle('theme-lab', !isPremium);
  try { localStorage.setItem('hive-theme', isPremium ? 'premium' : 'lab'); } catch { /* ignore quota */ }
  document.querySelectorAll('#theme-toggle button[data-theme]').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === (isPremium ? 'premium' : 'lab'));
  });
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
    const onPreview = btn.dataset.tab === 'preview';
    previewSource.style.display = onPreview ? 'inline-block' : 'none';
    document.getElementById('preview-popout').style.display = onPreview ? 'inline' : 'none';
    document.getElementById('annotate-tools').style.display = onPreview ? 'inline-flex' : 'none';
    if (onPreview) refreshPreviewSources();
  });
});

document.getElementById('preview-popout').addEventListener('click', async (e) => {
  e.preventDefault();
  await window.hive.openPreviewWindow();
  // Push current iframe content immediately so the new window isn't blank
  if (previewFrame.srcdoc) await window.hive.pushPreviewHtml(previewFrame.srcdoc, projectType);
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
// Files older than this are stale artifacts from prior sessions — never load
// them in auto mode, otherwise yesterday's demo screen haunts today's preview.
// Trimmed by 60s so a file written milliseconds before launch isn't excluded.
const previewSessionStart = Date.now() - 60_000;

async function refreshPreviewSources() {
  // v1.0 — 'project' shows the merged main branch (canonical state). 'auto'
  // prefers project; falls back to the most recent in-flight worker branch
  // so users see live work before it merges.
  const ids = ['auto', 'project', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];
  if (previewSource.options.length !== ids.length) {
    previewSource.innerHTML = ids.map(id => {
      const label = id === 'project' ? '🌿 main' : id;
      return `<option value="${id}">${label}</option>`;
    }).join('');
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
  // v1.0 — 'auto' prefers the merged project main; falls back to per-worker
  // branches so users see in-flight work before merge.
  const ids = previewWorker === 'auto'
    ? ['project', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']
    : [previewWorker];

  let best = null;
  for (const id of ids) {
    const res = await window.hive.listWorktreeFiles(id);
    if (!res.ok) continue;
    // In auto mode, ignore files written before this session started — those
    // are leftovers from prior runs and shouldn't outrank an empty project.
    // When a specific worker is picked, show whatever's there (the user asked).
    const candidates = previewWorker === 'auto'
      ? res.files.filter(f => f.mtime >= previewSessionStart)
      : res.files;
    const html = candidates.find(f => f.path.endsWith('.html'));
    if (html && (!best || html.mtime > best.mtime)) {
      best = { id, path: html.path, mtime: html.mtime };
    }
    // In auto mode, the project main wins as soon as it has an .html — don't
    // override with worker branches that often contain stale pre-merge state.
    if (previewWorker === 'auto' && id === 'project' && best) break;
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
  window.hive.pushPreviewHtml(r.content, projectType).catch(() => {});
}

// ---- live event subscription ----
let totalTokens = 0;
let totalCostGBP = 0;
const metaCostEl = document.getElementById('meta-cost');
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
  else if (evt.type === 'cost') {
    totalCostGBP += evt.deltaGBP;
    if (metaCostEl) metaCostEl.textContent = totalCostGBP < 0.01 ? totalCostGBP.toFixed(4) : totalCostGBP.toFixed(2);
  }
});

// ---- cost modal (click on £ in titlebar) ----
const costModal = document.getElementById('cost-modal');
const costRows = document.getElementById('cost-rows');
const costByModel = document.getElementById('cost-by-model');
async function openCostModal() {
  const r = await window.hive.getCostSummary();
  if (!r || !r.ok) { costRows.textContent = 'failed to load'; }
  else {
    const fmt = (n) => '£' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
    const fmtTok = (n) => Number(n).toLocaleString();
    costRows.innerHTML = `
      <span class="label">Today</span><span class="value">${fmtTok(r.today.tokens)} tok · ${r.today.runs || 0} runs</span><span class="gbp">${fmt(r.today.gbp)}</span>
      <span class="label">This project</span><span class="value">${fmtTok(r.project.tokens)} tok</span><span class="gbp">${fmt(r.project.gbp)}</span>
      <span class="label">All time</span><span class="value">${fmtTok(r.allTime.tokens)} tok</span><span class="gbp">${fmt(r.allTime.gbp)}</span>
    `;
    costByModel.innerHTML = '<div style="color:var(--muted);margin-bottom:6px;letter-spacing:1px;">BY MODEL (all time)</div>' +
      r.byModel.sort((a, b) => b.gbp - a.gbp).map(m =>
        `<div class="row"><span class="m">${m.model}</span><span>${m.runs} runs</span><span>${fmtTok(m.tokens)} tok</span><span class="g">${fmt(m.gbp)}</span></div>`
      ).join('');
  }
  costModal.style.display = 'flex';
}
document.getElementById('meta-cost-wrap').addEventListener('click', openCostModal);
document.getElementById('close-cost').addEventListener('click', (e) => { e.preventDefault(); costModal.style.display = 'none'; });
costModal.addEventListener('click', (e) => { if (e.target === costModal) costModal.style.display = 'none'; });

// ---- diff modal (per-worker patch view) ----
const diffModal = document.getElementById('diff-modal');
const diffTitle = document.getElementById('diff-title');
const diffStat = document.getElementById('diff-stat');
const diffPatch = document.getElementById('diff-patch');
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function colorisePatch(raw) {
  if (!raw) return '<span class="meta">(no diff)</span>';
  return raw.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return `<span class="meta">${escapeHtml(line)}</span>`;
    }
    if (line.startsWith('@@')) return `<span class="hunk">${escapeHtml(line)}</span>`;
    if (line.startsWith('+')) return `<span class="add">${escapeHtml(line)}</span>`;
    if (line.startsWith('-')) return `<span class="del">${escapeHtml(line)}</span>`;
    return `<span>${escapeHtml(line)}</span>`;
  }).join('');
}
async function openDiffModal(workerId) {
  diffTitle.textContent = `DIFF — ${workerId}`;
  diffStat.textContent = 'loading…';
  diffPatch.innerHTML = '';
  diffModal.style.display = 'flex';
  const r = await window.hive.getWorkerDiff(workerId);
  if (!r || !r.ok) {
    diffStat.textContent = 'failed: ' + (r?.error || 'unknown');
    return;
  }
  diffStat.textContent = (r.stat || '').trim() || '(no changes vs main)';
  diffPatch.innerHTML = colorisePatch(r.patch || '');
}
document.getElementById('close-diff').addEventListener('click', (e) => { e.preventDefault(); diffModal.style.display = 'none'; });
diffModal.addEventListener('click', (e) => { if (e.target === diffModal) diffModal.style.display = 'none'; });

// ---- Babysit modal ----
const babysitModal = document.getElementById('babysit-modal');
const babysitOpen = document.getElementById('open-babysit');
const babysitClose = document.getElementById('close-babysit');
const babysitStart = document.getElementById('babysit-start');
const babysitStop = document.getElementById('babysit-stop');
const babysitStateEl = document.getElementById('babysit-state');
const babysitLogEl = document.getElementById('babysit-log');
async function refreshBabysitState() {
  const s = await window.hive.babysitStatus();
  if (!s) return;
  if (s.running) {
    babysitStateEl.textContent = `running · ${s.repo} · ${s.processedCount} done${s.currentIssue ? ` · on #${s.currentIssue}` : ''}`;
    babysitStateEl.classList.add('running');
    babysitStart.disabled = true;
    babysitStop.disabled = false;
  } else {
    babysitStateEl.textContent = 'idle';
    babysitStateEl.classList.remove('running');
    babysitStart.disabled = false;
    babysitStop.disabled = true;
  }
}
function appendBabysitLog(line) {
  if (line === '__state__') { refreshBabysitState(); return; }
  const t = new Date();
  const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
  babysitLogEl.textContent += `[${ts}] ${line}\n`;
  babysitLogEl.scrollTop = babysitLogEl.scrollHeight;
}
window.hive.onBabysitLog(appendBabysitLog);
babysitOpen.addEventListener('click', (e) => {
  e.preventDefault();
  babysitModal.style.display = 'flex';
  refreshBabysitState();
});
babysitClose.addEventListener('click', (e) => { e.preventDefault(); babysitModal.style.display = 'none'; });
babysitModal.addEventListener('click', (e) => { if (e.target === babysitModal) babysitModal.style.display = 'none'; });
babysitStart.addEventListener('click', async () => {
  const repo = document.getElementById('babysit-repo').value.trim();
  const label = document.getElementById('babysit-label').value.trim() || 'hive-take-this';
  const intervalSec = Math.max(30, parseInt(document.getElementById('babysit-interval').value, 10) || 60);
  const tokenEnv = document.getElementById('babysit-token').value.trim() || 'GITHUB_TOKEN';
  const r = await window.hive.babysitStart({ repo, label, intervalMs: intervalSec * 1000, tokenEnv });
  if (!r.ok) appendBabysitLog(`✗ ${r.error}`);
  refreshBabysitState();
});
babysitStop.addEventListener('click', async () => {
  await window.hive.babysitStop();
  refreshBabysitState();
});
refreshBabysitState();

// ---- task input ----
const taskInput = document.getElementById('task-input');
const taskRun = document.getElementById('task-run');
const liveBadge = document.getElementById('live-badge');

// ---- spec interview state ----
let specMode = false;
let specPendingTask = null;     // original raw task waiting on answers
const specBtn = document.getElementById('spec-btn');
const specPanel = document.getElementById('spec-panel');
const specQuestionsDiv = document.getElementById('spec-questions');

specBtn.addEventListener('click', () => {
  specMode = !specMode;
  specBtn.style.background = specMode ? 'var(--accent)' : '';
  specBtn.style.color = specMode ? '#00171f' : '';
  if (!specMode) {
    specPendingTask = null;
    specPanel.style.display = 'none';
    specQuestionsDiv.innerHTML = '';
  }
});

function renderSpecQuestions(questions) {
  specQuestionsDiv.innerHTML = questions.map((q, i) => `
    <div>
      <div style="font-size:11px;color:var(--accent);margin-bottom:3px;">Q${i + 1}. ${q}</div>
      <input type="text" data-spec-q="${i}" placeholder="answer (or leave blank)" style="width:100%;background:var(--panel);border:1px solid var(--border-strong);color:var(--text);padding:5px 8px;border-radius:3px;font-family:inherit;font-size:12px;" />
    </div>
  `).join('');
  specPanel.style.display = 'block';
  // Focus first answer field for fast typing.
  const first = specQuestionsDiv.querySelector('input[data-spec-q]');
  if (first) first.focus();
}

function buildEnrichedTask(originalTask, questions) {
  const lines = [originalTask, '', '## Clarifications'];
  for (let i = 0; i < questions.length; i++) {
    const ans = (specQuestionsDiv.querySelector(`input[data-spec-q="${i}"]`)?.value || '(no preference)').trim();
    lines.push(`Q: ${questions[i]}`);
    lines.push(`A: ${ans}`);
  }
  return lines.join('\n');
}

async function runTask() {
  // Spec mode, second click — collect answers and dispatch enriched task.
  if (specPendingTask && specPanel.style.display === 'block') {
    const enriched = buildEnrichedTask(specPendingTask.task, specPendingTask.questions);
    specPendingTask = null;
    specPanel.style.display = 'none';
    specQuestionsDiv.innerHTML = '';
    document.getElementById('meta-task').textContent = enriched.slice(0, 50) + '…';
    liveBadge.textContent = '● running';
    startRuntime();
    const imgUrl = attachedImage;
    micStatus.textContent = '🐝 Manager is thinking…';
    try {
      const res = await window.hive.runTask(enriched, imgUrl);
      if (!res.ok) appendLog('M', '✗ ' + res.error);
      micStatus.textContent = '';
    } finally {
      clearAttachment();
    }
    return;
  }

  const task = taskInput.value.trim();
  if (!task) return;

  // Spec mode, first click — fire interview, render questions, wait for next click.
  if (specMode) {
    micStatus.textContent = '📋 spec interview…';
    taskInput.value = '';
    const res = await window.hive.runSpecInterview(task);
    micStatus.textContent = '';
    if (res.ok && res.questions && res.questions.length > 0) {
      specPendingTask = { task, questions: res.questions };
      renderSpecQuestions(res.questions);
      return;
    }
    // No questions came back — fall through to normal dispatch with the raw task.
    taskInput.value = task;
  }

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

// Push-to-talk on Space, but only when no text field has focus — otherwise
// typing a space anywhere swallows the keystroke and triggers the mic.
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !isTypingTarget(document.activeElement) && !isRecording && !e.repeat) {
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

// ---- templates modal ----
const templatesModal = document.getElementById('templates-modal');
const templatesList = document.getElementById('templates-list');
const templatesWorker = document.getElementById('templates-worker');
const templatesName = document.getElementById('templates-name');
const templatesStatus = document.getElementById('templates-status');

async function buildTemplatesList() {
  const tpls = await window.hive.listTemplates();
  templatesList.innerHTML = tpls.map(t => `
    <div style="border:1px solid var(--border-strong);border-radius:4px;padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div>
        <div style="font-weight:700;color:var(--text);">${t.name}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px;">${t.description}</div>
      </div>
      <button data-tpl="${t.name}" class="tpl-scaffold" style="background:var(--accent);border:none;color:#00171f;font-weight:700;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;">Scaffold →</button>
    </div>
  `).join('');
  templatesList.querySelectorAll('.tpl-scaffold').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tplName = btn.dataset.tpl;
      const workerId = templatesWorker.value;
      const projectName = templatesName.value || 'my-app';
      btn.disabled = true;
      btn.textContent = '…';
      templatesStatus.textContent = `scaffolding ${tplName} → ${workerId}…`;
      const result = await window.hive.scaffoldTemplate(workerId, tplName, projectName);
      btn.disabled = false;
      btn.textContent = 'Scaffold →';
      if (result.ok) {
        templatesStatus.style.color = 'var(--accent)';
        templatesStatus.textContent = `✓ ${result.template}: ${result.filesWritten.length} files written to ${workerId}. Watch the worker log.`;
      } else {
        templatesStatus.style.color = 'var(--error)';
        templatesStatus.textContent = `✗ ${result.error}`;
      }
    });
  });
}

document.getElementById('open-templates').addEventListener('click', async (e) => {
  e.preventDefault();
  templatesStatus.textContent = '';
  templatesStatus.style.color = 'var(--muted)';
  await buildTemplatesList();
  templatesModal.style.display = 'flex';
});
document.getElementById('close-templates').addEventListener('click', (e) => {
  e.preventDefault();
  templatesModal.style.display = 'none';
});

// ---- project type ---------------------------------------------------------
// Drives preview chrome (iPhone bezel for ios) and prefixes dispatched tasks
// with a viewport hint so workers target the right form factor.
const PROJECT_TYPES = ['web', 'ios', 'api'];
const projectTypeSel = document.getElementById('project-type');
let projectType = (() => {
  const saved = localStorage.getItem('hive.projectType');
  return PROJECT_TYPES.includes(saved) ? saved : 'web';
})();
function applyProjectType(t) {
  projectType = t;
  localStorage.setItem('hive.projectType', t);
  projectTypeSel.value = t;
  document.body.classList.remove('ptype-web', 'ptype-ios', 'ptype-api');
  document.body.classList.add('ptype-' + t);
  resizeAnnotCanvas();
}
projectTypeSel.addEventListener('change', () => applyProjectType(projectTypeSel.value));
// Initial apply is deferred until after annotCanvas is initialized further
// down — calling resizeAnnotCanvas() here hits a TDZ on `const annotCanvas`
// and halts the rest of the script (including the advisors panel wiring).

// Auto-bump project type when user scaffolds a template that implies one.
const TPL_TO_TYPE = { 'expo-rn': 'ios', 'html-spa': 'web', 'react-vite': 'web', 'express-api': 'api' };
const _origScaffold = window.hive.scaffoldTemplate;
window.hive.scaffoldTemplate = async (workerId, tplName, projectName) => {
  const r = await _origScaffold(workerId, tplName, projectName);
  if (r?.ok && TPL_TO_TYPE[tplName]) applyProjectType(TPL_TO_TYPE[tplName]);
  return r;
};

// Prefix the user's task with a project-type hint so Manager + workers know
// the target form factor without a separate IPC parameter.
const _origRunTask = window.hive.runTask;
window.hive.runTask = (task, imageDataUrl) => {
  const hint = projectType === 'ios'
    ? '[project: iOS app — design for 375×812 mobile viewport, iOS-style components, RN/Expo if scaffolded]\n'
    : projectType === 'api'
      ? '[project: API service — JSON endpoints, no UI]\n'
      : '';
  return _origRunTask(hint + task, imageDataUrl);
};

// ---- annotation overlay ---------------------------------------------------
// Canvas sits on top of the preview iframe. User toggles drawing on, draws
// strokes, optionally types a comment, sends → packs strokes as PNG and
// fires a follow-up runTask with the image attached. Worker sees redlines.
const annotCanvas = document.getElementById('annot-canvas');
const annotCtx = annotCanvas.getContext('2d');
const annotToggleBtn = document.getElementById('annot-toggle');
const annotClearBtn = document.getElementById('annot-clear');
const annotSendBtn = document.getElementById('annot-send');
const annotCommentRow = document.getElementById('annot-comment-row');
const annotCommentInput = document.getElementById('annot-comment');
const annotWorkerSel = document.getElementById('annot-worker');
let annotDrawing = false;
let annotHasStrokes = false;
let annotMode = false;

// Now that annotCanvas exists, do the initial project-type apply that we
// deferred earlier. Calling it here lets resizeAnnotCanvas() touch the canvas
// safely.
applyProjectType(projectType);

function resizeAnnotCanvas() {
  const rect = annotCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  // Preserve any existing strokes during resize by snapshotting → drawing back
  const prev = annotHasStrokes ? annotCanvas.toDataURL() : null;
  const dpr = window.devicePixelRatio || 1;
  annotCanvas.width = rect.width * dpr;
  annotCanvas.height = rect.height * dpr;
  annotCtx.scale(dpr, dpr);
  annotCtx.lineCap = 'round';
  annotCtx.lineJoin = 'round';
  annotCtx.strokeStyle = '#ff3b30';
  annotCtx.lineWidth = 3;
  if (prev) {
    const img = new Image();
    img.onload = () => annotCtx.drawImage(img, 0, 0, rect.width, rect.height);
    img.src = prev;
  }
}
window.addEventListener('resize', resizeAnnotCanvas);
// First paint after layout settles
requestAnimationFrame(() => requestAnimationFrame(resizeAnnotCanvas));

function setAnnotMode(on) {
  annotMode = on;
  annotCanvas.classList.toggle('drawing', on);
  annotToggleBtn.style.background = on ? 'var(--accent)' : '';
  annotToggleBtn.style.color = on ? '#00171f' : '';
  annotToggleBtn.textContent = on ? '✎ drawing' : '✎ mark up';
  annotClearBtn.style.display = on ? 'inline-block' : 'none';
  annotSendBtn.style.display = on ? 'inline-block' : 'none';
  annotCommentRow.style.display = on ? 'flex' : 'none';
  if (on) resizeAnnotCanvas();
}
annotToggleBtn.addEventListener('click', () => setAnnotMode(!annotMode));
annotClearBtn.addEventListener('click', () => {
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  annotHasStrokes = false;
});

let annotPath = null;
annotCanvas.addEventListener('pointerdown', (e) => {
  if (!annotMode) return;
  annotCanvas.setPointerCapture(e.pointerId);
  annotDrawing = true;
  const r = annotCanvas.getBoundingClientRect();
  annotPath = { x: e.clientX - r.left, y: e.clientY - r.top };
  annotCtx.beginPath();
  annotCtx.moveTo(annotPath.x, annotPath.y);
});
annotCanvas.addEventListener('pointermove', (e) => {
  if (!annotDrawing) return;
  const r = annotCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  annotCtx.lineTo(x, y);
  annotCtx.stroke();
  annotHasStrokes = true;
});
annotCanvas.addEventListener('pointerup', () => { annotDrawing = false; });
annotCanvas.addEventListener('pointercancel', () => { annotDrawing = false; });

// Compose preview screenshot (iframe HTML rendered via html2canvas-style trick
// is heavy — instead we composite the iframe's srcdoc DataURL with the canvas
// strokes by drawing the iframe's body via getComputedStyle is impractical.
// Pragmatic approach: ship the strokes-only PNG plus the raw HTML in the
// comment so the worker can re-render and overlay mentally. Most cases the
// comment + strokes is enough; a worker reading the HTML it just wrote can
// map coordinates back.
async function sendAnnotation() {
  if (!annotHasStrokes && !annotCommentInput.value.trim()) {
    annotCommentInput.focus();
    return;
  }
  const comment = annotCommentInput.value.trim() || 'Address the redlines on the preview.';
  const targetWorker = annotWorkerSel.value;

  // Pack strokes as PNG with a transparent background so the worker can see
  // shape + position. Add a faint grid so coordinates make sense without the
  // underlying iframe content.
  const out = document.createElement('canvas');
  out.width = annotCanvas.width;
  out.height = annotCanvas.height;
  const octx = out.getContext('2d');
  octx.fillStyle = 'rgba(255,255,255,0.96)';
  octx.fillRect(0, 0, out.width, out.height);
  // Faint grid every 50 logical px for spatial reference
  octx.strokeStyle = 'rgba(0,0,0,0.08)';
  octx.lineWidth = 1;
  const dpr = window.devicePixelRatio || 1;
  for (let x = 0; x < out.width; x += 50 * dpr) {
    octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, out.height); octx.stroke();
  }
  for (let y = 0; y < out.height; y += 50 * dpr) {
    octx.beginPath(); octx.moveTo(0, y); octx.lineTo(out.width, y); octx.stroke();
  }
  octx.drawImage(annotCanvas, 0, 0);
  const dataUrl = out.toDataURL('image/png');

  const enriched = `[redline annotation on ${projectType} preview${targetWorker !== 'auto' ? ` — target ${targetWorker}` : ''}]\n${comment}\n\nThe attached image shows the user's drawn marks on the current preview. Coordinates are in screen pixels (375×812 viewport when iOS).`;

  micStatus.textContent = '✎ sending annotation…';
  try {
    const res = await window.hive.runTask(enriched, dataUrl);
    if (!res.ok) appendLog('M', '✗ ' + res.error);
    micStatus.textContent = '';
    // Reset overlay after dispatch
    annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
    annotHasStrokes = false;
    annotCommentInput.value = '';
    setAnnotMode(false);
  } catch (err) {
    micStatus.textContent = '✗ ' + err.message;
  }
}
annotSendBtn.addEventListener('click', sendAnnotation);
annotCommentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendAnnotation();
});

// ----- FXV advisors -----
// Chat-only domain specialists. Each persona has its own memory namespace
// seeded by `npm run seed:fxv`. Replies are grounded in retrieved sources
// and lint-checked for citations before they reach the user.

const advisorsModal = document.getElementById('advisors-modal');
const advisorsListEl = document.getElementById('advisors-list');
const advisorHeader = document.getElementById('advisor-header');
const advisorChat = document.getElementById('advisor-chat');
const advisorInput = document.getElementById('advisor-input');
const advisorSend = document.getElementById('advisor-send');

let advisorList = [];
let activeAdvisorId = null;
const advisorHistories = new Map(); // personaId -> [{role, content}]

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderAdvisorList() {
  advisorsListEl.innerHTML = advisorList.map(a => {
    const color = PERSONA_COLOR[a.id] || 'var(--accent)';
    return `
    <div class="advisor-row${a.id === activeAdvisorId ? ' active' : ''}" data-id="${a.id}" data-color="${color}" style="padding:8px 14px;cursor:pointer;border-left:3px solid transparent;">
      <div style="font-size:12px;color:${color};font-weight:600;letter-spacing:0.3px;">${escapeHtml(a.name)}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px;line-height:1.4;">${escapeHtml(a.title)}</div>
    </div>
  `;
  }).join('');
  advisorsListEl.querySelectorAll('.advisor-row').forEach(row => {
    row.addEventListener('click', () => selectAdvisor(row.dataset.id));
  });
}

function selectAdvisor(id) {
  activeAdvisorId = id;
  const a = advisorList.find(x => x.id === id);
  const color = PERSONA_COLOR[id] || 'var(--accent)';
  advisorsListEl.querySelectorAll('.advisor-row').forEach(r => {
    const rowColor = r.dataset.color || 'var(--accent)';
    r.classList.toggle('active', r.dataset.id === id);
    r.style.background = r.dataset.id === id ? 'var(--panel)' : '';
    r.style.borderLeftColor = r.dataset.id === id ? rowColor : 'transparent';
  });
  if (a) {
    advisorHeader.innerHTML = `<span style="color:${color};font-weight:600;">${escapeHtml(a.name)}</span> <span style="color:var(--muted);">— ${escapeHtml(a.scope)}</span>`;
  } else {
    advisorHeader.textContent = '';
  }
  renderAdvisorChat();
  advisorInput.focus();
}

function renderAdvisorChat() {
  if (!activeAdvisorId) { advisorChat.innerHTML = '<div style="color:var(--muted);font-size:12px;">Select an advisor to start.</div>'; return; }
  const hist = advisorHistories.get(activeAdvisorId) ?? [];
  if (hist.length === 0) {
    advisorChat.innerHTML = '<div style="color:var(--muted);font-size:12px;">No conversation yet — ask a question below.</div>';
    return;
  }
  advisorChat.innerHTML = hist.map(m => {
    if (m.role === 'user') {
      return `<div style="align-self:flex-end;max-width:75%;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:12px;line-height:1.5;color:var(--text);">${escapeHtml(m.content)}</div>`;
    }
    const sourcesHtml = m.sources && m.sources.length
      ? `<div style="margin-top:8px;font-size:10px;color:var(--muted);"><div style="text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">sources</div>${m.sources.map(s => `<div>[${s.index}] ${escapeHtml(s.label)} <span style="opacity:0.6;">(score ${s.score.toFixed(2)})</span></div>`).join('')}</div>`
      : '';
    const warning = m.citationMissingCount > 0
      ? `<div style="margin-top:6px;font-size:10px;color:var(--error,#ff7777);">⚠ ${m.citationMissingCount} claim(s) without citation — answer may be partly ungrounded.</div>`
      : '';
    const replyColor = PERSONA_COLOR[activeAdvisorId] || 'var(--accent)';
    const pinBtn = `<a href="#" class="pin-reply-btn" data-content="${encodeURIComponent(m.content)}" style="position:absolute;top:6px;right:8px;color:var(--muted);text-decoration:none;font-size:11px;opacity:0.5;" title="Pin to brainstorm">◎ pin</a>`;
    return `<div style="position:relative;align-self:flex-start;max-width:85%;background:rgba(0,42,58,0.4);border:1px solid var(--border-strong);border-left:3px solid ${replyColor};border-radius:6px;padding:10px 28px 10px 14px;font-size:12px;line-height:1.55;color:var(--text);white-space:pre-wrap;">${pinBtn}${escapeHtml(m.content)}${sourcesHtml}${warning}</div>`;
  }).join('');
  advisorChat.scrollTop = advisorChat.scrollHeight;
}

async function loadAdvisors() {
  const res = await window.hive.listAdvisors();
  if (res && res.ok) {
    advisorList = res.advisors;
    renderAdvisorList();
    if (!activeAdvisorId && advisorList.length) selectAdvisor(advisorList[0].id);
    paintAdvisorGrid();
    paintPageBar();
  } else {
    advisorsListEl.innerHTML = `<div style="padding:14px;font-size:11px;color:var(--error,#ff7777);">Failed to load advisors: ${escapeHtml((res && res.error) || 'unknown')}</div>`;
  }
}

// Render the 4 page pills across the top. Click a pill → open the advisor
// modal pre-selected on that page agent.
function paintPageBar() {
  const wrap = document.getElementById('page-bar-buttons');
  if (!wrap) return;
  const pages = PAGE_AGENTS_ORDER
    .map(id => advisorList.find(a => a.id === id))
    .filter(Boolean);
  if (pages.length === 0) {
    wrap.innerHTML = '<span style="font-size:11px;color:var(--muted);">no page agents loaded</span>';
    return;
  }
  wrap.innerHTML = pages.map(p => {
    const color = PERSONA_COLOR[p.id] || 'var(--accent)';
    return `
      <button class="page-pill" data-id="${p.id}" style="--page-color:${color};font-family:inherit;color:var(--text);">
        <span class="page-pill-name">${escapeHtml(p.name.toUpperCase())}</span>
        <span class="page-pill-hint">tap to chat →</span>
      </button>
    `;
  }).join('');
  wrap.querySelectorAll('.page-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      advisorsModal.style.display = 'flex';
      selectAdvisor(btn.dataset.id);
    });
  });
}

// Rewrite each grid cell as a chat surface for its mapped specialist. Hides
// shipping-era buttons (cancel / override / diff) and makes the whole cell
// clickable to open the advisor modal pre-selected on that persona.
function paintAdvisorGrid() {
  for (const [cellId, personaId] of Object.entries(CELL_TO_PERSONA)) {
    const persona = advisorList.find(p => p.id === personaId);
    const cell = cells.get(cellId);
    if (!persona || !cell) continue;

    const isLead = !!persona.isManager;
    cell.el.classList.add('advisor-cell');
    if (isLead) cell.el.classList.add('advisor-lead');

    const color = PERSONA_COLOR[persona.id] || 'var(--accent)';
    cell.el.style.setProperty('--persona-color', color);

    // Rebuild head: NAME + role-line. Drop status pill + buttons.
    const head = cell.el.querySelector('.head');
    if (head) {
      head.innerHTML = `
        <div class="id" style="color:${color};">${isLead ? '◆ ' : ''}${escapeHtml(persona.name.toUpperCase())}<span class="tag" style="color:${color};opacity:0.7;">${isLead ? 'programme lead' : 'specialist'}</span></div>
        <div style="font-size:10px;color:${color};text-transform:uppercase;letter-spacing:1px;opacity:0.85;">tap to chat →</div>
      `;
    }
    // Repurpose .task as the scope blurb.
    if (cell.taskEl) {
      cell.taskEl.classList.remove('empty');
      cell.taskEl.textContent = persona.scope;
      cell.taskEl.style.fontStyle = 'normal';
      cell.taskEl.style.opacity = '0.85';
    }
    // .log holds the most recent assistant reply preview.
    if (cell.logEl) {
      cell.logEl.textContent = '— no conversation yet —';
      cell.logEl.style.opacity = '0.55';
    }
    // Footer: turn count + a hint.
    const footer = cell.el.querySelector('.footstats');
    if (footer) {
      footer.innerHTML = `<span>${escapeHtml(persona.title)}</span><span><span class="advisor-turns">0</span> turns</span>`;
    }

    // Whole-cell click → open chat (avoiding text-select drag noise).
    cell.el.style.cursor = 'pointer';
    cell.el.addEventListener('click', (e) => {
      // Don't open the modal when text is being selected
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      advisorsModal.style.display = 'flex';
      selectAdvisor(persona.id);
    });
  }
}

// When a chat reply lands, mirror a preview onto the corresponding grid cell
// and bump its turn counter so the dashboard reflects activity.
function updateCellAfterReply(personaId, reply) {
  const cellId = Object.keys(CELL_TO_PERSONA).find(k => CELL_TO_PERSONA[k] === personaId);
  if (!cellId) return;
  const cell = cells.get(cellId);
  if (!cell) return;
  if (cell.logEl) {
    cell.logEl.textContent = reply.length > 220 ? reply.slice(0, 220) + '…' : reply;
    cell.logEl.style.opacity = '1';
  }
  const turnsEl = cell.el.querySelector('.advisor-turns');
  if (turnsEl) turnsEl.textContent = String((advisorHistories.get(personaId) ?? []).filter(m => m.role === 'assistant').length);
}

async function sendAdvisorMessage() {
  if (!activeAdvisorId) return;
  const q = advisorInput.value.trim();
  if (!q) return;
  const hist = advisorHistories.get(activeAdvisorId) ?? [];
  hist.push({ role: 'user', content: q });
  advisorHistories.set(activeAdvisorId, hist);
  advisorInput.value = '';
  renderAdvisorChat();

  // Show a placeholder while the model + retrieval run
  const thinkingNode = document.createElement('div');
  thinkingNode.style.cssText = 'align-self:flex-start;color:var(--muted);font-size:11px;font-style:italic;';
  thinkingNode.textContent = 'thinking…';
  advisorChat.appendChild(thinkingNode);
  advisorChat.scrollTop = advisorChat.scrollHeight;

  // Pass the prior turns (excluding the just-pushed user msg) so the
  // server-side retrieval query gets some pronoun context.
  const priorHistory = hist.slice(0, -1);
  try {
    const res = await window.hive.consultAdvisor(activeAdvisorId, q, priorHistory);
    thinkingNode.remove();
    if (res && res.ok) {
      hist.push({
        role: 'assistant',
        content: res.reply,
        sources: res.sources,
        citationMissingCount: res.citationMissingCount,
      });
    } else {
      hist.push({ role: 'assistant', content: `(error: ${(res && res.error) || 'unknown'})`, sources: [], citationMissingCount: 0 });
    }
    advisorHistories.set(activeAdvisorId, hist);
    renderAdvisorChat();
    const last = hist[hist.length - 1];
    if (last && last.role === 'assistant') {
      updateCellAfterReply(activeAdvisorId, last.content);
      window.__extractActionsFor(activeAdvisorId, q, last.content);
    }
  } catch (err) {
    thinkingNode.remove();
    hist.push({ role: 'assistant', content: `(error: ${err.message || err})`, sources: [], citationMissingCount: 0 });
    advisorHistories.set(activeAdvisorId, hist);
    renderAdvisorChat();
  }
}

// Delegated pin-button handler — assistant replies render with a ◎ pin
// link; clicking it pushes the reply to the brainstorm sidebar.
advisorChat.addEventListener('click', (e) => {
  const a = e.target.closest('.pin-reply-btn');
  if (!a) return;
  e.preventDefault();
  const content = decodeURIComponent(a.dataset.content || '');
  if (content && activeAdvisorId) {
    window.__pinAdvisorReply(activeAdvisorId, content);
    a.textContent = '✓ pinned';
    a.style.color = PERSONA_COLOR[activeAdvisorId] || 'var(--accent)';
    a.style.opacity = '1';
    setTimeout(() => { a.textContent = '◎ pin'; a.style.color = 'var(--muted)'; a.style.opacity = '0.5'; }, 1100);
  }
});

document.getElementById('open-advisors').addEventListener('click', (e) => {
  e.preventDefault();
  advisorsModal.style.display = 'flex';
  if (advisorList.length === 0) loadAdvisors();
});
// Paint the grid as soon as the renderer is ready — don't wait for the user
// to open the modal. listAdvisors() is a cheap JSON read on the main side.
loadAdvisors();

// ----- Brainstorm sidebar -----
// Persists pinned agent replies + free-form notes to localStorage so they
// survive restart. Each note: { id, ts, source: personaId|null, sourceName,
// content, agentReply (bool) }.

const BRAINSTORM_KEY = 'fxv.brainstorm.notes';
const BRAINSTORM_COLLAPSED_KEY = 'fxv.brainstorm.collapsed';
const brainstormEl = document.getElementById('brainstorm');
const brainstormListEl = document.getElementById('brainstorm-list');
const brainstormInput = document.getElementById('brainstorm-input');
const brainstormAddBtn = document.getElementById('brainstorm-add');
const brainstormCount = document.getElementById('brainstorm-count');
const brainstormToggle = document.getElementById('brainstorm-toggle');

function loadNotes() {
  try {
    const raw = localStorage.getItem(BRAINSTORM_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveNotes(notes) {
  localStorage.setItem(BRAINSTORM_KEY, JSON.stringify(notes));
}
function fmtTs(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderNotes() {
  const notes = loadNotes();
  brainstormCount.textContent = notes.length === 1 ? '1 note' : `${notes.length} notes`;
  if (notes.length === 0) {
    brainstormListEl.innerHTML = '<div class="brainstorm-empty">No notes yet. Save your own thought above, or pin an agent reply with ◎ from the chat panel.</div>';
    return;
  }
  brainstormListEl.innerHTML = notes.map(n => {
    const color = n.source ? (PERSONA_COLOR[n.source] || 'var(--accent)') : 'var(--muted)';
    const sourceName = n.sourceName || 'YOU';
    return `
      <div class="brainstorm-note" style="--note-color:${color};" data-id="${n.id}">
        <div class="note-meta">
          <span class="note-source">${escapeHtml(sourceName)}</span>
          <span>${fmtTs(n.ts)}</span>
        </div>
        <div class="note-body">${escapeHtml(n.content)}</div>
        <div class="note-actions">
          <a class="note-expand" data-id="${n.id}">expand</a>
          <a class="note-copy" data-id="${n.id}">copy</a>
          <a class="note-delete" data-id="${n.id}" style="color:var(--error);">delete</a>
        </div>
      </div>
    `;
  }).join('');
  brainstormListEl.querySelectorAll('.note-expand').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const note = brainstormListEl.querySelector(`.brainstorm-note[data-id="${a.dataset.id}"] .note-body`);
      if (note) {
        note.classList.toggle('expanded');
        a.textContent = note.classList.contains('expanded') ? 'collapse' : 'expand';
      }
    });
  });
  brainstormListEl.querySelectorAll('.note-copy').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const n = loadNotes().find(x => String(x.id) === a.dataset.id);
      if (n) {
        try { await navigator.clipboard.writeText(n.content); a.textContent = 'copied'; setTimeout(() => a.textContent = 'copy', 900); } catch {}
      }
    });
  });
  brainstormListEl.querySelectorAll('.note-delete').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.id;
      const next = loadNotes().filter(x => String(x.id) !== id);
      saveNotes(next);
      renderNotes();
    });
  });
}

function addNote(content, source = null, sourceName = null) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return;
  const notes = loadNotes();
  notes.unshift({
    id: Date.now(),
    ts: Date.now(),
    source,
    sourceName,
    content: trimmed,
  });
  saveNotes(notes);
  renderNotes();
}

brainstormAddBtn.addEventListener('click', () => {
  addNote(brainstormInput.value);
  brainstormInput.value = '';
  brainstormInput.focus();
});
brainstormInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    addNote(brainstormInput.value);
    brainstormInput.value = '';
  }
});

brainstormToggle.addEventListener('click', (e) => {
  e.preventDefault();
  brainstormEl.classList.toggle('collapsed');
  const collapsed = brainstormEl.classList.contains('collapsed');
  localStorage.setItem(BRAINSTORM_COLLAPSED_KEY, collapsed ? '1' : '0');
  brainstormToggle.textContent = collapsed ? '»' : '«';
});
if (localStorage.getItem(BRAINSTORM_COLLAPSED_KEY) === '1') {
  brainstormEl.classList.add('collapsed');
  brainstormToggle.textContent = '»';
}

renderNotes();

// ----- Brainstorm: ACTIONS tab -----
// Auto-extracted from agent replies via Haiku. Stored alongside notes.

const ACTIONS_KEY = 'fxv.brainstorm.actions';
const ACTIONS_SORT_KEY = 'fxv.brainstorm.actions.sort';
const URGENCY_RANK = { high: 0, critical: 0, medium: 1, low: 2 };
const actionsListEl = document.getElementById('actions-list');
const bsCountNotes = document.getElementById('bs-count-notes');
const bsCountActions = document.getElementById('bs-count-actions');
const actionsClearDone = document.getElementById('actions-clear-done');
const actionsSortToggle = document.getElementById('actions-sort-toggle');

function getActionsSort() {
  return localStorage.getItem(ACTIONS_SORT_KEY) === 'priority' ? 'priority' : 'newest';
}
function setActionsSort(mode) {
  localStorage.setItem(ACTIONS_SORT_KEY, mode);
  if (actionsSortToggle) actionsSortToggle.textContent = `sort: ${mode}`;
}

function loadActions() {
  try {
    const raw = localStorage.getItem(ACTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveActions(actions) {
  localStorage.setItem(ACTIONS_KEY, JSON.stringify(actions));
}

function renderActions() {
  const actions = loadActions();
  const open = actions.filter(a => a.status !== 'done').length;
  bsCountActions.textContent = open;
  if (actions.length === 0) {
    actionsListEl.innerHTML = '<div class="brainstorm-empty">No actions yet. They\'ll auto-appear when an agent reply suggests one.</div>';
    return;
  }
  // Open actions first, then done at bottom. Within each, sort by chosen mode.
  const mode = getActionsSort();
  const sorted = [...actions].sort((a, b) => {
    if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
    if (mode === 'priority') {
      const ra = URGENCY_RANK[a.urgency] ?? 1;
      const rb = URGENCY_RANK[b.urgency] ?? 1;
      if (ra !== rb) return ra - rb;
    }
    return (b.ts || 0) - (a.ts || 0);
  });
  actionsListEl.innerHTML = sorted.map(a => {
    const color = a.source ? (PERSONA_COLOR[a.source] || 'var(--accent)') : 'var(--muted)';
    const sourceName = a.sourceName || 'YOU';
    const urgClass = `action-urgency-${a.urgency || 'medium'}`;
    return `
      <div class="action-item ${a.status === 'done' ? 'done' : ''}" data-id="${a.id}" style="--note-color:${color};">
        <input type="checkbox" class="action-checkbox" data-id="${a.id}" ${a.status === 'done' ? 'checked' : ''} title="Mark done (stays in list, struck through)" />
        <div class="action-body">
          <div class="action-summary">${escapeHtml(a.summary)}</div>
          <div class="action-meta">
            <span class="action-source">${escapeHtml(sourceName)}</span>
            <span class="${urgClass}">${escapeHtml((a.urgency || 'medium').toUpperCase())}</span>
          </div>
        </div>
        <a class="action-delete" data-id="${a.id}" title="Delete this action">✕</a>
      </div>
    `;
  }).join('');
  actionsListEl.querySelectorAll('.action-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = cb.dataset.id;
      const next = loadActions().map(x =>
        String(x.id) === id ? { ...x, status: cb.checked ? 'done' : 'todo' } : x
      );
      saveActions(next);
      renderActions();
    });
  });
  actionsListEl.querySelectorAll('.action-delete').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.id;
      const next = loadActions().filter(x => String(x.id) !== id);
      saveActions(next);
      renderActions();
    });
  });
}

function normalizeActionText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^fix\s+(high|medium|low|critical)\s*:\s*/i, '')
    .replace(/^(fix|add|implement|create|update|build|make|set\s*up|setup|configure|ensure|need\s+to|should|must|consider|try\s+to)\s+/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addAction(summary, urgency, source = null, sourceName = null) {
  const t = String(summary || '').trim();
  if (!t) return;
  const actions = loadActions();
  // Global dedupe across all sources. Catches: identical text, same intent
  // with different verb prefixes, and substring overlaps (one wording
  // contains the other). Length floor of 12 chars on substring guard so
  // "add login" doesn't dedupe against "add login button to settings".
  const norm = normalizeActionText(t);
  if (!norm) return;
  const exists = actions.some(x => {
    const xn = normalizeActionText(x.summary);
    if (!xn) return false;
    if (xn === norm) return true;
    if (norm.length >= 12 && xn.length >= 12 && (xn.includes(norm) || norm.includes(xn))) return true;
    return false;
  });
  if (exists) return;
  actions.unshift({
    id: Date.now() + Math.random(),
    ts: Date.now(),
    source,
    sourceName,
    summary: t,
    urgency: urgency || 'medium',
    status: 'todo',
  });
  saveActions(actions);
  renderActions();
}

actionsClearDone.addEventListener('click', (e) => {
  e.preventDefault();
  const next = loadActions().filter(a => a.status !== 'done');
  saveActions(next);
  renderActions();
});

if (actionsSortToggle) {
  actionsSortToggle.textContent = `sort: ${getActionsSort()}`;
  actionsSortToggle.addEventListener('click', (e) => {
    e.preventDefault();
    setActionsSort(getActionsSort() === 'priority' ? 'newest' : 'priority');
    renderActions();
  });
}

// Tab switching.
document.querySelectorAll('.bs-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bs-tab').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    document.getElementById('bs-pane-notes').style.display = tab === 'notes' ? 'flex' : 'none';
    document.getElementById('bs-pane-actions').style.display = tab === 'actions' ? 'flex' : 'none';
    document.getElementById('bs-pane-alerts').style.display = tab === 'alerts' ? 'flex' : 'none';
  });
});

// Update notes-tab count when renderNotes runs.
const _origRenderNotes = renderNotes;
renderNotes = function() {
  _origRenderNotes();
  bsCountNotes.textContent = loadNotes().length;
};
// One-shot cleanup of existing duplicates in localStorage. Keeps the oldest
// entry per cluster, preserves 'done' if any duplicate had it.
(function cleanupDuplicateActions() {
  const actions = loadActions();
  if (actions.length < 2) return;
  const sorted = [...actions].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const kept = [];
  let removed = 0;
  for (const a of sorted) {
    const norm = normalizeActionText(a.summary);
    if (!norm) { kept.push(a); continue; }
    const dup = kept.find(k => {
      const kn = normalizeActionText(k.summary);
      if (!kn) return false;
      if (kn === norm) return true;
      if (norm.length >= 12 && kn.length >= 12 && (kn.includes(norm) || norm.includes(kn))) return true;
      return false;
    });
    if (dup) {
      if (a.status === 'done' && dup.status !== 'done') dup.status = 'done';
      removed++;
    } else {
      kept.push(a);
    }
  }
  if (removed > 0) {
    kept.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    saveActions(kept);
    console.log(`[actions] cleaned up ${removed} duplicate${removed === 1 ? '' : 's'}`);
  }
})();

renderActions();
bsCountNotes.textContent = loadNotes().length;

// ----- ALERTS tab -----
// Reads from the SQLite alerts table populated by main-process pollers.
// Each alert: severity, source (github/sentry/supabase/asc), title, body,
// optional file_hint + persona_id, link out to the source.

const alertsListEl = document.getElementById('alerts-list');
const bsCountAlerts = document.getElementById('bs-count-alerts');
const alertsConfigStatus = document.getElementById('alerts-config-status');
const alertsPollNow = document.getElementById('alerts-poll-now');
let alertCache = [];

const SOURCE_BADGE = {
  github:   { label: 'GH', bg: '#1f2a37', fg: '#e2e8f0' },
  sentry:   { label: 'SY', bg: '#3b1d4f', fg: '#e9d5ff' },
  supabase: { label: 'SB', bg: '#0c4a3a', fg: '#a7f3d0' },
  asc:      { label: 'AC', bg: '#1e3a5f', fg: '#bfdbfe' },
};
const SEVERITY_COLOR = {
  red:    '#f87171',
  amber:  '#fbbf24',
  yellow: '#facc15',
  info:   '#94a3b8',
};

async function refreshAlerts() {
  try {
    const res = await window.hive.listAlerts('open');
    if (res && res.ok) {
      alertCache = res.alerts || [];
      renderAlerts();
    }
  } catch { /* fine */ }
}

function renderAlerts() {
  bsCountAlerts.textContent = alertCache.length;
  if (alertCache.length === 0) {
    alertsListEl.innerHTML = '<div class="brainstorm-empty">No alerts. Connected sources will populate as bugs land.</div>';
    return;
  }
  alertsListEl.innerHTML = alertCache.map(a => {
    const sev = SEVERITY_COLOR[a.severity] || SEVERITY_COLOR.info;
    const src = SOURCE_BADGE[a.source] || { label: a.source.toUpperCase().slice(0,2), bg: 'var(--panel-2)', fg: 'var(--muted)' };
    const personaColor = a.persona_id ? (PERSONA_COLOR[a.persona_id] || 'var(--accent)') : 'var(--muted)';
    const persona = a.persona_id ? advisorList.find(x => x.id === a.persona_id) : null;
    const personaName = persona ? persona.name : (a.persona_id ? a.persona_id : null);
    const fileLine = a.file_hint
      ? `<div style="font-size:9px;color:var(--muted);">📎 ${escapeHtml(a.file_hint)}</div>`
      : '';
    const personaPill = personaName
      ? `<span style="font-size:9px;background:var(--panel-2);color:${personaColor};padding:1px 6px;border-radius:8px;border:1px solid ${personaColor};">${escapeHtml(personaName)}</span>`
      : '';
    const bodyHtml = a.body
      ? `<div class="alert-body" style="font-size:10px;color:var(--muted);max-height:3em;overflow:hidden;line-height:1.4;white-space:pre-wrap;">${escapeHtml(a.body.slice(0, 300))}${a.body.length > 300 ? '…' : ''}</div>`
      : '';
    const askBtn = persona
      ? `<a href="#" class="alert-ask" data-id="${a.id}" data-persona="${a.persona_id}" data-context="${encodeURIComponent('I just got an alert in your domain:\n\nTITLE: ' + a.title + '\n\nBODY: ' + (a.body || '(no body)'))}" style="color:var(--accent);text-decoration:none;font-size:9px;">ask ${escapeHtml(personaName)}</a>`
      : '';
    const linkBtn = a.url
      ? `<a href="${escapeHtml(a.url)}" target="_blank" style="color:var(--muted);text-decoration:none;font-size:9px;">open ↗</a>`
      : '';
    return `
      <div class="brainstorm-note" style="--note-color:${sev};" data-id="${a.id}">
        <div class="note-meta" style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="background:${src.bg};color:${src.fg};font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:0.5px;">${src.label}</span>
            <span style="color:${sev};font-size:9px;font-weight:700;letter-spacing:0.5px;">${(a.severity || 'info').toUpperCase()}</span>
            ${personaPill}
          </div>
          <span style="font-size:9px;">${fmtTs(a.ts)}</span>
        </div>
        <div style="font-size:11px;line-height:1.4;color:var(--text);font-weight:500;word-break:break-word;">${escapeHtml(a.title)}</div>
        ${fileLine}
        ${bodyHtml}
        <div class="note-actions">
          ${askBtn}
          ${linkBtn}
          <a href="#" class="alert-ack" data-id="${a.id}" style="color:var(--muted);">ack</a>
          <a href="#" class="alert-delete" data-id="${a.id}" style="color:var(--error);">delete</a>
        </div>
      </div>
    `;
  }).join('');

  alertsListEl.querySelectorAll('.alert-ack').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.hive.ackAlert(Number(a.dataset.id));
      refreshAlerts();
    });
  });
  alertsListEl.querySelectorAll('.alert-delete').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.hive.deleteAlert(Number(a.dataset.id));
      refreshAlerts();
    });
  });
  alertsListEl.querySelectorAll('.alert-ask').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const personaId = a.dataset.persona;
      const context = decodeURIComponent(a.dataset.context || '');
      // Open the advisor modal pre-loaded with the alert as the user message.
      advisorsModal.style.display = 'flex';
      selectAdvisor(personaId);
      advisorInput.value = context + '\n\nWhat does this mean and what should I do?';
      advisorInput.focus();
    });
  });
}

async function refreshAlertsConfig() {
  try {
    const cfg = await window.hive.alertsConfig();
    if (!cfg) { alertsConfigStatus.textContent = 'config unavailable'; return; }
    const sources = [];
    if (cfg.github) sources.push('GH');
    if (cfg.sentry) sources.push('Sentry');
    if (cfg.supabase) sources.push('Supabase');
    if (cfg.asc) sources.push('ASC');
    alertsConfigStatus.textContent = sources.length
      ? `Sources: ${sources.join(' · ')}`
      : 'No sources wired — set GITHUB_TOKEN / SENTRY_AUTH_TOKEN in .env';
  } catch { alertsConfigStatus.textContent = ''; }
}

alertsPollNow.addEventListener('click', async (e) => {
  e.preventDefault();
  alertsPollNow.textContent = 'polling…';
  try {
    await window.hive.pollAlertsNow();
    await refreshAlerts();
  } finally {
    alertsPollNow.textContent = 'poll now';
  }
});

window.hive.onAlertEvent(async (evt) => {
  if (!evt) return;
  if (evt.type === 'new-alerts' && evt.count > 0) {
    await refreshAlerts();
    // Auto-push high-severity alerts as actions.
    const highSev = alertCache.filter(a =>
      a.severity === 'red' && evt.alertIds && evt.alertIds.includes(a.id)
    );
    for (const a of highSev) {
      const persona = a.persona_id ? advisorList.find(x => x.id === a.persona_id) : null;
      addAction(`Fix ${a.severity.toUpperCase()}: ${a.title.slice(0, 80)}`, 'high', a.persona_id, persona ? persona.name : (a.source || null));
    }
    // Visual nudge — flash the ALERTS tab counter.
    bsCountAlerts.style.transition = 'background 0.4s';
    bsCountAlerts.style.background = SEVERITY_COLOR.red;
    setTimeout(() => { bsCountAlerts.style.background = ''; }, 1200);
  } else if (evt.type === 'poll-result') {
    // Optional: log poll-source results to alerts-config-status briefly
    if (evt.result && evt.result.error && !evt.result.error.includes('not set')) {
      // Surface real errors, but ignore "not set" (just means env var missing).
      console.warn('[alerts] poll', evt.result.source, evt.result.error);
    }
  }
});

refreshAlertsConfig();
refreshAlerts();

// Hook: after every advisor reply, fire-and-forget extract actions.
window.__extractActionsFor = async (personaId, question, reply) => {
  const persona = advisorList.find(a => a.id === personaId);
  const personaName = persona ? persona.name : personaId;
  try {
    const res = await window.hive.extractActions(question, reply, personaName);
    if (res && res.ok && Array.isArray(res.actions)) {
      for (const act of res.actions) {
        addAction(act.summary, act.urgency, personaId, personaName);
      }
    }
  } catch { /* fire-and-forget */ }
};

// Expose pinAdvisorReply so the modal chat renderer can call it.
window.__pinAdvisorReply = (personaId, content) => {
  const persona = advisorList.find(a => a.id === personaId);
  addNote(content, personaId, persona ? persona.name : null);
  // Visual nudge: briefly flash the brainstorm header
  const head = brainstormEl.querySelector('.brainstorm-head strong');
  if (head) {
    const orig = head.style.color;
    head.style.color = PERSONA_COLOR[personaId] || 'var(--accent)';
    setTimeout(() => { head.style.color = orig; }, 600);
  }
};

// ----- Council mode -----
const councilModal = document.getElementById('council-modal');
const councilGrid = document.getElementById('council-grid');
const councilSynth = document.getElementById('council-synth');
const councilQuestionEl = document.getElementById('council-question');
const councilBtn = document.getElementById('council-run');
let councilRunning = false;

function renderCouncilLoading(question) {
  councilQuestionEl.textContent = `“${question.length > 80 ? question.slice(0, 80) + '…' : question}”`;
  councilSynth.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic;">Programme Lead will synthesise once every specialist replies…</div>';
  // Show all advisor specialists + page agents as pending cards
  const pending = advisorList.filter(a => !a.isManager);
  councilGrid.innerHTML = pending.map(p => {
    const color = PERSONA_COLOR[p.id] || 'var(--accent)';
    return `<div data-id="${p.id}" style="background:var(--panel-2);border:1px solid var(--border);border-left:3px solid ${color};border-radius:6px;padding:10px 14px;display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="color:${color};font-size:12px;">${escapeHtml(p.name)}</strong>
        <span style="font-size:9px;color:var(--muted);font-style:italic;">thinking…</span>
      </div>
    </div>`;
  }).join('');
}

function renderCouncilFinal(result) {
  councilQuestionEl.textContent = `“${result.question.length > 80 ? result.question.slice(0, 80) + '…' : result.question}”`;
  councilSynth.innerHTML = `
    <div style="font-size:9px;color:var(--manager,#c084fc);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">⟦ PROGRAMME LEAD SYNTHESIS ⟧</div>
    <div style="font-size:13px;line-height:1.6;color:var(--text);white-space:pre-wrap;">${escapeHtml(result.synthesis)}</div>
  `;
  councilGrid.innerHTML = (result.participants || []).map(p => {
    const color = PERSONA_COLOR[p.personaId] || 'var(--accent)';
    const sourcesHtml = (p.sources || []).length
      ? `<div style="margin-top:6px;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">sources</div>` +
        (p.sources || []).map(s => `<div style="font-size:10px;color:var(--muted);">[${s.index}] ${escapeHtml(s.label)}</div>`).join('')
      : '';
    const errorHtml = p.error ? `<div style="color:var(--error);font-size:11px;">error: ${escapeHtml(p.error)}</div>` : '';
    const replyHtml = p.reply ? `<div style="font-size:11px;line-height:1.55;color:var(--text);white-space:pre-wrap;">${escapeHtml(p.reply)}</div>` : '';
    return `
      <div style="background:var(--panel-2);border:1px solid var(--border);border-left:3px solid ${color};border-radius:6px;padding:10px 14px;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="color:${color};font-size:12px;">${escapeHtml(p.personaName)}</strong>
          <a href="#" class="council-pin" data-content="${encodeURIComponent(p.reply || '')}" data-id="${p.personaId}" style="color:var(--muted);text-decoration:none;font-size:10px;opacity:0.6;">◎ pin</a>
        </div>
        ${errorHtml}
        ${replyHtml}
        ${sourcesHtml}
      </div>
    `;
  }).join('');
  // Wire pin buttons
  councilGrid.querySelectorAll('.council-pin').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const content = decodeURIComponent(a.dataset.content || '');
      if (content) {
        window.__pinAdvisorReply(a.dataset.id, content);
        a.textContent = '✓ pinned';
        setTimeout(() => a.textContent = '◎ pin', 900);
      }
    });
  });
}

document.getElementById('close-council').addEventListener('click', (e) => {
  e.preventDefault();
  councilModal.style.display = 'none';
});
councilModal.addEventListener('click', (e) => {
  if (e.target === councilModal) councilModal.style.display = 'none';
});

councilBtn.addEventListener('click', async () => {
  if (councilRunning) return;
  const question = taskInput.value.trim();
  if (!question) {
    taskInput.focus();
    taskInput.placeholder = 'type a question first, then Council fans it to every specialist';
    setTimeout(() => taskInput.placeholder = 'Ask the Programme Lead, or hit Council to fan out to every specialist', 2200);
    return;
  }
  councilRunning = true;
  councilBtn.disabled = true;
  councilBtn.style.opacity = '0.5';
  councilModal.style.display = 'flex';
  renderCouncilLoading(question);
  try {
    const res = await window.hive.runCouncil(question);
    if (res && res.ok) {
      renderCouncilFinal(res);
      taskInput.value = '';
      // Extract actions from each agent's reply + the synthesis. Each
      // extraction is its own Haiku call but they fire in parallel and the
      // user doesn't wait for them — actions arrive a second or two later.
      for (const p of (res.participants || [])) {
        if (p.reply && p.reply.trim().length > 60) {
          window.__extractActionsFor(p.personaId, question, p.reply);
        }
      }
      if (res.synthesis && res.synthesis.trim().length > 60) {
        window.__extractActionsFor('fxv:manager', question, res.synthesis);
      }
    } else {
      councilSynth.innerHTML = `<div style="color:var(--error);font-size:12px;">Council failed: ${escapeHtml((res && res.error) || 'unknown')}</div>`;
    }
  } catch (err) {
    councilSynth.innerHTML = `<div style="color:var(--error);font-size:12px;">Council failed: ${escapeHtml(err.message || String(err))}</div>`;
  } finally {
    councilRunning = false;
    councilBtn.disabled = false;
    councilBtn.style.opacity = '';
  }
});

// ----- Ship-readiness audit -----
const shipAuditModal = document.getElementById('ship-audit-modal');
const shipAuditGrid = document.getElementById('ship-audit-grid');
const shipAuditStatus = document.getElementById('ship-audit-status');
const shipAuditRunBtn = document.getElementById('ship-audit-run');
const shipAuditOverall = document.getElementById('ship-audit-overall');
let shipAuditRunning = false;
const shipAuditState = new Map(); // personaId -> {status, blockers, mitigations, sources}

const STATUS_COLORS = {
  red:    { bg: 'rgba(248,113,113,0.18)', fg: '#fca5a5' },
  amber:  { bg: 'rgba(251,191,36,0.18)',  fg: '#fcd34d' },
  green:  { bg: 'rgba(74,222,128,0.18)',  fg: '#86efac' },
  unknown:{ bg: 'rgba(107,124,146,0.15)', fg: '#94a3b8' },
};

function renderShipAuditGrid() {
  const cards = Array.from(shipAuditState.entries()).map(([personaId, r]) => {
    const persona = advisorList.find(a => a.id === personaId);
    const personaColor = PERSONA_COLOR[personaId] || 'var(--accent)';
    const sc = STATUS_COLORS[r.status] || STATUS_COLORS.unknown;
    const statusLabel = r.status === 'unknown' ? '...' : r.status.toUpperCase();
    const blockers = (r.blockers || []).map(b => `<li>${escapeHtml(b)}</li>`).join('');
    const mits = (r.mitigations || []).map(b => `<li>${escapeHtml(b)}</li>`).join('');
    const errMsg = r.error ? `<div style="color:var(--error);font-size:10px;">error: ${escapeHtml(r.error)}</div>` : '';
    return `
      <div style="background:var(--panel-2);border:1px solid var(--border);border-left:3px solid ${personaColor};border-radius:6px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="color:${personaColor};font-size:12px;letter-spacing:0.5px;">${escapeHtml(persona ? persona.name : personaId)}</strong>
          <span style="background:${sc.bg};color:${sc.fg};font-size:9px;letter-spacing:1px;padding:3px 9px;border-radius:10px;font-weight:700;">${statusLabel}</span>
        </div>
        ${errMsg}
        ${blockers ? `<div><div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">blockers</div><ul style="margin:0;padding-left:18px;font-size:11px;line-height:1.5;color:var(--text);">${blockers}</ul></div>` : ''}
        ${mits ? `<div><div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">mitigations</div><ul style="margin:0;padding-left:18px;font-size:11px;line-height:1.5;color:var(--text);">${mits}</ul></div>` : ''}
      </div>
    `;
  }).join('');
  shipAuditGrid.innerHTML = cards || '<div style="color:var(--muted);font-size:11px;padding:20px;text-align:center;">Run an audit to populate.</div>';
}

function setShipOverall(status) {
  if (!status) { shipAuditOverall.style.display = 'none'; return; }
  const sc = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  shipAuditOverall.style.background = sc.bg;
  shipAuditOverall.style.color = sc.fg;
  shipAuditOverall.style.fontWeight = '700';
  shipAuditOverall.textContent = `OVERALL: ${status.toUpperCase()}`;
  shipAuditOverall.style.display = 'inline-block';
}

document.getElementById('open-ship-audit').addEventListener('click', (e) => {
  e.preventDefault();
  shipAuditModal.style.display = 'flex';
  if (shipAuditState.size === 0) {
    shipAuditGrid.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:20px;text-align:center;">Click RUN AUDIT to scan every agent. ~30-60s, ~£0.05.</div>';
  }
});
document.getElementById('close-ship-audit').addEventListener('click', (e) => {
  e.preventDefault();
  shipAuditModal.style.display = 'none';
});
shipAuditModal.addEventListener('click', (e) => {
  if (e.target === shipAuditModal) shipAuditModal.style.display = 'none';
});

window.hive.onShipAuditProgress((evt) => {
  if (!evt) return;
  if (evt.type === 'start') {
    shipAuditState.clear();
    setShipOverall(null);
    shipAuditStatus.textContent = `Auditing 0 / ${evt.total ?? '?'} agents...`;
    renderShipAuditGrid();
    return;
  }
  if (evt.type === 'agent-done' && evt.report) {
    shipAuditState.set(evt.report.personaId, evt.report);
    const done = shipAuditState.size;
    shipAuditStatus.textContent = `Auditing ${done} / ${shipAuditState.size + (evt.total ? evt.total - done : 0)} agents... (${evt.report.personaName} done)`;
    renderShipAuditGrid();
  }
});

shipAuditRunBtn.addEventListener('click', async () => {
  if (shipAuditRunning) return;
  shipAuditRunning = true;
  shipAuditState.clear();
  shipAuditRunBtn.disabled = true;
  shipAuditRunBtn.style.opacity = '0.5';
  shipAuditRunBtn.textContent = 'RUNNING...';
  shipAuditStatus.textContent = 'Asking every agent to audit their domain...';
  setShipOverall(null);
  renderShipAuditGrid();
  try {
    const res = await window.hive.runShipAudit();
    if (res && res.ok) {
      // Merge final reports (in case any progress events were missed).
      for (const r of (res.reports || [])) shipAuditState.set(r.personaId, r);
      setShipOverall(res.overall);
      const counts = { red: 0, amber: 0, green: 0, unknown: 0 };
      for (const r of (res.reports || [])) counts[r.status] = (counts[r.status] || 0) + 1;
      shipAuditStatus.textContent = `Done. ${counts.red} red · ${counts.amber} amber · ${counts.green} green${counts.unknown ? ' · ' + counts.unknown + ' unknown' : ''}`;
      renderShipAuditGrid();
    } else {
      shipAuditStatus.textContent = `Audit failed: ${(res && res.error) || 'unknown'}`;
    }
  } catch (err) {
    shipAuditStatus.textContent = `Audit failed: ${err.message || err}`;
  } finally {
    shipAuditRunning = false;
    shipAuditRunBtn.disabled = false;
    shipAuditRunBtn.style.opacity = '';
    shipAuditRunBtn.textContent = 'RUN AGAIN';
  }
});

// ----- Refresh memory button -----
const refreshLink = document.getElementById('refresh-seeds');
const refreshToast = document.getElementById('refresh-toast');
const refreshLog = document.getElementById('refresh-log');
const refreshClose = document.getElementById('refresh-close');
let refreshing = false;

window.hive.onRefreshSeedsLog((line) => {
  refreshLog.textContent += line + '\n';
  refreshLog.scrollTop = refreshLog.scrollHeight;
});
refreshClose.addEventListener('click', (e) => { e.preventDefault(); refreshToast.style.display = 'none'; });
refreshLink.addEventListener('click', async (e) => {
  e.preventDefault();
  if (refreshing) return;
  refreshing = true;
  refreshLog.textContent = '';
  refreshToast.style.display = 'block';
  refreshClose.style.display = 'none';
  refreshLink.style.opacity = '0.5';
  refreshLink.textContent = '↻ refreshing…';
  try {
    const res = await window.hive.refreshSeeds();
    if (res && res.ok) {
      const lines = [
        `[done] ${res.totalFiles} files, ${res.totalChunks} chunks`,
        '',
        ...res.perAgent.map(a => `  ${a.id.padEnd(22)}  ${String(a.files).padStart(3)}f  ${String(a.chunks).padStart(4)}c`),
      ];
      refreshLog.textContent += lines.join('\n');
      // Re-paint the grid since chunk counts may have changed.
      await loadAdvisors();
    } else {
      refreshLog.textContent += `\n[error] ${(res && res.error) || 'unknown'}`;
    }
  } catch (err) {
    refreshLog.textContent += `\n[error] ${err.message || err}`;
  } finally {
    refreshing = false;
    refreshLink.style.opacity = '';
    refreshLink.textContent = '↻ refresh memory';
    refreshClose.style.display = 'inline';
  }
});

// In FXV advise mode, the top input talks to the Programme Lead instead of
// dispatching to workers. We override window.hive.runTask so the existing
// runTask() handler keeps working (input clear, runtime clock, etc.) but
// the actual call routes to consultAdvisor.
if (document.body.classList.contains('mode-fxv-advise')) {
  const _origRunTaskAdvise = window.hive.runTask;
  window.hive.runTask = async (task, _imageDataUrl) => {
    const personaId = 'fxv:manager';
    // Open the modal so the user sees the conversation, then push the turn.
    advisorsModal.style.display = 'flex';
    if (advisorList.length === 0) await loadAdvisors();
    selectAdvisor(personaId);
    const hist = advisorHistories.get(personaId) ?? [];
    hist.push({ role: 'user', content: task });
    advisorHistories.set(personaId, hist);
    renderAdvisorChat();

    const thinking = document.createElement('div');
    thinking.style.cssText = 'align-self:flex-start;color:var(--muted);font-size:11px;font-style:italic;';
    thinking.textContent = 'Programme Lead is thinking…';
    advisorChat.appendChild(thinking);
    advisorChat.scrollTop = advisorChat.scrollHeight;

    try {
      const res = await window.hive.consultAdvisor(personaId, task, hist.slice(0, -1));
      thinking.remove();
      if (res && res.ok) {
        hist.push({
          role: 'assistant',
          content: res.reply,
          sources: res.sources,
          citationMissingCount: res.citationMissingCount,
        });
        updateCellAfterReply(personaId, res.reply);
        window.__extractActionsFor(personaId, task, res.reply);
      } else {
        hist.push({ role: 'assistant', content: `(error: ${(res && res.error) || 'unknown'})`, sources: [], citationMissingCount: 0 });
      }
      advisorHistories.set(personaId, hist);
      renderAdvisorChat();
      return { ok: true };
    } catch (err) {
      thinking.remove();
      return { ok: false, error: err.message || String(err) };
    }
  };
}
document.getElementById('close-advisors').addEventListener('click', (e) => {
  e.preventDefault();
  advisorsModal.style.display = 'none';
});
// Click on the dimmed backdrop (anywhere outside the inner panel) closes
// the modal. The inner panel is the modal's first element child.
advisorsModal.addEventListener('click', (e) => {
  if (e.target === advisorsModal) advisorsModal.style.display = 'none';
});
// Esc closes too.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && advisorsModal.style.display === 'flex') {
    advisorsModal.style.display = 'none';
  }
});
advisorSend.addEventListener('click', sendAdvisorMessage);
advisorInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendAdvisorMessage();
  }
});

// ----- Deploy modal -----
// Three panes (intent → plan → execute) plus a history pane. The plan pane
// is the safety gate: blockers prevent SHIP entirely, production requires
// typing the literal word "production" into a confirm input. The execute
// pane streams live log lines from the main process via DeployLog IPC.

const deployModal = document.getElementById('deploy-modal');
const deployStageEl = document.getElementById('deploy-stage');
const deployIntentInput = document.getElementById('deploy-intent-input');
const deployMessageInput = document.getElementById('deploy-message-input');
const deploySkipTypecheck = document.getElementById('deploy-skip-typecheck');
const deployPrepareBtn = document.getElementById('deploy-prepare-btn');
const deployPrepareLog = document.getElementById('deploy-prepare-log');
const deployShipBtn = document.getElementById('deploy-ship-btn');
const deployBackBtn = document.getElementById('deploy-back-btn');
const deployConfirmInput = document.getElementById('deploy-confirm-input');
const deployConfirmPrompt = document.getElementById('deploy-confirm-prompt');
const deployExecuteHeader = document.getElementById('deploy-execute-header');
const deployExecuteLog = document.getElementById('deploy-execute-log');
const deployExecuteStatus = document.getElementById('deploy-execute-status');
const deployExecuteFooter = document.getElementById('deploy-execute-footer');
const deployRollbackBtn = document.getElementById('deploy-rollback-btn');
const deployDoneBtn = document.getElementById('deploy-done-btn');
const deployHistoryLink = document.getElementById('deploy-history-link');
const deployHistoryList = document.getElementById('deploy-history-list');

const deployState = {
  channel: 'preview',
  plan: null,
  lastResult: null,
  busy: false,
};

function setDeployStage(stage) {
  deployStageEl.textContent = stage.toUpperCase();
  for (const p of document.querySelectorAll('#deploy-modal .deploy-pane')) p.style.display = 'none';
  const target = document.getElementById('deploy-pane-' + stage);
  if (target) target.style.display = 'flex';
}

function setDeployChannel(ch) {
  deployState.channel = ch;
  document.querySelectorAll('.deploy-channel-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.channel === ch);
  });
}
document.querySelectorAll('.deploy-channel-btn').forEach(btn => {
  btn.addEventListener('click', () => setDeployChannel(btn.dataset.channel));
});

document.getElementById('open-deploy').addEventListener('click', (e) => {
  e.preventDefault();
  deployModal.style.display = 'flex';
  setDeployStage('intent');
  // Default to preview every open — production should never be sticky.
  setDeployChannel('preview');
  deployIntentInput.focus();
});
document.getElementById('close-deploy').addEventListener('click', (e) => {
  e.preventDefault();
  deployModal.style.display = 'none';
});
deployModal.addEventListener('click', (e) => {
  if (e.target === deployModal) deployModal.style.display = 'none';
});

deployIntentInput.addEventListener('input', () => {
  const text = deployIntentInput.value.trim();
  if (!text || deployMessageInput.dataset.touched === '1') return;
  if (deployIntentInput._t) clearTimeout(deployIntentInput._t);
  deployIntentInput._t = setTimeout(async () => {
    try {
      const res = await window.hive.extractDeployIntent(text);
      if (!res || !res.ok) return;
      if (deployMessageInput.dataset.touched !== '1') {
        deployMessageInput.value = res.message || '';
      }
      // Pre-flip channel only if the user said "production" / "prod" — the
      // LLM doesn't get to silently escalate.
      if (res.llmGuessedProduction && deployState.channel !== 'production') {
        setDeployChannel('production');
      }
    } catch { /* fine */ }
  }, 700);
});
deployMessageInput.addEventListener('input', () => {
  deployMessageInput.dataset.touched = '1';
});
deployIntentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    deployPrepareBtn.click();
  }
});

let deployLogUnsub = null;
function attachDeployLog(target) {
  if (deployLogUnsub) try { deployLogUnsub(); } catch { /* fine */ }
  deployLogUnsub = window.hive.onDeployLog((line) => {
    if (!target) return;
    target.textContent += line + '\n';
    target.scrollTop = target.scrollHeight;
  });
}
function detachDeployLog() {
  if (deployLogUnsub) try { deployLogUnsub(); } catch { /* fine */ }
  deployLogUnsub = null;
}

deployPrepareBtn.addEventListener('click', async () => {
  if (deployState.busy) return;
  const message = (deployMessageInput.value || '').trim();
  if (!message) {
    deployMessageInput.focus();
    deployMessageInput.placeholder = 'message is required — what changed?';
    return;
  }
  deployState.busy = true;
  deployPrepareBtn.disabled = true;
  deployPrepareBtn.style.opacity = '0.5';
  deployPrepareBtn.textContent = 'PREPARING…';
  deployPrepareLog.style.display = 'block';
  deployPrepareLog.textContent = '';
  attachDeployLog(deployPrepareLog);
  try {
    const res = await window.hive.prepareDeploy({
      project: 'fxv',
      channel: deployState.channel,
      message,
      skipTypecheck: !!deploySkipTypecheck.checked,
    });
    detachDeployLog();
    if (!res || !res.ok) {
      deployPrepareLog.textContent += '\n[ERROR] ' + ((res && res.error) || 'unknown');
      return;
    }
    deployState.plan = res.plan;
    renderPlanPane(res.plan);
    setDeployStage('plan');
  } catch (err) {
    deployPrepareLog.textContent += '\n[ERROR] ' + (err.message || String(err));
  } finally {
    deployState.busy = false;
    deployPrepareBtn.disabled = false;
    deployPrepareBtn.style.opacity = '';
    deployPrepareBtn.textContent = 'PREPARE';
  }
});

function renderPlanPane(plan) {
  const headerEl = document.getElementById('deploy-plan-header');
  const channelColor = plan.channel === 'production' ? 'var(--error)' : 'var(--accent)';
  headerEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:10px;background:${channelColor};color:#00171f;padding:2px 10px;border-radius:10px;font-weight:700;letter-spacing:0.5px;">${escapeHtml(plan.channel.toUpperCase())}</span>
      <span style="font-size:13px;color:var(--text);font-weight:600;">"${escapeHtml(plan.message)}"</span>
    </div>
    <span style="font-size:10px;color:var(--muted);">plan ${plan.planId.slice(0, 12)} · ${Math.round((plan.expiresAt - Date.now()) / 1000)}s ttl</span>
  `;
  const preflightEl = document.getElementById('deploy-preflight-list');
  preflightEl.innerHTML = plan.preflight.map(c => {
    const cls = c.ok ? 'ok' : (c.blocking ? 'fail-blocking' : 'fail-warning');
    const icon = c.ok ? '✓' : (c.blocking ? '✗' : '⚠');
    const detail = c.detail ? '<div class="pf-detail">' + escapeHtml(c.detail) + '</div>' : '';
    return `<div class="deploy-preflight-row ${cls}"><span class="pf-icon">${icon}</span><div style="flex:1;"><span class="pf-name">${escapeHtml(c.name)}</span>${detail}</div></div>`;
  }).join('');
  document.getElementById('deploy-diff-summary').textContent = plan.diff.summary;
  document.getElementById('deploy-diff-meta').textContent = `${plan.diff.commitCount} commit(s), ${plan.diff.changedFiles.length} file(s) on ${plan.diff.branch} · since ${plan.diff.sinceSha ? plan.diff.sinceSha.slice(0, 8) : '(no prior ship on this channel)'} → ${plan.diff.toSha.slice(0, 8)}`;
  const rb = document.getElementById('deploy-rollback-prep');
  if (plan.rollbackPrep.captured) {
    rb.innerHTML = `<span style="color:var(--success,#4ade80);">✓</span> rollback target captured: <code style="font-size:10px;background:var(--panel-2);padding:2px 6px;border-radius:3px;">${escapeHtml(plan.rollbackPrep.previousGroupId.slice(0, 16))}…</code> — "${escapeHtml(plan.rollbackPrep.previousMessage || '(no message)')}"`;
  } else {
    rb.innerHTML = `<span style="color:var(--waiting);">⚠</span> no prior update group on this channel — rollback won't be available for this ship`;
  }
  const blockersWrap = document.getElementById('deploy-blockers-wrap');
  const warningsWrap = document.getElementById('deploy-warnings-wrap');
  if (plan.blockers.length) {
    blockersWrap.style.display = 'block';
    document.getElementById('deploy-blockers-list').innerHTML = plan.blockers.map(b => '<li>' + escapeHtml(b) + '</li>').join('');
  } else { blockersWrap.style.display = 'none'; }
  if (plan.warnings.length) {
    warningsWrap.style.display = 'block';
    document.getElementById('deploy-warnings-list').innerHTML = plan.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('');
  } else { warningsWrap.style.display = 'none'; }
  if (plan.channel === 'production') {
    deployConfirmInput.style.display = 'block';
    deployConfirmInput.value = '';
    deployConfirmInput.placeholder = 'type "production" to confirm';
    deployConfirmPrompt.innerHTML = '<span style="color:var(--error);font-weight:700;">PRODUCTION SHIP</span> — type the literal word <code>production</code> below to enable the SHIP button.';
  } else {
    deployConfirmInput.style.display = 'none';
    deployConfirmInput.value = 'ship';
    deployConfirmPrompt.textContent = 'PREVIEW ship — click SHIP to push. Hits the preview channel, not real users.';
  }
  updateShipButtonState();
}

function updateShipButtonState() {
  const plan = deployState.plan;
  if (!plan) return;
  const blocked = plan.blockers.length > 0;
  let confirmOk = true;
  if (plan.channel === 'production') {
    confirmOk = deployConfirmInput.value.trim().toLowerCase() === 'production';
  }
  deployShipBtn.disabled = blocked || !confirmOk;
  deployShipBtn.style.opacity = (blocked || !confirmOk) ? '0.4' : '';
  deployShipBtn.style.cursor = (blocked || !confirmOk) ? 'not-allowed' : 'pointer';
  deployShipBtn.textContent = blocked ? 'BLOCKED' : (plan.channel === 'production' ? 'SHIP TO PRODUCTION' : 'SHIP TO PREVIEW');
}
deployConfirmInput.addEventListener('input', updateShipButtonState);
deployBackBtn.addEventListener('click', () => setDeployStage('intent'));

deployShipBtn.addEventListener('click', async () => {
  if (deployState.busy) return;
  const plan = deployState.plan;
  if (!plan) return;
  const confirmation = plan.channel === 'production' ? deployConfirmInput.value.trim() : 'ship';
  setDeployStage('execute');
  deployExecuteHeader.innerHTML = `<span style="color:${plan.channel === 'production' ? 'var(--error)' : 'var(--accent)'};font-weight:700;">${escapeHtml(plan.channel.toUpperCase())}</span> · "${escapeHtml(plan.message)}" · plan ${plan.planId.slice(0, 12)}…`;
  deployExecuteLog.textContent = '';
  deployExecuteFooter.style.display = 'none';
  attachDeployLog(deployExecuteLog);
  deployState.busy = true;
  try {
    const res = await window.hive.executeDeploy({ planId: plan.planId, confirmation });
    detachDeployLog();
    deployState.lastResult = res;
    deployExecuteFooter.style.display = 'flex';
    if (res.ok) {
      const smokeMsg = res.smoke ? (res.smoke.ok ? `smoke OK (${res.smoke.detail})` : `smoke MISMATCH (${res.smoke.detail})`) : 'no smoke';
      deployExecuteStatus.innerHTML = `<span style="color:var(--success,#4ade80);font-weight:700;">✓ SHIPPED</span> in ${(res.durationMs / 1000).toFixed(1)}s — group <code style="font-size:10px;background:var(--panel-2);padding:1px 5px;border-radius:3px;">${escapeHtml(res.groupId ? res.groupId.slice(0, 12) + '…' : '?')}</code> — ${escapeHtml(smokeMsg)}`;
      if (plan.rollbackPrep.captured && plan.rollbackPrep.previousGroupId) {
        deployRollbackBtn.style.display = 'inline-block';
        deployRollbackBtn.textContent = 'ROLLBACK TO ' + plan.rollbackPrep.previousGroupId.slice(0, 8) + '…';
      }
    } else {
      deployExecuteStatus.innerHTML = `<span style="color:var(--error);font-weight:700;">✗ FAILED</span> — ${escapeHtml(res.error || 'unknown')}`;
    }
  } catch (err) {
    detachDeployLog();
    deployExecuteFooter.style.display = 'flex';
    deployExecuteStatus.innerHTML = `<span style="color:var(--error);font-weight:700;">✗ ERROR</span> — ${escapeHtml(err.message || String(err))}`;
  } finally {
    deployState.busy = false;
  }
});

deployRollbackBtn.addEventListener('click', async () => {
  if (deployState.busy) return;
  const plan = deployState.plan;
  if (!plan || !plan.rollbackPrep.previousGroupId) return;
  if (!confirm(`Rollback ${plan.channel} channel to group ${plan.rollbackPrep.previousGroupId.slice(0, 12)}…?\n\nMessage: "${plan.rollbackPrep.previousMessage || '(none)'}"\n\nThis re-publishes the previous update so users on the channel get it within a minute.`)) return;
  deployState.busy = true;
  deployRollbackBtn.disabled = true;
  deployExecuteLog.textContent += '\n--- ROLLBACK ---\n';
  attachDeployLog(deployExecuteLog);
  try {
    const res = await window.hive.rollbackDeploy({
      project: 'fxv',
      channel: plan.channel,
      toGroupId: plan.rollbackPrep.previousGroupId,
      reason: 'manual rollback from deploy modal after smoke/visual review',
    });
    detachDeployLog();
    if (res.ok) {
      deployExecuteStatus.innerHTML = `<span style="color:var(--success,#4ade80);font-weight:700;">✓ ROLLED BACK</span> in ${(res.durationMs / 1000).toFixed(1)}s — new group <code style="font-size:10px;background:var(--panel-2);padding:1px 5px;border-radius:3px;">${escapeHtml(res.groupId ? res.groupId.slice(0, 12) + '…' : '?')}</code>`;
      deployRollbackBtn.style.display = 'none';
    } else {
      deployExecuteStatus.innerHTML = `<span style="color:var(--error);font-weight:700;">✗ ROLLBACK FAILED</span> — ${escapeHtml(res.error || 'unknown')}`;
    }
  } catch (err) {
    detachDeployLog();
    deployExecuteStatus.innerHTML = `<span style="color:var(--error);font-weight:700;">✗ ROLLBACK ERROR</span> — ${escapeHtml(err.message || String(err))}`;
  } finally {
    deployState.busy = false;
    deployRollbackBtn.disabled = false;
  }
});

deployDoneBtn.addEventListener('click', () => { deployModal.style.display = 'none'; });

deployHistoryLink.addEventListener('click', async (e) => {
  e.preventDefault();
  setDeployStage('history');
  deployHistoryList.innerHTML = '<div style="font-size:11px;color:var(--muted);">loading…</div>';
  try {
    const res = await window.hive.listDeploys(30);
    if (!res || !res.ok) {
      deployHistoryList.innerHTML = `<div style="color:var(--error);font-size:11px;">Failed: ${escapeHtml((res && res.error) || 'unknown')}</div>`;
      return;
    }
    if (!res.deploys.length) {
      deployHistoryList.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:20px;">No deploy history yet.</div>';
      return;
    }
    deployHistoryList.innerHTML = res.deploys.map(d => {
      const ts = new Date(d.ts);
      const tsStr = `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
      const dur = d.durationMs ? `${(d.durationMs / 1000).toFixed(1)}s` : '?';
      const groupShort = d.groupId ? d.groupId.slice(0, 12) : '—';
      const errSnippet = d.error ? `<div style="color:var(--error);font-size:10px;margin-top:3px;">${escapeHtml(d.error.slice(0, 200))}</div>` : '';
      return `
        <div class="deploy-history-row ${d.status}">
          <div class="row-head">
            <span>${escapeHtml(d.kind.toUpperCase())} · ${escapeHtml(d.channel.toUpperCase())} · ${escapeHtml(d.status.toUpperCase())}</span>
            <span>${tsStr}</span>
          </div>
          <div class="row-msg">${escapeHtml(d.message)}</div>
          <div class="row-meta">group ${groupShort} · ${d.sha ? d.sha.slice(0, 8) : 'no-sha'} · ${dur}</div>
          ${errSnippet}
        </div>
      `;
    }).join('');
  } catch (err) {
    deployHistoryList.innerHTML = `<div style="color:var(--error);font-size:11px;">${escapeHtml(err.message || String(err))}</div>`;
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && deployModal.style.display === 'flex') {
    if (!deployState.busy) deployModal.style.display = 'none';
  }
});
