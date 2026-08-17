import { json, error } from '@sveltejs/kit';
import sql from '$lib/db.js';
import {
  isJiraConfigured,
  searchWeekIssues,
  searchAllIssues,
  resolveHierarchy,
  fetchTransitionsForIssues,
  fetchCommentsForIssues,
  getMyself,
  warnTimezone,
  jiraBrowseUrl,
  addDays,
  JiraError
} from '$lib/server/jira.js';
import { mapIssuesToEntries } from '$lib/server/jiraMapping.js';

// First sync (preview AND apply) after this feature shipped pulls the
// account's ENTIRE Jira history instead of just the selected week — see
// isBackfillDone() below. That first click should be run via `npm run dev`
// against the production DATABASE_URL, not the deployed instance: this
// route's maxDuration is left at 60s, and an unbounded changelog/comment
// walk across many issues can comfortably exceed that. Local dev has no
// such limit. Every sync after the first one is back to normal and fast.
export const config = { maxDuration: 60 };

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKFILL_FLOOR = '2000-01-01';

export async function GET() {
  return json({ configured: isJiraConfigured() });
}

/**
 * `issue_summary` is a column only this feature's code ever writes — so
 * "does any row have it set" is a reliable "have we ever run the new,
 * hierarchy-aware sync" signal, independent of how many `source='jira'`
 * rows already exist from before this feature (there are 206 of them).
 * Checking `source='jira'` directly would never detect a first run.
 */
async function isBackfillDone() {
  const [row] = await sql`SELECT 1 FROM worklog_entries WHERE issue_summary IS NOT NULL LIMIT 1`;
  return Boolean(row);
}

/**
 * The single source of truth for how far the existing-rows lookup, the
 * preview's "removing" list, and the actual DELETE-prune all reach — they
 * must never diverge, or the preview undercounts what apply really deletes.
 */
function pruneRange(week, fullHistory) {
  return fullHistory ? { from: BACKFILL_FLOOR, to: todayStr() } : { from: week, to: addDays(week, 6) };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }

  const { week, mode = 'preview' } = body ?? {};
  if (!week || !WEEK_RE.test(week)) throw error(400, 'week must be a YYYY-MM-DD Monday');
  if (mode !== 'preview' && mode !== 'apply') throw error(400, "mode must be 'preview' or 'apply'");

  try {
    const fullHistory = !(await isBackfillDone());
    const result = await computeSync(week, fullHistory);

    if (mode === 'preview') {
      return json(await buildPreview(week, result, fullHistory));
    }

    return json(await applySync(week, result, fullHistory));
  } catch (e) {
    if (e instanceof JiraError) throw error(e.status, e.message);
    if (e?.status && e?.body) throw e; // already a SvelteKit HttpError
    throw error(500, `Sync failed: ${e.message}`);
  }
}

async function computeSync(week, fullHistory) {
  const warnings = [];

  const me = await getMyself();
  warnTimezone(me, warnings);

  const { jql, issues } = fullHistory
    ? await searchAllIssues(warnings)
    : await searchWeekIssues(week, warnings);

  if (fullHistory) {
    warnings.push('First sync — pulling your entire Jira history instead of just this week. Every sync after this one is back to normal.');
  }

  if (!issues.length) {
    return { jql, entries: [], warnings, issuesSeen: 0, issuesSuppressed: 0, commentEntries: 0, continuedEntries: 0 };
  }

  const issueKeys = issues.map((i) => i.key);
  const { from, to } = pruneRange(week, fullHistory);

  // Concurrent at the top level: halves wall time, and none of the three
  // depend on each other's output.
  const [hierarchy, transitionsByKey, commentsByKey] = await Promise.all([
    resolveHierarchy(issues, warnings),
    fetchTransitionsForIssues(issueKeys, from, to, { fullWalk: fullHistory }),
    fetchCommentsForIssues(issueKeys, from, to, me.accountId)
  ]);

  const { entries, suppressedCount, commentEntryCount, continuedCount } = mapIssuesToEntries({
    issues,
    transitionsByKey,
    commentsByKey,
    hierarchy,
    browseUrl: jiraBrowseUrl,
    warnings,
    weekMonday: week,
    myAccountId: me.accountId,
    fullHistory
  });

  if (issues.length && !commentEntryCount) {
    warnings.push(
      'No comments authored by you were found — entries fell back to status transitions. ' +
        `Confirm JIRA_EMAIL resolves to the account that writes your comments (accountId ${me.accountId}).`
    );
  }

  return {
    jql,
    entries,
    warnings,
    issuesSeen: issues.length,
    issuesSuppressed: suppressedCount,
    commentEntries: commentEntryCount,
    continuedEntries: continuedCount
  };
}

async function existingJiraRows(from, to) {
  const rows = await sql`
    SELECT id, jira_key, date::text, description, details, user_edited
    FROM worklog_entries
    WHERE source = 'jira' AND date BETWEEN ${from}::date AND ${to}::date
  `;
  return new Map(rows.map((r) => [r.id, r]));
}

async function buildPreview(week, result, fullHistory) {
  const { from, to } = pruneRange(week, fullHistory);
  const existing = await existingJiraRows(from, to);
  const desiredIds = new Set(result.entries.map((e) => e.id));

  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;

  const entries = result.entries.map((e) => {
    const row = existing.get(e.id);
    let action;
    if (!row) {
      action = 'new';
      newCount += 1;
    } else if (row.user_edited) {
      action = 'skip';
      skipCount += 1;
    } else {
      action = 'update';
      updateCount += 1;
    }
    return { ...e, action };
  });

  const removing = [...existing.values()]
    .filter((row) => !row.user_edited && !desiredIds.has(row.id))
    .map((row) => ({ id: row.id, jira_key: row.jira_key, date: row.date, description: row.description }));

  return {
    mode: 'preview',
    jql: result.jql,
    entries,
    removing,
    stats: {
      new: newCount,
      update: updateCount,
      skip: skipCount,
      remove: removing.length,
      issuesSeen: result.issuesSeen,
      issuesSuppressed: result.issuesSuppressed,
      comments: result.commentEntries,
      continued: result.continuedEntries
    },
    warnings: result.warnings
  };
}

async function applySync(week, result, fullHistory) {
  const sunday = addDays(week, 6);
  const { from, to } = pruneRange(week, fullHistory);
  const existing = await existingJiraRows(from, to);
  const desiredIds = result.entries.map((e) => e.id);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  await sql.begin(async (tx) => {
    for (const e of result.entries) {
      const row = existing.get(e.id);
      if (row?.user_edited) {
        skipped += 1;
        continue;
      }

      const [written] = await tx`
        INSERT INTO worklog_entries
          (id, date, description, details, status, source, jira_key, jira_url,
           issue_type, epic, project, domain, labels, issue_summary, parent_key,
           parent_summary, parent_issue_type, parent_url, signal, synced_at)
        VALUES (${e.id}, ${e.date}, ${e.description}, ${e.details}, ${e.status}, 'jira',
                ${e.jira_key}, ${e.jira_url}, ${e.issue_type}, ${e.epic}, ${e.project},
                ${e.domain}, ${e.labels}, ${e.issue_summary}, ${e.parent_key},
                ${e.parent_summary}, ${e.parent_issue_type}, ${e.parent_url},
                ${e.signal ?? null}, now())
        ON CONFLICT (id) DO UPDATE SET
          date = EXCLUDED.date, description = EXCLUDED.description, details = EXCLUDED.details,
          status = EXCLUDED.status,
          jira_url = EXCLUDED.jira_url, issue_type = EXCLUDED.issue_type,
          epic = EXCLUDED.epic, project = EXCLUDED.project,
          domain = EXCLUDED.domain, labels = EXCLUDED.labels,
          issue_summary = EXCLUDED.issue_summary, parent_key = EXCLUDED.parent_key,
          parent_summary = EXCLUDED.parent_summary, parent_issue_type = EXCLUDED.parent_issue_type,
          parent_url = EXCLUDED.parent_url, signal = EXCLUDED.signal, synced_at = now()
        WHERE worklog_entries.user_edited = false
        RETURNING (xmax = 0) AS inserted
      `;

      if (written) {
        if (written.inserted) inserted += 1;
        else updated += 1;
      } else {
        skipped += 1;
      }
    }

    if (desiredIds.length) {
      await tx`
        DELETE FROM worklog_entries
        WHERE source = 'jira' AND user_edited = false
          AND date BETWEEN ${from}::date AND ${to}::date
          AND NOT (id = ANY(${desiredIds}))
      `;
    } else {
      await tx`
        DELETE FROM worklog_entries
        WHERE source = 'jira' AND user_edited = false
          AND date BETWEEN ${from}::date AND ${to}::date
      `;
    }
  });

  const removed = [...existing.values()].filter(
    (row) => !row.user_edited && !result.entries.some((e) => e.id === row.id)
  ).length;

  // Response stays scoped to the currently-viewed week regardless of how
  // wide the backfill was — the client only needs to refresh what's on
  // screen; other backfilled weeks load normally via week navigation.
  const entries = await sql`
    SELECT id, date::text, description, details, status,
           source, jira_key, jira_url, issue_type, epic, project, domain, labels,
           issue_summary, parent_key, parent_summary, parent_issue_type, parent_url,
           signal
    FROM worklog_entries
    WHERE date BETWEEN ${week}::date AND ${sunday}::date
    ORDER BY date, created_at
  `;

  return {
    mode: 'apply',
    stats: { inserted, updated, skipped, removed, comments: result.commentEntries, continued: result.continuedEntries },
    entries,
    warnings: result.warnings
  };
}
