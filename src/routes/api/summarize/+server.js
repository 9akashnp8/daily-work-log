import Anthropic from '@anthropic-ai/sdk';
import { json, error } from '@sveltejs/kit';
import { ANTHROPIC_API_KEY } from '$env/static/private';
import sql from '$lib/db.js';
import { parseSections, prevWeekMonday } from '$lib/parseSections.js';

// Thinking is on by default on this model and is billed against `max_tokens`
// alongside the response text — 2048 (the old value, sized for a non-thinking
// model) truncates the report mid-section. This is headroom, not a longer
// report: length is governed by the bullet rules in the prompt.
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 8192;

// Enough to carry last week's commitments without letting an unusually long
// previous report crowd out this week's actual notes.
const MAX_CARRIED_COMMITMENTS = 10;

// The prompt asks for an explicit "nothing here" bullet rather than an empty
// section, so last week's report can legitimately contain lines like "No
// outstanding action items from this week's work." Those are placeholders,
// not commitments — carrying one forward would invite this week's report to
// claim follow-through on nothing. Anchored at the start so "Note that…" and
// "No-code onboarding…" are unaffected.
const PLACEHOLDER_COMMITMENT =
  /^(no|none)\b[^.]*\b(item|blocker|challenge|issue|achievement|plan|update|activit|follow[- ]?up)/i;

const isPlaceholder = (line) => PLACEHOLDER_COMMITMENT.test(line);

/**
 * Last week's forward-looking commitments, so this week's report can show
 * follow-through ("delivered the migration planned last week") — the single
 * clearest signal of reliable delivery, and previously thrown away even
 * though the print view already renders both weeks side by side.
 *
 * Deliberately narrow: only *Plan for Next Week* and *Action Items*, not the
 * whole report. Feeding back last week's Updates would invite the model to
 * restate old work as new.
 */
async function previousCommitments(week) {
  if (!week) return null;

  const [row] = await sql`
    SELECT summary FROM worklog_reports WHERE week_monday = ${prevWeekMonday(week)}::date
  `;
  if (!row?.summary) return null;

  const sections = parseSections(row.summary);
  const lines = [...(sections['Plan for Next Week'] ?? []), ...(sections['Action Items'] ?? [])];

  // The two sections routinely restate each other; dedupe so the model isn't
  // shown the same commitment twice and weight it accordingly.
  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (!key || seen.has(key) || isPlaceholder(key)) continue;
    seen.add(key);
    unique.push(line.trim());
    if (unique.length >= MAX_CARRIED_COMMITMENTS) break;
  }

  return unique.length ? unique.map((l) => `- ${l}`).join('\n') : null;
}

function buildPrompt({ draft, weekLabel, carried }) {
  const continuity = carried
    ? `
Last week's report committed to the following. Where this week's notes show one of these was delivered, say so plainly inside the relevant Updates in Detail bullet — as a clause, not as an extra bullet. Do not otherwise refer to last week, and do not mention items that did not move.

--- last week's plan and action items ---
${carried}
--- end of last week's commitments ---
`
    : '';

  return `You are helping a software engineer prepare their weekly status update for their reporting officer.

Week: ${weekLabel}

Below are the engineer's own notes for the week, organized by epic and story/task, each followed by dated updates — their own Jira comments or status changes. These notes, including anything typed in by hand, are the primary source of truth for what was actually done. Prefer the dated notes over ticket titles. Do NOT cite Jira issue keys in your output even though they appear below.

The notes open with a one-line summary of the week's volume, and each issue heading carries its type, status and domain. Use these to judge how much ground the report has to cover — a six-epic week needs its breadth represented, a one-epic week does not.

A dated line marked "(no activity logged this week — still open)" means the ticket stayed open but nothing was actually done on it. Do not present it as work: leave it out of Updates in Detail unless the week contains nothing else. It may still justify an Action Item.
${continuity}
--- Engineer's notes for the week ---
${draft}
--- end of notes ---

Write the update as exactly these five sections, using these headings verbatim and in this order. Under each heading write bullet points only — no preamble, no closing paragraph, no sub-headings.

**Updates in Detail**
[The complete record of the week's work. At least one bullet per epic, 5–8 bullets in total; if the week spans more epics than that, merge the smallest into a shared bullet rather than dropping them. Lead with the epic or theme name where it clarifies.]

**Challenges & Issues**
[2–4 bullets. Blockers and problems faced. These re-frame work that also appears in Updates in Detail — they do not replace it, so do not remove an item from Updates to put it here.]

**Achievements & Accomplishments**
[2–4 bullets. The notable wins only, not every completed item. Same rule: an achievement stays in Updates in Detail as well.]

**Action Items**
[2–4 bullets. Follow-ups arising from unresolved or in-progress work.]

**Plan for Next Week**
[2–4 bullets. Planned activities, based on next-week and in-progress entries.]

Rules:
- One line per bullet. Updates in Detail allows roughly 20 words; the other four sections are printed in a narrower column, so keep those to 14 words or fewer. Your reader skims this; brevity is the point and is not negotiable.
- Within that line, choose the concrete outcome over the vague one. Keep figures, measurable results, and the names of systems or deliverables the reader would recognise. "Cut report generation from 40 seconds to 3" beats "progressed reporting work" — same length, and only one of them shows the work.
- Translate away implementation detail, internal shorthand and technical jargon. This is not licence to add technical depth: it is about which facts fill the line, never about making the line longer.
- Where the notes support it, say what a piece of work enabled or unblocked — inside the same one-line budget.
- If a section has nothing genuine in it, write one bullet saying so (e.g. "No blockers this week"). Never invent challenges, achievements or plans to fill a section — a padded section makes the real ones harder to believe.
- The reader is a reporting officer, not a technical peer. Be concise and professional.`;
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  if (!ANTHROPIC_API_KEY) {
    throw error(500, 'ANTHROPIC_API_KEY is not set — add it to your .env file');
  }

  const { draft, weekLabel, week } = await request.json();
  if (!draft?.trim()) {
    throw error(400, 'No draft notes found for this week');
  }

  // Continuity is an enhancement, never a precondition — a missing or
  // unreadable previous report must not stop this week's summary.
  let carried = null;
  try {
    carried = await previousCommitments(week);
  } catch (e) {
    console.warn('Could not load previous week for continuity:', e.message);
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: buildPrompt({ draft, weekLabel, carried }) }],
  });

  if (msg.stop_reason === 'refusal') {
    throw error(502, 'The model declined to generate a summary from these notes.');
  }

  // With thinking on, content[0] is a thinking block — the text is not
  // necessarily the first block, so it has to be looked up by type.
  const summary = msg.content.find((b) => b.type === 'text')?.text?.trim();
  if (!summary) {
    throw error(502, `The model returned no summary text (stop_reason: ${msg.stop_reason}).`);
  }

  return json({ summary });
}
