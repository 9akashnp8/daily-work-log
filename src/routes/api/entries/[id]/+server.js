import { json } from '@sveltejs/kit';
import sql from '$lib/db.js';

export async function PUT({ params, request }) {
  const { description, category, status } = await request.json();

  if (!description || !category || !status) {
    return json({ message: 'Missing required fields' }, { status: 400 });
  }

  const [entry] = await sql`
    UPDATE worklog_entries
    SET description = ${description}, category = ${category}, status = ${status}
    WHERE id = ${params.id}
    RETURNING id, date::text, description, category, status
  `;

  if (!entry) return json({ message: 'Not found' }, { status: 404 });

  return json({ entry });
}

export async function DELETE({ params }) {
  await sql`DELETE FROM worklog_entries WHERE id = ${params.id}`;
  return new Response(null, { status: 204 });
}
