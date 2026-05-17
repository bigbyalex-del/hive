// ════════════════════════════════════════════════════════════════════
// IPHONE MOCKUP TOOL
//
// Full-screen iframe overlay that loads mockup-tool.html (the standalone
// HTML mockup tool). Two entry points:
//   1. Sidebar nav: data-view="mockups"
//   2. Canvas image right-click: "Open in iPhone mockup" → opens with
//      the right-clicked image pre-loaded via postMessage.
//
// The iframe stays loaded once first opened so state (background, tilt,
// caption text) survives across opens within a session.
// ════════════════════════════════════════════════════════════════════

(function mockupModule() {
  const SHELL = document.getElementById('ls-mockup-shell');
  const FRAME = document.getElementById('ls-mockup-frame');
  const CLOSE = document.getElementById('ls-mockup-close');
  if (!SHELL || !FRAME) return;

  let loaded = false;
  let pendingImage = null;  // queued image dataUrl for when iframe finishes loading

  // Iframe announces 'mockup-ready' when its script runs. Flush any
  // queued image / schema into it at that point.
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'mockup-ready') {
      loaded = true;
      if (pendingImage) {
        FRAME.contentWindow?.postMessage({ type: 'load-image', dataUrl: pendingImage }, '*');
        pendingImage = null;
      }
      if (pendingSchema) {
        pushSchema(pendingSchema);
        pendingSchema = null;
      }
    }
  });

  function isVisible() {
    return SHELL.style.display !== 'none' && SHELL.style.display !== '';
  }

  function open(dataUrl) {
    // First open lazy-loads the iframe to keep startup fast
    if (!FRAME.src) {
      FRAME.src = 'mockup-tool.html';
    }
    SHELL.style.display = 'flex';
    document.body.classList.add('mockup-active');
    // Also close conflicting overlays
    window.__lsChat?.close?.();
    if (dataUrl) {
      if (loaded) {
        FRAME.contentWindow?.postMessage({ type: 'load-image', dataUrl }, '*');
      } else {
        pendingImage = dataUrl;
      }
    }
  }

  // Open the mockup tool with a full schema (template + size + props).
  // Used by the chat → mockup_schema button.
  let pendingSchema = null;
  function openWithSchema(schema) {
    if (!schema || typeof schema !== 'object') return;
    open();   // ensures iframe + visibility
    if (loaded) {
      pushSchema(schema);
    } else {
      pendingSchema = schema;
    }
  }
  function pushSchema(schema) {
    const w = FRAME.contentWindow;
    if (!w) return;
    if (schema.template) w.postMessage({ type: 'set-template', template: schema.template }, '*');
    if (schema.size) w.postMessage({ type: 'set-size', size: schema.size }, '*');
    if (schema.background) w.postMessage({ type: 'set-bg', background: schema.background }, '*');
    if (schema.halo) w.postMessage({ type: 'set-halo', halo: schema.halo }, '*');
    if (typeof schema.showCaption === 'boolean') w.postMessage({ type: 'set-caption-visible', visible: schema.showCaption }, '*');
    if (typeof schema.showLogo === 'boolean') w.postMessage({ type: 'set-logo-visible', visible: schema.showLogo }, '*');
    if (schema.headline !== undefined) w.postMessage({ type: 'set-field', field: 'headline', value: schema.headline }, '*');
    if (schema.subline !== undefined)  w.postMessage({ type: 'set-field', field: 'subline',  value: schema.subline },  '*');
    if (schema.statEyebrow !== undefined) w.postMessage({ type: 'set-field', field: 'statEyebrow', value: schema.statEyebrow }, '*');
    if (schema.statNumber !== undefined)  w.postMessage({ type: 'set-field', field: 'statNumber',  value: schema.statNumber },  '*');
    if (schema.statLabel !== undefined)   w.postMessage({ type: 'set-field', field: 'statLabel',   value: schema.statLabel },   '*');
    if (schema.methQuote !== undefined)    w.postMessage({ type: 'set-field', field: 'methQuote',    value: schema.methQuote },    '*');
    if (schema.methCitation !== undefined) w.postMessage({ type: 'set-field', field: 'methCitation', value: schema.methCitation }, '*');
    if (schema.cmpLabelLeft  !== undefined) w.postMessage({ type: 'set-field', field: 'cmpLabelL', value: schema.cmpLabelLeft  }, '*');
    if (schema.cmpLabelRight !== undefined) w.postMessage({ type: 'set-field', field: 'cmpLabelR', value: schema.cmpLabelRight }, '*');
  }

  function close() {
    SHELL.style.display = 'none';
    document.body.classList.remove('mockup-active');
  }

  function toggle(dataUrl) {
    if (isVisible()) close();
    else open(dataUrl);
  }

  window.__lsMockup = { open, close, isVisible, toggle, openWithSchema };

  CLOSE?.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isVisible() && document.activeElement?.tagName !== 'IFRAME') {
      close();
    }
  });

  // Sidebar Mockups nav item — open with no preloaded image (use default)
  document.querySelectorAll('.linear-shell .ls-nav-item[data-view="mockups"]').forEach(el => {
    el.addEventListener('click', () => open(), true);
  });
})();
