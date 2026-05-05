const SECTION_KEYS = [
  'Updates in Detail',
  'Plan for Next Week',
  'Challenges & Issues',
  'Achievements & Accomplishments',
  'Action Items',
];

/**
 * Parse an AI summary into a map of section → bullet array.
 * Handles both **Header** and ## Header styles.
 * Uses word-boundary matching so e.g. "week" doesn't match inside "weekly".
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
      const title = headerMatch[1].trim().toLowerCase();
      current = SECTION_KEYS.find(k => {
        const words = k.toLowerCase().split(/[\s&]+/).filter(w => w.length > 3);
        // Word-boundary check: "week" must not match inside "weekly"
        return words.some(w => new RegExp(`\\b${w}\\b`).test(title));
      }) ?? null;
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
