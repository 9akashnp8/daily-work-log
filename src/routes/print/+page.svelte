<script>
  import { page } from '$app/stores';
  import { parseSections, formatSlideDate, prevWeekMonday } from '$lib/parseSections.js';

  /**
   * Convert inline markdown to safe HTML for use with {@html}.
   * Handles: **bold**, *italic*, `code`, and escapes HTML entities.
   */
  function renderInline(text) {
    return text
      // Escape HTML entities first to prevent injection
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      // Italic: *text* or _text_ (not already consumed by bold)
      .replace(/\*([^*]+?)\*/g, '<em>$1</em>')
      .replace(/_([^_]+?)_/g, '<em>$1</em>')
      // Inline code: `code`
      .replace(/`([^`]+?)`/g, '<code>$1</code>');
  }

  // ── Read week from URL query param (?week=2026-04-13) ────────────────────
  const weekStart = $derived($page.url.searchParams.get('week') ?? '');
  const prevStart = $derived(weekStart ? prevWeekMonday(weekStart) : '');

  let reportText = $state('');
  let prevText   = $state('');

  $effect(() => {
    if (!weekStart) return;
    reportText = '';
    fetch(`/api/reports?week=${weekStart}`)
      .then(r => r.json())
      .then(d => { if (d.summary) reportText = d.summary; })
      .catch(() => {});
  });

  $effect(() => {
    if (!prevStart) return;
    prevText = '';
    fetch(`/api/reports?week=${prevStart}`)
      .then(r => r.json())
      .then(d => { if (d.summary) prevText = d.summary; })
      .catch(() => {});
  });

  const sections     = $derived(reportText ? parseSections(reportText) : null);
  const prevSections = $derived(prevText   ? parseSections(prevText)   : null);

  const currentDate = $derived(weekStart ? formatSlideDate(weekStart) : '');
  const prevDate    = $derived(prevStart  ? formatSlideDate(prevStart)  : '');

  // Derive previous week label for the slide title
  const prevWeekEnd = $derived(() => {
    if (!prevStart) return '';
    const d = new Date(prevStart + 'T00:00:00');
    d.setDate(d.getDate() + 6);
    return formatSlideDate(
      `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    );
  });
</script>

<!-- ── Control bar (hidden when printing) ───────────────────────────────── -->
<div class="controls no-print">
  {#if sections}
    <button class="print-btn" onclick={() => window.print()}>🖨 Print / Save as PDF</button>
  {/if}
  <button class="close-btn" onclick={() => window.close()}>✕ Close</button>
  {#if !sections}
    <p class="no-report">No saved report found for this week. Go back and generate a summary first.</p>
  {/if}
</div>

<!-- ── Slide 1: Current week ─────────────────────────────────────────────── -->
{#if sections}
  <div class="slide">
    <div class="top-bar"></div>

    <div class="slide-header">
      <h1>Current Week – {currentDate}</h1>
      <div class="logo">
        <span class="logo-icon">⬛</span>
        <span class="logo-bein">BEIN</span><span class="logo-ex">EX</span>
      </div>
    </div>

    <div class="divider"></div>

    <div class="slide-body">
      <div class="col-left">
        <div class="section-box updates-box">
          <span class="section-label">Updates in Detail</span>
          <ul class="section-bullets">
            {#each sections['Updates in Detail'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
            {#if sections['Updates in Detail'].length === 0}
              <li class="empty">No updates logged.</li>
            {/if}
          </ul>
        </div>

        <div class="section-box">
          <span class="section-label">Action Items</span>
          <ul class="section-bullets">
            {#each sections['Action Items'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
            {#if sections['Action Items'].length === 0}
              <li class="empty">No action items.</li>
            {/if}
          </ul>
        </div>
      </div>

      <div class="col-right">
        <div class="section-box">
          <span class="section-label">Plan for the next Week</span>
          <ul class="section-bullets">
            {#each sections['Plan for Next Week'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
            {#if sections['Plan for Next Week'].length === 0}
              <li class="empty">No plan logged.</li>
            {/if}
          </ul>
        </div>

        <div class="section-box">
          <span class="section-label">Challenges &amp; Issues</span>
          <ul class="section-bullets">
            {#each sections['Challenges & Issues'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
            {#if sections['Challenges & Issues'].length === 0}
              <li class="empty">No challenges logged.</li>
            {/if}
          </ul>
        </div>

        <div class="section-box">
          <span class="section-label">Achievements &amp; Accomplishments</span>
          <ul class="section-bullets">
            {#each sections['Achievements & Accomplishments'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
            {#if sections['Achievements & Accomplishments'].length === 0}
              <li class="empty">No achievements logged.</li>
            {/if}
          </ul>
        </div>
      </div>
    </div>

    <div class="bottom-bar"></div>
  </div>
{/if}

<!-- ── Slide 2: Previous week (if saved report exists) ───────────────────── -->
{#if prevSections}
  <div class="slide page-break">
    <div class="top-bar"></div>

    <div class="slide-header">
      <h1>Previous Week – {prevDate}</h1>
      <div class="logo">
        <span class="logo-icon">⬛</span>
        <span class="logo-bein">BEIN</span><span class="logo-ex">EX</span>
      </div>
    </div>

    <div class="divider"></div>

    <div class="slide-body">
      <div class="col-left">
        <div class="section-box updates-box">
          <span class="section-label">Updates in Detail</span>
          <ul class="section-bullets">
            {#each prevSections['Updates in Detail'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
          </ul>
        </div>

        <div class="section-box">
          <span class="section-label">Action Items</span>
          <ul class="section-bullets">
            {#each prevSections['Action Items'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
          </ul>
        </div>
      </div>

      <div class="col-right">
        <div class="section-box">
          <span class="section-label">Plan for the next Week</span>
          <ul class="section-bullets">
            {#each prevSections['Plan for Next Week'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
          </ul>
        </div>

        <div class="section-box">
          <span class="section-label">Challenges &amp; Issues</span>
          <ul class="section-bullets">
            {#each prevSections['Challenges & Issues'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
          </ul>
        </div>

        <div class="section-box">
          <span class="section-label">Achievements &amp; Accomplishments</span>
          <ul class="section-bullets">
            {#each prevSections['Achievements & Accomplishments'] as bullet}
              <li>{@html renderInline(bullet)}</li>
            {/each}
          </ul>
        </div>
      </div>
    </div>

    <div class="bottom-bar"></div>
  </div>
{/if}

<style>
  /* ── Print / page setup ───────────────────────────────────────────── */
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { background: #d0d0d0; font-family: 'Segoe UI', Calibri, Arial, sans-serif; }

  @page { size: A4 landscape; margin: 0; }

  @media print {
    :global(body) { background: white; }
    .no-print { display: none !important; }
    .slide { box-shadow: none; margin: 0; }
  }

  /* ── Control bar ─────────────────────────────────────────────────── */
  .controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    background: #1e293b;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .print-btn {
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 0.4rem;
    padding: 0.5rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
  .print-btn:hover { background: #1d4ed8; }

  .close-btn {
    background: none;
    border: 1px solid #475569;
    border-radius: 0.4rem;
    padding: 0.5rem 1rem;
    color: #94a3b8;
    font-size: 0.875rem;
    cursor: pointer;
  }
  .close-btn:hover { background: #334155; color: #f1f5f9; }

  .no-report { color: #f87171; font-size: 0.875rem; }

  /* ── Slide wrapper ───────────────────────────────────────────────── */
  .slide {
    width: 297mm;
    height: 210mm;
    background: #ffffff;
    display: flex;
    flex-direction: column;
    margin: 1.5rem auto;
    box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    overflow: hidden;
  }

  .page-break { page-break-before: always; }

  /* ── Bars ────────────────────────────────────────────────────────── */
  .top-bar, .bottom-bar {
    background: #0d1b2e;
    height: 9mm;
    flex-shrink: 0;
  }

  /* ── Header ──────────────────────────────────────────────────────── */
  .slide-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding: 5mm 12mm 2mm;
    flex-shrink: 0;
  }

  h1 {
    font-size: 20pt;
    font-weight: 700;
    color: #1a3560;
    letter-spacing: -0.3px;
  }

  /* ── BEINEX logo ─────────────────────────────────────────────────── */
  .logo {
    font-size: 16pt;
    font-weight: 800;
    letter-spacing: -0.5px;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .logo-icon { font-size: 10pt; color: #00b4d8; margin-right: 2px; line-height: 1; }
  .logo-bein { color: #1a3560; }
  .logo-ex   { color: #00b4d8; }

  /* ── Teal divider ────────────────────────────────────────────────── */
  .divider {
    height: 2.5px;
    background: #00b4d8;
    margin: 0 12mm 3mm;
    flex-shrink: 0;
  }

  /* ── Two-column body ─────────────────────────────────────────────── */
  .slide-body {
    display: grid;
    grid-template-columns: 55fr 45fr;
    gap: 4mm;
    padding: 0 12mm 3mm;
    flex: 1;
    min-height: 0;
  }

  .col-left, .col-right {
    display: flex;
    flex-direction: column;
    gap: 3mm;
    min-height: 0;
  }

  /* Updates in Detail gets more space in left col */
  .updates-box { flex: 2; }

  /* ── Section boxes ───────────────────────────────────────────────── */
  .section-box {
    border: 1.5px dashed #1a3560;
    border-radius: 3px;
    padding: 6px 8px 6px;
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .section-label {
    position: absolute;
    top: -1px;
    left: -1px;
    background: #dff0f8;
    border: 1.5px solid #0095b6;
    border-radius: 0 0 4px 0;
    padding: 1.5px 9px;
    font-size: 7.5pt;
    font-weight: 700;
    color: #006f8e;
    white-space: nowrap;
  }

  /* ── Bullets ─────────────────────────────────────────────────────── */
  .section-bullets {
    list-style: none;
    margin-top: 13px;
    padding: 0;
    overflow: hidden;
  }

  .section-bullets li {
    font-size: 7.5pt;
    line-height: 1.4;
    padding: 1.5px 0;
    padding-left: 10px;
    position: relative;
    color: #1e293b;
  }

  .section-bullets li::before {
    content: '•';
    position: absolute;
    left: 0;
    color: #1a3560;
    font-weight: bold;
  }

  .section-bullets li.empty {
    color: #94a3b8;
    font-style: italic;
  }
  .section-bullets li.empty::before { content: ''; }

  /* Inline markdown styles */
  :global(.section-bullets li strong) { font-weight: 700; color: #0f2a50; }
  :global(.section-bullets li em)     { font-style: italic; color: #1e3a6e; }
  :global(.section-bullets li code)   {
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 6.5pt;
    background: #f0f4f8;
    border: 0.5px solid #c7d4e0;
    border-radius: 2px;
    padding: 0 3px;
  }
</style>
