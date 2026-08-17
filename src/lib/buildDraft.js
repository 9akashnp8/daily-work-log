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
    // The silent-ticket fallback (see buildContinuedEntry in jiraMapping.js):
    // the issue was open all week but nothing was actually done on it. Say so
    // in plain language so the summarizer can down-weight it instead of
    // treating it as work. `signal` is null on pre-column and hand-edited
    // rows — those are genuine work and get no marker.
    if (r.signal === 'continued') line += ' _(no activity logged this week — still open)_';
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

/**
 * The " — Bug · In Progress · backend" suffix on an issue heading. Issue type
 * and domain are resolved during sync but were previously dropped here, so
 * the summarizer could not tell a bug fix from a feature, or backend work
 * from frontend. Any facet that is null is simply omitted.
 */
function headingFacets(rows) {
  return [rows[0].issue_type, latestStatusLabel(rows), rows[0].domain]
    .filter(Boolean)
    .join(' · ');
}

function renderStoryBlock(key, rows) {
  const title = rows[0].issue_summary || rows[0].description;
  return `### ${title} (${key}) — ${headingFacets(rows)}\n${renderBullets(rows)}`;
}

function renderSubtaskBlock(key, rows) {
  const title = rows[0].issue_summary || rows[0].description;
  return `#### ${title} (${key}) — ${headingFacets(rows)}\n${renderBullets(rows)}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function countList(counts) {
  return [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(', ');
}

/**
 * A one-line "week at a glance" for the top of the draft: how much work there
 * was, and of what kind. Without it the summarizer has no idea whether it is
 * compressing one epic or six into the same handful of bullets.
 *
 * Counts DISTINCT ISSUES, not entry rows — `entries` holds one row per issue
 * per day, so a ticket touched on four days would otherwise count as four.
 * Status is taken per issue from its latest day (same rule as the issue
 * headings), not summed across rows.
 */
function weekSummaryLine(jiraEntries, epicCount) {
  const byKey = groupByKey(jiraEntries, 'jira_key');
  if (!byKey.size) return null;

  const statusCounts = new Map();
  const typeCounts = new Map();

  for (const rows of byKey.values()) {
    const status = rows[rows.length - 1].status;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const type = rows[0].issue_type;
    if (type) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }

  // Iterate STATUS_LABELS rather than the Map so the order is stable
  // (Done, In Progress, Next Week, Blocker, Achievement) regardless of
  // which status happened to appear first in the week.
  const statuses = new Map();
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    if (statusCounts.has(key)) statuses.set(label, statusCounts.get(key));
  }
  for (const [key, n] of statusCounts) {
    if (!(key in STATUS_LABELS)) statuses.set(key, n);
  }

  const types = new Map(
    [...typeCounts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
  );

  const parts = [
    `${plural(byKey.size, 'issue')} across ${plural(epicCount, 'epic')}`,
    countList(statuses)
  ];
  if (types.size) parts.push(countList(types));

  return `_${parts.join(' · ')}_`;
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

  // Only worth naming the project when the week actually spans more than one
  // — on a single-project week it is the same word on every heading.
  const allProjects = new Set(jiraEntries.map(e => e.project).filter(Boolean));
  const showProject = allProjects.size > 1;

  const blocks = [];

  const glance = weekSummaryLine(jiraEntries, epicNames.length);
  if (glance) blocks.push(glance);

  for (const epic of epicNames) {
    const items = byEpic.get(epic);
    const projects = showProject
      ? [...new Set(items.map(e => e.project).filter(Boolean))]
      : [];
    const epicHeading = projects.length ? `${epic} — ${projects.join(' / ')}` : epic;
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

    blocks.push(`## ${epicHeading}\n\n${storyBlocks.join('\n\n')}`);
  }

  if (manual.length) {
    const sorted = [...manual].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    blocks.push(`## Manual / Other\n\n${renderBullets(sorted)}`);
  }

  return blocks.join('\n\n');
}
