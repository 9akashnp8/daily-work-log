import postgres from 'postgres';
import { readFileSync } from 'fs';

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
