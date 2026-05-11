// ════════════════════════════════════════════════════════════════════
// CANVAS VIEW (v3.0-β)
//
// Infinite canvas backed by Konva.js. Pan / zoom / pen / arrow / text /
// sticky / image / select / undo / redo. State is debounced-saved into
// the canvases table via SaveCanvas IPC. Images survive reload because
// each Konva.Image gets a `dataUrl` attr serialised with the rest.
//
// Bootstraps only when the sidebar's "Canvas" item is clicked. Initial
// stage size is set from the .ls-canvas-stage container; ResizeObserver
// keeps it in sync with window resizes.
// ════════════════════════════════════════════════════════════════════

(function canvasModule() {
  const SHELL = document.getElementById('ls-canvas-shell');
  const STAGE_HOST = document.getElementById('ls-canvas-stage');
  const TOOLBAR = document.getElementById('ls-canvas-toolbar');
  const RAIL_LIST = document.getElementById('ls-canvas-list');
  const NAME_INPUT = document.getElementById('ls-canvas-name');
  const ZOOM_LABEL = document.getElementById('ls-canvas-zoom');
  const STATUS_LABEL = document.getElementById('ls-canvas-status');
  const EMPTY = document.getElementById('ls-canvas-empty');
  if (!SHELL || !STAGE_HOST || typeof window.Konva === 'undefined') {
    window.__lsCanvas = {
      open: () => alert('Konva failed to load — canvas unavailable.'),
      close: () => {},
    };
    return;
  }

  const ACCENT = '#D4A574';
  const PEN_DEFAULT = '#F7F8F8';
  const STICKY_BG = '#3a3320';
  const STICKY_FG = '#F7F8F8';

  let stage = null;
  let layer = null;
  let transformer = null;
  let currentTool = 'select';
  let currentCanvasId = null;
  let currentCanvasName = '';
  let isPanning = false;
  let spaceHeld = false;
  let drawing = null;          // active Konva.Line | Konva.Arrow
  let saveTimer = null;
  let history = { past: [], future: [] };
  let suppressDirty = false;

  // ── Stage init / teardown ──────────────────────────────────────────

  function initStage() {
    if (stage) return;
    const rect = STAGE_HOST.getBoundingClientRect();
    stage = new Konva.Stage({
      container: STAGE_HOST,
      width: Math.max(100, rect.width),
      height: Math.max(100, rect.height),
      draggable: false,
    });
    layer = new Konva.Layer();
    stage.add(layer);
    transformer = new Konva.Transformer({
      rotateEnabled: true,
      borderStroke: ACCENT,
      borderStrokeWidth: 1,
      anchorStroke: ACCENT,
      anchorFill: '#08090A',
      anchorSize: 8,
      anchorCornerRadius: 2,
    });
    layer.add(transformer);

    wireStageEvents();
    wireResize();
  }

  function wireResize() {
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      const r = STAGE_HOST.getBoundingClientRect();
      stage.width(Math.max(100, r.width));
      stage.height(Math.max(100, r.height));
    });
    ro.observe(STAGE_HOST);
  }

  function wireStageEvents() {
    // Wheel zoom (zoom to cursor)
    stage.on('wheel', e => {
      e.evt.preventDefault();
      const scaleBy = 1.07;
      const oldScale = stage.scaleX();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const mousePointTo = {
        x: (pointer.x - stage.x()) / oldScale,
        y: (pointer.y - stage.y()) / oldScale,
      };
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
      const clamped = Math.max(0.1, Math.min(8, newScale));
      stage.scale({ x: clamped, y: clamped });
      stage.position({
        x: pointer.x - mousePointTo.x * clamped,
        y: pointer.y - mousePointTo.y * clamped,
      });
      updateZoomLabel();
    });

    // Mouse down — start drawing / panning / selecting
    stage.on('mousedown touchstart', e => {
      const isStageTarget = e.target === stage;
      const pointer = stage.getRelativePointerPosition();

      // Middle mouse OR space-held → pan
      if (e.evt && (e.evt.button === 1 || spaceHeld)) {
        isPanning = true;
        stage.draggable(true);
        STAGE_HOST.classList.add('panning');
        return;
      }

      if (currentTool === 'pen') {
        drawing = new Konva.Line({
          points: [pointer.x, pointer.y, pointer.x, pointer.y],
          stroke: PEN_DEFAULT,
          strokeWidth: 2,
          lineCap: 'round',
          lineJoin: 'round',
          tension: 0.4,
          draggable: false,
        });
        layer.add(drawing);
        return;
      }

      if (currentTool === 'arrow') {
        drawing = new Konva.Arrow({
          points: [pointer.x, pointer.y, pointer.x, pointer.y],
          stroke: ACCENT,
          fill: ACCENT,
          strokeWidth: 2,
          pointerLength: 10,
          pointerWidth: 10,
        });
        layer.add(drawing);
        return;
      }

      if (currentTool === 'text') {
        spawnText(pointer.x, pointer.y);
        return;
      }

      if (currentTool === 'sticky') {
        spawnSticky(pointer.x, pointer.y);
        return;
      }

      if (currentTool === 'eraser') {
        if (!isStageTarget) {
          const shape = e.target;
          if (shape !== transformer && !transformer.nodes().includes(shape)) {
            shape.destroy();
            transformer.nodes([]);
            markDirty(true);
          }
        }
        return;
      }

      // Select tool — clicking empty stage deselects.
      if (currentTool === 'select') {
        if (isStageTarget) {
          transformer.nodes([]);
        } else {
          const shape = e.target;
          if (shape === transformer || shape.getParent() === transformer) return;
          transformer.nodes([shape]);
        }
      }
    });

    stage.on('mousemove touchmove', () => {
      if (!drawing) return;
      const pointer = stage.getRelativePointerPosition();
      if (currentTool === 'pen') {
        const pts = drawing.points().concat([pointer.x, pointer.y]);
        drawing.points(pts);
      } else if (currentTool === 'arrow') {
        const pts = drawing.points();
        drawing.points([pts[0], pts[1], pointer.x, pointer.y]);
      }
    });

    stage.on('mouseup touchend', () => {
      if (isPanning) {
        isPanning = false;
        stage.draggable(false);
        STAGE_HOST.classList.remove('panning');
        return;
      }
      if (drawing) {
        drawing = null;
        markDirty(true);
      }
    });

    // Dragend on any selectable shape → save
    stage.on('dragend', e => {
      if (e.target === stage) return;
      markDirty(true);
    });

    // Transform end → save
    stage.on('transformend', () => markDirty(true));

    // Drag-and-drop images onto the stage host
    STAGE_HOST.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      STAGE_HOST.classList.add('dragover');
    });
    STAGE_HOST.addEventListener('dragleave', () => STAGE_HOST.classList.remove('dragover'));
    STAGE_HOST.addEventListener('drop', e => {
      STAGE_HOST.classList.remove('dragover');
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      e.preventDefault();
      const rect = STAGE_HOST.getBoundingClientRect();
      const stageScale = stage.scaleX();
      const dropX = (e.clientX - rect.left - stage.x()) / stageScale;
      const dropY = (e.clientY - rect.top - stage.y()) / stageScale;
      let offset = 0;
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = () => {
          spawnImage(reader.result, dropX + offset, dropY + offset);
          offset += 20;
        };
        reader.readAsDataURL(f);
      }
    });

    // Clipboard paste — accept images
    document.addEventListener('paste', e => {
      if (!isVisible()) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type?.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => spawnImage(reader.result, stageCenter().x, stageCenter().y);
          reader.readAsDataURL(file);
          e.preventDefault();
        }
      }
    });
  }

  function stageCenter() {
    const w = stage.width();
    const h = stage.height();
    return {
      x: (w / 2 - stage.x()) / stage.scaleX(),
      y: (h / 2 - stage.y()) / stage.scaleY(),
    };
  }

  function updateZoomLabel() {
    if (ZOOM_LABEL) ZOOM_LABEL.textContent = Math.round(stage.scaleX() * 100) + '%';
  }

  // ── Shape spawners ─────────────────────────────────────────────────

  function spawnImage(dataUrl, x, y) {
    const img = new Image();
    img.onload = () => {
      const max = 480;
      const ratio = img.width / img.height;
      const w = img.width > img.height ? Math.min(img.width, max) : Math.min(img.width, max * ratio);
      const h = w / ratio;
      const node = new Konva.Image({
        x: x - w / 2,
        y: y - h / 2,
        image: img,
        width: w,
        height: h,
        draggable: true,
      });
      node.setAttr('dataUrl', dataUrl);
      layer.add(node);
      if (currentTool === 'select') transformer.nodes([node]);
      markDirty(true);
    };
    img.src = dataUrl;
  }

  function spawnText(x, y, initial = '') {
    const node = new Konva.Text({
      x, y,
      text: initial || 'Double-click to edit',
      fontSize: 16,
      fontFamily: 'Inter, system-ui, sans-serif',
      fill: '#F7F8F8',
      draggable: true,
      padding: 2,
    });
    layer.add(node);
    node.on('dblclick dbltap', () => editTextNode(node));
    if (currentTool === 'select' || currentTool === 'text') {
      transformer.nodes([node]);
      setTimeout(() => editTextNode(node), 50);
    }
    markDirty(true);
  }

  function spawnSticky(x, y) {
    const group = new Konva.Group({ x, y, draggable: true });
    const rect = new Konva.Rect({
      width: 160, height: 100,
      fill: STICKY_BG,
      cornerRadius: 6,
      shadowColor: '#000', shadowBlur: 8, shadowOpacity: 0.4, shadowOffset: { x: 0, y: 2 },
    });
    const text = new Konva.Text({
      width: 144, height: 84,
      x: 8, y: 8,
      text: 'Sticky',
      fontSize: 13,
      fontFamily: 'Inter, system-ui, sans-serif',
      fill: STICKY_FG,
      padding: 0,
    });
    group.add(rect); group.add(text);
    group.setAttr('hiveType', 'sticky');
    layer.add(group);
    group.on('dblclick dbltap', () => editTextNode(text, group));
    if (currentTool === 'select' || currentTool === 'sticky') {
      transformer.nodes([group]);
      setTimeout(() => editTextNode(text, group), 50);
    }
    markDirty(true);
  }

  // Inline edit via a positioned <textarea>. We use fixed-position +
  // viewport coords so we don't have to worry about the stage's own
  // pan/zoom transform on the overlay (Konva's getAbsolutePosition
  // already accounts for it).
  function editTextNode(textNode, parentGroup) {
    const scale = stage.scaleX();
    const absPos = textNode.getAbsolutePosition();
    const containerOffset = STAGE_HOST.getBoundingClientRect();
    const ta = document.createElement('textarea');
    ta.className = 'ls-canvas-text-overlay';
    ta.value = textNode.text();
    ta.style.position = 'fixed';
    ta.style.left = (containerOffset.left + absPos.x) + 'px';
    ta.style.top = (containerOffset.top + absPos.y) + 'px';
    ta.style.width = Math.max(80, textNode.width() * scale) + 'px';
    ta.style.height = Math.max(24, (textNode.height() || textNode.fontSize() * 1.4) * scale) + 'px';
    ta.style.fontSize = (textNode.fontSize() * scale) + 'px';
    ta.style.color = String(textNode.fill());
    ta.style.background = parentGroup ? STICKY_BG : '#101113';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const commit = () => {
      textNode.text(ta.value);
      layer.draw();
      ta.remove();
      markDirty(true);
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { ta.remove(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commit(); }
    });
  }

  // ── Tool selection ─────────────────────────────────────────────────

  function setTool(tool) {
    currentTool = tool;
    TOOLBAR.querySelectorAll('.ls-tool[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    STAGE_HOST.className = STAGE_HOST.className.replace(/tool-\S+/g, '').trim();
    STAGE_HOST.classList.add('tool-' + tool);
    if (tool !== 'select') transformer.nodes([]);
    if (tool === 'image') openImagePicker();
  }

  function openImagePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => {
      if (!input.files?.length) return;
      let offset = 0;
      for (const f of input.files) {
        const reader = new FileReader();
        reader.onload = () => {
          const c = stageCenter();
          spawnImage(reader.result, c.x + offset, c.y + offset);
          offset += 20;
        };
        reader.readAsDataURL(f);
      }
    };
    input.click();
    setTool('select');
  }

  TOOLBAR?.querySelectorAll('.ls-tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  document.getElementById('ls-canvas-undo')?.addEventListener('click', undo);
  document.getElementById('ls-canvas-redo')?.addEventListener('click', redo);
  document.getElementById('ls-canvas-zoom-fit')?.addEventListener('click', fitToContent);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!isVisible()) return;
    if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    if (e.key === ' ') { spaceHeld = true; STAGE_HOST.classList.add('panning'); }
    else if (e.key.toLowerCase() === 'v') setTool('select');
    else if (e.key.toLowerCase() === 'p') setTool('pen');
    else if (e.key.toLowerCase() === 'a') setTool('arrow');
    else if (e.key.toLowerCase() === 't') setTool('text');
    else if (e.key.toLowerCase() === 'n') setTool('sticky');
    else if (e.key.toLowerCase() === 'i') setTool('image');
    else if (e.key.toLowerCase() === 'f') fitToContent();
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = transformer.nodes();
      if (sel.length) { sel.forEach(n => n.destroy()); transformer.nodes([]); markDirty(true); }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault(); undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault(); redo();
    }
  });
  document.addEventListener('keyup', e => {
    if (e.key === ' ') { spaceHeld = false; if (!isPanning) STAGE_HOST.classList.remove('panning'); }
  });

  // ── Undo / redo via state snapshots ─────────────────────────────────
  // Konva.toJSON emits every attribute on each node, including our
  // custom `dataUrl` on Konva.Image (image elements themselves are
  // dropped because they can't serialize). On load we walk the tree
  // and rehydrate images from their dataUrl.
  function snapshot() {
    if (!stage) return null;
    return JSON.stringify({
      stage: JSON.parse(stage.toJSON()),
      camera: { x: stage.x(), y: stage.y(), scale: stage.scaleX() },
    });
  }

  function pushHistory() {
    if (suppressDirty) return;
    const snap = snapshot();
    if (!snap) return;
    history.past.push(snap);
    if (history.past.length > 50) history.past.shift();
    history.future = [];
  }

  function undo() {
    if (history.past.length < 2) return;
    const cur = history.past.pop();
    history.future.push(cur);
    const prev = history.past[history.past.length - 1];
    loadState(prev, false);
    scheduleSave();
  }

  function redo() {
    if (!history.future.length) return;
    const next = history.future.pop();
    history.past.push(next);
    loadState(next, false);
    scheduleSave();
  }

  // ── Persistence ────────────────────────────────────────────────────

  function markDirty(snap) {
    if (snap) pushHistory();
    scheduleSave();
  }
  function scheduleSave() {
    if (!currentCanvasId) return;
    if (saveTimer) clearTimeout(saveTimer);
    setStatus('saving…');
    saveTimer = setTimeout(async () => {
      const state = snapshot();
      if (!state) return;
      try {
        await window.hive.saveCanvas({ id: currentCanvasId, stateJson: state, name: currentCanvasName });
        setStatus('saved · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      } catch (err) {
        setStatus('save failed');
      }
    }, 1200);
  }
  function setStatus(s) { if (STATUS_LABEL) STATUS_LABEL.textContent = s; }

  function loadState(stateJson, resetHistory = true) {
    suppressDirty = true;
    if (transformer) transformer.nodes([]);
    layer.destroyChildren();
    layer.add(transformer);
    if (!stateJson || stateJson === '{}') {
      layer.draw();
      if (resetHistory) { history.past = [snapshot()]; history.future = []; }
      suppressDirty = false;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(stateJson); } catch { parsed = null; }
    if (!parsed) { suppressDirty = false; return; }

    // Camera
    if (parsed.camera) {
      stage.x(parsed.camera.x || 0);
      stage.y(parsed.camera.y || 0);
      stage.scale({ x: parsed.camera.scale || 1, y: parsed.camera.scale || 1 });
      updateZoomLabel();
    }
    // Stage children
    const stageJson = parsed.stage;
    const stageLayers = (stageJson?.children) || [];
    for (const layerJson of stageLayers) {
      for (const child of (layerJson.children || [])) {
        const node = Konva.Node.create(JSON.stringify(child));
        if (!node) continue;
        if (node.className === 'Image' && child.attrs?.dataUrl) {
          const img = new Image();
          img.onload = () => { node.image(img); layer.draw(); };
          img.src = child.attrs.dataUrl;
          node.setAttr('dataUrl', child.attrs.dataUrl);
        }
        if (node.className === 'Text') {
          node.on('dblclick dbltap', () => editTextNode(node));
        }
        if (node.className === 'Group' && child.attrs?.hiveType === 'sticky') {
          const text = node.findOne('Text');
          if (text) node.on('dblclick dbltap', () => editTextNode(text, node));
        }
        layer.add(node);
      }
    }
    transformer.moveToTop();
    layer.draw();
    if (resetHistory) { history.past = [snapshot()]; history.future = []; }
    suppressDirty = false;
  }

  function fitToContent() {
    const nodes = layer.getChildren(n => n !== transformer);
    if (!nodes.length) { stage.position({ x: 0, y: 0 }); stage.scale({ x: 1, y: 1 }); updateZoomLabel(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      const r = n.getClientRect({ relativeTo: stage });
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    });
    const pad = 60;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const scale = Math.min(stage.width() / w, stage.height() / h, 2);
    stage.scale({ x: scale, y: scale });
    stage.position({
      x: -(minX - pad) * scale,
      y: -(minY - pad) * scale,
    });
    updateZoomLabel();
  }

  // ── Canvas list (left rail) ────────────────────────────────────────

  async function refreshList() {
    let canvases = [];
    try {
      const res = await window.hive.listCanvases();
      canvases = res?.canvases ?? [];
    } catch {}
    if (!RAIL_LIST) return;
    if (!canvases.length) {
      RAIL_LIST.innerHTML = '<div style="padding:14px 12px;color:var(--ls-text-faint);font-size:11px;line-height:1.5;">No canvases yet. Hit + to start.</div>';
      return;
    }
    RAIL_LIST.innerHTML = canvases.map(c => `
      <div class="ls-canvas-rail-item${c.id === currentCanvasId ? ' active' : ''}" data-id="${c.id}">
        <span class="ls-canvas-rail-name">${escapeHtml(c.name)}</span>
        <span class="ls-canvas-rail-date">${shortDate(c.updatedAt)}</span>
      </div>
    `).join('');
    RAIL_LIST.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', () => loadCanvas(Number(el.dataset.id)));
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function shortDate(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function loadCanvas(id) {
    let row;
    try {
      const res = await window.hive.getCanvas(id);
      row = res?.canvas;
    } catch {}
    if (!row) return;
    currentCanvasId = id;
    currentCanvasName = row.name;
    if (NAME_INPUT) NAME_INPUT.value = row.name;
    loadState(row.stateJson || '{}');
    setStatus('loaded');
    refreshList();
    if (EMPTY) EMPTY.style.display = 'none';
  }

  async function newCanvas() {
    const name = `Canvas ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    let id;
    try {
      const res = await window.hive.createCanvas({ name });
      id = res?.id;
    } catch {}
    if (!id) return;
    await refreshList();
    await loadCanvas(id);
  }

  document.getElementById('ls-canvas-new')?.addEventListener('click', newCanvas);

  NAME_INPUT?.addEventListener('input', () => {
    currentCanvasName = NAME_INPUT.value;
    scheduleSave();
  });

  // ── Tabs (Canvases | Photos) ──────────────────────────────────────
  const RAIL = document.getElementById('ls-canvas-rail');
  let photosLoaded = false;
  function setTab(name) {
    RAIL?.querySelectorAll('.ls-canvas-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
    RAIL?.querySelectorAll('.ls-canvas-tab-panel').forEach(el => {
      el.style.display = el.dataset.panel === name ? '' : 'none';
    });
    if (name === 'photos' && !photosLoaded) refreshPhotos();
  }
  RAIL?.querySelectorAll('.ls-canvas-tab').forEach(t => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  // ── Photos tab ───────────────────────────────────────────────────
  const PHOTOS_GRID = document.getElementById('ls-photos-grid');
  const PHOTOS_FOLDER_LBL = document.getElementById('ls-photos-folder');
  const PHOTOS_EMPTY = document.getElementById('ls-photos-empty');

  const PHOTOS_FOLDER_KEY = 'hive.photosFolder';
  function chosenPhotosFolder() { try { return localStorage.getItem(PHOTOS_FOLDER_KEY) || undefined; } catch { return undefined; } }
  function setChosenPhotosFolder(p) { try { localStorage.setItem(PHOTOS_FOLDER_KEY, p); } catch {} }

  async function refreshPhotos() {
    photosLoaded = true;
    if (!PHOTOS_GRID || !PHOTOS_EMPTY) return;
    PHOTOS_GRID.innerHTML = '<div style="grid-column:1/-1;color:var(--ls-text-faint);font-size:11px;padding:14px 6px;text-align:center;">Loading…</div>';
    PHOTOS_EMPTY.style.display = 'none';
    let res;
    const folder = chosenPhotosFolder();
    try { res = await window.hive.listPhotos({ folder, limit: 200 }); } catch (err) { res = { ok: false, error: String(err) }; }
    if (!res?.ok) {
      PHOTOS_GRID.innerHTML = '';
      PHOTOS_EMPTY.style.display = '';
      PHOTOS_EMPTY.innerHTML = `Failed to read photos folder.<br><span style="color:var(--ls-text-faint);">${escapeHtml(res?.error ?? 'unknown')}</span>`;
      return;
    }
    if (PHOTOS_FOLDER_LBL) PHOTOS_FOLDER_LBL.textContent = res.folder ?? '';
    if (!res.exists) {
      PHOTOS_GRID.innerHTML = '';
      PHOTOS_EMPTY.style.display = '';
      PHOTOS_EMPTY.innerHTML = `Folder not found. The new iCloud-for-Windows uses Microsoft Photos virtual placeholders — there's no real folder. Click the <strong>…</strong> button above to pick whatever folder actually has the images you want (e.g. your Windows Screenshots folder, or a folder you've exported iCloud photos into).<br><br><code>${escapeHtml(res.folder ?? '')}</code>`;
      return;
    }
    if (!res.photos.length) {
      PHOTOS_GRID.innerHTML = '';
      PHOTOS_EMPTY.style.display = '';
      PHOTOS_EMPTY.innerHTML = `Folder is empty — wait for iCloud to sync, then refresh.<br><code>${escapeHtml(res.folder)}</code>`;
      return;
    }
    PHOTOS_EMPTY.style.display = 'none';
    PHOTOS_GRID.innerHTML = res.photos.map(p => {
      const dt = new Date(p.mtime);
      const dateLbl = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
      if (!p.thumbDataUrl) {
        return `<div class="ls-photo-thumb unsupported" title="${escapeHtml(p.name)} — ${p.ext} not supported. Switch iPhone Camera to 'Most Compatible' for JPG.">${escapeHtml(p.ext.slice(1).toUpperCase())}</div>`;
      }
      return `<div class="ls-photo-thumb" draggable="true" data-photo="${escapeHtml(p.path)}" title="${escapeHtml(p.name)} · ${dt.toLocaleString()}">
        <img src="${p.thumbDataUrl}" alt="" />
        <span class="ls-photo-thumb-date">${dateLbl}</span>
      </div>`;
    }).join('');
    wirePhotoThumbs();
  }

  function wirePhotoThumbs() {
    PHOTOS_GRID.querySelectorAll('.ls-photo-thumb[data-photo]').forEach(el => {
      el.addEventListener('click', () => placePhoto(el.dataset.photo));
      el.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', 'hive-photo:' + el.dataset.photo);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
  }

  async function placePhoto(photoPath, x, y) {
    if (!stage) return;
    if (!currentCanvasId) await newCanvas();
    const res = await window.hive.getPhotoFull(photoPath);
    if (!res?.ok) {
      setStatus('photo load failed · ' + (res?.error ?? 'unknown'));
      return;
    }
    const c = (x != null && y != null) ? { x, y } : stageCenter();
    spawnImage(res.dataUrl, c.x, c.y);
  }

  // Augment the existing stage drop handler to recognise photo-thumb drags.
  // The original drop listener only handles e.dataTransfer.files — add a
  // sibling listener for the text/plain payload our thumbs emit.
  STAGE_HOST.addEventListener('drop', async e => {
    const txt = e.dataTransfer?.getData('text/plain');
    if (txt && txt.startsWith('hive-photo:')) {
      e.preventDefault();
      STAGE_HOST.classList.remove('dragover');
      const photoPath = txt.slice('hive-photo:'.length);
      const rect = STAGE_HOST.getBoundingClientRect();
      const scale = stage.scaleX();
      const dropX = (e.clientX - rect.left - stage.x()) / scale;
      const dropY = (e.clientY - rect.top - stage.y()) / scale;
      placePhoto(photoPath, dropX, dropY);
    }
  });
  STAGE_HOST.addEventListener('dragover', e => {
    const txt = e.dataTransfer?.types?.includes('text/plain');
    if (txt) { e.preventDefault(); STAGE_HOST.classList.add('dragover'); }
  });

  document.getElementById('ls-photos-refresh')?.addEventListener('click', () => { photosLoaded = false; refreshPhotos(); });
  document.getElementById('ls-photos-pick')?.addEventListener('click', async () => {
    const res = await window.hive.pickPhotosFolder();
    if (!res?.ok) return;
    setChosenPhotosFolder(res.folder);
    photosLoaded = false;
    refreshPhotos();
  });

  // ── Open / close ───────────────────────────────────────────────────

  function isVisible() { return document.body.classList.contains('canvas-active'); }

  async function open() {
    console.log('[hive canvas] open() — body classes:', document.body.className);
    document.body.classList.add('canvas-active');
    SHELL.style.display = '';
    SHELL.style.visibility = 'visible';
    initStage();
    console.log('[hive canvas] stage host rect:', STAGE_HOST.getBoundingClientRect());
    // Resize handler kicks in via ResizeObserver — but Konva needs an initial sync now too.
    requestAnimationFrame(() => {
      const r = STAGE_HOST.getBoundingClientRect();
      stage.width(Math.max(100, r.width));
      stage.height(Math.max(100, r.height));
    });
    await refreshList();
    // Load most recent canvas, or create one if none
    const res = await window.hive.listCanvases();
    const list = res?.canvases ?? [];
    if (list.length) {
      await loadCanvas(list[0].id);
    } else {
      await newCanvas();
    }
  }

  function close() {
    document.body.classList.remove('canvas-active');
  }

  window.__lsCanvas = { open, close, isVisible };

  // Wire sidebar nav click into open()
  document.querySelectorAll('.linear-shell .ls-nav-item[data-view="canvas"]').forEach(el => {
    el.addEventListener('click', () => {
      open();
    }, true);  // capture phase so we run before the default handler that flashes a toast
  });
})();
