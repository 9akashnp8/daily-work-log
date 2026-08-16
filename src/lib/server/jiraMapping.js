import { env } from '$env/dynamic/private';
import { addDays } from './jira.js';

function parseJsonEnv(name) {
  const raw = env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseListEnv(name, fallback) {
  const raw = env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const DEFAULT_STATUS_MAP = {
  done: 'done',
  closed: 'done',
  resolved: 'done',
  complete: 'done',
  completed: 'done',
  'in progress': 'in-progress',
  'in development': 'in-progress',
  doing: 'in-progress',
  review: 'in-progress',
  'in review': 'in-progress',
  'code review': 'in-progress',
  qa: 'in-progress',
  testing: 'in-progress',
  'to do': 'next-week',
  todo: 'next-week',
  'selected for development': 'next-week',
  ready: 'next-week',
  blocked: 'blocker',
  'on hold': 'blocker',
  impediment: 'blocker',
  backlog: null
};

function statusMap() {
  const override = parseJsonEnv('JIRA_STATUS_MAP');
  return override ? { ...DEFAULT_STATUS_MAP, ...override } : DEFAULT_STATUS_MAP;
}

const DEFAULT_DOMAIN_LABELS = [
  'backend',
  'frontend',
  'fullstack',
  'devops',
  'infra',
  'infrastructure',
  'data',
  'mobile',
  'qa',
  'design',
  'security'
];

const DEFAULT_DOMAIN_PREFIXES = ['t', 'domain', 'area', 'team'];
const DEFAULT_PROJECT_PREFIXES = ['p', 'project', 'proj', 'client'];
const DEFAULT_ACHIEVEMENT_LABELS = ['achievement', 'milestone', 'launch', 'released'];
const DEFAULT_BLOCKER_LABELS = ['blocked', 'blocker', 'impediment'];

/**
 * Drops any issue that is the `parent` of another issue in the same result
 * set — a moved sub-task should be logged, not its parent story/epic too.
 * Exception: a parent carrying your own comments is re-admitted, since the
 * discovery JQL's `updated` clause now pulls in far more parent stories, and
 * a blanket drop would otherwise suppress a story you wrote notes on in
 * favour of a sub-task that only got a field edit.
 * Returns { kept, suppressed } where suppressed is a list of dropped keys
 * (for the preview's warnings).
 */
export function suppressParents(issues, commentsByKey = new Map()) {
  const parentKeys = new Set(issues.map((i) => i.fields.parent?.key).filter(Boolean));
  const isSuppressed = (i) => parentKeys.has(i.key) && !(commentsByKey.get(i.key)?.length);
  const kept = issues.filter((i) => !isSuppressed(i));
  const suppressed = issues.filter(isSuppressed).map((i) => i.key);
  return { kept, suppressed };
}

function mapStatusName(name, warnings) {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  const map = statusMap();
  if (key in map) return map[key];
  return undefined; // signal "unknown" to caller, which falls back to statusCategory
}

function statusFromCategory(issue) {
  const key = issue.fields.status?.statusCategory?.key;
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in-progress';
  if (key === 'new') return 'next-week';
  return 'in-progress';
}

function resolveStatusForTransition(toName, issue, warnings) {
  const mapped = mapStatusName(toName, warnings);
  if (mapped !== undefined) return mapped;
  const fallback = statusFromCategory(issue);
  warnings.push(`Unknown Jira status '${toName}' on ${issue.key} mapped to ${fallback} via status category`);
  return fallback;
}

function splitPrefixedLabel(label, prefixes) {
  const idx = label.indexOf(':');
  if (idx === -1) return null;
  const prefix = label.slice(0, idx).trim().toLowerCase();
  const value = label.slice(idx + 1).trim();
  return prefixes.includes(prefix) && value ? value : null;
}

function resolveDomainAndProject(labels, projectName, warnings, unmatchedLabels) {
  const domainPrefixes = parseListEnv('JIRA_DOMAIN_PREFIXES', DEFAULT_DOMAIN_PREFIXES);
  const projectPrefixes = parseListEnv('JIRA_PROJECT_PREFIXES', DEFAULT_PROJECT_PREFIXES);
  const domainLabels = parseListEnv('JIRA_DOMAIN_LABELS', DEFAULT_DOMAIN_LABELS);

  let domain = null;
  let project = null;
  // Labels that were actually consumed as a project/domain signal — excluded
  // from the unmatched-label warning below. Anything else with an unrecognised
  // `prefix:value` shape (e.g. a typo'd domain prefix) is left in, so it
  // surfaces as a warning instead of vanishing silently.
  const consumed = new Set();

  for (const label of labels) {
    if (!project) {
      const v = splitPrefixedLabel(label, projectPrefixes);
      if (v) { project = v; consumed.add(label); }
    }
    if (!domain) {
      const v = splitPrefixedLabel(label, domainPrefixes);
      // Normalise casing so a prefix-derived domain (`t:Backend`) collapses
      // into the same facet chip as a bare canonical label (`backend`).
      if (v) { domain = v.toLowerCase(); consumed.add(label); }
    }
  }

  if (!domain) {
    for (const wanted of domainLabels) {
      const hit = labels.find((l) => l.trim().toLowerCase() === wanted);
      if (hit) {
        domain = wanted;
        consumed.add(hit);
        break;
      }
    }
  }

  if (!domain) {
    for (const label of labels) {
      if (consumed.has(label)) continue;
      const key = label.trim().toLowerCase();
      if (!domainLabels.includes(key)) unmatchedLabels.add(label);
    }
  }

  if (!project) project = projectName ?? null;

  return { domain, project };
}

function resolveDomainProjectWithInheritance(issue, hierarchy, warnings, unmatchedLabels) {
  const ownLabels = issue.fields.labels ?? [];
  const projectName = issue.fields.project?.name ?? null;

  let { domain, project } = resolveDomainAndProject(ownLabels, projectName, warnings, unmatchedLabels);
  if (domain) return { domain, project };

  const resolved = hierarchy.get(issue.key);
  const parentLabels = resolved?.parentLabels ?? [];
  if (parentLabels.length) {
    const fromParent = resolveDomainAndProject(parentLabels, projectName, warnings, unmatchedLabels);
    if (fromParent.domain) domain = fromParent.domain;
  }

  return { domain, project };
}

function isAchievementCandidate(issue, mappedStatus) {
  if (mappedStatus !== 'done') return false;
  const achievementLabels = parseListEnv('JIRA_ACHIEVEMENT_LABELS', DEFAULT_ACHIEVEMENT_LABELS);
  const labels = (issue.fields.labels ?? []).map((l) => l.trim().toLowerCase());
  return achievementLabels.some((l) => labels.includes(l));
}

function isBlockerByLabel(issue, mappedStatus) {
  if (mappedStatus === 'done') return false;
  const blockerLabels = parseListEnv('JIRA_BLOCKER_LABELS', DEFAULT_BLOCKER_LABELS);
  const labels = (issue.fields.labels ?? []).map((l) => l.trim().toLowerCase());
  return blockerLabels.some((l) => labels.includes(l));
}

/**
 * Groups an issue's in-window status transitions, Flagged transitions and
 * your own comments into one record per calendar day:
 *   { date, statuses[], flagged[], comments[] }
 * A day with none of the three (e.g. an un-flag transition, whose `to` is
 * empty) never gets a record, preserving today's rule that an un-flag
 * contributes nothing.
 */
function collapseByDay(transitions, comments) {
  const byDay = new Map();
  const dayRec = (d) => {
    if (!byDay.has(d)) byDay.set(d, { date: d, statuses: [], flagged: [], comments: [] });
    return byDay.get(d);
  };

  for (const t of transitions) {
    if (t.kind === 'flagged' && t.to) dayRec(t.date).flagged.push(t);
    else if (t.kind === 'status') dayRec(t.date).statuses.push(t);
  }
  for (const c of comments) dayRec(c.date).comments.push(c);

  for (const d of byDay.values()) d.comments.sort((a, b) => (a.at < b.at ? -1 : 1));

  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const SNIPPET_MAX = 70;
const DESC_MAX = 140;
const COMMENT_DAY_CAP = 4000;
const COMMENT_SEP = '\n\n---\n\n';

/** First non-empty line of merged comment text, flattened and cut on a word boundary. */
function snippetOf(text) {
  if (!text) return '';
  const firstLine = text
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .find(Boolean) ?? '';
  const flat = firstLine.replace(/\s+/g, ' ');
  if (!flat) return '';
  if (flat.length <= SNIPPET_MAX) return flat;
  return flat.slice(0, SNIPPET_MAX).replace(/\s+\S*$/, '') + '…';
}

function capDescription(text) {
  if (text.length <= DESC_MAX) return text;
  return text.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * Merges a day's comments into `details`, chronological, separated so the
 * summarizer sees discrete notes rather than one run-on blob. Per-comment
 * and whole-day caps stop one pasted log from bloating the row and the
 * prompt. Returns null for a day with no comments — that null is meaningful
 * downstream (no first-hand note; the summarizer falls back to description).
 */
function mergeDetails(comments) {
  if (!comments.length) return null;
  const perCommentCap = Number(env.JIRA_COMMENT_MAX_CHARS) || 2000;
  let budget = COMMENT_DAY_CAP;
  const parts = [];

  for (const c of comments) {
    let text = c.text.length > perCommentCap ? c.text.slice(0, perCommentCap) + '…[truncated]' : c.text;
    if (text.length > budget) {
      if (budget <= 0) break;
      text = text.slice(0, budget) + '…[truncated]';
    }
    parts.push(text);
    budget -= text.length;
    if (budget <= 0) break;
  }

  return parts.length ? parts.join(COMMENT_SEP) : null;
}

/** Silent status-name lookup with no "unknown status" warning — used for
 *  carrying a status forward onto a comment-only day, which is an inference
 *  rather than something Jira told us directly. */
function statusForCarryForward(statusName, issue) {
  if (statusName) {
    const mapped = mapStatusName(statusName);
    if (mapped !== undefined) return mapped;
  }
  return statusFromCategory(issue);
}

/**
 * Merges one day's signals into an entry's core fields, per this precedence:
 *   flagged > transition+comments > transition only > comments only.
 * `priorStatusName` is the last known Jira status name as of the START of
 * this day (i.e. before any transition that happens today), used only when
 * the day has comments but no transition of its own.
 */
function mergeDay(issue, dayRec, priorStatusName, warnings) {
  const summary = issue.fields.summary ?? issue.key;
  const hasComments = dayRec.comments.length > 0;
  const details = mergeDetails(dayRec.comments);
  const snippet = hasComments ? snippetOf(dayRec.comments.map((c) => c.text).join(' ')) : '';

  if (dayRec.flagged.length) {
    const last = dayRec.flagged[dayRec.flagged.length - 1];
    return {
      status: 'blocker',
      description: capDescription(`${summary} — flagged: ${last.to}`),
      details,
      signal: hasComments ? 'comment' : 'flagged'
    };
  }

  if (dayRec.statuses.length) {
    const to = dayRec.statuses[dayRec.statuses.length - 1].to;
    const from = dayRec.statuses[0].from;
    let status = resolveStatusForTransition(to, issue, warnings);

    if (status === null) {
      // e.g. moved back to Backlog — not work, UNLESS you left a note that
      // day, which is real work regardless of where the card landed.
      if (!hasComments) return null;
      status = 'in-progress';
    } else if (isAchievementCandidate(issue, status)) {
      status = 'achievement';
    }

    const description = hasComments && snippet
      ? `${summary} — ${snippet} (→ ${to})`
      : from && from !== to
        ? `${summary} — ${from} → ${to}`
        : `${summary} — ${to}`;

    return { status, description: capDescription(description), details, signal: hasComments ? 'comment' : 'transition' };
  }

  if (hasComments) {
    let status = statusForCarryForward(priorStatusName, issue);
    if (status === null) status = 'in-progress'; // a comment is real work even if the last known status was Backlog-like
    if (isAchievementCandidate(issue, status)) status = 'achievement';
    const description = snippet ? `${summary} — ${snippet}` : `${summary} — worked on`;
    return { status, description: capDescription(description), details, signal: 'comment' };
  }

  return null; // unreachable — collapseByDay never creates an all-empty day record
}

function isFallbackEnabled() {
  const v = (env.JIRA_FALLBACK_ACTIVE ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

/** `mapped === 'in-progress'` via STATUS_MAP wins as a precise veto (e.g. an
 *  indeterminate-category "Waiting on Client" status is not your work);
 *  falling back to statusCategory keeps the check instance-agnostic. */
function isActiveForFallback(issue) {
  const mapped = mapStatusName(issue.fields.status?.name);
  if (mapped !== undefined) return mapped === 'in-progress';
  return issue.fields.status?.statusCategory?.key === 'indeterminate';
}

function fallbackDate(weekMonday) {
  const friday = addDays(weekMonday, 4);
  const today = new Date().toISOString().slice(0, 10);
  if (today < weekMonday) return weekMonday;
  if (today < friday) return today;
  return friday;
}

/**
 * The silent-ticket fallback: an issue the discovery JQL returned but which
 * produced no comment and no transition anywhere in the window still gets
 * ONE entry, so a multi-week ticket nobody touched that particular week
 * never silently vanishes from the report — but only when it's unambiguously
 * yours and currently active, to keep bot edits and other people's activity
 * out of the log.
 */
function buildContinuedEntry(issue, weekMonday, myAccountId, warnings) {
  if (!isFallbackEnabled()) return null;
  if (!myAccountId || issue.fields.assignee?.accountId !== myAccountId) return null;
  if (!isActiveForFallback(issue)) return null;

  const summary = issue.fields.summary ?? issue.key;
  const statusName = issue.fields.status?.name ?? 'In Progress';
  return {
    date: fallbackDate(weekMonday),
    status: 'in-progress',
    description: capDescription(`${summary} — continued (still ${statusName})`),
    details: null,
    signal: 'continued'
  };
}

/**
 * Maps issues + their changelog transitions + their authored comments into
 * worklog_entries rows. `transitionsByKey`, `commentsByKey` and `hierarchy`
 * come from src/lib/server/jira.js.
 */
export function mapIssuesToEntries({
  issues, transitionsByKey, commentsByKey, hierarchy, browseUrl, warnings, weekMonday, myAccountId,
  fullHistory = false
}) {
  const commentsByKeySafe = commentsByKey ?? new Map();
  const { kept, suppressed } = suppressParents(issues, commentsByKeySafe);
  suppressed.forEach((key) =>
    warnings.push(`${key} suppressed — a sub-task under it also had activity this week`)
  );

  const unmatchedLabels = new Set();
  const entries = [];
  let commentEntryCount = 0;
  let continuedCount = 0;

  for (const issue of kept) {
    const transitions = transitionsByKey.get(issue.key) ?? [];
    const comments = commentsByKeySafe.get(issue.key) ?? [];

    const resolved = hierarchy.get(issue.key) ?? { epic: null, parentIssueType: null, parentLabels: [], parentKey: null, parentSummary: null };
    const { domain, project } = resolveDomainProjectWithInheritance(issue, hierarchy, warnings, unmatchedLabels);
    const labels = (issue.fields.labels ?? []).join(',');

    const days = collapseByDay(transitions, comments);
    const dayResults = [];

    if (days.length) {
      let priorStatusName = null;
      for (const dayRec of days) {
        const priorForThisDay = priorStatusName;
        if (dayRec.statuses.length) {
          priorStatusName = dayRec.statuses[dayRec.statuses.length - 1].to;
        }
        const merged = mergeDay(issue, dayRec, priorForThisDay, warnings);
        if (merged) dayResults.push({ date: dayRec.date, ...merged });
      }
    } else if (!fullHistory) {
      // "Still active, no activity this window" only means something for a
      // single-week sync — meaningless (and noisy) across years of backfill.
      const fb = buildContinuedEntry(issue, weekMonday, myAccountId, warnings);
      if (fb) dayResults.push(fb);
    }

    for (const d of dayResults) {
      let status = d.status;
      if (status !== 'blocker' && isBlockerByLabel(issue, status)) status = 'blocker';

      if (d.signal === 'comment') commentEntryCount += 1;
      if (d.signal === 'continued') continuedCount += 1;

      entries.push({
        id: `jira:${issue.key}:${d.date}`,
        date: d.date,
        description: d.description,
        details: d.details ?? null,
        status,
        source: 'jira',
        jira_key: issue.key,
        jira_url: browseUrl(issue.key),
        issue_type: issue.fields.issuetype?.name ?? null,
        epic: resolved.epic,
        project,
        domain,
        labels,
        issue_summary: issue.fields.summary ?? null,
        parent_key: resolved.parentKey ?? null,
        parent_summary: resolved.parentSummary ?? null,
        parent_issue_type: resolved.parentIssueType ?? null,
        parent_url: resolved.parentKey ? browseUrl(resolved.parentKey) : null,
        signal: d.signal
      });
    }
  }

  if (unmatchedLabels.size) {
    warnings.push(
      `Labels not recognised as domain/project: ${[...unmatchedLabels].join(', ')} — configure JIRA_DOMAIN_LABELS or use a "domain:" prefix`
    );
  }

  entries.sort((a, b) => (a.date === b.date ? a.jira_key.localeCompare(b.jira_key) : a.date < b.date ? -1 : 1));

  return { entries, suppressedCount: suppressed.length, commentEntryCount, continuedCount };
}
