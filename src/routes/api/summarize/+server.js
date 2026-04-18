import Anthropic from '@anthropic-ai/sdk';
import { json, error } from '@sveltejs/kit';
import { ANTHROPIC_API_KEY } from '$env/static/private';

const fmt = (list) =>
  list.length ? list.map((e) => `  - ${e.description}`).join('\n') : '  (none)';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  if (!ANTHROPIC_API_KEY) {
    throw error(500, 'ANTHROPIC_API_KEY is not set — add it to your .env file');
  }

  const { entries, weekLabel } = await request.json();
  if (!entries?.length) {
    throw error(400, 'No entries found for this week');
  }

  const prompt = `You are helping a software engineer prepare their weekly status update for their reporting officer.

Week: ${weekLabel}

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

Write a professional weekly update covering these 5 sections:

**Updates in Detail**
[4–6 high-level bullets. Group related work by theme. Do NOT list tasks verbatim.]

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
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return json({ summary: msg.content[0].text });
}
