import { json } from '@sveltejs/kit';
import sql from '$lib/db.js';

export async function GET({ url }) {
  const week = url.searchParams.get('week');
  if (!week) return json({ message: 'week param required' }, { status: 400 });

  const [row] = await sql`
    SELECT summary FROM worklog_reports WHERE week_monday = ${week}::date
  `;

  return json({ summary: row?.summary ?? null });
}

export async function POST({ request }) {
  const { week, summary } = await request.json();

  if (!week || !summary) {
    return json({ message: 'Missing required fields' }, { status: 400 });
  }

  await sql`
    INSERT INTO worklog_reports (week_monday, summary)
    VALUES (${week}::date, ${summary})
    ON CONFLICT (week_monday) DO UPDATE SET summary = ${summary}, generated_at = now()
  `;

  return json({ ok: true });
}
