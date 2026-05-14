// ════════════════════════════════════════════════════════════════════
// DEPLOYS VIEW (v3.0-δ)
//
// Native Linear-shell panel listing deploy history. Each row expands
// to show the commit range that landed in that deploy via the
// DeployCommitRange IPC (git log prev_sha..cur_sha against the FXV
// repo). The "+ New deploy" button opens the legacy deploy-modal for
// actual deploy actions — we're not rebuilding the deploy form, just
// the read-only history surface.
// ════════════════════════════════════════════════════════════════════

(function deploysModule() {
  const SHELL = document.getElementById('ls-deploys-shell');
  if (!SHELL) return;

  const LIST = document.getElementById('ls-deploys-list');
  const REFRESH_BTN = document.getElementById('ls-deploys-refresh');
  const NEW_BTN = document.getElementById('ls-deploys-new');

  let loaded = false;
  let loading = false;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtRelative(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return fmtTs(ts);
  }

  function statusColor(status) {
    return ({
      shipped: '#6BBF7B',
      'in-progress': '#D4A574',
      pending: '#D4A574',
      planning: '#8A8F98',
      failed: '#E07B5F',
      'rolled-back': '#E07B5F',
      cancelled: '#8A8F98',
    })[status] || '#8A8F98';
  }

  async function load() {
    if (loading) return;
    loading = true;
    LIST.innerHTML = '<div class="ls-deploys-empty">Loading…</div>';
    let res;
    try {
      res = await window.hive.listDeploys(60);
    } catch (err) {
      LIST.innerHTML = `<div class="ls-deploys-empty error">${escapeHtml(err?.message ?? String(err))}</div>`;
      loading = false;
      return;
    }
    loading = false;
    if (!res?.ok) {
      LIST.innerHTML = `<div class="ls-deploys-empty error">${escapeHtml(res?.error ?? 'failed')}</div>`;
      return;
    }
    const deploys = res.deploys ?? [];
    if (!deploys.length) {
      LIST.innerHTML = `
        <div class="ls-deploys-empty">
          <div class="ls-deploys-empty-title">No deploys yet</div>
          <div class="ls-deploys-empty-sub">Every EAS update or TestFlight build will land here with what changed.</div>
        </div>
      `;
      loaded = true;
      return;
    }
    LIST.innerHTML = deploys.map(renderRow).join('');
    LIST.querySelectorAll('[data-toggle-commits]').forEach(btn => {
      btn.addEventListener('click', () => toggleCommits(Number(btn.dataset.toggleCommits), btn));
    });
    loaded = true;
  }

  function renderRow(d) {
    const dur = d.durationMs != null ? `${(d.durationMs / 1000).toFixed(1)}s` : null;
    const groupShort = d.groupId ? d.groupId.slice(0, 8) : null;
    const shaShort = d.sha ? d.sha.slice(0, 7) : null;
    const canShowCommits = d.status === 'shipped' && !!d.sha;
    const dot = statusColor(d.status);
    const meta = [
      d.kind?.toUpperCase(),
      d.channel?.toUpperCase(),
      shaShort && `sha ${shaShort}`,
      groupShort && `group ${groupShort}`,
      dur,
    ].filter(Boolean).join(' · ');
    return `
      <div class="ls-deploy-row" data-id="${d.id}">
        <div class="ls-deploy-row-h">
          <span class="ls-deploy-row-dot" style="background:${dot};"></span>
          <span class="ls-deploy-row-status">${escapeHtml(d.status)}</span>
          <span class="ls-deploy-row-msg" title="${escapeHtml(d.message ?? '')}">${escapeHtml(d.message ?? '(no message)')}</span>
          <span class="ls-deploy-row-time" title="${escapeHtml(fmtTs(d.ts))}">${escapeHtml(fmtRelative(d.ts))}</span>
        </div>
        <div class="ls-deploy-row-meta">${escapeHtml(meta)}</div>
        ${canShowCommits ? `
          <button class="ls-deploy-row-commits-btn" data-toggle-commits="${d.id}">Show commits</button>
          <div class="ls-deploy-row-commits" data-commits-for="${d.id}" style="display:none;"></div>
        ` : ''}
        ${d.error ? `<div class="ls-deploy-row-error">${escapeHtml(String(d.error).slice(0, 400))}</div>` : ''}
      </div>
    `;
  }

  async function toggleCommits(deployId, btn) {
    const block = LIST.querySelector(`[data-commits-for="${deployId}"]`);
    if (!block) return;
    if (block.dataset.loaded === '1') {
      const visible = block.style.display !== 'none';
      block.style.display = visible ? 'none' : '';
      btn.textContent = visible ? 'Show commits' : 'Hide commits';
      return;
    }
    block.style.display = '';
    btn.textContent = 'Loading…';
    let cr;
    try {
      cr = await window.hive.deployCommitRange(deployId);
    } catch (err) {
      block.innerHTML = `<div class="ls-deploy-commit-err">${escapeHtml(err?.message ?? String(err))}</div>`;
      btn.textContent = 'Show commits';
      return;
    }
    if (!cr?.ok) {
      block.innerHTML = `<div class="ls-deploy-commit-err">${escapeHtml(cr?.error ?? 'failed')}</div>`;
      btn.textContent = 'Show commits';
      return;
    }
    const commits = cr.commits ?? [];
    if (!commits.length) {
      block.innerHTML = '<div class="ls-deploy-commit-empty">No new commits since the previous deploy on this channel.</div>';
    } else {
      block.innerHTML = commits.map(c => `
        <div class="ls-deploy-commit">
          <span class="ls-deploy-commit-sha">${escapeHtml(c.sha.slice(0, 7))}</span>
          <span class="ls-deploy-commit-subject">${escapeHtml(c.subject)}</span>
          <span class="ls-deploy-commit-meta">${escapeHtml(fmtRelative(c.ts))} · ${escapeHtml(c.author)}</span>
        </div>
      `).join('');
    }
    block.dataset.loaded = '1';
    btn.textContent = 'Hide commits';
  }

  REFRESH_BTN.addEventListener('click', () => { loaded = false; load(); });
  NEW_BTN.addEventListener('click', () => {
    // Re-use the existing legacy deploy modal for the actual deploy form.
    document.getElementById('open-deploy')?.click();
  });

  function open() {
    SHELL.style.display = '';
    if (!loaded) load();
  }
  function close() { SHELL.style.display = 'none'; }
  function isVisible() { return SHELL.style.display !== 'none'; }

  window.__lsDeploys = { open, close, isVisible, reload: () => { loaded = false; load(); } };
}());
