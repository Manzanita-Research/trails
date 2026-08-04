export interface Migration {
  readonly version: number
  readonly sql: string
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('state_revision', '0');

      CREATE TABLE machines(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE sessions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL REFERENCES machines(id),
        source TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        cwd TEXT,
        project TEXT NOT NULL,
        branch TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        user_event_count INTEGER NOT NULL,
        first_prompt TEXT,
        digest TEXT,
        digest_hash TEXT,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(machine_id, source, source_session_id)
      );

      CREATE TABLE session_activity(
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        minute INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        user_event_count INTEGER NOT NULL,
        PRIMARY KEY(session_id, local_date, minute)
      );

      CREATE TABLE settings(
        id INTEGER PRIMARY KEY CHECK(id = 1),
        boundary INTEGER NOT NULL,
        halo INTEGER NOT NULL
      );
      INSERT INTO settings(id, boundary, halo) VALUES (1, 6, 10);

      CREATE TABLE custom_engagements(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE project_preferences(
        project TEXT PRIMARY KEY,
        engagement_id TEXT,
        display_name TEXT
      );

      CREATE TABLE pocket_items(
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE session_summaries(
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        digest_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        summary TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE day_summaries(
        work_date TEXT NOT NULL,
        project TEXT NOT NULL,
        boundary INTEGER NOT NULL,
        model TEXT NOT NULL,
        summary TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(work_date, project, boundary)
      );

      CREATE TABLE session_summary_jobs(
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        digest_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        last_error TEXT
      );

      CREATE TABLE day_summary_jobs(
        work_date TEXT NOT NULL,
        project TEXT NOT NULL,
        boundary INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        last_error TEXT,
        PRIMARY KEY(work_date, project, boundary)
      );

      CREATE INDEX sessions_started_at ON sessions(started_at, id);
      CREATE INDEX sessions_project ON sessions(project);
      CREATE INDEX session_activity_date ON session_activity(local_date, session_id);
      CREATE INDEX session_jobs_available ON session_summary_jobs(available_at);
      CREATE INDEX day_jobs_available ON day_summary_jobs(available_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE settings ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE settings ADD COLUMN hub_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:7412/';
    `,
  },
]
