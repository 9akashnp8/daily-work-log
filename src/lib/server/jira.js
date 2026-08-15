import { env } from '$env/dynamic/private';

export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function config() {
  const base = (env.JIRA_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
    throw new JiraError(500, 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set');
  }
  return {
    base,
    auth: 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')
  };
}

export function isJiraConfigured() {
  return Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jiraFetch(path, { method = 'GET', body, searchParams } = {}, attempt = 0) {
  const cfg = config();
  const url = new URL(cfg.base + path);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: cfg.auth,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new JiraError(502, `Could not reach Jira at ${cfg.base}: ${e.message}`);
  }

  if (res.status === 429) {
    if (attempt >= 4) throw new JiraError(503, 'Jira rate limit exceeded — try again later');
    const retryAfter = res.headers.get('Retry-After');
    const delay = retryAfter
      ? Math.min(Number(retryAfter) * 1000, 30000)
      : Math.min(2000 * 2 ** attempt, 30000) * (0.7 + Math.random() * 0.6);
    await sleep(delay);
    return jiraFetch(path, { method, body, searchParams }, attempt + 1);
  }

  if (res.status === 401) {
    throw new JiraError(502, 'Jira rejected the credentials — check JIRA_EMAIL / JIRA_API_TOKEN');
  }
  if (res.status === 403) {
    throw new JiraError(502, 'Jira denied access (403) — the token lacks permission for this project');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400) {
      try {
        const data = JSON.parse(text);
        const parts = [...(data.errorMessages ?? []), ...Object.values(data.errors ?? {})];
        throw new JiraError(502, `Jira rejected the request: ${parts.join('; ') || text.slice(0, 300)}`);
      } catch (parseErr) {
        if (parseErr instanceof JiraError) throw parseErr;
        throw new JiraError(502, `Jira rejected the request: ${text.slice(0, 300)}`);
      }
    }
    throw new JiraError(502, `Jira ${res.status}: ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `updated` is a scalar last-modified stamp, NOT a history search: an issue
 * touched again after the week ends drops out of a plain range query, even
 * though its status changed inside the window. So the changelog-based clause
 * is OR'd back in rather than replaced by the (much cheaper) updated range.
 * `DURING` is a predicate, not a standalone operator — it only refines the
 * history operators WAS / WAS IN / CHANGED, never a scalar field like
 * `updated` directly (that combination 400s).
 */
export function buildJql(weekMonday) {
  const start = weekMonday;
  const end = addDays(weekMonday, 7); // exclusive upper bound — must be the NEXT Monday
  const scope = env.JIRA_JQL_SCOPE || 'assignee = currentUser()';

  const clauses = [
    `(updated >= "${start}" AND updated < "${end}")`,
    `status CHANGED DURING ("${start}", "${end}")`
  ];

  const active = (env.JIRA_ACTIVE_STATUS_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (active.length) {
    // Catches an issue that sat in an active status all week with no
    // transition, no comment and no field edit — invisible to both clauses
    // above. Opt-in because a status name that doesn't exist on this
    // instance makes Jira 400 the whole query.
    clauses.push(`status WAS IN (${active.map((n) => `"${n}"`).join(', ')}) DURING ("${start}", "${end}")`);
  }

  return `(${scope}) AND (${clauses.join(' OR ')}) ORDER BY updated DESC`;
}

// `status` (nests statusCategory.key) and `assignee` (carries accountId) are
// both required by the silent-ticket fallback in jiraMapping.js — keep them
// even if they look unused from this file alone.
function searchFields() {
  const base = 'summary,issuetype,status,labels,parent,project,assignee,priority,resolutiondate';
  return env.JIRA_EPIC_LINK_FIELD_ID ? `${base},${env.JIRA_EPIC_LINK_FIELD_ID}` : base;
}

async function searchIssues(jql, fields, warnings = []) {
  let token;
  const out = [];
  const seen = new Set();
  let pages = 0;

  do {
    const data = await jiraFetch('/rest/api/3/search/jql', {
      searchParams: { jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) }
    });
    const issues = data.issues ?? [];
    out.push(...issues);

    const next = data.nextPageToken;
    if (!next || data.isLast || seen.has(next) || issues.length === 0) break;
    seen.add(next);
    token = next;
    pages += 1;
  } while (pages < 20);

  if (pages >= 20) {
    warnings.push('Jira search pagination hit the 20-page safety cap — results may be incomplete');
  }

  return out;
}

/** Fetch issues whose status changed inside the week window, per buildJql(). */
export async function searchWeekIssues(weekMonday, warnings = []) {
  const jql = buildJql(weekMonday);
  const issues = await searchIssues(jql, searchFields(), warnings);
  return { jql, issues };
}

/** Batch-resolve a set of issue keys (used to look up sub-task parents / epics). */
export async function searchByKeys(keys, warnings = []) {
  if (!keys.length) return [];
  const fields = 'summary,issuetype,parent,labels,project';
  const chunks = [];
  for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));

  const out = [];
  for (const chunk of chunks) {
    const jql = `key IN (${chunk.join(',')})`;
    out.push(...(await searchIssues(jql, fields, warnings)));
  }
  return out;
}

function isSubtaskIssue(issue) {
  return Boolean(issue.fields.issuetype?.subtask) || issue.fields.issuetype?.hierarchyLevel === -1;
}

/**
 * Resolves epic/parent context for a set of issues. `parent` on an issue is
 * only one level deep, so a sub-task's parent is its Story, not the Epic —
 * resolving a sub-task's epic requires one extra batched lookup of its
 * parent story. Returns a Map keyed by issue key:
 *   { epic, parentIssueType, parentLabels }
 */
export async function resolveHierarchy(issues, warnings = []) {
  const subtaskParentKeys = new Set();
  for (const issue of issues) {
    if (isSubtaskIssue(issue) && issue.fields.parent?.key) {
      subtaskParentKeys.add(issue.fields.parent.key);
    }
  }

  const parents = subtaskParentKeys.size ? await searchByKeys([...subtaskParentKeys], warnings) : [];
  const parentByKey = new Map(parents.map((p) => [p.key, p]));

  // Legacy company-managed fallback: resolve Epic Link custom field for
  // issues that still have no epic via `parent`.
  const epicLinkFieldId = env.JIRA_EPIC_LINK_FIELD_ID;
  const legacyEpicKeys = new Set();

  const hierarchy = new Map();
  for (const issue of issues) {
    const resolved = resolveOne(issue, parentByKey);
    if (!resolved.epic && epicLinkFieldId) {
      const epicKey = issue.fields[epicLinkFieldId];
      if (epicKey) legacyEpicKeys.add(epicKey);
      resolved.legacyEpicKey = epicKey ?? null;
    }
    hierarchy.set(issue.key, resolved);
  }

  if (legacyEpicKeys.size) {
    const epics = await searchByKeys([...legacyEpicKeys], warnings);
    const epicSummaryByKey = new Map(epics.map((e) => [e.key, e.fields.summary]));
    for (const [key, resolved] of hierarchy) {
      if (!resolved.epic && resolved.legacyEpicKey) {
        resolved.epic = epicSummaryByKey.get(resolved.legacyEpicKey) ?? null;
      }
    }
  }

  return hierarchy;
}

function resolveOne(issue, parentByKey) {
  const fields = issue.fields;
  const level = fields.issuetype?.hierarchyLevel;

  if (level === 1) {
    return { epic: fields.summary, parentIssueType: null, parentLabels: [] };
  }

  if (isSubtaskIssue(issue) && fields.parent?.key) {
    const parentLight = fields.parent;
    const parentFull = parentByKey.get(parentLight.key);
    const parentIssueType = parentFull?.fields?.issuetype?.name ?? parentLight.fields?.issuetype?.name ?? null;
    const parentLabels = parentFull?.fields?.labels ?? [];
    const grandparent = parentFull?.fields?.parent ?? null;
    const epic = grandparent?.fields?.summary ?? null;
    return { epic, parentIssueType, parentLabels };
  }

  // Story/Task level — an embedded `parent` (if present) is the epic itself.
  if (fields.parent?.fields?.summary && fields.parent?.fields?.issuetype?.hierarchyLevel !== -1) {
    return { epic: fields.parent.fields.summary, parentIssueType: null, parentLabels: [] };
  }

  return { epic: null, parentIssueType: null, parentLabels: [] };
}

async function fetchChangelogPage(issueKey, startAt) {
  return jiraFetch(`/rest/api/3/issue/${issueKey}/changelog`, {
    searchParams: { startAt, maxResults: 100 }
  });
}

/**
 * Returns status/flagged transitions for an issue whose calendar date (per
 * the Jira account's own timezone, i.e. `created.slice(0, 10)`) falls inside
 * [fromDate, toDate] inclusive. We deliberately compare calendar dates
 * rather than full timestamps: Jira's `created` carries the account's own
 * timezone offset, which we don't know in advance, so date-only comparison
 * sidesteps any offset mismatch while still filing work on the correct day.
 */
export async function fetchStatusTransitions(issueKey, fromDate, toDate) {
  const first = await fetchChangelogPage(issueKey, 0);
  let values = first.values ?? [];
  const total = first.total ?? values.length;

  if (total > 100) {
    // Walk backward from the tail until the oldest entry we hold is at or
    // before the window start, so no in-window transition is missed.
    let startAt = Math.max(0, total - 100);
    let page = await fetchChangelogPage(issueKey, startAt);
    values = page.values ?? [];
    let hops = 0;
    while (startAt > 0 && values.length && values[0].created.slice(0, 10) > fromDate && hops < 3) {
      startAt = Math.max(0, startAt - 100);
      page = await fetchChangelogPage(issueKey, startAt);
      values = [...(page.values ?? []), ...values];
      hops += 1;
    }
  }

  const inWindow = values.filter((h) => {
    const d = h.created.slice(0, 10);
    return d >= fromDate && d <= toDate;
  });

  const transitions = [];
  for (const history of inWindow) {
    for (const item of history.items ?? []) {
      if (item.field === 'status') {
        transitions.push({
          at: history.created,
          date: history.created.slice(0, 10),
          from: item.fromString,
          to: item.toString,
          kind: 'status'
        });
      } else if (item.field === 'Flagged') {
        transitions.push({
          at: history.created,
          date: history.created.slice(0, 10),
          from: item.fromString,
          to: item.toString,
          kind: 'flagged'
        });
      }
    }
  }

  return transitions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Fetch changelog transitions for many issues, BATCH_SIZE at a time. */
export async function fetchTransitionsForIssues(issueKeys, fromDate, toDate) {
  const byKey = new Map();
  for (let i = 0; i < issueKeys.length; i += BATCH_SIZE) {
    const batch = issueKeys.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((key) => fetchStatusTransitions(key, fromDate, toDate))
    );
    batch.forEach((key, idx) => byKey.set(key, results[idx]));
  }
  return byKey;
}

export function jiraBrowseUrl(issueKey) {
  const cfg = config();
  return `${cfg.base}/browse/${issueKey}`;
}

// Shared by fetchTransitionsForIssues and fetchCommentsForIssues.
const BATCH_SIZE = 8;

let myselfCache = null;

/**
 * There is no "commented by me" in standard Jira Cloud JQL — the `comment`
 * field only supports ~ / !~ text matching, never authorship — so author
 * filtering has to happen client-side against `accountId`. Cached for the
 * life of the serverless instance: single-user app, the id never changes.
 */
export async function getMyself() {
  if (myselfCache) return myselfCache;
  const me = await jiraFetch('/rest/api/3/myself');
  myselfCache = { accountId: me.accountId, displayName: me.displayName, timeZone: me.timeZone };
  return myselfCache;
}

/**
 * Jira resolves JQL date bounds and comment/changelog timestamps in the
 * *account's* timezone (confirmed by the account's own offset appearing on
 * `created`), not the server's. The browser, meanwhile, computes "this week"
 * in *its own* local time. If the two zones disagree, work near midnight can
 * land on the adjacent day — warn rather than silently drift.
 */
export function warnTimezone(me, warnings) {
  if (!me?.timeZone) return;
  try {
    const at = new Date();
    const offsetOf = (tz) =>
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const jiraOffset = offsetOf(me.timeZone);
    const serverOffset = offsetOf(serverTz);
    if (!jiraOffset || !serverOffset || jiraOffset === serverOffset) return;
    warnings.push(
      `Your Jira account timezone is ${me.timeZone} (${jiraOffset}) but this server runs in ` +
        `${serverTz} (${serverOffset}). Jira dates are resolved in your account timezone; work logged ` +
        `near midnight may land on the adjacent day.`
    );
  } catch {
    // Intl quirk on an unrecognised zone name — not worth failing the sync over.
  }
}

const ADF_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'panel',
  'tableRow', 'rule', 'expand', 'nestedExpand', 'taskItem', 'decisionItem'
]);

/**
 * Flattens a Jira v3 comment body (Atlassian Document Format JSON) to plain
 * text. Unknown node types fall through to `default`, which recurses into
 * `content` rather than dropping the node — worst case is run-together text,
 * never silent data loss. Link marks are ignored deliberately: the visible
 * label survives on the `text` node, the href does not — URLs are noise in
 * a status report and inflate the summarizer prompt.
 */
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node; // v2 body, or any plain-string field
  if (Array.isArray(node)) return node.map(adfToText).join('');

  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return node.attrs?.text ?? '@user';
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'status':
      return node.attrs?.text ?? '';
    case 'date': {
      const ts = node.attrs?.timestamp;
      return ts ? new Date(Number(ts)).toISOString().slice(0, 10) : '';
    }
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ?? node.attrs?.data?.url ?? '';
    case 'media':
    case 'mediaInline':
    case 'mediaGroup':
    case 'mediaSingle':
      return ''; // attachments carry no report value
    case 'rule':
      return '\n';
    case 'listItem':
      return '- ' + adfToText(node.content).trim() + '\n';
    case 'tableCell':
    case 'tableHeader':
      return adfToText(node.content).trim() + ' | ';
    case 'codeBlock': {
      const code = adfToText(node.content).trim();
      return '\n' + (code.length > 200 ? code.slice(0, 200) + ' …' : code) + '\n';
    }
    default: {
      const inner = adfToText(node.content);
      return node.type === 'doc' || ADF_BLOCK_TYPES.has(node.type) ? inner.trim() + '\n' : inner;
    }
  }
}

function tidy(text) {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Comments authored by `myAccountId` on `issueKey` with a calendar date
 * (per the account's own timezone — same `created.slice(0,10)` technique as
 * fetchStatusTransitions) inside [fromDate, toDate]. Paged newest-first via
 * orderBy=-created so we can stop as soon as a page is entirely older than
 * the window — almost always a single request. Keyed off `created`, not
 * `updated`: an edit made this week to a note written last week is not this
 * week's work.
 */
export async function fetchComments(issueKey, fromDate, toDate, myAccountId) {
  const out = [];
  let startAt = 0;

  for (let page = 0; page < 10; page += 1) {
    const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
      searchParams: { startAt, maxResults: 100, orderBy: '-created' }
    });
    const list = data.comments ?? [];
    if (!list.length) break;

    for (const c of list) {
      const date = (c.created ?? '').slice(0, 10);
      if (date < fromDate || date > toDate) continue;
      if (myAccountId && c.author?.accountId !== myAccountId) continue;
      let text = '';
      try {
        text = tidy(adfToText(c.body));
      } catch {
        text = ''; // one malformed comment body must not fail the whole sync
      }
      if (!text) continue;
      out.push({ id: c.id, at: c.created, date, text });
    }

    const oldestOnPage = (list[list.length - 1].created ?? '').slice(0, 10);
    if (oldestOnPage < fromDate) break; // newest-first: nothing further back can qualify
    startAt += list.length;
    if (startAt >= (data.total ?? 0)) break;
  }

  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Fetch in-window authored comments for many issues, BATCH_SIZE at a time. */
export async function fetchCommentsForIssues(issueKeys, fromDate, toDate, myAccountId) {
  const byKey = new Map();
  for (let i = 0; i < issueKeys.length; i += BATCH_SIZE) {
    const batch = issueKeys.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((key) => fetchComments(key, fromDate, toDate, myAccountId))
    );
    batch.forEach((key, idx) => byKey.set(key, results[idx]));
  }
  return byKey;
}
