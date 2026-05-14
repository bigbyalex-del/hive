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
  let currentBg = 'dotted';
  let isPanning = false;
  let spaceHeld = false;
  let drawing = null;          // active Konva.Line | Konva.Arrow
  let saveTimer = null;
  let history = { past: [], future: [] };
  let suppressDirty = false;
  let pendingTextEdit = false;
  let currentColor = '#F7F8F8';

  function applyBg(name) {
    currentBg = name || 'dotted';
    STAGE_HOST.className = STAGE_HOST.className.replace(/bg-\S+/g, '').trim();
    STAGE_HOST.classList.add('bg-' + currentBg);
    document.querySelectorAll('#ls-canvas-bg-menu .ls-bg-swatch').forEach(b => {
      b.classList.toggle('active', b.dataset.bg === currentBg);
    });
  }

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
    applyBg(currentBg);  // ensure stage has a bg class from boot
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

      // Pan tool / middle mouse / space-held → pan
      if (currentTool === 'pan' || (e.evt && (e.evt.button === 1 || spaceHeld))) {
        isPanning = true;
        stage.draggable(true);
        STAGE_HOST.classList.add('panning');
        return;
      }

      if (currentTool === 'pen') {
        drawing = new Konva.Line({
          points: [pointer.x, pointer.y, pointer.x, pointer.y],
          stroke: currentColor,
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
          stroke: currentColor,
          fill: currentColor,
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

      if (currentTool === 'mind') {
        spawnMindNode(pointer.x, pointer.y, null, null);
        // One-shot: drop one root, then return to select so the next
        // click doesn't spawn another root by accident.
        setTool('select');
        return;
      }

      if (currentTool === 'focus') {
        // Drag to create a focus region. Live preview during the drag.
        drawing = new Konva.Rect({
          x: pointer.x, y: pointer.y, width: 0, height: 0,
          fill: 'rgba(212,165,116,0.05)',
          stroke: '#D4A574',
          strokeWidth: 1.5,
          dash: [6, 4],
          cornerRadius: 4,
          draggable: false,
        });
        drawing.setAttr('hiveType', 'focus-region');
        drawing.setAttr('hiveDragStart', { x: pointer.x, y: pointer.y });
        layer.add(drawing);
        drawing.moveToBottom();
        return;
      }

      if (currentTool === 'eraser') {
        if (!isStageTarget) {
          let shape = e.target;
          // If the user hit a Konva.Text or Rect inside a mind-node group,
          // delete the whole node (and its branch + connectors) instead of
          // ripping out one child of the group.
          let cursor = shape;
          while (cursor && !isMindNode(cursor)) cursor = cursor.getParent?.();
          if (isMindNode(cursor)) shape = cursor;
          if (shape !== transformer && !transformer.nodes().includes(shape)) {
            destroyNodeWithConnectors(shape);
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
      } else if (currentTool === 'focus') {
        const start = drawing.getAttr('hiveDragStart');
        if (!start) return;
        const x = Math.min(start.x, pointer.x);
        const y = Math.min(start.y, pointer.y);
        const w = Math.abs(pointer.x - start.x);
        const h = Math.abs(pointer.y - start.y);
        drawing.x(x); drawing.y(y);
        drawing.width(w); drawing.height(h);
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
        // Focus regions get a final size/position validation + listener wire-up
        if (drawing.getAttr('hiveType') === 'focus-region') {
          if (drawing.width() < 30 || drawing.height() < 30) {
            drawing.destroy();
          } else {
            drawing.draggable(true);
            drawing.listening(true);
          }
        }
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

  function spawnImage(dataUrl, x, y, opts = {}) {
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
      if (opts.sourcePath) node.setAttr('hiveSourcePath', opts.sourcePath);
      layer.add(node);
      markDirty(true);
      markPhotoThumbsUsed();
    };
    img.src = dataUrl;
  }

  function spawnText(x, y, initial = '') {
    const node = new Konva.Text({
      x, y,
      text: initial || ' ',
      fontSize: 16,
      fontFamily: 'Inter, system-ui, sans-serif',
      fill: currentColor,
      draggable: true,
      padding: 2,
    });
    layer.add(node);
    layer.draw();  // force layout so getAbsolutePosition is accurate
    node.on('dblclick dbltap', () => editTextNode(node));
    // Open editor synchronously while the user gesture is still active —
    // gives the browser permission to set focus on the textarea.
    editTextNode(node, undefined, true);
    markDirty(true);
  }

  // ── Mind-mapping ─────────────────────────────────────────────────
  //
  // Each node is a Konva.Group with hiveType='mind-node'. Groups store
  // hivePid (parent group _id) and hiveBranchColor. Connectors are
  // Konva.Line nodes with hiveConnector=true and hiveFromId/hiveToId so
  // we can find and redraw them when a node is dragged. Each top-level
  // child of a root picks a branch color from a cycling palette;
  // descendants inherit their branch's color so a whole limb stays
  // visually unified.
  const MIND_BRANCH_COLORS = ['#6BBF7B', '#E07B5F', '#D4A574', '#B7AFE0', '#6BB1D6', '#C77DD9', '#F2D26A', '#5E6AD2'];

  function findGroupById(_id) {
    let found = null;
    layer.getChildren().forEach(n => { if (n._id === _id) found = n; });
    return found;
  }

  function isMindNode(n) {
    return n?.getAttr?.('hiveType') === 'mind-node';
  }

  function spawnMindNode(x, y, parentGroup, branchColor, initialText) {
    const group = new Konva.Group({ x, y, draggable: true });
    group.setAttr('hiveType', 'mind-node');
    group.setAttr('hivePid', parentGroup?._id ?? null);
    group.setAttr('hiveBranchColor', branchColor ?? null);

    const text = new Konva.Text({
      text: initialText ?? (parentGroup ? 'Idea' : 'Topic'),
      fontSize: parentGroup ? 14 : 16,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontStyle: parentGroup ? 'normal' : '600',
      fill: '#F7F8F8',
      padding: 0,
    });
    const padX = 14, padY = 9;
    const innerW = Math.max(50, text.width());
    const w = innerW + padX * 2;
    const h = text.height() + padY * 2;
    const rect = new Konva.Rect({
      width: w, height: h,
      cornerRadius: Math.min(h / 2, 18),
      fill: parentGroup ? '#16171A' : '#1F2023',
      stroke: branchColor ?? '#5D6068',
      strokeWidth: 2,
      shadowColor: '#000',
      shadowBlur: parentGroup ? 4 : 8,
      shadowOpacity: parentGroup ? 0.25 : 0.4,
      shadowOffset: { x: 0, y: 1 },
    });
    text.position({ x: padX, y: padY });

    // Hover affordances — manual + on the right edge, ✨ "ask agent" next to it
    const PLUS_R = 9;
    const plusBg = new Konva.Circle({
      x: w + PLUS_R + 4, y: h / 2,
      radius: PLUS_R,
      fill: branchColor ?? '#D4A574',
      opacity: 0,
    });
    const plusGlyph = new Konva.Text({
      x: w + 4, y: h / 2 - 9,
      width: PLUS_R * 2, height: PLUS_R * 2,
      text: '+', fontSize: 16, fontStyle: 'bold',
      fill: '#08090A',
      align: 'center', verticalAlign: 'middle',
      opacity: 0,
    });
    const sparkBg = new Konva.Circle({
      x: w + PLUS_R * 3 + 8, y: h / 2,
      radius: PLUS_R,
      fill: '#1F2023',
      stroke: branchColor ?? '#D4A574',
      strokeWidth: 1.5,
      opacity: 0,
    });
    const sparkGlyph = new Konva.Text({
      x: w + PLUS_R * 2 + 8, y: h / 2 - 8,
      width: PLUS_R * 2, height: PLUS_R * 2,
      text: '✨', fontSize: 11,
      fill: branchColor ?? '#D4A574',
      align: 'center', verticalAlign: 'middle',
      opacity: 0,
    });

    group.add(rect);
    group.add(text);
    group.add(plusBg);
    group.add(plusGlyph);
    group.add(sparkBg);
    group.add(sparkGlyph);
    layer.add(group);

    // Hover: reveal + and ✨
    group.on('mouseenter', () => {
      plusBg.opacity(0.92); plusGlyph.opacity(1);
      sparkBg.opacity(1); sparkGlyph.opacity(1);
      layer.batchDraw();
      STAGE_HOST.style.cursor = 'pointer';
    });
    group.on('mouseleave', () => {
      plusBg.opacity(0); plusGlyph.opacity(0);
      sparkBg.opacity(0); sparkGlyph.opacity(0);
      layer.batchDraw();
      STAGE_HOST.style.cursor = '';
    });

    // ✨ click → persona-picker popover
    const onSpark = (e) => {
      e.cancelBubble = true;
      showAgentPickerForNode(group);
    };
    sparkBg.on('click tap', onSpark);
    sparkGlyph.on('click tap', onSpark);

    // Spawn animation — gentle scale-up so adds feel alive
    group.scale({ x: 0.7, y: 0.7 });
    group.opacity(0.4);
    group.to({ scaleX: 1, scaleY: 1, opacity: 1, duration: 0.18, easing: Konva.Easings.EaseOut });

    // Connector from parent
    if (parentGroup) {
      drawMindConnector(parentGroup, group, branchColor);
    }

    // + button → add child
    const onPlus = (e) => {
      e.cancelBubble = true;
      addMindChild(group);
    };
    plusBg.on('click tap', onPlus);
    plusGlyph.on('click tap', onPlus);

    // Click-vs-drag tracking + drag-to-reparent
    let dragStarted = false;
    let descSnap = null;
    let dropTarget = null;
    group.on('dragstart', () => {
      dragStarted = true;
      const sx = group.x(), sy = group.y();
      descSnap = descendantsOf(group).map(d => ({ node: d, dx0: d.x() - sx, dy0: d.y() - sy }));
      group.moveToTop();  // float above siblings while dragging
    });
    group.on('dragmove', () => {
      if (descSnap) {
        const x = group.x(), y = group.y();
        for (const d of descSnap) {
          d.node.x(x + d.dx0);
          d.node.y(y + d.dy0);
        }
      }
      // Drop-target detection — find another mind-node we're overlapping
      // and that isn't a descendant of us (no cycles).
      const myRect = group.getClientRect({ relativeTo: stage, skipTransform: false });
      let found = null;
      for (const other of layer.getChildren()) {
        if (!isMindNode(other)) continue;
        if (other === group) continue;
        if (isDescendantOf(other, group)) continue;
        if (other.getAttr('hivePid') === group._id) continue;  // already a child of us → skip
        const otherRect = other.getClientRect({ relativeTo: stage, skipTransform: false });
        if (rectsOverlap(myRect, otherRect)) { found = other; break; }
      }
      if (dropTarget !== found) {
        if (dropTarget) {
          const r = dropTarget.findOne('Rect');
          if (r) { r.shadowEnabled(false); r.strokeWidth(2); }
        }
        dropTarget = found;
        if (dropTarget) {
          const r = dropTarget.findOne('Rect');
          if (r) {
            r.shadowColor('#D4A574');
            r.shadowBlur(20);
            r.shadowOpacity(0.9);
            r.shadowOffset({ x: 0, y: 0 });
            r.shadowEnabled(true);
            r.strokeWidth(3);
          }
        }
      }
      redrawAllMindConnectors();
    });
    group.on('dragend', () => {
      if (dropTarget) {
        const r = dropTarget.findOne('Rect');
        if (r) { r.shadowEnabled(false); r.strokeWidth(2); }
        reparentMindNode(group, dropTarget);
      }
      dropTarget = null;
      descSnap = null;
      markDirty(true);
      setTimeout(() => { dragStarted = false; }, 0);
    });
    const onEdit = (e) => {
      e.cancelBubble = true;
      if (dragStarted) return;
      if (currentTool !== 'select' && currentTool !== 'mind') return;
      editTextNode(text, group);
    };
    rect.on('click tap', onEdit);
    text.on('click tap', onEdit);
    rect.on('dblclick dbltap', onEdit);
    text.on('dblclick dbltap', onEdit);

    // Right-click → canvas-chat Ask flow
    group.on('contextmenu', (e) => {
      e.cancelBubble = true;
      if (e.evt) { e.evt.preventDefault(); }
      const cx = e.evt?.clientX ?? 0;
      const cy = e.evt?.clientY ?? 0;
      showAskPickerForNode(group, cx, cy);
    });

    markDirty(true);
    return group;
  }

  function addMindChild(parentGroup) {
    const parentRect = parentGroup.findOne('Rect');
    const isRootChild = !parentGroup.getAttr('hivePid');
    const siblings = layer.getChildren(n => isMindNode(n) && n.getAttr('hivePid') === parentGroup._id);
    const color = isRootChild
      ? MIND_BRANCH_COLORS[siblings.length % MIND_BRANCH_COLORS.length]
      : (parentGroup.getAttr('hiveBranchColor') ?? '#D4A574');
    const newX = parentGroup.x() + parentRect.width() + 100;
    // Place at parent's y for now; relayoutChildrenOf below fans everyone out
    const child = spawnMindNode(newX, parentGroup.y(), parentGroup, color);
    relayoutChildrenOf(parentGroup);
    setTimeout(() => editTextNode(child.findOne('Text'), child, true), 30);
    return child;
  }

  function addMindSibling(node) {
    const pid = node.getAttr('hivePid');
    if (pid == null) return null;  // root has no siblings
    const parent = findGroupById(pid);
    if (!parent) return null;
    return addMindChild(parent);
  }

  // Fan all children of `parentGroup` out evenly above and below the
  // parent's y axis. Spacing scales with each child's rendered height.
  // Subtree height = total vertical space this node's whole branch needs.
  // Used to allocate space to each child during layout so that a kid with
  // 10 grandkids doesn't overlap a kid with 1.
  function subtreeHeight(node, spacing) {
    const kids = layer.getChildren(n => isMindNode(n) && n.getAttr('hivePid') === node._id);
    const selfH = node.findOne('Rect')?.height() ?? 32;
    if (!kids.length) return selfH;
    let sum = 0;
    for (const k of kids) sum += subtreeHeight(k, spacing);
    sum += (kids.length - 1) * spacing;
    return Math.max(selfH, sum);
  }

  function relayoutChildrenOf(parentGroup) {
    const children = layer.getChildren(n => isMindNode(n) && n.getAttr('hivePid') === parentGroup._id);
    if (!children.length) return;
    const parentRect = parentGroup.findOne('Rect');
    const baseX = parentGroup.x() + parentRect.width() + 100;
    const spacing = 20;
    // Allocate vertical space based on each child's subtree height
    const slots = children.map(c => subtreeHeight(c, spacing));
    const totalH = slots.reduce((a, b) => a + b, 0) + (children.length - 1) * spacing;
    const parentCenter = parentGroup.y() + parentRect.height() / 2;
    let cursorY = parentCenter - totalH / 2;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const slot = slots[i];
      const cRect = c.findOne('Rect');
      const cH = cRect?.height() ?? 32;
      const targetY = cursorY + slot / 2 - cH / 2;
      c.x(baseX);
      c.y(targetY);
      cursorY += slot + spacing;
      relayoutChildrenOf(c);  // recurse so grandchildren are positioned relative to their new parent location
    }
    redrawAllMindConnectors();
  }

  function redrawAllMindConnectors() {
    layer.getChildren().forEach(line => {
      if (line.className !== 'Line') return;
      if (!line.getAttr?.('hiveConnector')) return;
      const from = findGroupById(line.getAttr('hiveFromId'));
      const to = findGroupById(line.getAttr('hiveToId'));
      if (!from || !to) {
        line.destroy();
        return;
      }
      const fr = from.findOne('Rect');
      const tr = to.findOne('Rect');
      const isFromRoot = !from.getAttr('hivePid');
      const wStart = isFromRoot ? 5 : 3.5;
      const wEnd = 1.4;
      line.points(taperedConnectorPoints(
        from.x() + fr.width(), from.y() + fr.height() / 2,
        to.x(), to.y() + tr.height() / 2,
        wStart, wEnd,
      ));
      // Migrate any old stroke-style connectors to the new fill polygon
      if (!line.closed()) {
        line.closed(true);
        line.fill(line.stroke() || line.getAttr('hiveBranchColor') || '#5D6068');
        line.strokeEnabled(false);
      }
    });
    layer.batchDraw();
  }

  function descendantsOf(group) {
    const out = [];
    const queue = [group];
    while (queue.length) {
      const cur = queue.shift();
      const kids = layer.getChildren(n => isMindNode(n) && n.getAttr('hivePid') === cur._id);
      for (const k of kids) { out.push(k); queue.push(k); }
    }
    return out;
  }

  function isDescendantOf(maybeDesc, ancestor) {
    let cur = maybeDesc;
    while (cur) {
      const pid = cur.getAttr?.('hivePid');
      if (pid == null) return false;
      if (pid === ancestor._id) return true;
      cur = findGroupById(pid);
    }
    return false;
  }

  function rectsOverlap(a, b) {
    return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
  }

  function reparentMindNode(node, newParent) {
    // Reject self-reparent (would no-op anyway)
    if (node === newParent || node.getAttr('hivePid') === newParent._id) return;
    node.setAttr('hivePid', newParent._id);
    // Inherit branch color. If new parent is the root, pick from the
    // rotating palette based on existing-child count for variety.
    const parentIsRoot = !newParent.getAttr('hivePid');
    const siblingCount = layer.getChildren(n =>
      isMindNode(n) && n.getAttr('hivePid') === newParent._id && n !== node
    ).length;
    const newColor = parentIsRoot
      ? MIND_BRANCH_COLORS[siblingCount % MIND_BRANCH_COLORS.length]
      : (newParent.getAttr('hiveBranchColor') ?? '#D4A574');
    applyBranchColor(node, newColor);
    // Destroy stale incoming connectors, draw fresh one
    const stale = layer.getChildren(n =>
      n.className === 'Line' && n.getAttr?.('hiveConnector') && n.getAttr('hiveToId') === node._id
    );
    for (const c of stale) c.destroy();
    drawMindConnector(newParent, node, newColor);
    relayoutChildrenOf(newParent);
  }

  function applyBranchColor(node, color) {
    node.setAttr('hiveBranchColor', color);
    const rect = node.findOne('Rect');
    if (rect) rect.stroke(color);
    const plusBg = node.findOne('Circle');
    if (plusBg) plusBg.fill(color);
    // Update outgoing connectors from this node so the new color flows
    layer.getChildren().forEach(line => {
      if (line.className !== 'Line') return;
      if (!line.getAttr?.('hiveConnector')) return;
      if (line.getAttr('hiveFromId') !== node._id) return;
      line.fill(color);
    });
    const kids = layer.getChildren(n => isMindNode(n) && n.getAttr('hivePid') === node._id);
    for (const k of kids) applyBranchColor(k, color);
  }

  // Re-fit a mind node's rect to its current text width/height. Called
  // after committing an edit so long labels don't overflow the pill.
  // ── Agent integration on mind nodes ──────────────────────────────
  //
  // ✨ button on each mind node opens a popover of all advisors. Picking
  // one fires ExpandMindTopic with that persona + the node's current
  // label; reply is parsed as a JSON array and each idea becomes a
  // child of the clicked node, colored by the persona.
  const AGENT_COLOR = {
    'fxv:aerobic':    '#6BBF7B',
    'fxv:strength':   '#E07B5F',
    'fxv:concurrent': '#D4A574',
    'fxv:load':       '#B7AFE0',
    'fxv:readiness':  '#6BB1D6',
    'fxv:coach':      '#C77DD9',
    'fxv:uiux':       '#E8C39C',
    'fxv:marketing':  '#F2D26A',
    'fxv:manager':    '#FFFFFF',
    'page:today':     '#9CB4D6',
    'page:programme': '#D4A574',
    'page:coach':     '#C77DD9',
    'page:health':    '#6BBF7B',
  };

  let agentPickerEl = null;
  let agentCache = null;

  async function showAgentPickerForNode(group) {
    closeAgentPicker();
    if (!agentCache) {
      try {
        const res = await window.hive.listAdvisors();
        agentCache = res?.advisors ?? res ?? [];
      } catch { agentCache = []; }
    }
    const rectInScreen = group.findOne('Rect').getClientRect({ relativeTo: stage });
    const hostRect = STAGE_HOST.getBoundingClientRect();
    const x = hostRect.left + rectInScreen.x + rectInScreen.width + 36;
    const y = hostRect.top + rectInScreen.y;

    const el = document.createElement('div');
    el.className = 'ls-agent-picker';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.innerHTML = `
      <div class="ls-agent-picker-h">Expand with…</div>
      ${agentCache.map(a => `
        <button class="ls-agent-picker-row" data-persona="${a.id}">
          <span class="ls-agent-picker-dot" style="background:${AGENT_COLOR[a.id] || '#8A8F98'};"></span>
          <span class="ls-agent-picker-name">${escapeHtml(a.name)}</span>
          <span class="ls-agent-picker-scope">${escapeHtml((a.title || a.scope || '').slice(0, 40))}</span>
        </button>
      `).join('')}
    `;
    document.body.appendChild(el);
    agentPickerEl = el;
    el.querySelectorAll('[data-persona]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pid = btn.dataset.persona;
        closeAgentPicker();
        await runAgentExpand(group, pid);
      });
    });
    setTimeout(() => document.addEventListener('mousedown', onAgentPickerOutside, true), 0);
  }
  function onAgentPickerOutside(e) {
    if (!agentPickerEl) return;
    if (!agentPickerEl.contains(e.target)) closeAgentPicker();
  }
  function closeAgentPicker() {
    if (agentPickerEl) { agentPickerEl.remove(); agentPickerEl = null; }
    document.removeEventListener('mousedown', onAgentPickerOutside, true);
  }

  // Find a focus region (dashed rectangle) that contains the given node.
  // Returns the region's bounding rect in stage coords, or null.
  function enclosingFocusRegion(node) {
    const nodeRect = node.getClientRect({ relativeTo: stage });
    const cx = nodeRect.x + nodeRect.width / 2;
    const cy = nodeRect.y + nodeRect.height / 2;
    for (const f of layer.getChildren()) {
      if (f.className !== 'Rect') continue;
      if (f.getAttr?.('hiveType') !== 'focus-region') continue;
      const fx = f.x(), fy = f.y(), fw = f.width(), fh = f.height();
      if (cx >= fx && cx <= fx + fw && cy >= fy && cy <= fy + fh) {
        return { region: f, x: fx, y: fy, width: fw, height: fh };
      }
    }
    return null;
  }

  // Collect text labels of nodes / stickies / text that fall inside the
  // given stage-space rectangle (excluding the node being expanded).
  function gatherContextInRect(rect, excludeNode) {
    const texts = [];
    for (const n of layer.getChildren()) {
      if (n === excludeNode) continue;
      const r = n.getClientRect({ relativeTo: stage });
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx < rect.x || cx > rect.x + rect.width) continue;
      if (cy < rect.y || cy > rect.y + rect.height) continue;
      if (isMindNode(n)) {
        const t = n.findOne('Text');
        if (t?.text()?.trim()) texts.push(t.text().trim());
      } else if (n.className === 'Text') {
        if (n.text()?.trim()) texts.push(n.text().trim());
      } else if (n.className === 'Group' && n.getAttr?.('hiveType') === 'sticky') {
        const t = n.findOne('Text');
        if (t?.text()?.trim()) texts.push(t.text().trim());
      }
    }
    return texts;
  }

  async function runAgentExpand(group, personaId) {
    const text = group.findOne('Text');
    const topic = (text?.text() || '').trim();
    if (!topic) return;
    // If the node sits inside a focus region, harvest the other shapes
    // in that region as context for the agent.
    const focus = enclosingFocusRegion(group);
    const contextTexts = focus ? gatherContextInRect(focus, group) : [];
    const sparkGlyph = group.getChildren(c => c.className === 'Text')[2];
    if (sparkGlyph) sparkGlyph.text('⋯');
    layer.batchDraw();
    let res;
    try {
      res = await window.hive.expandMindTopic(personaId, topic, contextTexts);
    } catch (err) { res = { ok: false, error: String(err) }; }
    if (sparkGlyph) sparkGlyph.text('✨');
    layer.batchDraw();
    if (!res?.ok || !Array.isArray(res.ideas) || res.ideas.length === 0) {
      flashCanvasToast(`No ideas — ${res?.error ?? 'empty reply'}`);
      return;
    }
    const color = AGENT_COLOR[personaId] || '#D4A574';
    for (const label of res.ideas) {
      const newX = group.x() + group.findOne('Rect').width() + 100;
      spawnMindNode(newX, group.y(), group, color, label);
    }
    relayoutChildrenOf(group);
    if (focus) {
      flashCanvasToast(`Expanded with ${res.personaName ?? personaId} using ${contextTexts.length} item(s) in focus area`);
    }
    markDirty(true);
  }

  // ── Canvas chat (Q&A as mind branches) ───────────────────────────
  //
  // Right-click any mind node → persona picker → free-form question
  // input → reply spawns as a colored child connected by curve.
  // Reply nodes store hiveQA={question, answer, personaId, personaName, ts}
  // so the conversation can be re-read and continued. Right-clicking
  // a reply triggers the same flow, but ancestryQAHistory threads
  // prior Q&A pairs as conversation history.

  const REPLY_LABEL_MAX = 80;

  function summariseReply(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return '(empty reply)';
    const m = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
    let head = m ? m[0] : trimmed.split(/\n/)[0];
    if (head.length > REPLY_LABEL_MAX) head = head.slice(0, REPLY_LABEL_MAX - 1).trimEnd() + '…';
    return head;
  }

  function ancestryQAHistory(node) {
    // Walk parents oldest-first. Every Q&A ancestor contributes a
    // user→assistant pair so follow-ups thread coherently.
    const chain = [];
    let cur = node;
    let safety = 64;
    while (cur && safety-- > 0) {
      const qa = cur.getAttr?.('hiveQA');
      if (qa && qa.question && qa.answer) chain.unshift(qa);
      const pid = cur.getAttr?.('hivePid');
      if (pid == null) break;
      cur = findGroupById(pid);
    }
    const history = [];
    for (const qa of chain) {
      history.push({ role: 'user', content: qa.question });
      history.push({ role: 'assistant', content: qa.answer });
    }
    return history;
  }

  let askPickerEl = null;
  let askInputEl = null;

  function closeAskPicker() {
    if (askPickerEl) { askPickerEl.remove(); askPickerEl = null; }
    document.removeEventListener('mousedown', onAskPickerOutside, true);
  }
  function onAskPickerOutside(e) {
    if (!askPickerEl) return;
    if (!askPickerEl.contains(e.target)) closeAskPicker();
  }

  async function showAskPickerForNode(group, clientX, clientY) {
    closeAgentPicker();
    closeAskPicker();
    closeAskInput();
    if (!agentCache) {
      try {
        const res = await window.hive.listAdvisors();
        agentCache = res?.advisors ?? res ?? [];
      } catch { agentCache = []; }
    }
    const isFollowUp = !!group.getAttr?.('hiveQA');
    const header = isFollowUp ? 'Ask follow-up…' : 'Ask…';
    const el = document.createElement('div');
    el.className = 'ls-agent-picker';
    // Place near cursor; clamp to viewport
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(clientX, vw - 280);
    const top = Math.min(clientY, vh - 320);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.innerHTML = `
      <div class="ls-agent-picker-h">${escapeHtml(header)}</div>
      ${agentCache.map(a => `
        <button class="ls-agent-picker-row" data-persona="${a.id}">
          <span class="ls-agent-picker-dot" style="background:${AGENT_COLOR[a.id] || '#8A8F98'};"></span>
          <span class="ls-agent-picker-name">${escapeHtml(a.name)}</span>
          <span class="ls-agent-picker-scope">${escapeHtml((a.title || a.scope || '').slice(0, 40))}</span>
        </button>
      `).join('')}
    `;
    document.body.appendChild(el);
    askPickerEl = el;
    el.querySelectorAll('[data-persona]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.persona;
        const persona = agentCache.find(a => a.id === pid);
        closeAskPicker();
        showAskInputForNode(group, persona, clientX, clientY);
      });
    });
    setTimeout(() => document.addEventListener('mousedown', onAskPickerOutside, true), 0);
  }

  function closeAskInput() {
    if (askInputEl) { askInputEl.remove(); askInputEl = null; }
    document.removeEventListener('mousedown', onAskInputOutside, true);
  }
  function onAskInputOutside(e) {
    if (!askInputEl) return;
    if (!askInputEl.contains(e.target)) closeAskInput();
  }

  function showAskInputForNode(group, persona, clientX, clientY) {
    closeAskInput();
    const personaName = persona?.name ?? persona?.id ?? 'advisor';
    const personaId = persona?.id;
    if (!personaId) return;
    const color = AGENT_COLOR[personaId] || '#D4A574';
    const isFollowUp = !!group.getAttr?.('hiveQA');
    const topicText = (group.findOne('Text')?.text() || '').trim();

    const el = document.createElement('div');
    el.className = 'ls-ask-input';
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(clientX, vw - 340);
    const top = Math.min(clientY, vh - 180);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.innerHTML = `
      <div class="ls-ask-input-h">
        <span class="ls-agent-picker-dot" style="background:${color};"></span>
        <span class="ls-ask-input-persona">${escapeHtml(personaName)}</span>
        <span class="ls-ask-input-topic">${escapeHtml(isFollowUp ? 'follow-up' : (topicText.slice(0, 32) || 'topic'))}</span>
      </div>
      <textarea class="ls-ask-input-ta" placeholder="${isFollowUp ? 'Follow-up question…' : 'Ask anything…'}" rows="3"></textarea>
      <div class="ls-ask-input-hint">Enter to send · Shift+Enter newline · Esc cancel</div>
    `;
    document.body.appendChild(el);
    askInputEl = el;
    const ta = el.querySelector('textarea');
    ta.focus();
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeAskInput(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const q = ta.value.trim();
        if (!q) { closeAskInput(); return; }
        closeAskInput();
        runAsk(group, personaId, personaName, q, color);
      }
    });
    setTimeout(() => document.addEventListener('mousedown', onAskInputOutside, true), 0);
  }

  async function runAsk(sourceGroup, personaId, personaName, question, color) {
    // Spinner on source node — reuse the spark glyph slot
    const texts = sourceGroup.getChildren(c => c.className === 'Text');
    const sparkGlyph = texts[2];
    let prevSpark = null;
    if (sparkGlyph) {
      prevSpark = sparkGlyph.text();
      sparkGlyph.text('⋯');
      sparkGlyph.opacity(1);
      layer.batchDraw();
    }
    flashCanvasToast(`Asking ${personaName}…`);
    const history = ancestryQAHistory(sourceGroup);
    let res;
    try {
      res = await window.hive.consultAdvisor(personaId, question, history);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    if (sparkGlyph) {
      sparkGlyph.text(prevSpark ?? '✨');
      sparkGlyph.opacity(0);
      layer.batchDraw();
    }
    const reply = res?.reply ?? res?.text ?? '';
    if (!reply || (typeof res === 'object' && res?.ok === false)) {
      flashCanvasToast(`No reply — ${res?.error ?? 'empty'}`);
      return;
    }
    spawnReplyNode(sourceGroup, personaId, personaName, question, reply, color);
  }

  function spawnReplyNode(parentGroup, personaId, personaName, question, answer, color) {
    const label = summariseReply(answer);
    const parentRect = parentGroup.findOne('Rect');
    const newX = parentGroup.x() + parentRect.width() + 100;
    const replyColor = color || AGENT_COLOR[personaId] || '#D4A574';
    const group = spawnMindNode(newX, parentGroup.y(), parentGroup, replyColor, label);
    group.setAttr('hiveQA', {
      question,
      answer,
      personaId,
      personaName,
      ts: Date.now(),
    });
    // If answer has more than the label captures, add an expand indicator
    if (answer.trim().length > label.length) {
      addExpandIndicator(group);
    }
    relayoutChildrenOf(parentGroup);
    markDirty(true);
    return group;
  }

  function addExpandIndicator(group) {
    const rect = group.findOne('Rect');
    if (!rect) return;
    const w = rect.width();
    const h = rect.height();
    const color = group.getAttr('hiveBranchColor') || '#D4A574';
    // Small chevron at bottom-right indicating "more"
    const indicator = new Konva.Text({
      x: w - 14, y: h - 12,
      text: '▾',
      fontSize: 9,
      fill: color,
      opacity: 0.65,
      listening: true,
    });
    indicator.setAttr('hiveType', 'qa-expand');
    indicator.on('click tap', (e) => {
      e.cancelBubble = true;
      openReplyPanel(group);
    });
    indicator.on('mouseenter', () => { indicator.opacity(1); STAGE_HOST.style.cursor = 'pointer'; layer.batchDraw(); });
    indicator.on('mouseleave', () => { indicator.opacity(0.65); STAGE_HOST.style.cursor = ''; layer.batchDraw(); });
    group.add(indicator);
    layer.batchDraw();
  }

  let replyPanelEl = null;
  function closeReplyPanel() {
    if (replyPanelEl) { replyPanelEl.remove(); replyPanelEl = null; }
    document.removeEventListener('keydown', onReplyPanelKey, true);
  }
  function onReplyPanelKey(e) {
    if (e.key === 'Escape') closeReplyPanel();
  }

  function openReplyPanel(group) {
    closeReplyPanel();
    const qa = group.getAttr?.('hiveQA');
    if (!qa) return;
    const color = AGENT_COLOR[qa.personaId] || '#D4A574';
    const ts = qa.ts ? new Date(qa.ts).toLocaleString() : '';
    const el = document.createElement('div');
    el.className = 'ls-reply-panel';
    el.innerHTML = `
      <div class="ls-reply-panel-h">
        <span class="ls-agent-picker-dot" style="background:${color};"></span>
        <span class="ls-reply-panel-name">${escapeHtml(qa.personaName || qa.personaId || '')}</span>
        <span class="ls-reply-panel-ts">${escapeHtml(ts)}</span>
        <button class="ls-reply-panel-close" type="button">×</button>
      </div>
      <div class="ls-reply-panel-q-label">Question</div>
      <div class="ls-reply-panel-q">${escapeHtml(qa.question)}</div>
      <div class="ls-reply-panel-a-label">Reply</div>
      <div class="ls-reply-panel-a">${escapeHtml(qa.answer)}</div>
      <div class="ls-reply-panel-actions">
        <button class="ls-reply-panel-followup" type="button">Ask follow-up</button>
      </div>
    `;
    document.body.appendChild(el);
    replyPanelEl = el;
    el.querySelector('.ls-reply-panel-close').addEventListener('click', closeReplyPanel);
    el.querySelector('.ls-reply-panel-followup').addEventListener('click', () => {
      const rect = group.findOne('Rect').getClientRect({ relativeTo: stage });
      const hostRect = STAGE_HOST.getBoundingClientRect();
      const cx = hostRect.left + rect.x + rect.width + 40;
      const cy = hostRect.top + rect.y;
      closeReplyPanel();
      // Skip picker — re-use the same persona
      const persona = (agentCache || []).find(a => a.id === qa.personaId)
        ?? { id: qa.personaId, name: qa.personaName };
      showAskInputForNode(group, persona, cx, cy);
    });
    document.addEventListener('keydown', onReplyPanelKey, true);
  }

  function flashCanvasToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#16171A;color:#F7F8F8;padding:10px 14px;border:1px solid #1F2023;border-radius:6px;font-size:12px;z-index:200;box-shadow:0 4px 16px rgba(0,0,0,0.5);`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  function autoSizeMindNode(group) {
    if (!isMindNode(group)) return;
    const text = group.findOne('Text');
    const rect = group.findOne('Rect');
    if (!text || !rect) return;
    const padX = 14, padY = 9;
    const innerW = Math.max(50, text.width());
    const newW = innerW + padX * 2;
    const newH = text.height() + padY * 2;
    rect.width(newW);
    rect.height(newH);
    rect.cornerRadius(Math.min(newH / 2, 18));
    text.position({ x: padX, y: padY });
    // Reposition + button
    const PLUS_R = 9;
    const plusBg = group.findOne('Circle');
    const plusGlyph = group.getChildren(c => c.className === 'Text')[1];
    if (plusBg) { plusBg.x(newW + PLUS_R + 4); plusBg.y(newH / 2); }
    if (plusGlyph) { plusGlyph.x(newW + 4); plusGlyph.y(newH / 2 - 9); }
  }

  function drawMindConnector(fromGroup, toGroup, color) {
    const fromRect = fromGroup.findOne('Rect');
    const toRect = toGroup.findOne('Rect');
    const fromX = fromGroup.x() + fromRect.width();
    const fromY = fromGroup.y() + fromRect.height() / 2;
    const toX = toGroup.x();
    const toY = toGroup.y() + toRect.height() / 2;
    // Width: thicker at parent end, thinner toward leaf. Roots get a
    // slightly fatter taper to read as the trunk.
    const isFromRoot = !fromGroup.getAttr('hivePid');
    const wStart = isFromRoot ? 5 : 3.5;
    const wEnd = 1.4;
    const line = new Konva.Line({
      points: taperedConnectorPoints(fromX, fromY, toX, toY, wStart, wEnd),
      fill: color ?? '#5D6068',
      closed: true,
      stroke: null,
      strokeEnabled: false,
      lineJoin: 'round',
      hitStrokeWidth: 12,
    });
    line.setAttr('hiveConnector', true);
    line.setAttr('hiveFromId', fromGroup._id);
    line.setAttr('hiveToId', toGroup._id);
    layer.add(line);
    line.moveToBottom();
    return line;
  }

  // Sweep orphan connectors — lines whose from/to nodes no longer exist.
  // Runs on canvas load to clean up pre-cascade-fix state.
  function cleanupOrphanConnectors() {
    const ids = new Set(layer.getChildren().map(n => n._id));
    const orphans = layer.getChildren(n =>
      n.className === 'Line' &&
      n.getAttr?.('hiveConnector') &&
      (!ids.has(n.getAttr('hiveFromId')) || !ids.has(n.getAttr('hiveToId')))
    );
    if (orphans.length) {
      console.log('[hive canvas] sweeping', orphans.length, 'orphan connector(s)');
      orphans.forEach(o => o.destroy());
      layer.draw();
    }
    return orphans.length;
  }

  // Tapered cubic-bezier connector. Sampled into a closed polygon so we
  // can vary the width along the curve (true tapering — Canvas's stroke
  // is uniform, so we render the connector as a filled shape instead).
  // Control points are offset horizontally with magnitude proportional to
  // the parent→child distance, which gives Lucid/Coggle-style smooth
  // horizontal tangents at both ends.
  function taperedConnectorPoints(fromX, fromY, toX, toY, widthStart, widthEnd) {
    const samples = 28;
    const dx = toX - fromX;
    const offset = Math.max(40, Math.abs(dx) * 0.5);
    const c1x = fromX + offset, c1y = fromY;
    const c2x = toX - offset, c2y = toY;
    // Pre-compute (x, y, perpendicular normal) at each sample
    const xs = [], ys = [], nxs = [], nys = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const u = 1 - t;
      const x = u*u*u*fromX + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*toX;
      const y = u*u*u*fromY + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*toY;
      const tx = 3*u*u*(c1x - fromX) + 6*u*t*(c2x - c1x) + 3*t*t*(toX - c2x);
      const ty = 3*u*u*(c1y - fromY) + 6*u*t*(c2y - c1y) + 3*t*t*(toY - c2y);
      const len = Math.hypot(tx, ty) || 1;
      xs.push(x); ys.push(y);
      nxs.push(-ty / len); nys.push(tx / len);
    }
    // Build polygon — upper edge forward, lower edge reverse
    const poly = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const w = (widthStart * (1 - t) + widthEnd * t) / 2;
      poly.push(xs[i] + nxs[i] * w, ys[i] + nys[i] * w);
    }
    for (let i = samples; i >= 0; i--) {
      const t = i / samples;
      const w = (widthStart * (1 - t) + widthEnd * t) / 2;
      poly.push(xs[i] - nxs[i] * w, ys[i] - nys[i] * w);
    }
    return poly;
  }
  // Back-compat alias for any caller still expecting bezierPoints
  function bezierPoints(fromX, fromY, toX, toY) {
    return taperedConnectorPoints(fromX, fromY, toX, toY, 3, 1.5);
  }

  function updateMindConnectors(movedGroup) {
    layer.getChildren().forEach(n => {
      if (n.className !== 'Line') return;
      if (!n.getAttr('hiveConnector')) return;
      const fromId = n.getAttr('hiveFromId');
      const toId = n.getAttr('hiveToId');
      if (fromId !== movedGroup._id && toId !== movedGroup._id) return;
      const fromGroup = findGroupById(fromId);
      const toGroup = findGroupById(toId);
      if (!fromGroup || !toGroup) return;
      const fromRect = fromGroup.findOne('Rect');
      const toRect = toGroup.findOne('Rect');
      const fromX = fromGroup.x() + fromRect.width();
      const fromY = fromGroup.y() + fromRect.height() / 2;
      const toX = toGroup.x();
      const toY = toGroup.y() + toRect.height() / 2;
      n.points(bezierPoints(fromX, fromY, toX, toY));
    });
  }

  // After loading state, rebuild mind connectors from parent links
  // (toJSON serialises the groups + their hivePid attrs, but the
  // connector Lines also serialise. We just re-wire the dragmove
  // handlers so connectors update again.)
  // Cascade-delete: if the node is a mind-node, also destroy any connectors
  // touching it AND recursively destroy descendant mind-nodes (so deleting
  // a branch takes the whole limb).
  function destroyNodeWithConnectors(node) {
    if (!node) return;
    if (isMindNode(node)) {
      // Find children first (mind nodes whose hivePid === this._id)
      const myId = node._id;
      const children = layer.getChildren(n => isMindNode(n) && n.getAttr('hivePid') === myId);
      for (const c of children) destroyNodeWithConnectors(c);
      // Connectors where from or to is this node
      const connectors = layer.getChildren(n => n.className === 'Line' && n.getAttr?.('hiveConnector') && (n.getAttr('hiveFromId') === myId || n.getAttr('hiveToId') === myId));
      for (const c of connectors) c.destroy();
    }
    node.destroy();
  }

  function rewireMindNodesAfterLoad() {
    // Wipe all existing connectors and redraw from parent-child links —
    // this also migrates old uniform-stroke connectors to the new
    // tapered-fill format in one pass.
    const stale = layer.getChildren(n => n.className === 'Line' && n.getAttr?.('hiveConnector'));
    stale.forEach(c => c.destroy());

    layer.getChildren().forEach(n => {
      if (!isMindNode(n)) return;
      const text = n.findOne('Text');
      const rect = n.findOne('Rect');
      // Canvas may have been saved before ✨ was added → pad missing
      // sub-shapes onto the group so older nodes get the affordance.
      let circles = n.getChildren(c => c.className === 'Circle');
      let texts = n.getChildren(c => c.className === 'Text');
      // Ensure two Circles (plusBg, sparkBg) and three Texts (text, plusGlyph, sparkGlyph)
      const rW = rect?.width() ?? 100;
      const rH = rect?.height() ?? 32;
      const PLUS_R = 9;
      const branchColor = n.getAttr('hiveBranchColor') ?? '#D4A574';
      if (circles.length < 2) {
        const sparkBg = new Konva.Circle({
          x: rW + PLUS_R * 3 + 8, y: rH / 2, radius: PLUS_R,
          fill: '#1F2023', stroke: branchColor, strokeWidth: 1.5, opacity: 0,
        });
        n.add(sparkBg);
      }
      if (texts.length < 3) {
        const sparkGlyph = new Konva.Text({
          x: rW + PLUS_R * 2 + 8, y: rH / 2 - 8,
          width: PLUS_R * 2, height: PLUS_R * 2,
          text: '✨', fontSize: 11, fill: branchColor,
          align: 'center', verticalAlign: 'middle', opacity: 0,
        });
        n.add(sparkGlyph);
      }
      circles = n.getChildren(c => c.className === 'Circle');
      texts = n.getChildren(c => c.className === 'Text');
      const plusBg = circles[0];
      const sparkBg = circles[1];
      const plusGlyph = texts[1];
      const sparkGlyph = texts[2];

      if (plusBg) plusBg.opacity(0);
      if (plusGlyph) plusGlyph.opacity(0);
      if (sparkBg) sparkBg.opacity(0);
      if (sparkGlyph) sparkGlyph.opacity(0);

      if (rect && text) {
        const onEdit = (e) => { e.cancelBubble = true; editTextNode(text, n); };
        rect.on('click tap', onEdit);
        text.on('click tap', onEdit);
        rect.on('dblclick dbltap', onEdit);
        text.on('dblclick dbltap', onEdit);
      }
      if (plusBg) plusBg.on('click tap', (e) => { e.cancelBubble = true; addMindChild(n); });
      if (plusGlyph) plusGlyph.on('click tap', (e) => { e.cancelBubble = true; addMindChild(n); });
      if (sparkBg) sparkBg.on('click tap', (e) => { e.cancelBubble = true; showAgentPickerForNode(n); });
      if (sparkGlyph) sparkGlyph.on('click tap', (e) => { e.cancelBubble = true; showAgentPickerForNode(n); });

      // Right-click → canvas-chat Ask flow (mirrors spawnMindNode wiring)
      n.on('contextmenu', (e) => {
        e.cancelBubble = true;
        if (e.evt) { e.evt.preventDefault(); }
        const cx = e.evt?.clientX ?? 0;
        const cy = e.evt?.clientY ?? 0;
        showAskPickerForNode(n, cx, cy);
      });

      // Re-attach the Q&A expand indicator click on reload — it round-trips
      // via Konva.toJSON (hiveType attr preserved) but event handlers do not.
      if (n.getAttr?.('hiveQA')) {
        const extraTexts = n.getChildren(c => c.className === 'Text' && c.getAttr?.('hiveType') === 'qa-expand');
        for (const ind of extraTexts) {
          ind.off('click tap mouseenter mouseleave');
          ind.on('click tap', (e) => { e.cancelBubble = true; openReplyPanel(n); });
          ind.on('mouseenter', () => { ind.opacity(1); STAGE_HOST.style.cursor = 'pointer'; layer.batchDraw(); });
          ind.on('mouseleave', () => { ind.opacity(0.65); STAGE_HOST.style.cursor = ''; layer.batchDraw(); });
        }
      }

      // Hover affordance
      n.on('mouseenter', () => {
        if (plusBg) plusBg.opacity(0.92);
        if (plusGlyph) plusGlyph.opacity(1);
        if (sparkBg) sparkBg.opacity(1);
        if (sparkGlyph) sparkGlyph.opacity(1);
        layer.batchDraw();
        STAGE_HOST.style.cursor = 'pointer';
      });
      n.on('mouseleave', () => {
        if (plusBg) plusBg.opacity(0);
        if (plusGlyph) plusGlyph.opacity(0);
        if (sparkBg) sparkBg.opacity(0);
        if (sparkGlyph) sparkGlyph.opacity(0);
        layer.batchDraw();
        STAGE_HOST.style.cursor = '';
      });

      // Drag wiring (same as spawnMindNode)
      let dragStarted = false;
      let descSnap = null;
      let dropTarget = null;
      n.on('dragstart', () => {
        dragStarted = true;
        const sx = n.x(), sy = n.y();
        descSnap = descendantsOf(n).map(d => ({ node: d, dx0: d.x() - sx, dy0: d.y() - sy }));
        n.moveToTop();
      });
      n.on('dragmove', () => {
        if (descSnap) {
          const x = n.x(), y = n.y();
          for (const d of descSnap) { d.node.x(x + d.dx0); d.node.y(y + d.dy0); }
        }
        const myRect = n.getClientRect({ relativeTo: stage });
        let found = null;
        for (const other of layer.getChildren()) {
          if (!isMindNode(other) || other === n) continue;
          if (isDescendantOf(other, n)) continue;
          if (other.getAttr('hivePid') === n._id) continue;
          const oR = other.getClientRect({ relativeTo: stage });
          if (rectsOverlap(myRect, oR)) { found = other; break; }
        }
        if (dropTarget !== found) {
          if (dropTarget) {
            const r = dropTarget.findOne('Rect');
            if (r) { r.shadowEnabled(false); r.strokeWidth(2); }
          }
          dropTarget = found;
          if (dropTarget) {
            const r = dropTarget.findOne('Rect');
            if (r) {
              r.shadowColor('#D4A574'); r.shadowBlur(20); r.shadowOpacity(0.9);
              r.shadowOffset({ x: 0, y: 0 }); r.shadowEnabled(true); r.strokeWidth(3);
            }
          }
        }
        redrawAllMindConnectors();
      });
      n.on('dragend', () => {
        if (dropTarget) {
          const r = dropTarget.findOne('Rect');
          if (r) { r.shadowEnabled(false); r.strokeWidth(2); }
          reparentMindNode(n, dropTarget);
        }
        dropTarget = null; descSnap = null;
        markDirty(true);
        setTimeout(() => { dragStarted = false; }, 0);
      });
    });

    // Rebuild connectors from parent-child links
    layer.getChildren().forEach(n => {
      if (!isMindNode(n)) return;
      const pid = n.getAttr('hivePid');
      if (pid == null) return;
      const parent = findGroupById(pid);
      if (!parent) return;
      drawMindConnector(parent, n, n.getAttr('hiveBranchColor'));
    });
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

  // Direct in-canvas text editing — no DOM overlay, no focus games.
  // We keep a buffer on the node and listen to keys at the document
  // level, routing them into the buffer until Enter/Esc/click-outside.
  // Sidesteps the focus-loss issue that plagued the textarea approach.
  let activeTextEditor = null;  // { node, parentGroup, buffer, commit, cancel, isFresh }

  function editTextNode(textNode, parentGroup, isFresh) {
    if (textNode.__editorOpen) return;
    if (textNode.__destroyed) return;
    // If another editor is active, commit it first
    if (activeTextEditor) activeTextEditor.commit();
    textNode.__editorOpen = true;

    let buffer = isFresh ? '' : (textNode.text() || '').replace(/​/g, '');
    const ORIGINAL = buffer;

    // Cursor indicator: a small caret appended to the visible text. We
    // show buffer + '▎' while editing, then strip on commit.
    function render() {
      const display = buffer + '▎';
      textNode.text(display);
      layer.batchDraw();
    }
    render();

    // Mind nodes get a placeholder label on empty-commit instead of
    // being destroyed — otherwise pressing Tab on a fresh node would
    // wipe its parent and orphan the new child's connector.
    const isMindNode_ = parentGroup && parentGroup.getAttr?.('hiveType') === 'mind-node';

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      textNode.__editorOpen = false;
      activeTextEditor = null;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onOutsideMouseDown, true);
      const final = buffer.trim();
      if (!final) {
        if (isMindNode_) {
          textNode.text('Idea');
        } else {
          textNode.destroy();
          if (parentGroup) parentGroup.destroy();
          transformer.nodes([]);
        }
      } else {
        textNode.text(buffer);
      }
      if (isMindNode_ && parentGroup) {
        autoSizeMindNode(parentGroup);
        // Relayout this branch + ancestors so the parent re-spaces children
        const pid = parentGroup.getAttr('hivePid');
        const ancestor = pid != null ? findGroupById(pid) : parentGroup;
        if (ancestor) relayoutChildrenOf(ancestor);
        redrawAllMindConnectors();
      }
      layer.draw();
      cleanupOrphanConnectors();
      markDirty(true);
    }
    function cancel() {
      if (committed) return;
      committed = true;
      textNode.__editorOpen = false;
      activeTextEditor = null;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onOutsideMouseDown, true);
      if (!ORIGINAL.trim()) {
        if (isMindNode_) {
          textNode.text('Idea');
        } else {
          textNode.destroy();
          if (parentGroup) parentGroup.destroy();
          transformer.nodes([]);
        }
      } else {
        textNode.text(ORIGINAL);
      }
      layer.draw();
      cleanupOrphanConnectors();
    }

    // Is the node being edited a mind-node? (its parent group has hiveType)
    const isMind = parentGroup && parentGroup.getAttr?.('hiveType') === 'mind-node';

    function onKey(e) {
      if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      // Mind-map keyboard flow: Enter = commit + add sibling, Tab = commit + add child.
      // Plain text: Enter just commits.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const node = parentGroup;
        commit();
        if (isMind && node && !node.__destroyed) {
          const sib = addMindSibling(node);
          // editor opens inside addMindSibling via addMindChild
        }
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const node = parentGroup;
        commit();
        if (isMind && node && !node.__destroyed) {
          addMindChild(node);
        }
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); buffer += '\n'; render(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); buffer = buffer.slice(0, -1); render(); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        buffer += e.key;
        render();
      }
    }

    function onOutsideMouseDown(e) {
      // Konva's canvas elements live inside STAGE_HOST. A click anywhere
      // commits the edit (Figma-style).
      // Skip clicks that originate inside the rail (so picking another
      // canvas commits, not cancels).
      commit();
    }

    document.addEventListener('keydown', onKey, true);
    // Defer mousedown listener to skip the spawning click
    setTimeout(() => {
      document.addEventListener('mousedown', onOutsideMouseDown, true);
    }, 50);

    activeTextEditor = { node: textNode, parentGroup, commit, cancel };
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

  // Text / stroke color palette
  function setColor(hex) {
    currentColor = hex;
    document.querySelectorAll('#ls-color-picker .ls-color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === hex);
    });
    // Recolor selected nodes
    const selected = transformer?.nodes() ?? [];
    if (selected.length) {
      for (const n of selected) {
        if (n.className === 'Text') n.fill(hex);
        else if (n.className === 'Line' || n.className === 'Arrow') { n.stroke(hex); if (n.className === 'Arrow') n.fill(hex); }
        else if (n.className === 'Group') {
          // Sticky group: recolor inner text only (leave background)
          const t = n.findOne('Text');
          if (t) t.fill(hex);
        }
      }
      layer.draw();
      markDirty(true);
    }
  }
  document.querySelectorAll('#ls-color-picker .ls-color-swatch').forEach(s => {
    s.addEventListener('click', () => setColor(s.dataset.color));
  });
  setColor(currentColor);  // initialise active swatch

  // Background picker
  const bgBtn = document.getElementById('ls-canvas-bg-btn');
  const bgMenu = document.getElementById('ls-canvas-bg-menu');
  bgBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    bgMenu.style.display = bgMenu.style.display === 'none' ? 'grid' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!bgMenu || bgMenu.style.display === 'none') return;
    if (!bgMenu.contains(e.target) && e.target !== bgBtn) bgMenu.style.display = 'none';
  });
  bgMenu?.querySelectorAll('.ls-bg-swatch').forEach(b => {
    b.addEventListener('click', () => {
      applyBg(b.dataset.bg);
      bgMenu.style.display = 'none';
      markDirty(true);
    });
  });

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!isVisible()) return;
    if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    if (document.querySelector('.ls-canvas-text-overlay')) return;  // any text editor open → don't intercept
    if (pendingTextEdit) return;  // editor is about to open
    if (currentTool === 'text') return;  // text tool active → keys are content, not shortcuts
    if (e.key === ' ') { spaceHeld = true; STAGE_HOST.classList.add('panning'); }
    else if (e.key.toLowerCase() === 'v') setTool('select');
    else if (e.key.toLowerCase() === 'h') setTool('pan');
    else if (e.key.toLowerCase() === 'p') setTool('pen');
    else if (e.key.toLowerCase() === 'a') setTool('arrow');
    else if (e.key.toLowerCase() === 't') setTool('text');
    else if (e.key.toLowerCase() === 'n') setTool('sticky');
    else if (e.key.toLowerCase() === 'm') setTool('mind');
    else if (e.key.toLowerCase() === 'i') setTool('image');
    else if (e.key.toLowerCase() === 'f') fitToContent();
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = transformer.nodes();
      if (sel.length) { sel.forEach(n => destroyNodeWithConnectors(n)); transformer.nodes([]); markDirty(true); }
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
      bg: currentBg,
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
    markPhotoThumbsUsed();
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
        refreshList();  // bubble name changes into the rail
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
    // Background
    applyBg(parsed.bg || 'dotted');
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
    rewireMindNodesAfterLoad();
    cleanupOrphanConnectors();
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

  function showRailContextMenu(railItemEl, x, y) {
    // Remove any existing menu
    document.querySelectorAll('.ls-rail-ctx-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'ls-rail-ctx-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = `
      <button data-act="rename">Rename</button>
      <button data-act="delete">Delete</button>
    `;
    document.body.appendChild(menu);
    const closeMenu = () => { menu.remove(); document.removeEventListener('click', onOutside, true); };
    const onOutside = (e) => { if (!menu.contains(e.target)) closeMenu(); };
    setTimeout(() => document.addEventListener('click', onOutside, true), 0);
    menu.querySelector('[data-act="rename"]').addEventListener('click', () => {
      closeMenu();
      startInlineRailRename(railItemEl);
    });
    menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      closeMenu();
      const id = Number(railItemEl.dataset.id);
      const name = railItemEl.dataset.name;
      if (!confirm(`Delete canvas "${name}"? This cannot be undone.`)) return;
      await window.hive.deleteCanvas(id);
      const wasActive = id === currentCanvasId;
      if (wasActive) currentCanvasId = null;
      await refreshList();
      if (wasActive) {
        const after = await window.hive.listCanvases();
        const list = after?.canvases ?? [];
        if (list.length) await loadCanvas(list[0].id); else await newCanvas();
      }
    });
  }

  function startInlineRailRename(el) {
    const id = Number(el.dataset.id);
    const nameSpan = el.querySelector('.ls-canvas-rail-name');
    if (!nameSpan) return;
    const current = el.dataset.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ls-canvas-rail-rename';
    input.value = current;
    input.maxLength = 120;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (!next || next === current) {
        await refreshList();
        return;
      }
      if (id === currentCanvasId) {
        currentCanvasName = next;
        if (NAME_INPUT) NAME_INPUT.value = next;
        scheduleSave();
      } else {
        const res = await window.hive.getCanvas(id);
        const existing = res?.canvas?.stateJson ?? '{}';
        await window.hive.saveCanvas({ id, stateJson: existing, name: next });
        refreshList();
      }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; refreshList(); }
    });
    input.addEventListener('blur', commit);
  }

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
      <div class="ls-canvas-rail-item${c.id === currentCanvasId ? ' active' : ''}" data-id="${c.id}" data-name="${escapeHtml(c.name)}" title="Click to open · Double-click to rename">
        <span class="ls-canvas-rail-name">${escapeHtml(c.name)}</span>
        <button class="ls-canvas-rail-icon" data-act="rename" title="Rename">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/></svg>
        </button>
        <button class="ls-canvas-rail-icon ls-canvas-rail-icon-danger" data-act="delete" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/></svg>
        </button>
        <span class="ls-canvas-rail-date">${shortDate(c.updatedAt)}</span>
      </div>
    `).join('');
    RAIL_LIST.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showRailContextMenu(el, e.clientX, e.clientY);
      });
      // Rename icon → inline rename
      el.querySelector('[data-act="rename"]')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        startInlineRailRename(el);
      });

      // Delete icon → confirm + delete
      el.querySelector('[data-act="delete"]')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const id = Number(el.dataset.id);
        const name = el.dataset.name;
        if (!confirm(`Delete canvas "${name}"? This cannot be undone.`)) return;
        await window.hive.deleteCanvas(id);
        const wasActive = id === currentCanvasId;
        if (wasActive) currentCanvasId = null;
        await refreshList();
        if (wasActive) {
          const after = await window.hive.listCanvases();
          const list = after?.canvases ?? [];
          if (list.length) await loadCanvas(list[0].id); else await newCanvas();
        }
      });

      el.addEventListener('click', async (e) => {
        // Don't open canvas when clicking action icons
        const act = e.target.closest?.('[data-act]')?.dataset?.act;
        if (act) return;
        if (e.altKey) {
          const id = Number(el.dataset.id);
          const name = el.dataset.name;
          if (!confirm(`Delete canvas "${name}"? This cannot be undone.`)) return;
          await window.hive.deleteCanvas(id);
          if (id === currentCanvasId) { currentCanvasId = null; }
          await refreshList();
          // If we deleted the active one, open the next-most-recent or make a new blank
          if (id === currentCanvasId || !currentCanvasId) {
            const after = await window.hive.listCanvases();
            const list = after?.canvases ?? [];
            if (list.length) await loadCanvas(list[0].id); else await newCanvas();
          }
          return;
        }
        loadCanvas(Number(el.dataset.id));
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineRailRename(el);
      });
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
    markPhotoThumbsUsed();
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
  const PHOTOS_WINDOW_KEY = 'hive.photosWindow';
  function chosenPhotosFolder() { try { return localStorage.getItem(PHOTOS_FOLDER_KEY) || undefined; } catch { return undefined; } }
  function setChosenPhotosFolder(p) { try { localStorage.setItem(PHOTOS_FOLDER_KEY, p); } catch {} }
  function chosenPhotosWindow() { try { return localStorage.getItem(PHOTOS_WINDOW_KEY) || 'today'; } catch { return 'today'; } }
  function setChosenPhotosWindow(w) { try { localStorage.setItem(PHOTOS_WINDOW_KEY, w); } catch {} }

  function windowToSinceTs(win) {
    const now = Date.now();
    if (win === 'all') return 0;
    if (win === 'today') {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    const m = /^(\d+)d$/.exec(win);
    if (m) return now - Number(m[1]) * 24 * 3600 * 1000;
    return 0;
  }

  async function refreshPhotos() {
    photosLoaded = true;
    if (!PHOTOS_GRID || !PHOTOS_EMPTY) return;
    PHOTOS_GRID.innerHTML = '<div style="grid-column:1/-1;color:var(--ls-text-faint);font-size:11px;padding:14px 6px;text-align:center;">Loading…</div>';
    PHOTOS_EMPTY.style.display = 'none';
    let res;
    const folder = chosenPhotosFolder();
    const win = chosenPhotosWindow();
    const sinceTs = windowToSinceTs(win);
    try { res = await window.hive.listPhotos({ folder, limit: 200, sinceTs }); } catch (err) { res = { ok: false, error: String(err) }; }
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
    markPhotoThumbsUsed();
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
    spawnImage(res.dataUrl, c.x, c.y, { sourcePath: photoPath });
  }

  function markPhotoThumbsUsed() {
    if (!PHOTOS_GRID) return;
    const used = new Set();
    for (const n of layer.getChildren()) {
      if (n.className !== 'Image') continue;
      const p = n.getAttr('hiveSourcePath');
      if (p) used.add(p);
    }
    PHOTOS_GRID.querySelectorAll('.ls-photo-thumb[data-photo]').forEach(el => {
      el.classList.toggle('used', used.has(el.dataset.photo));
    });
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
    startWatcher();
  });
  // Date range buttons — sync the .active class with localStorage on
  // load, refresh on click.
  function syncRangeButtons() {
    const cur = chosenPhotosWindow();
    document.querySelectorAll('#ls-photos-range .ls-photos-range-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.window === cur);
    });
  }
  document.querySelectorAll('#ls-photos-range .ls-photos-range-btn').forEach(b => {
    b.addEventListener('click', () => {
      setChosenPhotosWindow(b.dataset.window);
      syncRangeButtons();
      photosLoaded = false;
      refreshPhotos();
    });
  });
  syncRangeButtons();

  // Folder watcher → auto-refresh thumbnail grid when iPhone screenshots
  // land (debounced because iCloud often touches files several times as
  // it syncs).
  let watchDebounce = null;
  let watcherActive = false;
  async function startWatcher() {
    const folder = chosenPhotosFolder();
    if (!folder) return;
    try {
      await window.hive.watchPhotosFolder(folder);
      watcherActive = true;
    } catch {}
  }
  window.hive.onPhotosFolderEvent?.(() => {
    if (!watcherActive) return;
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      photosLoaded = false;
      refreshPhotos();
    }, 800);
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

  // Wire sidebar nav click into open() — kick off the watcher whenever
  // the canvas view opens so new iPhone screenshots refresh the grid.
  document.querySelectorAll('.linear-shell .ls-nav-item[data-view="canvas"]').forEach(el => {
    el.addEventListener('click', async () => {
      await open();
      if (typeof startWatcher === 'function' && chosenPhotosFolder()) startWatcher();
    }, true);  // capture phase so we run before the default handler that flashes a toast
  });
})();
