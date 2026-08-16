import { json } from '@sveltejs/kit';
import sql from '$lib/db.js';

export async function GET({ url }) {
  const week = url.searchParams.get('week');
  if (!week) return json({ message: 'week param required' }, { status: 400 });

  const [row] = await sql`
    SELECT summary, draft FROM worklog_reports WHERE week_monday = ${week}::date
  `;

  return json({ summary: row?.summary ?? null, draft: row?.draft ?? null });
}

// `summary` (the LLM-generated report) and `draft` (the user-edited markdown
// it's built from) are set independently — a draft autosave must never wipe
// a previously-generated summary, and vice versa. Only `summary` bumps
// `generated_at`, so it keeps meaning "last time the report was (re)generated".
export async function POST({ request }) {
  const { week, summary, draft } = await request.json();

  if (!week || (summary === undefined && draft === undefined)) {
    return json({ message: 'Missing required fields' }, { status: 400 });
  }

  const summaryVal = summary ?? null;
  const draftVal = draft ?? null;

  await sql`
    INSERT INTO worklog_reports (week_monday, summary, draft)
    VALUES (${week}::date, ${summaryVal}, ${draftVal})
    ON CONFLICT (week_monday) DO UPDATE SET
      summary = COALESCE(${summaryVal}::text, worklog_reports.summary),
      draft = COALESCE(${draftVal}::text, worklog_reports.draft),
      generated_at = CASE WHEN ${summaryVal}::text IS NOT NULL THEN now() ELSE worklog_reports.generated_at END
  `;

  return json({ ok: true });
}
