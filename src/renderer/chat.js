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

  const RAIL_PERSONAS = document.getElementById('ls-chat-persona-list');
  const NEW_BTN = document.getElementById('ls-chat-new');
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

  async function loadAdvisors() {
    try {
      const res = await window.hive.listAdvisors();
      advisors = res?.advisors ?? res ?? [];
    } catch { advisors = []; }
    renderRail();
    setPersona(selectedPersonaId);
  }

  async function loadProviders() {
    try {
      const res = await window.hive.listChatModels();
      providers = res?.providers ?? [];
    } catch { providers = []; }
    renderProviderSel();
  }

  function renderRail() {
    const lead = advisors.find(a => a.id === 'fxv:manager');
    const specs = advisors.filter(a => !a.isPage && a.id !== 'fxv:manager');
    const pages = advisors.filter(a => a.isPage);
    const sections = [
      { label: 'Lead', items: lead ? [lead] : [] },
      { label: 'Specialists', items: specs },
      { label: 'Pages', items: pages },
    ];
    RAIL_PERSONAS.innerHTML = sections.map(s => `
      <div class="ls-chat-rail-sub">${escapeHtml(s.label)}</div>
      ${s.items.map(a => `
        <button class="ls-chat-persona-row" data-id="${escapeHtml(a.id)}">
          <span class="ls-chat-persona-dot" style="background:${PERSONA_COLOR[a.id] || '#8A8F98'};"></span>
          <span class="ls-chat-persona-name-cell">${escapeHtml(a.name)}</span>
        </button>
      `).join('')}
    `).join('');
    RAIL_PERSONAS.querySelectorAll('[data-id]').forEach(btn => {
      btn.addEventListener('click', () => setPersona(btn.dataset.id));
    });
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
    INPUT.placeholder = `Ask ${p.name} anything…`;
    RAIL_PERSONAS.querySelectorAll('[data-id]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.id === id);
    });
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
    HISTORY.scrollTop = HISTORY.scrollHeight;
  }

  function renderMessage(m, i) {
    if (m.role === 'user') {
      return `
        <div class="ls-chat-msg ls-chat-msg-user">
          <div class="ls-chat-bubble ls-chat-bubble-user">${escapeHtml(m.content)}</div>
        </div>
      `;
    }
    const dotColor = PERSONA_COLOR[m.persona] || '#8A8F98';
    const tools = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const meta = [m.provider, m.model].filter(Boolean).join(' · ');
    const pendingCls = m.pending ? ' pending' : '';
    return `
      <div class="ls-chat-msg ls-chat-msg-assistant">
        <div class="ls-chat-msg-h">
          <span class="ls-chat-persona-dot" style="background:${dotColor};"></span>
          <span class="ls-chat-msg-name">${escapeHtml(m.personaName ?? m.persona ?? '')}</span>
          <span class="ls-chat-msg-meta">${escapeHtml(meta)}</span>
          ${tools.length ? `<button class="ls-chat-toolcalls-btn" data-toolcalls-i="${i}" title="Show tool calls">${tools.length} tool${tools.length === 1 ? '' : 's'}</button>` : ''}
          ${m.pending ? '' : `<button class="ls-chat-speak-btn" data-speak-i="${i}" title="Speak this reply">▶</button>`}
        </div>
        <div class="ls-chat-bubble ls-chat-bubble-assistant${pendingCls}">${escapeHtml(m.content)}</div>
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
    if (!raw) return;
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

    // Push user turn (verbatim including @ tokens — visible in transcript)
    messages.push({ role: 'user', content: rawText, ts: Date.now(), kind: opts.kind });
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
          question: questionForLLM,
          history: historyForCall,
          providerName,
          model,
          enableTools,
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

  window.__lsChat = { open, close, toggle, isVisible };

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
}());
