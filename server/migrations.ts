import type { Database } from "bun:sqlite"
import { localParts, type Source, type UtcActivityTuple } from "../shared/domain"
import type { IngestSessionV2 } from "../shared/protocol"
import { rebuildDaySummaryJobs } from "./day-jobs"
import { sessionContentHash } from "./ingest"

export interface MigrationContext {
  readonly defaultTimezone: string
  readonly now: number
}

export interface Migration {
  readonly version: number
  readonly sql: string
  readonly afterSql?: (sqlite: Database, context: MigrationContext) => void
}
const LEGACY_TIMEZONE = "America/Los_Angeles"

function naiveEpochMinute(localDate: string, minute: number): number {
  return Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 60_000) + minute
}

function legacyUtcMinute(
  localDate: string,
  minute: number,
  startedAt: string,
  endedAt: string,
): number {
  const naiveMinute = naiveEpochMinute(localDate, minute)
  const naiveMs = naiveMinute * 60_000
  const offsets = new Set<number>()
  for (const probeMs of [naiveMs - 36 * 60 * 60_000, naiveMs + 36 * 60 * 60_000]) {
    const probe = localParts(probeMs, LEGACY_TIMEZONE)
    offsets.add(naiveEpochMinute(probe.date, probe.minute) - Math.floor(probeMs / 60_000))
  }
  const candidates = [...offsets]
    .map((offset) => naiveMinute - offset)
    .filter((candidate) => {
      const local = localParts(candidate * 60_000, LEGACY_TIMEZONE)
      return local.date === localDate && local.minute === minute
    })
    .sort((left, right) => left - right)
  if (candidates.length === 0) {
    throw new Error(`legacy activity minute does not exist in ${LEGACY_TIMEZONE}`)
  }
  const firstMinute = Math.floor(Date.parse(startedAt) / 60_000)
  const lastMinute = Math.floor(Date.parse(endedAt) / 60_000)
  const inRange = candidates.filter((candidate) => candidate >= firstMinute && candidate <= lastMinute)
  return inRange.length === 1 ? inRange[0] : candidates[0]
}

function migrateUtcActivity(sqlite: Database, context: MigrationContext): void {
  const legacyRows = sqlite
    .query(
      `SELECT a.session_id, a.local_date, a.minute, a.event_count, a.user_event_count,
         s.started_at, s.ended_at
       FROM session_activity_legacy a JOIN sessions s ON s.id = a.session_id
       ORDER BY a.session_id, a.local_date, a.minute`,
    )
    .all() as Array<{
    session_id: number
    local_date: string
    minute: number
    event_count: number
    user_event_count: number
    started_at: string
    ended_at: string
  }>
  const insert = sqlite.query(
    `INSERT INTO session_activity(session_id, utc_minute, event_count, user_event_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, utc_minute) DO UPDATE SET
       event_count = session_activity.event_count + excluded.event_count,
       user_event_count = session_activity.user_event_count + excluded.user_event_count`,
  )
  for (const row of legacyRows) {
    insert.run(
      row.session_id,
      legacyUtcMinute(row.local_date, row.minute, row.started_at, row.ended_at),
      row.event_count,
      row.user_event_count,
    )
  }

  const sessions = sqlite
    .query(
      `SELECT id, source_session_id, source, cwd, branch, started_at, ended_at,
         event_count, user_event_count, first_prompt, digest
       FROM sessions ORDER BY id`,
    )
    .all() as Array<{
    id: number
    source_session_id: string
    source: Source
    cwd: string | null
    branch: string | null
    started_at: string
    ended_at: string
    event_count: number
    user_event_count: number
    first_prompt: string | null
    digest: string | null
  }>
  const activityQuery = sqlite.query(
    `SELECT utc_minute, event_count, user_event_count
     FROM session_activity WHERE session_id = ? ORDER BY utc_minute`,
  )
  const updateHash = sqlite.query("UPDATE sessions SET content_hash = ? WHERE id = ?")
  for (const row of sessions) {
    const activity = (activityQuery.all(row.id) as Array<{
      utc_minute: number
      event_count: number
      user_event_count: number
    }>).map(
      (bucket): UtcActivityTuple => [bucket.utc_minute, bucket.event_count, bucket.user_event_count],
    )
    const session: IngestSessionV2 = {
      sourceSessionId: row.source_session_id,
      source: row.source,
      cwd: row.cwd,
      branch: row.branch,
      start: row.started_at,
      end: row.ended_at,
      events: row.event_count,
      userEvents: row.user_event_count,
      firstPrompt: row.first_prompt,
      activity,
      digest: row.digest,
    }
    updateHash.run(sessionContentHash(session), row.id)
  }

  sqlite.query("UPDATE settings SET timezone = ? WHERE id = 1").run(context.defaultTimezone)
  sqlite.query("DROP TABLE session_activity_legacy").run()
  if (context.defaultTimezone !== LEGACY_TIMEZONE) {
    const settings = sqlite.query("SELECT boundary FROM settings WHERE id = 1").get() as { boundary: number }
    rebuildDaySummaryJobs(sqlite, {
      boundary: settings.boundary,
      timezone: context.defaultTimezone,
      now: context.now,
      clearSummaries: true,
    })
  }
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
  {
    version: 4,
    sql: `
      DROP INDEX session_activity_date;
      ALTER TABLE session_activity RENAME TO session_activity_legacy;
      CREATE TABLE session_activity(
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        utc_minute INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        user_event_count INTEGER NOT NULL,
        PRIMARY KEY(session_id, utc_minute)
      );
      CREATE INDEX session_activity_utc ON session_activity(utc_minute, session_id);
      ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
    `,
    afterSql: migrateUtcActivity,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE machines ADD COLUMN last_ingested_at INTEGER;
      ALTER TABLE machines ADD COLUMN last_checked_at INTEGER;
      ALTER TABLE machines ADD COLUMN last_processed_at INTEGER;
      ALTER TABLE machines ADD COLUMN last_error TEXT;
      ALTER TABLE machines ADD COLUMN last_discovered INTEGER;
      ALTER TABLE machines ADD COLUMN last_changed INTEGER;
      ALTER TABLE machines ADD COLUMN last_uploaded INTEGER;
      ALTER TABLE machines ADD COLUMN last_ignored INTEGER;
      ALTER TABLE machines ADD COLUMN last_unchanged INTEGER;
      UPDATE machines SET last_ingested_at = last_seen_at;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE captures(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL REFERENCES machines(id),
        source TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        project TEXT,
        project_hint TEXT,
        title TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary_input TEXT NOT NULL,
        provider_payload TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source, source_record_id)
      );

      CREATE TABLE capture_attention(
        capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        utc_minute INTEGER NOT NULL,
        PRIMARY KEY(capture_id, utc_minute)
      );

      CREATE TABLE capture_images(
        capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        image_index INTEGER NOT NULL,
        mime TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY(capture_id, image_index)
      );

      CREATE INDEX captures_started_at ON captures(started_at, id);
      CREATE INDEX captures_project ON captures(project);
      CREATE INDEX capture_attention_utc ON capture_attention(utc_minute, capture_id);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE hub_credentials(
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'read', 'collector')),
        device_id TEXT,
        CHECK((role = 'collector' AND device_id IS NOT NULL) OR (role != 'collector' AND device_id IS NULL))
      );
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE captures_v8(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL REFERENCES machines(id),
        account_id TEXT NOT NULL DEFAULT '',
        owner_machine_id TEXT NOT NULL REFERENCES machines(id),
        source TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        project TEXT,
        project_hint TEXT,
        title TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary_input TEXT NOT NULL,
        provider_payload TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_id, source, source_record_id)
      );

      INSERT INTO captures_v8
        SELECT id, machine_id, '', machine_id, source, source_record_id, project, project_hint,
          title, started_at, ended_at, summary_input, provider_payload, content_hash, updated_at FROM captures;
      CREATE TEMP TABLE saved_capture_attention AS SELECT * FROM capture_attention;
      CREATE TEMP TABLE saved_capture_images AS SELECT * FROM capture_images;
      DROP TABLE capture_attention;
      DROP TABLE capture_images;
      DROP TABLE captures;
      ALTER TABLE captures_v8 RENAME TO captures;

      CREATE TABLE capture_attention(
        capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        utc_minute INTEGER NOT NULL,
        PRIMARY KEY(capture_id, utc_minute)
      );

      CREATE TABLE capture_images(
        capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        image_index INTEGER NOT NULL,
        mime TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY(capture_id, image_index)
      );

      CREATE INDEX captures_started_at ON captures(started_at, id);
      CREATE INDEX captures_project ON captures(project);
      CREATE INDEX capture_attention_utc ON capture_attention(utc_minute, capture_id);
      INSERT INTO capture_attention SELECT * FROM saved_capture_attention;
      INSERT INTO capture_images SELECT * FROM saved_capture_images;
      DROP TABLE saved_capture_attention;
      DROP TABLE saved_capture_images;

      -- An absent binding keeps legacy device ownership. Empty account IDs are reserved.
      CREATE TABLE capture_device_accounts(
        source TEXT NOT NULL CHECK(source IN ('granola', 'midjourney')),
        device_id TEXT NOT NULL,
        account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
        PRIMARY KEY(source, device_id)
      );
    `,
  },
]
