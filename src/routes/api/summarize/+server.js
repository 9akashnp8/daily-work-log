import Anthropic from '@anthropic-ai/sdk';
import { json, error } from '@sveltejs/kit';
import { ANTHROPIC_API_KEY } from '$env/static/private';

const ctx = (e) => {
  const bits = [];
  if (e.epic) bits.push(`epic: ${e.epic}`);
  else if (e.project) bits.push(`project: ${e.project}`);
  if (e.domain) bits.push(e.domain);
  return bits.length ? ` [${bits.join(', ')}]` : '';
};

const PER_ENTRY_DETAILS_CAP = 600;
const TOTAL_DETAILS_BUDGET = 12000;

/**
 * A `details`-aware formatter with a budget shared across all five status
 * sections (COMPLETED → IN PROGRESS → BLOCKERS → ACHIEVEMENTS → PLANNED),
 * in that call order. If a chatty week exhausts the budget, later — lower
 * priority — sections degrade to bare description lines first, which is
 * already the right ordering. Must be instantiated once per request, not
 * shared across requests.
 */
function makeFmt() {
  let budget = TOTAL_DETAILS_BUDGET;
  return (list) => {
    if (!list.length) return '  (none)';
    return list
      .map((e) => {
        const head = `  - ${e.description}${ctx(e)}`;
        const details = (e.details ?? '').trim();
        if (!details || budget <= 0) return head;

        let take = details.length > PER_ENTRY_DETAILS_CAP
          ? details.slice(0, PER_ENTRY_DETAILS_CAP).replace(/\s+\S*$/, '') + '…'
          : details;
        if (take.length > budget) take = take.slice(0, budget) + '…';
        budget -= take.length;

        const indented = take.split('\n').map((l) => `      ${l}`).join('\n');
        return `${head}\n${indented}`;
      })
      .join('\n');
  };
}

function themeBlock(entries) {
  const hasThemes = entries.some((e) => e.epic || e.domain);
  if (!hasThemes) return '';

  const byTheme = new Map();
  for (const e of entries) {
    const theme = e.epic || e.project || 'Uncategorised';
    if (!byTheme.has(theme)) byTheme.set(theme, []);
    byTheme.get(theme).push(e);
  }

  const lines = [...byTheme.entries()].map(([theme, items]) => {
    const domains = [...new Set(items.map((i) => i.domain).filter(Boolean))];
    const domainStr = domains.length ? domains.join('/') : 'n/a';
    return `  ${theme} (${items.length} items, ${domainStr})`;
  });

  return `\nWORK THEMES THIS WEEK (by epic, falling back to project):\n${lines.join('\n')}\n`;
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  if (!ANTHROPIC_API_KEY) {
    throw error(500, 'ANTHROPIC_API_KEY is not set — add it to your .env file');
  }

  const { entries, weekLabel } = await request.json();
  if (!entries?.length) {
    throw error(400, 'No entries found for this week');
  }

  const fmt = makeFmt();

  const prompt = `You are helping a software engineer prepare their weekly status update for their reporting officer.

Week: ${weekLabel}

Lines indented under a bullet are the engineer's own Jira comments written on that day. They are the primary source of truth for what was actually done; the bullet line itself is only the ticket title plus its status change. Prefer the notes over the titles, and never quote a note verbatim — translate it into business-level language.

Work entries by status:

COMPLETED:
${fmt(entries.filter((e) => e.status === 'done'))}

IN PROGRESS:
${fmt(entries.filter((e) => e.status === 'in-progress'))}

BLOCKERS:
${fmt(entries.filter((e) => e.status === 'blocker'))}

ACHIEVEMENTS:
${fmt(entries.filter((e) => e.status === 'achievement'))}

PLANNED FOR NEXT WEEK:
${fmt(entries.filter((e) => e.status === 'next-week'))}
${themeBlock(entries)}
Write a professional weekly update covering these 5 sections:

**Updates in Detail**
[4–6 high-level bullets. Draw the substance from the indented notes, not from the ticket titles. Group related work by the themes listed above (epic, then project). Lead each bullet with the theme name where it clarifies. Do NOT list tasks verbatim and do NOT cite Jira issue keys.]

**Challenges & Issues**
[2–4 bullets summarising blockers faced]

**Achievements & Accomplishments**
[2–4 bullets of notable wins]

**Action Items**
[Follow-ups from unresolved/in-progress work]

**Plan for Next Week**
[Planned activities based on next-week and in-progress entries]

Be concise and professional. The reader is a reporting officer, not a technical peer.`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return json({ summary: msg.content[0].text });
}
