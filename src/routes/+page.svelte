<script>
  import { browser } from '$app/environment';
  import { store, CATEGORIES, STATUSES, distinctValues } from '$lib/store.svelte.js';

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function toDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function todayStr() {
    return toDateStr(new Date());
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

  function formatDayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    return dateStr === todayStr() ? `${label} — Today` : label;
  }

  function statusLabel(val) {
    return STATUSES.find(s => s.value === val)?.label ?? val;
  }

  // ─── State ────────────────────────────────────────────────────────────────

  let weekOffset   = $state(0);
  let formDate     = $state(todayStr());
  let formDesc     = $state('');
  let formCategory = $state(CATEGORIES[0]);
  let formStatus   = $state(STATUSES[0].value);
  let activeTab    = $state('week'); // 'form' | 'week'

  // Dark mode
  let dark = $state(browser ? localStorage.getItem('theme') === 'dark' : false);
  $effect(() => {
    if (!browser) return;
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  });

  // Edit state
  let editingId  = $state(null);
  let editDesc   = $state('');
  let editCat    = $state('');
  let editStatus = $state('');

  const weekDays  = $derived(getWeekDays(weekOffset));
  const weekLabel = $derived(formatWeekLabel(weekDays));

  // Load entries whenever the week changes
  $effect(() => {
    store.loadWeek(weekDays[0]);
  });

  // Check once whether Jira sync is configured server-side
  $effect(() => {
    store.checkSyncEnabled();
  });

  // ─── Epic / project / domain filters ───────────────────────────────────────

  let filter = $state({ epic: null, project: null, domain: null });

  const facets = $derived({
    epic:    distinctValues(store.entries, 'epic'),
    project: distinctValues(store.entries, 'project'),
    domain:  distinctValues(store.entries, 'domain')
  });

  const filteredEntries = $derived(
    store.entries.filter(e =>
      (!filter.epic    || e.epic    === filter.epic) &&
      (!filter.project || e.project === filter.project) &&
      (!filter.domain  || e.domain  === filter.domain)
    )
  );

  function toggleFilter(dim, value) {
    filter[dim] = filter[dim] === value ? null : value;
  }

  function entriesForDay(day) {
    return filteredEntries.filter(e => e.date === day);
  }

  function handleGlobalKeydown(e) {
    if (e.key === 'Escape' && store.syncPreview) store.cancelSync();
  }

  const statusCounts = $derived(
    STATUSES.map(s => ({
      ...s,
      count: weekDays.flatMap(d => entriesForDay(d)).filter(e => e.status === s.value).length
    }))
  );

  // ─── Add entry ────────────────────────────────────────────────────────────

  async function addEntry() {
    const lines = formDesc.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const adds = lines.map((line, i) => ({
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      date: formDate,
      description: line,
      category: formCategory,
      status: formStatus
    }));
    formDesc = '';
    for (const entry of adds) {
      await store.add(entry);
    }
    // Switch to week view on mobile after adding
    if (browser && window.matchMedia('(max-width: 800px)').matches) {
      activeTab = 'week';
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addEntry(); }
  }

  // ─── Edit entry ───────────────────────────────────────────────────────────

  function startEdit(entry) {
    editingId  = entry.id;
    editDesc   = entry.description;
    editCat    = entry.category;
    editStatus = entry.status;
  }

  function saveEdit() {
    if (!editDesc.trim() || !editingId) return;
    store.update(editingId, { description: editDesc.trim(), category: editCat, status: editStatus });
    editingId = null;
  }

  function cancelEdit() { editingId = null; }

  function handleEditKeydown(e) {
    if (e.key === 'Enter')  { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { cancelEdit(); }
  }

  // ─── AI Summary ───────────────────────────────────────────────────────────

  let summarizing  = $state(false);
  let summary      = $state('');
  let summaryError = $state('');
  let copied       = $state(false);

  const weekEntries = $derived(weekDays.flatMap(d => entriesForDay(d)));

  // Load saved report whenever the week changes
  $effect(() => {
    const week = weekDays[0];
    summary = '';
    summaryError = '';
    fetch(`/api/reports?week=${week}`)
      .then(r => r.json())
      .then(d => { if (d.summary) summary = d.summary; })
      .catch(() => {});
  });

  async function persistReport(week, text) {
    await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week, summary: text })
    });
  }

  async function generateSummary() {
    summarizing = true; summaryError = ''; summary = '';
    const week = weekDays[0];
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: weekEntries, weekLabel })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'Request failed');
      summary = data.summary;
      await persistReport(week, summary);
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

  <!-- Mobile tab bar -->
  <div class="mobile-tabs">
    <button class:active={activeTab === 'form'} onclick={() => activeTab = 'form'}>
      Add Entry
    </button>
    <button class:active={activeTab === 'week'} onclick={() => activeTab = 'week'}>
      This Week
    </button>
  </div>

  <div class="layout">

    <!-- ── Add Entry Form ──────────────────────────────────────────── -->
    <aside class="form-panel" class:hidden-mobile={activeTab !== 'form'}>
      <form onsubmit={(e) => { e.preventDefault(); addEntry(); }}>
        <h2>Log Entry</h2>

        <div class="field">
          <label for="date">Date</label>
          <input id="date" type="date" bind:value={formDate} />
        </div>

        <div class="field">
          <label for="desc">Task <span class="hint">Shift+Enter for multiple</span></label>
          <textarea
            id="desc"
            placeholder="What did you work on?"
            bind:value={formDesc}
            onkeydown={handleKeydown}
            autocomplete="off"
            rows="3"
          ></textarea>
        </div>

        <div class="field">
          <label for="cat">Category</label>
          <select id="cat" bind:value={formCategory}>
            {#each CATEGORIES as cat}
              <option value={cat}>{cat}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label for="status">Status</label>
          <select id="status" bind:value={formStatus}>
            {#each STATUSES as s}
              <option value={s.value}>{s.label}</option>
            {/each}
          </select>
        </div>

        <button type="submit">Add Entry</button>
      </form>

      <div class="mapping-ref">
        <h3>Status → Weekly Deck</h3>
        <div class="mapping-rows">
          <div class="mapping-row">
            <span class="badge status-done">Done</span>
            <span>Updates in Detail</span>
          </div>
          <div class="mapping-row">
            <span class="badge status-in-progress">In Progress</span>
            <span>Updates in Detail</span>
          </div>
          <div class="mapping-row">
            <span class="badge status-next-week">Next Week</span>
            <span>Action Items / Plan</span>
          </div>
          <div class="mapping-row">
            <span class="badge status-blocker">Blocker</span>
            <span>Challenges &amp; Issues</span>
          </div>
          <div class="mapping-row">
            <span class="badge status-achievement">Achievement</span>
            <span>Achievements</span>
          </div>
        </div>
      </div>
    </aside>

    <!-- ── Weekly View ─────────────────────────────────────────────── -->
    <section class="week-panel" class:hidden-mobile={activeTab !== 'week'}>
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

      {#if facets.epic.length > 1 || facets.project.length > 1 || facets.domain.length > 1}
        <div class="facets">
          {#each [['epic', facets.epic], ['project', facets.project], ['domain', facets.domain]] as [dim, values]}
            {#if values.length > 1}
              <div class="facet-row">
                <span class="facet-label">{dim}</span>
                {#each values as v}
                  <button class="facet-chip" class:active={filter[dim] === v} onclick={() => toggleFilter(dim, v)}>{v}</button>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if store.loading}
        <div class="loading-bar">Loading…</div>
      {/if}

      {#if store.error}
        <p class="store-error">⚠ {store.error}</p>
      {/if}

      <div class="days">
        {#each weekDays as day}
          {@const dayEntries = entriesForDay(day)}
          {@const isToday = day === todayStr()}
          <div class="day" class:is-today={isToday} class:is-empty={dayEntries.length === 0}>
            <div class="day-header">
              <span class="day-name">{formatDayLabel(day)}</span>
              {#if dayEntries.length > 0}
                <span class="day-count">{dayEntries.length}</span>
              {/if}
            </div>

            {#if dayEntries.length > 0}
              <ul class="entries">
                {#each dayEntries as entry (entry.id)}
                  <li
                    class="entry"
                    class:is-editing={editingId === entry.id}
                    class:is-synced={entry.source === 'jira'}
                    class:has-note={Boolean(entry.details)}
                  >
                    {#if editingId === entry.id}
                      <div class="edit-row">
                        <input
                          class="edit-desc"
                          type="text"
                          bind:value={editDesc}
                          onkeydown={handleEditKeydown}
                        />
                        <select class="edit-select" bind:value={editCat}>
                          {#each CATEGORIES as cat}
                            <option value={cat}>{cat}</option>
                          {/each}
                        </select>
                        <select class="edit-select" bind:value={editStatus}>
                          {#each STATUSES as s}
                            <option value={s.value}>{s.label}</option>
                          {/each}
                        </select>
                        <button class="icon-btn confirm-btn" onclick={saveEdit} title="Save (Enter)">✓</button>
                        <button class="icon-btn cancel-btn" onclick={cancelEdit} title="Cancel (Esc)">✕</button>
                      </div>
                    {:else}
                      {#if entry.jira_key}
                        <a
                          class="jira-chip"
                          href={entry.jira_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onclick={(e) => e.stopPropagation()}
                        >{entry.jira_key}</a>
                      {/if}
                      <span class="desc" title={entry.details || entry.description}>{entry.description}</span>
                      <div class="entry-badges">
                        {#if entry.epic}
                          <span class="badge epic-badge" title={entry.epic}>{entry.epic}</span>
                        {/if}
                        {#if entry.domain}
                          <span class="badge domain-badge">{entry.domain}</span>
                        {/if}
                        <span class="badge cat-badge">{entry.category}</span>
                        <span class="badge status-{entry.status}">{statusLabel(entry.status)}</span>
                      </div>
                      <button class="edit-btn" onclick={() => startEdit(entry)} aria-label="Edit" title="Edit">✎</button>
                      <button class="del-btn"  onclick={() => store.delete(entry.id)} aria-label="Delete" title="Delete">×</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="empty-day">No entries</p>
            {/if}
          </div>
        {/each}
      </div>

      <div class="week-summary">
        {#each statusCounts as s}
          <div class="summary-chip">
            <span class="badge status-{s.value}">{s.label}</span>
            <strong>{s.count}</strong>
          </div>
        {/each}
      </div>

      <!-- ── AI Summary ─────────────────────────────────────────────── -->
      <div class="ai-section">
        <button
          class="summarize-btn"
          onclick={generateSummary}
          disabled={summarizing || weekEntries.length === 0}
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
              oninput={() => persistReport(weekDays[0], summary)}
              spellcheck="false"
            ></textarea>
          </div>
        {/if}
      </div>
    </section>

  </div>
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

  /* ── Mobile tab bar ────────────────────────────────────────────────── */
  .mobile-tabs {
    display: none;
  }

  /* ── Layout grid ───────────────────────────────────────────────────── */
  .layout {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 1.5rem;
    padding: 1.5rem 2rem;
    max-width: 1280px;
    margin: 0 auto;
  }

  /* ── Form panel ────────────────────────────────────────────────────── */
  .form-panel { display: flex; flex-direction: column; gap: 1rem; }

  form {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  h2 {
    font-size: 0.8125rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.125rem;
  }

  .field { display: flex; flex-direction: column; gap: 0.3rem; }

  label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }

  .hint {
    font-size: 0.65rem;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-hint);
  }

  textarea,
  input[type='text'],
  input[type='date'],
  select {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    font-size: 0.875rem;
    color: var(--text);
    background: var(--input-bg);
    width: 100%;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  textarea { resize: vertical; min-height: 4rem; }

  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
  }

  button[type='submit'] {
    margin-top: 0.25rem;
    padding: 0.625rem;
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 0.4rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  button[type='submit']:hover  { background: #1d4ed8; }
  button[type='submit']:active { background: #1e40af; }

  /* ── Mapping reference ─────────────────────────────────────────────── */
  .mapping-ref {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    padding: 1rem 1.25rem;
  }

  h3 {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    margin-bottom: 0.625rem;
  }

  .mapping-rows { display: flex; flex-direction: column; gap: 0.4rem; }

  .mapping-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--mapping-text);
  }

  /* ── Week panel ────────────────────────────────────────────────────── */
  .week-panel { display: flex; flex-direction: column; gap: 0.875rem; }

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

  .sync-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.5rem 0.875rem;
    background: var(--surface);
    color: #2563eb;
    border: 1px dashed #bfdbfe;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .sync-btn:hover:not(:disabled) { background: #eff6ff; border-color: #93c5fd; }
  .sync-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .sync-spinner { border-color: #bfdbfe; border-top-color: #2563eb; }

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

  .entry.is-synced { border-left: 2px solid #93c5fd; }
  /* A comment-derived entry carries your own words — mark it distinctly
     from a plain status-transition entry. */
  .entry.has-note { border-left-color: #a78bfa; }

  .epic-badge, .domain-badge {
    background: var(--cat-bg);
    color: var(--cat-text);
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Filter chips ──────────────────────────────────────────────────── */
  .facets {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    padding: 0.625rem 1rem;
  }

  .facet-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .facet-label {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
    width: 4.5rem;
    flex-shrink: 0;
  }

  .facet-chip {
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: none;
    font-size: 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .facet-chip:hover { background: var(--nav-hover); }
  .facet-chip.active { background: #2563eb; border-color: #2563eb; color: #fff; }

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

  /* ── Days ──────────────────────────────────────────────────────────── */
  .days { display: flex; flex-direction: column; gap: 0.5rem; }

  .day {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .day.is-today { border-color: var(--today-border); }
  .day.is-empty { opacity: 0.6; }

  .day-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.875rem;
    background: var(--surface-alt);
    border-bottom: 1px solid var(--border);
  }

  .day.is-today .day-header { background: var(--today-bg); border-bottom-color: var(--today-border); }

  .day-name { font-size: 0.8125rem; font-weight: 600; }

  .day-count {
    background: var(--count-bg);
    color: var(--count-text);
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.1rem 0.45rem;
    border-radius: 9999px;
  }

  .day.is-today .day-count { background: var(--today-count-bg); color: var(--today-count-text); }

  .entries { list-style: none; }

  .entry {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.875rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .entry:last-child { border-bottom: none; }

  .desc { flex: 1; font-size: 0.875rem; line-height: 1.4; }

  .entry-badges { display: flex; gap: 0.3rem; flex-shrink: 0; }

  .empty-day {
    padding: 0.5rem 0.875rem;
    font-size: 0.8rem;
    color: var(--text-faint);
    font-style: italic;
  }

  /* ── Action buttons (edit + delete) ───────────────────────────────── */
  .edit-btn,
  .del-btn {
    background: none;
    border: none;
    cursor: pointer;
    line-height: 1;
    padding: 0.15rem 0.3rem;
    border-radius: 0.25rem;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, background 0.15s;
  }

  .edit-btn { font-size: 0.9rem; color: var(--text-hint); }
  .del-btn  { font-size: 1.1rem; color: var(--text-hint); }

  .entry:hover .edit-btn,
  .entry:hover .del-btn  { opacity: 1; }

  .edit-btn:hover { color: #2563eb; background: #dbeafe; }
  .del-btn:hover  { color: #dc2626; background: #fee2e2; }

  /* ── Inline edit row ──────────────────────────────────────────────── */
  .entry.is-editing { flex-wrap: nowrap; }

  .edit-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    min-width: 0;
  }

  .edit-desc {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    font-size: 0.875rem;
    color: var(--text);
    background: var(--input-bg);
  }

  .edit-select {
    width: auto;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    font-size: 0.75rem;
    color: var(--text);
    background: var(--input-bg);
    flex-shrink: 0;
  }

  .edit-desc:focus, .edit-select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
  }

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

  .confirm-btn { color: #15803d; border-color: #86efac; background: #f0fdf4; }
  .confirm-btn:hover { background: #dcfce7; }
  .cancel-btn  { color: var(--text-faint); }
  .cancel-btn:hover  { color: #dc2626; background: #fee2e2; border-color: #fca5a5; }

  /* ── Week summary ──────────────────────────────────────────────────── */
  .week-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    padding: 0.75rem 1.25rem;
    align-items: center;
  }

  .summary-chip { display: flex; align-items: center; gap: 0.4rem; font-size: 0.875rem; }
  .summary-chip strong { font-size: 1rem; font-weight: 700; color: var(--summary-text); }

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

  .cat-badge { background: var(--cat-bg); color: var(--cat-text); }

  /*
    Status badge classes applied dynamically — :global() prevents tree-shaking.
  */
  :global(.status-done)        { background: #dcfce7; color: #15803d; }
  :global(.status-in-progress) { background: #f3e8ff; color: #7c3aed; }
  :global(.status-next-week)   { background: #dbeafe; color: #1d4ed8; }
  :global(.status-blocker)     { background: #fee2e2; color: #dc2626; }
  :global(.status-achievement) { background: #fef3c7; color: #b45309; }

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

    .mobile-tabs {
      display: flex;
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .mobile-tabs button {
      flex: 1;
      padding: 0.875rem;
      font-size: 0.9375rem;
      font-weight: 600;
      border: none;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }

    .mobile-tabs button.active {
      color: #2563eb;
      border-bottom-color: #2563eb;
    }

    .layout {
      grid-template-columns: 1fr;
      padding: 0.75rem 1rem;
      gap: 0.75rem;
    }

    .hidden-mobile { display: none; }

    /* Larger touch targets for edit/delete */
    .edit-btn,
    .del-btn {
      opacity: 1;
      padding: 0.5rem;
      min-width: 2.25rem;
      min-height: 2.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Taller textarea on mobile */
    textarea { min-height: 6rem; }

    /* Bigger submit button */
    button[type='submit'] {
      padding: 0.875rem;
      font-size: 1rem;
    }

    /* Dense entry rows: keep the Jira key and status, drop epic/domain */
    .epic-badge, .domain-badge { display: none; }

    .sync-card { max-height: 90vh; }
    .facet-label { width: auto; }
  }
</style>
