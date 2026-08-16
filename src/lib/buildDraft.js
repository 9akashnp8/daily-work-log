// Kept in sync with STATUSES in store.svelte.js by hand — not imported
// directly, since that file is a Svelte-rune module (`$state(...)` field
// initializers) that side-effect-instantiates a store the moment it's
// loaded; this is a plain lib with no Svelte runtime dependency.
const STATUS_LABELS = {
  done: 'Done',
  'in-progress': 'In Progress',
  'next-week': 'Next Week',
  blocker: 'Blocker',
  achievement: 'Achievement'
};

function statusLabel(val) {
  return STATUS_LABELS[val] ?? val;
}

function formatShortDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
}

function groupByKey(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  for (const list of map.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return map;
}

function renderBullets(rows) {
  return rows.map(r => {
    let line = `- **${formatShortDate(r.date)}** — ${r.description}`;
    if (r.details) {
      const indented = r.details.trim().split('\n').map(l => `  ${l}`).join('\n');
      line += `\n${indented}`;
    }
    return line;
  }).join('\n');
}

function latestStatusLabel(rows) {
  return statusLabel(rows[rows.length - 1].status);
}

function renderStoryBlock(key, rows) {
  const title = rows[0].issue_summary || rows[0].description;
  return `### ${title} (${key}) — ${latestStatusLabel(rows)}\n${renderBullets(rows)}`;
}

function renderSubtaskBlock(key, rows) {
  const title = rows[0].issue_summary || rows[0].description;
  return `#### ${title} (${key}) — ${latestStatusLabel(rows)}\n${renderBullets(rows)}`;
}

/**
 * Builds the week's work as one markdown document, organized Epic → Story →
 * Subtask, each issue followed by its dated updates for the week. This is
 * the editable draft shown in the main view, and later fed almost verbatim
 * into the AI summarizer's prompt — see src/routes/api/summarize/+server.js.
 */
export function buildDraftMarkdown(entries, weekLabel) {
  const manual = entries.filter(e => e.source !== 'jira');
  const jiraEntries = entries.filter(e => e.source === 'jira');

  if (!jiraEntries.length && !manual.length) {
    return `_No entries yet for ${weekLabel} — sync from Jira, or just start typing your notes here._`;
  }

  const byEpic = new Map();
  for (const e of jiraEntries) {
    const epic = e.epic || e.project || 'Uncategorised';
    if (!byEpic.has(epic)) byEpic.set(epic, []);
    byEpic.get(epic).push(e);
  }

  const epicNames = [...byEpic.keys()].sort((a, b) => {
    if (a === 'Uncategorised') return 1;
    if (b === 'Uncategorised') return -1;
    return a.localeCompare(b);
  });

  const blocks = [];

  for (const epic of epicNames) {
    const items = byEpic.get(epic);
    const topLevelRows = items.filter(e => !e.parent_key);
    const childRows = items.filter(e => e.parent_key);

    const topByKey = groupByKey(topLevelRows, 'jira_key');
    const childrenByParentKey = groupByKey(childRows, 'parent_key');

    const storyBlocks = [];

    for (const [key, rows] of topByKey) {
      let block = renderStoryBlock(key, rows);
      const kids = childrenByParentKey.get(key);
      if (kids) {
        const kidsByKey = groupByKey(kids, 'jira_key');
        for (const [ckey, crows] of kidsByKey) {
          block += `\n\n${renderSubtaskBlock(ckey, crows)}`;
        }
      }
      storyBlocks.push(block);
    }

    // A story with only subtask activity this week (the Story itself was
    // quiet) still needs a heading to nest under — synthesize it from data
    // carried on the subtask's own row (parent_summary/parent_key).
    for (const [parentKey, kids] of childrenByParentKey) {
      if (topByKey.has(parentKey)) continue;
      const sample = kids[0];
      const title = sample.parent_summary || parentKey;
      let block = `### ${title} (${parentKey})`;
      const kidsByKey = groupByKey(kids, 'jira_key');
      for (const [ckey, crows] of kidsByKey) {
        block += `\n\n${renderSubtaskBlock(ckey, crows)}`;
      }
      storyBlocks.push(block);
    }

    blocks.push(`## ${epic}\n\n${storyBlocks.join('\n\n')}`);
  }

  if (manual.length) {
    const sorted = [...manual].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    blocks.push(`## Manual / Other\n\n${renderBullets(sorted)}`);
  }

  return blocks.join('\n\n');
}
