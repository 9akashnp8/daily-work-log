import { json, error } from '@sveltejs/kit';
import sql from '$lib/db.js';
import {
  isJiraConfigured,
  searchWeekIssues,
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

export const config = { maxDuration: 60 };

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET() {
  return json({ configured: isJiraConfigured() });
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
    const result = await computeSync(week);

    if (mode === 'preview') {
      return json(await buildPreview(week, result));
    }

    return json(await applySync(week, result));
  } catch (e) {
    if (e instanceof JiraError) throw error(e.status, e.message);
    if (e?.status && e?.body) throw e; // already a SvelteKit HttpError
    throw error(500, `Sync failed: ${e.message}`);
  }
}

async function computeSync(week) {
  const sunday = addDays(week, 6);
  const warnings = [];

  const me = await getMyself();
  warnTimezone(me, warnings);

  const { jql, issues } = await searchWeekIssues(week, warnings);
  if (!issues.length) {
    return { jql, entries: [], warnings, issuesSeen: 0, issuesSuppressed: 0, commentEntries: 0, continuedEntries: 0 };
  }

  const issueKeys = issues.map((i) => i.key);

  // Concurrent at the top level: halves wall time, and none of the three
  // depend on each other's output.
  const [hierarchy, transitionsByKey, commentsByKey] = await Promise.all([
    resolveHierarchy(issues, warnings),
    fetchTransitionsForIssues(issueKeys, week, sunday),
    fetchCommentsForIssues(issueKeys, week, sunday, me.accountId)
  ]);

  const { entries, suppressedCount, commentEntryCount, continuedCount } = mapIssuesToEntries({
    issues,
    transitionsByKey,
    commentsByKey,
    hierarchy,
    browseUrl: jiraBrowseUrl,
    warnings,
    weekMonday: week,
    myAccountId: me.accountId
  });

  if (issues.length && !commentEntryCount) {
    warnings.push(
      'No comments authored by you were found this week — entries fell back to status transitions. ' +
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

async function existingJiraRows(week, sunday) {
  const rows = await sql`
    SELECT id, jira_key, date::text, description, details, user_edited
    FROM worklog_entries
    WHERE source = 'jira' AND date BETWEEN ${week}::date AND ${sunday}::date
  `;
  return new Map(rows.map((r) => [r.id, r]));
}

async function buildPreview(week, result) {
  const sunday = addDays(week, 6);
  const existing = await existingJiraRows(week, sunday);
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

async function applySync(week, result) {
  const sunday = addDays(week, 6);
  const existing = await existingJiraRows(week, sunday);
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
          (id, date, description, details, category, status, source, jira_key, jira_url,
           issue_type, epic, project, domain, labels, synced_at)
        VALUES (${e.id}, ${e.date}, ${e.description}, ${e.details}, ${e.category}, ${e.status}, 'jira',
                ${e.jira_key}, ${e.jira_url}, ${e.issue_type}, ${e.epic}, ${e.project},
                ${e.domain}, ${e.labels}, now())
        ON CONFLICT (id) DO UPDATE SET
          date = EXCLUDED.date, description = EXCLUDED.description, details = EXCLUDED.details,
          category = EXCLUDED.category, status = EXCLUDED.status,
          jira_url = EXCLUDED.jira_url, issue_type = EXCLUDED.issue_type,
          epic = EXCLUDED.epic, project = EXCLUDED.project,
          domain = EXCLUDED.domain, labels = EXCLUDED.labels, synced_at = now()
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
          AND date BETWEEN ${week}::date AND ${sunday}::date
          AND NOT (id = ANY(${desiredIds}))
      `;
    } else {
      await tx`
        DELETE FROM worklog_entries
        WHERE source = 'jira' AND user_edited = false
          AND date BETWEEN ${week}::date AND ${sunday}::date
      `;
    }
  });

  const removed = [...existing.values()].filter(
    (row) => !row.user_edited && !result.entries.some((e) => e.id === row.id)
  ).length;

  const entries = await sql`
    SELECT id, date::text, description, details, category, status,
           source, jira_key, jira_url, issue_type, epic, project, domain, labels
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
