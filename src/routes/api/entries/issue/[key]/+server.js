import { json } from '@sveltejs/kit';
import sql from '$lib/db.js';

// Full, unbounded history for one Jira issue — powers the expand-to-history
// interaction in the week view (a Story/Subtask's own row shows only its
// day's slice; expanding it fetches every day it's ever had activity).
export async function GET({ params }) {
  const entries = await sql`
    SELECT id, date::text, description, details, status,
           issue_type, epic, project, domain
    FROM worklog_entries
    WHERE jira_key = ${params.key}
    ORDER BY date
  `;

  return json({ entries });
}
