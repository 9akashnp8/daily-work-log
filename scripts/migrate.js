import postgres from 'postgres';
import { readFileSync } from 'fs';
import "dotenv/config";

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

await sql`
  CREATE TABLE IF NOT EXISTS worklog_entries (
    id           TEXT        PRIMARY KEY,
    date         DATE        NOT NULL,
    description  TEXT        NOT NULL,
    category     TEXT,
    status       TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

await sql`
  CREATE INDEX IF NOT EXISTS idx_worklog_entries_date ON worklog_entries (date)
`;

await sql`
  CREATE TABLE IF NOT EXISTS worklog_reports (
    week_monday  DATE        PRIMARY KEY,
    summary      TEXT        NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

// ── Jira sync columns ──────────────────────────────────────────────
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'manual'`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS jira_key    TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS jira_url    TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS issue_type  TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS epic        TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS project     TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS domain      TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS labels      TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS details     TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS user_edited BOOLEAN NOT NULL DEFAULT false`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS synced_at   TIMESTAMPTZ`;

// `category` (the old manual task-type) is retired — kept for historical rows,
// never written by the app again.
await sql`ALTER TABLE worklog_entries ALTER COLUMN category DROP NOT NULL`;

// ── Jira hierarchy columns ─────────────────────────────────────────
// `issue_summary` is the issue's own stable title (unlike `description`,
// which is a day-specific synthesized string). The `parent_*` columns are
// populated only when the issue is a Subtask, and let the UI nest it under
// its Story even on a day the Story itself had no activity of its own.
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS issue_summary     TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS parent_key        TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS parent_summary    TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS parent_issue_type TEXT`;
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS parent_url        TEXT`;

// ── Entry provenance ───────────────────────────────────────────────
// How a row came to exist: 'comment' (you wrote a note), 'transition' (the
// card moved), 'flagged', or 'continued' (the silent-ticket fallback — the
// issue was open all week but you touched nothing). The summarizer needs
// this to tell real work from a placeholder. NULL means unknown, not
// 'continued': rows written before this column existed, and hand-edited
// rows (which the sync's user_edited guard never overwrites), both stay
// NULL and must be treated as genuine work.
await sql`ALTER TABLE worklog_entries ADD COLUMN IF NOT EXISTS signal TEXT`;

await sql`CREATE INDEX IF NOT EXISTS idx_worklog_entries_jira_key ON worklog_entries (jira_key)`;
await sql`CREATE INDEX IF NOT EXISTS idx_worklog_entries_source   ON worklog_entries (source, date)`;

// `draft` is the user-edited, story-organized markdown that Generate Summary
// is built from — separate from `summary`, the LLM-generated report. A week
// can now have a saved draft with no summary generated yet, so `summary`
// drops its NOT NULL.
await sql`ALTER TABLE worklog_reports ADD COLUMN IF NOT EXISTS draft TEXT`;
await sql`ALTER TABLE worklog_reports ALTER COLUMN summary DROP NOT NULL`;

// One Jira issue can only produce one row per day (belt-and-braces alongside
// the deterministic id `jira:{key}:{date}` used by the sync route).
await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_worklog_entries_jira_day
  ON worklog_entries (jira_key, date) WHERE source = 'jira'
`;

console.log('Tables created.');

if (process.argv[2]) {
  const entries = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  let count = 0;
  for (const e of entries) {
    await sql`
      INSERT INTO worklog_entries (id, date, description, status)
      VALUES (${e.id}, ${e.date}, ${e.description}, ${e.status})
      ON CONFLICT (id) DO NOTHING
    `;
    count++;
  }
  console.log(`Seeded ${count} entries.`);
}

if (process.argv[3]) {
  const reports = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  let count = 0;
  for (const [week, summary] of Object.entries(reports)) {
    await sql`
      INSERT INTO worklog_reports (week_monday, summary)
      VALUES (${week}::date, ${summary})
      ON CONFLICT (week_monday) DO UPDATE SET summary = ${summary}
    `;
    count++;
  }
  console.log(`Seeded ${count} reports.`);
}

await sql.end();
