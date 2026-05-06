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
applyProjectType(projectType);

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
