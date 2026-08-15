import postgres from 'postgres';
import { readFileSync } from 'fs';
import "dotenv/config";

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

await sql`
  CREATE TABLE IF NOT EXISTS worklog_entries (
    id           TEXT        PRIMARY KEY,
    date         DATE        NOT NULL,
    description  TEXT        NOT NULL,
    category     TEXT        NOT NULL,
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

await sql`CREATE INDEX IF NOT EXISTS idx_worklog_entries_jira_key ON worklog_entries (jira_key)`;
await sql`CREATE INDEX IF NOT EXISTS idx_worklog_entries_source   ON worklog_entries (source, date)`;

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
      INSERT INTO worklog_entries (id, date, description, category, status)
      VALUES (${e.id}, ${e.date}, ${e.description}, ${e.category}, ${e.status})
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
