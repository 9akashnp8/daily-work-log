import { json } from '@sveltejs/kit';
import sql from '$lib/db.js';

export async function PUT({ params, request }) {
  const body = await request.json();
  const { description, status } = body;

  if (!description || !status) {
    return json({ message: 'Missing required fields' }, { status: 400 });
  }

  // Only touch `details` when the caller actually sent it — the existing
  // inline edit sends just {description, status}, and must not
  // blank out a synced entry's comment-derived details.
  const hasDetails = Object.prototype.hasOwnProperty.call(body, 'details');

  const [entry] = hasDetails
    ? await sql`
        UPDATE worklog_entries
        SET description = ${description}, status = ${status},
            details = ${body.details ?? null}, user_edited = true
        WHERE id = ${params.id}
        RETURNING id, date::text, description, details, status,
                  source, jira_key, jira_url, issue_type, epic, project, domain, labels,
                  issue_summary, parent_key, parent_summary, parent_issue_type, parent_url
      `
    : await sql`
        UPDATE worklog_entries
        SET description = ${description}, status = ${status}, user_edited = true
        WHERE id = ${params.id}
        RETURNING id, date::text, description, details, status,
                  source, jira_key, jira_url, issue_type, epic, project, domain, labels,
                  issue_summary, parent_key, parent_summary, parent_issue_type, parent_url
      `;

  if (!entry) return json({ message: 'Not found' }, { status: 404 });

  return json({ entry });
}

export async function DELETE({ params }) {
  await sql`DELETE FROM worklog_entries WHERE id = ${params.id}`;
  return new Response(null, { status: 204 });
}
