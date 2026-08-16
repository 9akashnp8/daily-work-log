import Anthropic from '@anthropic-ai/sdk';
import { json, error } from '@sveltejs/kit';
import { ANTHROPIC_API_KEY } from '$env/static/private';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  if (!ANTHROPIC_API_KEY) {
    throw error(500, 'ANTHROPIC_API_KEY is not set — add it to your .env file');
  }

  const { draft, weekLabel } = await request.json();
  if (!draft?.trim()) {
    throw error(400, 'No draft notes found for this week');
  }

  const prompt = `You are helping a software engineer prepare their weekly status update for their reporting officer.

Week: ${weekLabel}

Below are the engineer's own notes for the week, organized by epic and story/task, each followed by dated updates — their own Jira comments or status changes. These notes, including anything typed in by hand, are the primary source of truth for what was actually done. Prefer the dated notes over ticket titles, and never quote a note verbatim — translate it into business-level language. Do NOT cite Jira issue keys in your output even though they appear below.

--- Engineer's notes for the week ---
${draft}
--- end of notes ---

Write a professional weekly update covering these 5 sections:

**Updates in Detail**
[4–6 high-level bullets. Draw the substance from the notes, not from ticket titles. Group related work by epic, then by story where that adds clarity. Lead each bullet with the epic/theme name where it clarifies.]

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
