// ════════════════════════════════════════════════════════════════════
// CHAT VIEW (v3.0-δ)
//
// Live conversational chat with any persona (default Programme Lead).
// Per-message provider + model picker. Tools enabled by default so
// the persona can read FXV files, fetch web pages, list Hive actions.
//
// Voice in: browser SpeechRecognition. Voice out: existing speak IPC
// (per-message play button on each assistant reply).
//
// State is held in-memory; history isn't persisted yet (intentional —
// add SQLite persistence in a follow-up once shape stabilises).
// ════════════════════════════════════════════════════════════════════

(function chatModule() {
  const SHELL = document.getElementById('ls-chat-shell');
  if (!SHELL) return;

  const NEW_BTN = document.getElementById('ls-chat-new');
  const PERSONA_PILL = document.getElementById('ls-chat-persona-pill');
  const HEADER_DOT = document.getElementById('ls-chat-persona-dot');
  const HEADER_NAME = document.getElementById('ls-chat-persona-name');
  const HEADER_TITLE = document.getElementById('ls-chat-persona-title');
  const TOOLS_TOGGLE = document.getElementById('ls-chat-tools');
  const HISTORY = document.getElementById('ls-chat-history');
  const PROVIDER_SEL = document.getElementById('ls-chat-provider');
  const MODEL_SEL = document.getElementById('ls-chat-model');
  const MIC_BTN = document.getElementById('ls-chat-mic');
  const INPUT = document.getElementById('ls-chat-input');
  const SEND_BTN = document.getElementById('ls-chat-send');
  const COUNCIL_BTN = document.getElementById('ls-chat-council');

  const PERSONA_COLOR = {
    'fxv:aerobic':    '#6BBF7B',
    'fxv:strength':   '#E07B5F',
    'fxv:concurrent': '#D4A574',
    'fxv:load':       '#B7AFE0',
    'fxv:readiness':  '#6BB1D6',
    'fxv:coach':      '#C77DD9',
    'fxv:uiux':       '#E8C39C',
    'fxv:marketing':  '#F2D26A',
    'fxv:manager':    '#FFFFFF',
    'fxv:page-today':     '#9CB4D6',
    'fxv:page-programme': '#D4A574',
    'fxv:page-coach':     '#C77DD9',
    'fxv:page-health':    '#6BBF7B',
  };

  let advisors = [];
  let providers = [];
  let selectedPersonaId = 'fxv:manager';
  let messages = [];   // [{ role, content, persona?, provider?, model?, toolCalls?, ts }]
  let sending = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recording = false;
  // Queued image attachments (data URLs) — flushed into the next send().
  // Populated by paste on INPUT or by drag-drop. Rendered as a thumbnail
  // strip above the input.
  let pendingImages = [];

  async function loadAdvisors() {
    try {
      const res = await window.hive.listAdvisors();
      advisors = res?.advisors ?? res ?? [];
    } catch { advisors = []; }
    setPersona(selectedPersonaId);
  }

  async function loadProviders() {
    try {
      const res = await window.hive.listChatModels();
      providers = res?.providers ?? [];
    } catch { providers = []; }
    renderProviderSel();
  }

  // Persona dropdown (replaces the old left rail). Pops up below the pill.
  let pillPickerEl = null;
  function closePillPicker() {
    if (pillPickerEl) { pillPickerEl.remove(); pillPickerEl = null; }
    document.removeEventListener('mousedown', onPillPickerOutside, true);
  }
  function onPillPickerOutside(e) {
    if (!pillPickerEl) return;
    if (!pillPickerEl.contains(e.target) && !PERSONA_PILL.contains(e.target)) closePillPicker();
  }
  function openPillPicker() {
    if (pillPickerEl) { closePillPicker(); return; }
    const lead = advisors.find(a => a.id === 'fxv:manager');
    const specs = advisors.filter(a => !a.isPage && a.id !== 'fxv:manager');
    const pages = advisors.filter(a => a.isPage);
    const sections = [
      { label: 'Lead', items: lead ? [lead] : [] },
      { label: 'Specialists', items: specs },
      { label: 'Pages', items: pages },
    ];
    const renderRow = (a) => {
      const cls = a.id === selectedPersonaId ? ' active' : '';
      const dot = PERSONA_COLOR[a.id] || '#8A8F98';
      const scope = (a.title || a.scope || '').slice(0, 40);
      return `<button class="ls-chat-persona-row${cls}" data-id="${escapeHtml(a.id)}"><span class="ls-chat-persona-dot" style="background:${dot};"></span><span class="ls-chat-persona-name-cell">${escapeHtml(a.name)}</span><span class="ls-chat-persona-scope">${escapeHtml(scope)}</span></button>`;
    };
    const renderSection = (s) => {
      if (!s.items.length) return '';
      return `<div class="ls-chat-rail-sub">${escapeHtml(s.label)}</div>` + s.items.map(renderRow).join('');
    };
    const el = document.createElement('div');
    el.className = 'ls-chat-persona-dropdown';
    el.innerHTML = sections.map(renderSection).join('');
    document.body.appendChild(el);
    const r = PERSONA_PILL.getBoundingClientRect();
    el.style.left = r.left + 'px';
    el.style.top = (r.bottom + 4) + 'px';
    pillPickerEl = el;
    el.querySelectorAll('[data-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        setPersona(btn.dataset.id);
        closePillPicker();
      });
    });
    setTimeout(() => document.addEventListener('mousedown', onPillPickerOutside, true), 0);
  }

  function renderProviderSel() {
    PROVIDER_SEL.innerHTML = providers.map(p =>
      `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`
    ).join('');
    if (!providers.length) {
      PROVIDER_SEL.innerHTML = '<option>(none)</option>';
      return;
    }
    // Default to anthropic if present
    const def = providers.find(p => p.name === 'anthropic') ?? providers[0];
    PROVIDER_SEL.value = def.name;
    renderModelSel();
    PROVIDER_SEL.addEventListener('change', renderModelSel);
  }

  function renderModelSel() {
    const cur = providers.find(p => p.name === PROVIDER_SEL.value);
    if (!cur) { MODEL_SEL.innerHTML = ''; return; }
    MODEL_SEL.innerHTML = cur.models.map(m =>
      `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`
    ).join('');
  }

  function setPersona(id) {
    selectedPersonaId = id;
    const p = advisors.find(a => a.id === id);
    if (!p) return;
    HEADER_NAME.textContent = p.name;
    HEADER_TITLE.textContent = p.title ?? '';
    HEADER_DOT.style.background = PERSONA_COLOR[id] || '#8A8F98';
    INPUT.placeholder = `Ask ${p.name} anything…  type @ to mention a specialist`;
  }

  function newConversation() {
    messages = [];
    renderHistory();
  }

  function renderHistory() {
    if (!messages.length) {
      HISTORY.innerHTML = `
        <div class="ls-chat-empty">
          <div class="ls-chat-empty-title">Talk to ${escapeHtml(currentPersona()?.name ?? 'persona')}</div>
          <div class="ls-chat-empty-sub">Type a question, pick the provider/model under the input. Tools let it read FXV code, fetch web pages, list Hive actions.</div>
        </div>
      `;
      return;
    }
    HISTORY.innerHTML = messages.map((m, i) => renderMessage(m, i)).join('');
    HISTORY.querySelectorAll('[data-speak-i]').forEach(btn => {
      btn.addEventListener('click', () => speakMessage(Number(btn.dataset.speakI)));
    });
    HISTORY.querySelectorAll('[data-toolcalls-i]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.toolcallsI);
        const block = document.getElementById(`ls-chat-toolcalls-${i}`);
        if (block) block.style.display = block.style.display === 'none' ? '' : 'none';
      });
    });
    // Async-load any generate_image PNGs referenced by Saved: paths in tool results
    HISTORY.querySelectorAll('img.ls-chat-genimg[data-path]:not([data-loaded])').forEach(async (img) => {
      const p = img.dataset.path;
      img.dataset.loaded = '1';
      try {
        const res = await window.hive.readGeneratedImage(p);
        if (res?.ok && res.dataUrl) {
          img.src = res.dataUrl;
        } else {
          img.replaceWith(Object.assign(document.createElement('div'), {
            className: 'ls-chat-genimg-err',
            textContent: `Image unavailable: ${res?.error ?? 'unknown error'}`,
          }));
        }
      } catch (err) {
        console.error('[chat] readGeneratedImage failed', err);
      }
    });
    // Click on a generated image opens a fullscreen viewer with copy/share buttons
    HISTORY.querySelectorAll('img.ls-chat-genimg').forEach(img => {
      img.addEventListener('click', () => openGeneratedImageViewer(img.dataset.path, img.src));
    });
    // Mockup-schema buttons open the schema in the mockup tool
    HISTORY.querySelectorAll('button.ls-chat-mockup-open[data-mockup-schema]').forEach(btn => {
      btn.addEventListener('click', () => {
        try {
          const schema = JSON.parse(btn.dataset.mockupSchema);
          if (window.__lsMockup?.openWithSchema) {
            window.__lsMockup.openWithSchema(schema);
          } else {
            flashChatToast('Mockup tool not loaded');
          }
        } catch (err) {
          flashChatToast('Bad mockup schema: ' + (err?.message ?? err));
        }
      });
    });
    HISTORY.scrollTop = HISTORY.scrollHeight;
  }

  // Parse a `MOCKUP_SCHEMA:{...}` line out of a mockup_schema tool's
  // resultPreview. Returns the parsed schema object or null.
  function parseMockupSchema(resultPreview) {
    if (typeof resultPreview !== 'string') return null;
    const m = resultPreview.match(/MOCKUP_SCHEMA:(\{[\s\S]*\})/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  // Extract every `Saved: <abs-path-to-png>` reference from a tool-call
  // resultPreview string. The generate_image tool always emits this on
  // success. Returns an array of absolute paths (typically 0 or 1).
  function extractGeneratedImagePaths(resultPreview) {
    if (typeof resultPreview !== 'string') return [];
    const rx = /Saved:\s*(.+?\.png)\b/g;
    const out = [];
    let m;
    while ((m = rx.exec(resultPreview)) !== null) {
      const p = m[1].trim();
      // Restrict to ~/.hive/generated-images/ paths — the IPC handler will
      // refuse anything else anyway, but skip rendering placeholders for
      // off-folder paths.
      if (/[\\\/]\.hive[\\\/]generated-images[\\\/]/.test(p)) out.push(p);
    }
    return out;
  }

  // Fullscreen viewer for a generated image. Shows Copy / Save / Send to
  // Claude / Open folder / Drop on canvas actions.
  function openGeneratedImageViewer(absPath, dataUrl) {
    if (!dataUrl) return;
    const overlay = document.createElement('div');
    overlay.className = 'ls-chat-genimg-viewer';
    overlay.innerHTML = `
      <div class="ls-chat-genimg-viewer-card">
        <img src="${dataUrl}" alt="Generated image" />
        <div class="ls-chat-genimg-viewer-bar">
          <button data-act="copy">Copy image</button>
          <button data-act="share">Send to Claude</button>
          <button data-act="save">Save…</button>
          <button data-act="folder">Open folder</button>
          <button data-act="canvas">Drop on canvas</button>
          <div class="ls-chat-genimg-viewer-spacer"></div>
          <button data-act="close">Close</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(overlay);
    const dismiss = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    overlay.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', async () => {
        const act = b.dataset.act;
        try {
          if (act === 'close') dismiss();
          else if (act === 'copy') {
            const blob = await (await fetch(dataUrl)).blob();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            flashChatToast('Image copied');
          } else if (act === 'share') {
            const res = await window.hive.shareImage(dataUrl);
            if (!res?.ok) throw new Error(res?.error || 'share failed');
            await navigator.clipboard.writeText(res.path);
            flashChatToast('Path copied — Ctrl+V into Claude Code');
          } else if (act === 'save') {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = absPath?.split(/[\\\/]/).pop() || `hive-image-${Date.now()}.png`;
            document.body.appendChild(a); a.click(); a.remove();
          } else if (act === 'folder') {
            await window.hive.openGeneratedImagesFolder();
          } else if (act === 'canvas') {
            // Drop onto current canvas at centre — re-use canvas spawnImage if available
            if (window.__lsCanvas?.spawnImageDataUrl) {
              window.__lsCanvas.spawnImageDataUrl(dataUrl);
              flashChatToast('Added to canvas');
            } else {
              flashChatToast('Canvas not open');
            }
          }
        } catch (err) {
          console.error('[chat genimg viewer]', err);
          flashChatToast(`Failed: ${err?.message ?? err}`);
        }
      });
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', esc); }
    });
  }

  // Tick once a second: update every pending bubble's elapsed-time chip.
  // Colour escalates: purple < 20s, amber 20–60s, red > 60s — so a
  // stuck/stalled call is visually obvious vs a slow one.
  function tickElapsed() {
    const now = Date.now();
    document.querySelectorAll('.ls-chat-bubble.pending[data-pending-started]').forEach(b => {
      const started = Number(b.dataset.pendingStarted);
      if (!started) return;
      const sec = Math.floor((now - started) / 1000);
      const chip = b.querySelector('[data-elapsed]');
      if (!chip) return;
      const mm = Math.floor(sec / 60);
      const ss = sec % 60;
      chip.textContent = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`;
      chip.classList.toggle('stalled', sec >= 20 && sec < 60);
      chip.classList.toggle('stuck',   sec >= 60);
      if (sec >= 60) chip.title = 'Over 60s — likely stuck. Start a fresh chat (+ New) to abandon.';
      else if (sec >= 20) chip.title = 'Slow — tools (web fetch, FXV read) can add 10–30s.';
      else chip.title = 'In flight…';
    });
  }
  setInterval(tickElapsed, 1000);
  tickElapsed();

  function addPendingImage(dataUrl, mime) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return;
    pendingImages.push({ dataUrl, mime: mime || 'image/png' });
    renderPendingAttachments();
  }
  function removePendingImage(idx) {
    pendingImages.splice(idx, 1);
    renderPendingAttachments();
  }
  function clearPendingImages() {
    pendingImages = [];
    renderPendingAttachments();
  }
  function renderPendingAttachments() {
    const host = document.getElementById('ls-chat-attachments');
    if (!host) return;
    if (!pendingImages.length) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    host.style.display = '';
    host.innerHTML = pendingImages.map((img, i) => `
      <div class="ls-chat-attachment" data-i="${i}" title="Click to remove">
        <img src="${img.dataUrl}" alt="Attached" />
        <button class="ls-chat-attachment-remove" data-remove-i="${i}" aria-label="Remove">×</button>
      </div>
    `).join('');
    host.querySelectorAll('[data-remove-i]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removePendingImage(Number(btn.dataset.removeI));
      });
    });
  }

  function flashChatToast(msg) {
    if (typeof window.flashToast === 'function') return window.flashToast(msg);
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `
      position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
      background: #1d1d25; color: #f2f2f5; padding: 10px 18px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.12); font: 13px Inter, system-ui, sans-serif;
      z-index: 100001; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  function renderMessage(m, i) {
    if (m.role === 'user') {
      const imgs = Array.isArray(m.images) ? m.images : [];
      return `
        <div class="ls-chat-msg ls-chat-msg-user">
          <div class="ls-chat-bubble ls-chat-bubble-user">
            ${imgs.length ? `<div class="ls-chat-user-imgs">${imgs.map(u => `<img class="ls-chat-user-img" src="${u}" alt="Attached" />`).join('')}</div>` : ''}
            ${m.content ? `<div class="ls-chat-user-text">${escapeHtml(m.content)}</div>` : ''}
          </div>
        </div>
      `;
    }
    const dotColor = PERSONA_COLOR[m.persona] || '#8A8F98';
    const tools = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const meta = [m.provider, m.model].filter(Boolean).join(' · ');
    const pendingCls = m.pending ? ' pending' : '';
    // Gather any generated images from generate_image tool calls
    const generatedImages = [];
    for (const t of tools) {
      if (t?.name === 'generate_image') {
        for (const p of extractGeneratedImagePaths(t.resultPreview)) {
          generatedImages.push({ path: p, input: t.input });
        }
      }
    }
    // Gather any mockup schemas emitted by mockup_schema tool calls
    const mockupSchemas = [];
    for (const t of tools) {
      if (t?.name === 'mockup_schema') {
        const schema = parseMockupSchema(t.resultPreview);
        if (schema) mockupSchemas.push({ schema, input: t.input });
      }
    }
    return `
      <div class="ls-chat-msg ls-chat-msg-assistant">
        <div class="ls-chat-msg-h">
          <span class="ls-chat-persona-dot" style="background:${dotColor};"></span>
          <span class="ls-chat-msg-name">${escapeHtml(m.personaName ?? m.persona ?? '')}</span>
          <span class="ls-chat-msg-meta">${escapeHtml(meta)}</span>
          ${tools.length ? `<button class="ls-chat-toolcalls-btn" data-toolcalls-i="${i}" title="Show tool calls">${tools.length} tool${tools.length === 1 ? '' : 's'}</button>` : ''}
          ${m.pending ? '' : `<button class="ls-chat-speak-btn" data-speak-i="${i}" title="Speak this reply">▶</button>`}
        </div>
        <div class="ls-chat-bubble ls-chat-bubble-assistant${pendingCls}"${m.pending && m.pendingStartedAt ? ` data-pending-started="${m.pendingStartedAt}"` : ''}>${escapeHtml(m.content)}${m.pending ? '<span class="ls-chat-elapsed" data-elapsed></span>' : ''}</div>
        ${generatedImages.length ? `
          <div class="ls-chat-genimgs">
            ${generatedImages.map(g => `
              <figure class="ls-chat-genimg-figure">
                <img class="ls-chat-genimg" data-path="${escapeHtml(g.path)}" alt="Generated image" title="Click to open" />
                <figcaption>${escapeHtml((g.input?.model ?? 'gpt-image-1') + ' · ' + (g.input?.size ?? '1024x1024') + (g.input?.quality === 'high' ? ' · HD' : ''))}</figcaption>
              </figure>
            `).join('')}
          </div>
        ` : ''}
        ${mockupSchemas.length ? `
          <div class="ls-chat-mockups">
            ${mockupSchemas.map((m, j) => `
              <div class="ls-chat-mockup-card" data-mockup-idx="${i}-${j}">
                <div class="ls-chat-mockup-meta">
                  <strong>${escapeHtml(m.schema.template ?? 'iphone')}</strong> · ${escapeHtml(m.schema.size ?? 'ig-portrait')}
                  ${m.schema.background ? `· ${escapeHtml(m.schema.background)}` : ''}
                </div>
                ${m.schema.headline ? `<div class="ls-chat-mockup-headline">${escapeHtml(m.schema.headline)}</div>` : ''}
                ${m.schema.statNumber ? `<div class="ls-chat-mockup-headline">${escapeHtml(m.schema.statNumber)} <span style="opacity:0.7">· ${escapeHtml(m.schema.statLabel ?? '')}</span></div>` : ''}
                ${m.schema.methQuote ? `<div class="ls-chat-mockup-headline" style="font-style:italic;">"${escapeHtml(m.schema.methQuote)}"</div>` : ''}
                ${m.schema.notes ? `<div class="ls-chat-mockup-notes">${escapeHtml(m.schema.notes)}</div>` : ''}
                <button class="ls-chat-mockup-open" data-mockup-schema='${escapeHtml(JSON.stringify(m.schema))}'>Open in Mockup tool</button>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${tools.length ? `
          <div class="ls-chat-toolcalls" id="ls-chat-toolcalls-${i}" style="display:none;">
            ${tools.map(t => `
              <div class="ls-chat-toolcall">
                <div class="ls-chat-toolcall-name">${escapeHtml(t.name)}</div>
                <div class="ls-chat-toolcall-input">${escapeHtml(JSON.stringify(t.input).slice(0, 220))}</div>
                ${t.resultPreview ? `<div class="ls-chat-toolcall-result">${escapeHtml(t.resultPreview)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  function currentPersona() {
    return advisors.find(a => a.id === selectedPersonaId) ?? null;
  }

  // Parse @-mentions out of the user's text. Match against persona id
  // suffix (e.g. @aerobic → fxv:aerobic) AND name (no spaces).
  function parseMentions(text) {
    const rx = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
    const ids = new Set();
    let m;
    while ((m = rx.exec(text)) !== null) {
      const tok = m[1].toLowerCase();
      const found = advisors.find(a =>
        a.id.toLowerCase() === tok ||
        a.id.toLowerCase().endsWith(':' + tok) ||
        (a.name || '').toLowerCase().replace(/\s+/g, '') === tok
      );
      if (found) ids.add(found.id);
    }
    return Array.from(ids);
  }

  // Strip "@persona" tokens from text so the persona doesn't see them
  // as part of the question.
  function stripMentions(text) {
    return text.replace(/@[a-zA-Z][a-zA-Z0-9_-]*/g, '').replace(/\s+/g, ' ').trim();
  }

  async function send() {
    if (sending) return;
    const raw = INPUT.value.trim();
    // Allow image-only sends if there's at least one attached image
    if (!raw && pendingImages.length === 0) return;
    const mentions = parseMentions(raw);
    // If any mentions, dispatch to those personas (plus the active one if not already included).
    // Otherwise dispatch to the active persona.
    let targets;
    if (mentions.length > 0) {
      targets = mentions.includes(selectedPersonaId)
        ? mentions
        : [selectedPersonaId, ...mentions];
    } else {
      targets = [selectedPersonaId];
    }
    await dispatchToPersonas(raw, targets);
  }

  async function council() {
    if (sending) return;
    const raw = INPUT.value.trim();
    if (!raw) return;
    // Council = every non-page persona. Programme Lead included.
    const targets = advisors.filter(a => !a.isPage).map(a => a.id);
    if (!targets.length) return;
    await dispatchToPersonas(raw, targets, { kind: 'council' });
  }

  async function dispatchToPersonas(rawText, targetIds, opts = {}) {
    sending = true;
    SEND_BTN.disabled = true;
    SEND_BTN.textContent = '…';
    COUNCIL_BTN.disabled = true;
    const providerName = PROVIDER_SEL.value;
    const model = MODEL_SEL.value;
    const enableTools = !!TOOLS_TOGGLE.checked;
    const questionForLLM = stripMentions(rawText);

    // Snapshot + clear queued image attachments so they're sent once
    const imagesForSend = pendingImages.slice();
    clearPendingImages();

    // Push user turn (verbatim including @ tokens — visible in transcript).
    // Image attachments live on the message so they render in the bubble.
    messages.push({
      role: 'user',
      content: rawText,
      ts: Date.now(),
      kind: opts.kind,
      images: imagesForSend.length ? imagesForSend.map(i => i.dataUrl) : undefined,
    });
    INPUT.value = '';
    autoresize();

    // For each target, push a placeholder assistant message we'll replace
    // when the reply lands. Index lets us update in place out of order.
    const placeholderIds = targetIds.map(id => {
      const a = advisors.find(x => x.id === id);
      const placeholder = {
        role: 'assistant',
        content: '…thinking',
        persona: id,
        personaName: a?.name ?? id,
        provider: providerName,
        model,
        toolCalls: [],
        ts: Date.now(),
        pending: true,
        pendingStartedAt: Date.now(),
      };
      messages.push(placeholder);
      return messages.length - 1;
    });
    renderHistory();

    // Build a shared history snapshot from messages BEFORE the placeholders.
    // When >1 persona is responding, prefix prior assistant replies with the
    // persona who said it so the receiving model can disambiguate.
    const historyEnd = messages.length - placeholderIds.length - 1;
    const historyForCall = messages.slice(0, historyEnd).map(m => {
      if (m.role === 'assistant' && m.personaName) {
        return { role: 'assistant', content: `[${m.personaName}]: ${m.content}` };
      }
      return { role: m.role, content: m.content };
    });

    // Fire all in parallel
    await Promise.all(targetIds.map(async (personaId, idx) => {
      const slot = placeholderIds[idx];
      let res;
      try {
        res = await window.hive.chatWithAdvisor({
          personaId,
          question: questionForLLM || '(see attached image)',
          history: historyForCall,
          providerName,
          model,
          enableTools,
          images: imagesForSend.length ? imagesForSend.map(i => i.dataUrl) : undefined,
        });
      } catch (err) {
        res = { ok: false, error: String(err?.message ?? err) };
      }
      if (!res?.ok) {
        messages[slot] = {
          ...messages[slot],
          content: `(error: ${res?.error ?? 'unknown'})`,
          pending: false,
        };
      } else {
        messages[slot] = {
          ...messages[slot],
          content: res.reply ?? '(empty)',
          persona: res.personaId,
          personaName: res.personaName,
          provider: res.provider,
          model: res.model,
          toolCalls: res.toolCalls ?? [],
          pending: false,
        };
      }
      renderHistory();
    }));

    sending = false;
    SEND_BTN.disabled = false;
    SEND_BTN.textContent = 'Send';
    COUNCIL_BTN.disabled = false;
  }

  function speakMessage(i) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') return;
    try { window.hive.speak(m.content); } catch {}
  }

  function autoresize() {
    INPUT.style.height = 'auto';
    INPUT.style.height = Math.min(160, INPUT.scrollHeight) + 'px';
  }

  // Mic input — records via MediaRecorder, transcribes via OpenAI Whisper
  // through the existing TranscribeAudio IPC. Browser SpeechRecognition is
  // unreliable in Electron (needs Google's cloud key, not shipped).
  function initMic() {
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function') {
      MIC_BTN.style.display = 'none';
      return;
    }
    MIC_BTN.addEventListener('click', toggleRecord);
  }

  async function toggleRecord() {
    if (recording) {
      stopRecord();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        recording = false;
        MIC_BTN.classList.remove('active');
        MIC_BTN.classList.add('busy');
        const baseValue = INPUT.value.trim();
        try {
          const buf = await blob.arrayBuffer();
          const res = await window.hive.transcribeAudio(buf, blob.type);
          if (res?.ok === false) {
            console.error('[chat] transcribe error:', res.error);
            alert(`Transcribe failed: ${res.error}`);
          } else {
            const text = String(res?.text ?? '').trim();
            if (text) {
              INPUT.value = (baseValue ? baseValue + ' ' : '') + text;
              autoresize();
              INPUT.focus();
            }
          }
        } catch (err) {
          console.error('[chat] transcribe failed:', err);
          alert(`Transcribe failed: ${err?.message ?? err}`);
        }
        MIC_BTN.classList.remove('busy');
      };
      mediaRecorder.start();
      recording = true;
      MIC_BTN.classList.add('active');
    } catch (err) {
      console.error('[chat] mic permission denied:', err);
      alert(`Mic unavailable: ${err?.message ?? err}\n\nIn Windows: Settings → Privacy → Microphone → allow desktop apps.`);
    }
  }

  function stopRecord() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Public API
  let opened = false;
  const FAB = document.getElementById('ls-chat-fab');

  function syncFab() {
    if (!FAB) return;
    FAB.classList.toggle('chat-open', isVisible());
    FAB.title = isVisible() ? 'Close chat (Ctrl+Shift+H or Esc)' : 'Chat Hive (Ctrl+Shift+H)';
  }
  function open() {
    SHELL.style.display = '';
    if (!opened) {
      opened = true;
      loadAdvisors();
      loadProviders();
      initMic();
    }
    syncFab();
    setTimeout(() => INPUT.focus(), 0);
  }
  function close() {
    SHELL.style.display = 'none';
    syncFab();
  }
  function toggle() {
    if (isVisible()) close();
    else open();
  }
  function isVisible() { return SHELL.style.display !== 'none'; }

  function openWithPersona(personaId) {
    if (personaId && advisors.length) setPersona(personaId);
    else if (personaId) {
      // Advisors not yet loaded — set pending and let loadAdvisors apply
      selectedPersonaId = personaId;
    }
    open();
  }

  window.__lsChat = { open, close, toggle, isVisible, openWithPersona };

  if (FAB) FAB.addEventListener('click', toggle);

  // Global keyboard shortcut: Ctrl+Shift+H toggles chat from anywhere.
  // Esc closes chat when it's the topmost surface.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key === 'Escape' && isVisible()) {
      // Don't steal Esc from a focused dropdown / modal — only close
      // chat if the active focus is inside chat shell.
      if (document.activeElement && SHELL.contains(document.activeElement)) {
        close();
      } else if (!document.querySelector('[id$="-modal"][style*="display: flex"]')) {
        close();
      }
    }
  });

  syncFab();

  // @-mention autocomplete picker
  let mentionPickerEl = null;
  let mentionFilteredAdvisors = [];
  let mentionIndex = 0;
  let mentionTriggerPos = -1;  // textarea index of the '@'

  function closeMentionPicker() {
    if (mentionPickerEl) { mentionPickerEl.remove(); mentionPickerEl = null; }
    mentionTriggerPos = -1;
  }

  function updateMentionPicker() {
    const text = INPUT.value;
    const caret = INPUT.selectionStart ?? text.length;
    // Find the last '@' before the caret that's preceded by whitespace or start of string
    let trigger = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') { trigger = i; break; }
      if (/\s/.test(ch)) break;
    }
    if (trigger === -1) { closeMentionPicker(); return; }
    const query = text.slice(trigger + 1, caret).toLowerCase();
    if (!/^[a-zA-Z0-9_-]*$/.test(query)) { closeMentionPicker(); return; }
    mentionTriggerPos = trigger;
    const filtered = advisors.filter(a => {
      if (!query) return true;
      const id = a.id.toLowerCase();
      const idTail = id.includes(':') ? id.split(':').pop() : id;
      const nm = (a.name || '').toLowerCase().replace(/\s+/g, '');
      return id.startsWith(query) || idTail.startsWith(query) || nm.startsWith(query);
    }).slice(0, 8);
    if (!filtered.length) { closeMentionPicker(); return; }
    mentionFilteredAdvisors = filtered;
    mentionIndex = 0;
    renderMentionPicker();
  }

  function renderMentionPicker() {
    if (!mentionFilteredAdvisors.length) { closeMentionPicker(); return; }
    if (!mentionPickerEl) {
      mentionPickerEl = document.createElement('div');
      mentionPickerEl.className = 'ls-chat-mention-picker';
      document.body.appendChild(mentionPickerEl);
    }
    mentionPickerEl.innerHTML = mentionFilteredAdvisors.map((a, i) => `
      <div class="ls-chat-mention-row${i === mentionIndex ? ' active' : ''}" data-i="${i}">
        <span class="ls-chat-persona-dot" style="background:${PERSONA_COLOR[a.id] || '#8A8F98'};"></span>
        <span class="ls-chat-mention-name">${escapeHtml(a.name)}</span>
        <span class="ls-chat-mention-id">@${escapeHtml(a.id.includes(':') ? a.id.split(':').pop() : a.id)}</span>
      </div>
    `).join('');
    mentionPickerEl.querySelectorAll('[data-i]').forEach(row => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        mentionIndex = Number(row.dataset.i);
        insertMention();
      });
    });
    // Position above the input
    const rect = INPUT.getBoundingClientRect();
    mentionPickerEl.style.left = rect.left + 'px';
    mentionPickerEl.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  }

  function insertMention() {
    const a = mentionFilteredAdvisors[mentionIndex];
    if (!a || mentionTriggerPos < 0) { closeMentionPicker(); return; }
    const text = INPUT.value;
    const caret = INPUT.selectionStart ?? text.length;
    const tag = a.id.includes(':') ? a.id.split(':').pop() : a.id;
    const replacement = `@${tag} `;
    INPUT.value = text.slice(0, mentionTriggerPos) + replacement + text.slice(caret);
    const newCaret = mentionTriggerPos + replacement.length;
    INPUT.setSelectionRange(newCaret, newCaret);
    closeMentionPicker();
    autoresize();
  }

  // Event wiring
  SEND_BTN.addEventListener('click', send);
  COUNCIL_BTN.addEventListener('click', council);
  PERSONA_PILL.addEventListener('click', openPillPicker);
  INPUT.addEventListener('keydown', (e) => {
    if (mentionPickerEl) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionIndex = (mentionIndex + 1) % mentionFilteredAdvisors.length;
        renderMentionPicker();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionIndex = (mentionIndex - 1 + mentionFilteredAdvisors.length) % mentionFilteredAdvisors.length;
        renderMentionPicker();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeMentionPicker(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  INPUT.addEventListener('input', () => { autoresize(); updateMentionPicker(); });
  INPUT.addEventListener('blur', () => setTimeout(closeMentionPicker, 120));
  NEW_BTN.addEventListener('click', newConversation);

  // Paste images into chat — captures clipboard images from anywhere
  // (Hive canvas right-click → Copy image, Windows Snipping Tool, screenshots, etc.)
  // and queues them for the next send.
  INPUT.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let handled = false;
    for (const item of items) {
      if (item.type?.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => { addPendingImage(reader.result, item.type); };
        reader.readAsDataURL(file);
        handled = true;
      }
    }
    if (handled) e.preventDefault();
  });
  // Drag image files onto the input
  INPUT.addEventListener('dragover', (e) => { e.preventDefault(); });
  INPUT.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    let handled = false;
    for (const f of files) {
      if (!f.type?.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => addPendingImage(reader.result, f.type);
      reader.readAsDataURL(f);
      handled = true;
    }
    if (handled) e.preventDefault();
  });
}());
