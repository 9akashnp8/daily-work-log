/**
 * Convert inline markdown to safe HTML for use with {@html}.
 * Handles: **bold**, *italic*, `code`, and escapes HTML entities.
 */
export function renderInline(text) {
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

const SECTION_KEYS = [
  'Updates in Detail',
  'Plan for Next Week',
  'Challenges & Issues',
  'Achievements & Accomplishments',
  'Action Items',
];

const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Resolve a heading to one of SECTION_KEYS.
 *
 * Exact (normalised) match first, then a *best-scoring* fuzzy match. Scoring
 * matters: the previous first-match-wins scan routed "Action Items & Next
 * Steps" into "Plan for Next Week" on the strength of `next` alone, silently
 * emptying Action Items. Counting overlapping words instead lets "action" +
 * "items" (2) beat "next" (1). Ties keep SECTION_KEYS order.
 *
 * The prompt now pins the headings verbatim, so this is a safety net for a
 * model that reworded one — not the primary defence.
 */
function matchSection(title) {
  const norm = normalise(title);

  const exact = SECTION_KEYS.find(k => normalise(k) === norm);
  if (exact) return exact;

  let best = null;
  let bestScore = 0;

  for (const k of SECTION_KEYS) {
    const words = normalise(k).split(' ').filter(w => w.length > 3);
    // Word-boundary check: "week" must not match inside "weekly"
    const score = words.filter(w => new RegExp(`\\b${w}\\b`).test(norm)).length;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }

  return best;
}

/**
 * Parse an AI summary into a map of section → bullet array.
 * Handles both **Header** and ## Header styles.
 */
export function parseSections(text) {
  const result = Object.fromEntries(SECTION_KEYS.map(k => [k, []]));
  let current = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Accept **Header**, **Header**, or ## Header (1–3 #'s)
    const headerMatch =
      trimmed.match(/^\*\*(.+?)\*\*\s*$/) ||
      trimmed.match(/^#{1,3}\s+(.+)$/);

    if (headerMatch) {
      current = matchSection(headerMatch[1]);
      continue;
    }

    if (!current) continue;

    if (/^[•\-\*]\s/.test(trimmed)) {
      result[current].push(trimmed.replace(/^[•\-\*]\s/, ''));
    } else if (!/^-{3,}$/.test(trimmed)) {
      // Skip bare horizontal rules (---), include everything else
      result[current].push(trimmed);
    }
  }

  return result;
}

/**
 * "2026-04-13" → "13 April, 2026"
 */
export function formatSlideDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

/**
 * Given a Monday date string, return the Monday of the previous week.
 */
export function prevWeekMonday(mondayStr) {
  const d = new Date(mondayStr + 'T00:00:00');
  d.setDate(d.getDate() - 7);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
