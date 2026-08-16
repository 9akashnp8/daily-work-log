import { renderInline } from './parseSections.js';

/**
 * Renders the draft's block structure (as produced by buildDraft.js —
 * ## / ### / #### headers, `- ` bullets with indented continuation lines
 * for details) to safe HTML for a read-only preview. Falls back to plain
 * paragraphs for any freeform text that doesn't match that shape, since
 * the draft is user-edited and won't always look exactly like the
 * generated markdown.
 */
export function renderMarkdown(text) {
  const lines = text.split('\n');
  const html = [];
  let inList = false;
  let currentLi = null;

  function closeLi() {
    if (currentLi !== null) {
      html.push(currentLi + '</li>');
      currentLi = null;
    }
  }

  function closeList() {
    closeLi();
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      html.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      continue;
    }

    const bulletMatch = line.match(/^-\s+(.+)$/);
    if (bulletMatch) {
      closeLi();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      currentLi = `<li>${renderInline(bulletMatch[1])}`;
      continue;
    }

    // An indented continuation line belongs to the currently open bullet
    // (e.g. a comment's body, indented by buildDraft.js's renderBullets).
    if (/^\s+/.test(line) && currentLi !== null) {
      currentLi += `<br>${renderInline(trimmed)}`;
      continue;
    }

    // Freeform text with no bullet marker — its own paragraph.
    closeList();
    html.push(`<p>${renderInline(trimmed)}</p>`);
  }
  closeList();

  return html.join('\n');
}
