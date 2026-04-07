<script>
  import { browser } from '$app/environment';
  import { store, CATEGORIES, STATUSES } from '$lib/store.svelte.js';

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

  function entriesForDay(day) {
    return store.entries.filter(e => e.date === day);
  }

  const statusCounts = $derived(
    STATUSES.map(s => ({
      ...s,
      count: weekDays.flatMap(d => entriesForDay(d)).filter(e => e.status === s.value).length
    }))
  );

  // ─── Add entry ────────────────────────────────────────────────────────────

  function addEntry() {
    const lines = formDesc.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    lines.forEach((line, i) => {
      store.add({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        date: formDate,
        description: line,
        category: formCategory,
        status: formStatus
      });
    });
    formDesc = '';
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
</script>

<main>
  <header>
    <h1>Daily Work Log</h1>
    <button class="theme-btn" onclick={() => dark = !dark} title="{dark ? 'Switch to light mode' : 'Switch to dark mode'}">
      {dark ? '☀' : '☾'}
    </button>
  </header>

  <div class="layout">

    <!-- ── Add Entry Form ──────────────────────────────────────────── -->
    <aside class="form-panel">
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
    <section class="week-panel">
      <div class="week-nav">
        <button onclick={() => weekOffset--}>&#8592;</button>
        <span class="week-label">{weekLabel}</span>
        <button onclick={() => weekOffset++}>&#8594;</button>
      </div>

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
                  <li class="entry" class:is-editing={editingId === entry.id}>
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
                      <span class="desc">{entry.description}</span>
                      <div class="entry-badges">
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

  /* ── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .layout { grid-template-columns: 1fr; padding: 1rem; }
  }
</style>
