<script>
  import { browser } from '$app/environment';
  import { store, STATUSES } from '$lib/store.svelte.js';
  import { buildDraftMarkdown } from '$lib/buildDraft.js';
  import { renderMarkdown } from '$lib/renderMarkdown.js';

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function toDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getWeekDays(offset) {
    const now = new Date();
    const dow = now.getDay();
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(now);
    monday.setDate(now.getDate() + daysToMon + offset * 7);
    monday.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return toDateStr(d);
    });
  }

  function formatWeekLabel(days) {
    const fmt = (str) =>
      new Date(str + 'T00:00:00').toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
    return `${fmt(days[0])} – ${fmt(days[6])}`;
  }

  // Still needed by the sync-preview modal's status badges below.
  function statusLabel(val) {
    return STATUSES.find(s => s.value === val)?.label ?? val;
  }

  // ─── State ────────────────────────────────────────────────────────────────

  let weekOffset = $state(0);

  // Dark mode
  let dark = $state(browser ? localStorage.getItem('theme') === 'dark' : false);
  $effect(() => {
    if (!browser) return;
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  });

  const weekDays  = $derived(getWeekDays(weekOffset));
  const weekLabel = $derived(formatWeekLabel(weekDays));

  // Check once whether Jira sync is configured server-side
  $effect(() => {
    store.checkSyncEnabled();
  });

  function handleGlobalKeydown(e) {
    if (e.key === 'Escape' && store.syncPreview) store.cancelSync();
  }

  // ─── Draft + AI Summary ─────────────────────────────────────────────────

  let draft         = $state('');
  let draftMode     = $state('preview'); // 'preview' | 'edit' — resets on week change
  let summarizing    = $state(false);
  let summary        = $state('');
  let summaryError   = $state('');
  let copied         = $state(false);

  // Load this week's entries + saved draft/summary together, then decide the
  // draft's initial content — auto-generate from entries only when nothing
  // is saved for this week yet, so a persisted draft always wins over
  // regeneration. The staleness guard avoids a stale write if the week is
  // changed again before this resolves.
  $effect(() => {
    const week = weekDays[0];
    const label = weekLabel;
    summary = ''; summaryError = ''; draft = ''; draftMode = 'preview';
    (async () => {
      const [, reportData] = await Promise.all([
        store.loadWeek(week),
        fetch(`/api/reports?week=${week}`).then(r => r.json())
      ]);
      if (week !== weekDays[0]) return;
      summary = reportData.summary ?? '';
      draft = reportData.draft || buildDraftMarkdown(store.entries, label);
    })();
  });

  async function persistReport(week, partial) {
    await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week, ...partial })
    });
  }

  // Draft editing is heavier than summary editing (freeform notes, not just
  // occasional tweaks) — debounce instead of saving on every keystroke.
  let draftSaveTimer;
  function onDraftInput() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => persistReport(weekDays[0], { draft }), 400);
  }

  function regenerateFromJira() {
    draft = buildDraftMarkdown(store.entries, weekLabel);
    persistReport(weekDays[0], { draft });
  }

  async function generateSummary() {
    summarizing = true; summaryError = '';
    const week = weekDays[0];
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `week` lets the server pull last week's plan for follow-through.
        body: JSON.stringify({ draft, weekLabel, week })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'Request failed');
      summary = data.summary;
      await persistReport(week, { summary });
    } catch (e) {
      summaryError = e.message;
    } finally {
      summarizing = false;
    }
  }

  async function copyToClipboard() {
    await navigator.clipboard.writeText(summary);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<main>
  <header>
    <h1>Daily Work Log</h1>
    <button class="theme-btn" onclick={() => dark = !dark} title="{dark ? 'Switch to light mode' : 'Switch to dark mode'}">
      {dark ? '☀' : '☾'}
    </button>
  </header>

  <section class="week-panel">
    <div class="week-nav">
      <button onclick={() => weekOffset--}>&#8592;</button>
      <span class="week-label">{weekLabel}</span>
      <button onclick={() => weekOffset++}>&#8594;</button>
    </div>

    {#if store.syncEnabled}
      <div class="sync-bar">
        <button class="sync-btn" onclick={() => store.previewSync(weekDays[0])} disabled={store.syncing}>
          {#if store.syncing && !store.syncPreview}
            <span class="spinner sync-spinner"></span> Checking Jira…
          {:else}
            ⟳ Sync from Jira
          {/if}
        </button>
        {#if store.syncError}
          <span class="sync-error">⚠ {store.syncError}</span>
        {/if}
      </div>
    {/if}

    {#if store.syncPreview}
      {@const p = store.syncPreview}
      {@const totalChanges = p.stats.new + p.stats.update + p.stats.remove}
      <div class="sync-overlay">
        <div class="sync-card">
          <div class="sync-card-header">
            <h2 class="sync-title">Sync preview — {weekLabel}</h2>
            <button class="icon-btn cancel-btn" onclick={() => store.cancelSync()} aria-label="Close">✕</button>
          </div>

          <div class="sync-stats">
            <span class="sync-stat sync-stat-new">{p.stats.new} new</span>
            <span class="sync-stat sync-stat-update">{p.stats.update} updated</span>
            <span class="sync-stat sync-stat-skip">{p.stats.skip} kept (edited)</span>
            <span class="sync-stat sync-stat-remove">{p.stats.remove} removed</span>
            {#if p.stats.comments}
              <span class="sync-stat sync-stat-comment">{p.stats.comments} from comments</span>
            {/if}
            {#if p.stats.continued}
              <span class="sync-stat sync-stat-continued">{p.stats.continued} continued</span>
            {/if}
          </div>

          {#if p.warnings?.length}
            <ul class="sync-warnings">
              {#each p.warnings as w}<li>{w}</li>{/each}
            </ul>
          {/if}

          <div class="sync-entries">
            {#each p.entries as e}
              <div class="sync-entry-row sync-action-{e.action}">
                <span class="sync-marker">{e.action === 'new' ? '+' : e.action === 'update' ? '~' : '='}</span>
                <span
                  class="sync-signal sync-signal-{e.signal}"
                  title={e.signal === 'comment' ? 'From your Jira comments' : e.signal === 'flagged' ? 'Flagged' : e.signal === 'continued' ? 'No activity this week — still active' : 'From a status change'}
                >{e.signal === 'comment' ? '💬' : e.signal === 'flagged' ? '⚑' : e.signal === 'continued' ? '⋯' : '→'}</span>
                <span class="sync-date">{e.date}</span>
                <a class="jira-chip" href={e.jira_url} target="_blank" rel="noopener noreferrer">{e.jira_key}</a>
                <span class="sync-desc" title={e.details || e.description}>{e.description}</span>
                <span class="badge status-{e.status}">{statusLabel(e.status)}</span>
              </div>
            {/each}
            {#each p.removing as r}
              <div class="sync-entry-row sync-action-remove">
                <span class="sync-marker">−</span>
                <span class="sync-date">{r.date}</span>
                <span class="jira-chip">{r.jira_key}</span>
                <span class="sync-desc sync-desc-removed">{r.description}</span>
              </div>
            {/each}
            {#if p.entries.length === 0 && p.removing.length === 0}
              <p class="sync-empty">No Jira activity found for this week.</p>
            {/if}
          </div>

          <details class="sync-jql">
            <summary>Raw JQL</summary>
            <code>{p.jql}</code>
          </details>

          <div class="sync-card-footer">
            <button class="sync-cancel-btn" onclick={() => store.cancelSync()}>Cancel</button>
            <button
              class="sync-apply-btn"
              onclick={() => store.applySync(weekDays[0])}
              disabled={store.syncing || totalChanges === 0}
            >
              {#if store.syncing}
                <span class="spinner"></span> Applying…
              {:else}
                Apply {totalChanges} change{totalChanges === 1 ? '' : 's'}
              {/if}
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if store.loading}
      <div class="loading-bar">Loading…</div>
    {/if}

    {#if store.error}
      <p class="store-error">⚠ {store.error}</p>
    {/if}

    <!-- ── Weekly Notes (draft) ───────────────────────────────────────── -->
    <div class="draft-section">
      <div class="draft-toolbar">
        <span class="draft-label">Weekly Notes</span>
        <div class="draft-toolbar-actions">
          <div class="mode-toggle">
            <button class:active={draftMode === 'preview'} onclick={() => draftMode = 'preview'}>Preview</button>
            <button class:active={draftMode === 'edit'} onclick={() => draftMode = 'edit'}>Edit</button>
          </div>
          <button
            class="regen-btn"
            onclick={regenerateFromJira}
            disabled={store.entries.length === 0}
            title="Rebuild from current Jira data — overwrites this text"
          >
            ↺ Regenerate from Jira
          </button>
        </div>
      </div>
      {#if draftMode === 'edit'}
        <textarea
          class="draft-text"
          bind:value={draft}
          oninput={onDraftInput}
          spellcheck="false"
        ></textarea>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="draft-preview" onclick={() => draftMode = 'edit'} title="Click to edit">
          {@html renderMarkdown(draft)}
        </div>
      {/if}
    </div>

    <!-- ── AI Summary ─────────────────────────────────────────────── -->
    <div class="ai-section">
      <button
        class="summarize-btn"
        onclick={generateSummary}
        disabled={summarizing || !draft.trim()}
      >
        {#if summarizing}
          <span class="spinner"></span> Generating…
        {:else if summary}
          ↺ Regenerate Summary
        {:else}
          ✨ Generate Summary
        {/if}
      </button>

      {#if summaryError}
        <p class="summary-error">⚠ {summaryError}</p>
      {/if}

      {#if summary}
        <div class="summary-output">
          <div class="summary-toolbar">
            <span class="summary-label">AI Summary</span>
            <div class="summary-actions">
              <button class="copy-btn" onclick={copyToClipboard}>
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
              <button class="copy-btn export-btn" onclick={() => window.open(`/print?week=${weekDays[0]}`, '_blank')}>
                ↗ Open as Slide
              </button>
            </div>
          </div>
          <textarea
            class="summary-text"
            bind:value={summary}
            oninput={() => persistReport(weekDays[0], { summary })}
            spellcheck="false"
          ></textarea>
        </div>
      {/if}
    </div>
  </section>
</main>

<style>
  /* ── CSS variables — light (default) ──────────────────────────────── */
  :global(:root) {
    --bg:               #f1f5f9;
    --surface:          #ffffff;
    --surface-alt:      #f8fafc;
    --border:           #e2e8f0;
    --border-subtle:    #f1f5f9;
    --text:             #1e293b;
    --text-muted:       #64748b;
    --text-faint:       #94a3b8;
    --text-hint:        #cbd5e1;
    --today-bg:         #eff6ff;
    --today-border:     #bfdbfe;
    --today-count-bg:   #bfdbfe;
    --today-count-text: #1d4ed8;
    --count-bg:         #e2e8f0;
    --count-text:       #475569;
    --cat-bg:           #f1f5f9;
    --cat-text:         #475569;
    --nav-hover:        #f8fafc;
    --input-bg:         #ffffff;
    --mapping-text:     #475569;
    --summary-text:     #1e293b;
  }

  /* ── CSS variables — dark ──────────────────────────────────────────── */
  :global(body.dark) {
    --bg:               #0f172a;
    --surface:          #1e293b;
    --surface-alt:      #162032;
    --border:           #334155;
    --border-subtle:    #243044;
    --text:             #f1f5f9;
    --text-muted:       #94a3b8;
    --text-faint:       #64748b;
    --text-hint:        #475569;
    --today-bg:         #172554;
    --today-border:     #3b82f6;
    --today-count-bg:   #1e3a5f;
    --today-count-text: #93c5fd;
    --count-bg:         #334155;
    --count-text:       #94a3b8;
    --cat-bg:           #334155;
    --cat-text:         #94a3b8;
    --nav-hover:        #243044;
    --input-bg:         #162032;
    --mapping-text:     #94a3b8;
    --summary-text:     #f1f5f9;
  }

  /* ── Reset & globals ───────────────────────────────────────────────── */
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    transition: background 0.2s, color 0.2s;
  }

  /* ── Layout ────────────────────────────────────────────────────────── */
  main { min-height: 100vh; }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0.875rem 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1 { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.01em; }

  .theme-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    width: 2rem;
    height: 2rem;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, border-color 0.15s;
  }
  .theme-btn:hover { background: var(--nav-hover); border-color: var(--text-faint); }

  /* Bare h2 also styles .sync-title in the sync preview modal below. */
  h2 {
    font-size: 0.8125rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.125rem;
  }

  /* ── Week panel ────────────────────────────────────────────────────── */
  .week-panel {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 1280px;
    margin: 0 auto;
    padding: 1.5rem 2rem;
  }

  .week-nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    padding: 0.625rem 1rem;
  }

  .week-nav button {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 0.9rem;
    color: var(--text-muted);
    transition: background 0.15s, border-color 0.15s;
  }
  .week-nav button:hover { background: var(--nav-hover); border-color: var(--text-faint); }

  .week-label { flex: 1; text-align: center; font-weight: 600; font-size: 0.9375rem; }

  /* ── Sync from Jira ───────────────────────────────────────────────── */
  .sync-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* Primary action now that Jira is the main source of entries. */
  .sync-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.625rem 1.1rem;
    background: #2563eb;
    color: #ffffff;
    border: 1px solid #2563eb;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(37, 99, 235, 0.25);
    transition: background 0.15s, border-color 0.15s;
  }
  .sync-btn:hover:not(:disabled) { background: #1d4ed8; border-color: #1d4ed8; }
  .sync-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .sync-spinner { border-color: rgba(255, 255, 255, 0.35); border-top-color: #ffffff; }

  .sync-error {
    font-size: 0.8125rem;
    color: #dc2626;
  }

  .sync-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    z-index: 50;
  }

  .sync-card {
    background: var(--surface);
    border-radius: 0.75rem;
    width: 100%;
    max-width: 42rem;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
  }

  .sync-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .sync-title { font-size: 0.9375rem; font-weight: 700; }

  .sync-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.875rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .sync-stat {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    background: var(--cat-bg);
    color: var(--cat-text);
  }
  .sync-stat-new       { background: #dcfce7; color: #15803d; }
  .sync-stat-update    { background: #fef3c7; color: #b45309; }
  .sync-stat-skip      { background: var(--cat-bg); color: var(--cat-text); }
  .sync-stat-remove    { background: #fee2e2; color: #dc2626; }
  .sync-stat-comment   { background: #f3e8ff; color: #7c3aed; }
  .sync-stat-continued { background: var(--cat-bg); color: var(--text-faint); }

  .sync-warnings {
    list-style: none;
    padding: 0.625rem 1.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--text-muted);
    background: var(--surface-alt);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .sync-entries {
    overflow-y: auto;
    padding: 0.5rem 1.25rem;
    flex: 1;
  }

  .sync-entry-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.8125rem;
  }
  .sync-entry-row:last-child { border-bottom: none; }

  .sync-marker { font-weight: 700; width: 1rem; text-align: center; flex-shrink: 0; }
  .sync-action-new    .sync-marker { color: #15803d; }
  .sync-action-update .sync-marker { color: #b45309; }
  .sync-action-skip   .sync-marker { color: var(--text-faint); }
  .sync-action-remove .sync-marker { color: #dc2626; }

  .sync-signal { flex-shrink: 0; font-size: 0.8125rem; width: 1.1rem; text-align: center; }
  .sync-signal-continued { color: var(--text-faint); }

  .sync-date { color: var(--text-faint); font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .sync-desc { flex: 1; }
  .sync-desc-removed { text-decoration: line-through; color: var(--text-faint); }
  .sync-empty { padding: 1rem 0; color: var(--text-faint); font-size: 0.8125rem; text-align: center; }

  .sync-jql {
    padding: 0.625rem 1.25rem;
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
  }
  .sync-jql summary { cursor: pointer; color: var(--text-muted); font-weight: 600; }
  .sync-jql code {
    display: block;
    margin-top: 0.4rem;
    padding: 0.5rem;
    background: var(--surface-alt);
    border-radius: 0.35rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .sync-card-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.875rem 1.25rem;
    border-top: 1px solid var(--border);
  }

  .sync-cancel-btn {
    padding: 0.5rem 0.875rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
  }
  .sync-cancel-btn:hover { background: var(--nav-hover); }

  .sync-apply-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.875rem;
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 0.4rem;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
  }
  .sync-apply-btn:hover:not(:disabled) { background: #1d4ed8; }
  .sync-apply-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .jira-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.7rem;
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--cat-bg);
    color: #2563eb;
    text-decoration: none;
    flex-shrink: 0;
  }
  a.jira-chip:hover { background: #dbeafe; }

  .icon-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    width: 1.75rem;
    height: 1.75rem;
    cursor: pointer;
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .cancel-btn  { color: var(--text-faint); }
  .cancel-btn:hover  { color: #dc2626; background: #fee2e2; border-color: #fca5a5; }

  /* ── Loading / error ───────────────────────────────────────────────── */
  .loading-bar {
    text-align: center;
    font-size: 0.8125rem;
    color: var(--text-faint);
    padding: 0.5rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 0.4rem;
  }

  .store-error {
    font-size: 0.8125rem;
    color: #dc2626;
    background: #fee2e2;
    border: 1px solid #fca5a5;
    border-radius: 0.4rem;
    padding: 0.5rem 0.75rem;
  }

  /* ── Badges ────────────────────────────────────────────────────────── */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.175rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
  }

  /*
    Status badge classes applied dynamically — :global() prevents tree-shaking.
  */
  :global(.status-done)        { background: #dcfce7; color: #15803d; }
  :global(.status-in-progress) { background: #f3e8ff; color: #7c3aed; }
  :global(.status-next-week)   { background: #dbeafe; color: #1d4ed8; }
  :global(.status-blocker)     { background: #fee2e2; color: #dc2626; }
  :global(.status-achievement) { background: #fef3c7; color: #b45309; }

  /* ── Draft ─────────────────────────────────────────────────────────── */
  .draft-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    overflow: hidden;
  }

  .draft-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    background: var(--surface-alt);
    border-bottom: 1px solid var(--border);
  }

  .draft-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }

  .draft-toolbar-actions { display: flex; align-items: center; gap: 0.625rem; }

  .mode-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    overflow: hidden;
  }
  .mode-toggle button {
    background: var(--surface);
    border: none;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .mode-toggle button + button { border-left: 1px solid var(--border); }
  .mode-toggle button:hover { background: var(--nav-hover); }
  .mode-toggle button.active { background: #2563eb; color: #fff; }

  .regen-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .regen-btn:hover:not(:disabled) { background: var(--nav-hover); color: var(--text); }
  .regen-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .draft-text {
    display: block;
    width: 100%;
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--text);
    background: var(--surface);
    border: none;
    outline: none;
    padding: 1rem 1.25rem;
    min-height: 50vh;
    resize: vertical;
  }

  .draft-preview {
    padding: 1rem 1.25rem;
    min-height: 50vh;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--text);
    cursor: text;
  }

  .draft-preview :global(h2),
  .draft-preview :global(h3),
  .draft-preview :global(h4) {
    font-weight: 700;
    color: var(--text);
    margin: 1.25rem 0 0.5rem;
  }
  .draft-preview :global(h2:first-child),
  .draft-preview :global(h3:first-child),
  .draft-preview :global(h4:first-child) { margin-top: 0; }

  .draft-preview :global(h2) { font-size: 1.0625rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--border); }
  .draft-preview :global(h3) { font-size: 0.9375rem; }
  .draft-preview :global(h4) { font-size: 0.8125rem; color: var(--text-muted); margin-left: 1rem; }

  .draft-preview :global(ul) {
    list-style: none;
    margin: 0 0 0.75rem;
  }
  .draft-preview :global(h4) + :global(ul) { margin-left: 1rem; }

  .draft-preview :global(li) {
    position: relative;
    padding: 0.2rem 0 0.2rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .draft-preview :global(li:last-child) { border-bottom: none; }
  .draft-preview :global(li)::before {
    content: '•';
    position: absolute;
    left: 0.15rem;
    color: var(--text-hint);
  }

  .draft-preview :global(p) {
    margin: 0 0 0.5rem;
    color: var(--text-muted);
  }

  .draft-preview :global(strong) { color: var(--text); }
  .draft-preview :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8em;
    background: var(--surface-alt);
    border-radius: 0.2rem;
    padding: 0.05rem 0.3rem;
  }

  /* ── AI Summary ───────────────────────────────────────────────────── */
  .ai-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .summarize-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.625rem 1rem;
    background: var(--surface);
    color: #7c3aed;
    border: 1px dashed #c4b5fd;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .summarize-btn:hover:not(:disabled) { background: #faf5ff; border-color: #a78bfa; }
  .summarize-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  /* spinner */
  .spinner {
    width: 0.875rem;
    height: 0.875rem;
    border: 2px solid #c4b5fd;
    border-top-color: #7c3aed;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .summary-error {
    font-size: 0.8125rem;
    color: #dc2626;
    background: #fee2e2;
    border: 1px solid #fca5a5;
    border-radius: 0.4rem;
    padding: 0.5rem 0.75rem;
  }

  .summary-output {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    overflow: hidden;
  }

  .summary-actions { display: flex; gap: 0.375rem; }

  .export-btn { font-weight: 600; }

  .summary-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    background: var(--surface-alt);
    border-bottom: 1px solid var(--border);
  }

  .summary-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }

  .copy-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .copy-btn:hover { background: var(--nav-hover); color: var(--text); }

  .summary-text {
    display: block;
    width: 100%;
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--text);
    background: var(--surface);
    border: none;
    outline: none;
    padding: 1rem 1.25rem;
    min-height: 16rem;
    max-height: 32rem;
    resize: vertical;
    overflow-y: auto;
  }

  /* ── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    header { padding: 0.875rem 1rem; }

    .week-panel {
      padding: 0.75rem 1rem;
      gap: 0.75rem;
    }

    .sync-card { max-height: 90vh; }
  }
</style>
