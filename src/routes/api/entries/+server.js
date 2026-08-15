import { json } from '@sveltejs/kit';
import sql from '$lib/db.js';

export async function GET({ url }) {
  const week = url.searchParams.get('week');
  if (!week) return json({ message: 'week param required' }, { status: 400 });

  const monday = new Date(week + 'T00:00:00Z');
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const sundayStr = sunday.toISOString().slice(0, 10);

  const entries = await sql`
    SELECT id, date::text, description, details, category, status,
           source, jira_key, jira_url, issue_type, epic, project, domain, labels
    FROM worklog_entries
    WHERE date BETWEEN ${week}::date AND ${sundayStr}::date
    ORDER BY date, created_at
  `;

  return json({ entries });
}

export async function POST({ request }) {
  const { id, date, description, category, status, details } = await request.json();

  if (!id || !date || !description || !category || !status) {
    return json({ message: 'Missing required fields' }, { status: 400 });
  }

  const [entry] = await sql`
    INSERT INTO worklog_entries (id, date, description, details, category, status)
    VALUES (${id}, ${date}, ${description}, ${details ?? null}, ${category}, ${status})
    ON CONFLICT (id) DO NOTHING
    RETURNING id, date::text, description, details, category, status
  `;

  return json({ entry: entry ?? { id, date, description, details: details ?? null, category, status } }, { status: 201 });
}
