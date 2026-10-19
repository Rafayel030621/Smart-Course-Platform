import type Database from 'better-sqlite3'

/**
 * 数据库迁移
 * ----------------------------------------------------------------------------
 * 采用 SQLite + better-sqlite3：单文件、同步事务、唯一约束和 WAL。
 * 迁移按 version 递增，只追加不改写；每个迁移在一个事务内执行。
 *
 * 不把 SQL 放在 .sql 文件里：构建只产出 dist，避免运行时还要拷贝资源文件。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'v3_foundation',
    sql: `
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        account_normalized TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_algo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        role TEXT NOT NULL DEFAULT 'student',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id),
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        rotated_from_session_id TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(user_id),
        name TEXT NOT NULL,
        short TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        status TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        project_revision INTEGER NOT NULL DEFAULT 1,
        current_milestone_id TEXT,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT,
        purge_after TEXT,
        migrated_from_revision INTEGER,
        created_by_user_id TEXT NOT NULL
      );
      CREATE INDEX idx_projects_owner ON projects(owner_user_id, status);

      CREATE TABLE milestones (
        milestone_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        goal TEXT,
        done_criteria TEXT,
        due_at TEXT,
        status TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        source TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        archived_at TEXT,
        archived_from_status TEXT,
        created_by_user_id TEXT NOT NULL
      );
      CREATE INDEX idx_milestones_project ON milestones(project_id, archived_at, order_index);
      CREATE UNIQUE INDEX uq_milestones_active_name
        ON milestones(project_id, name_key) WHERE archived_at IS NULL;

      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        milestone_id TEXT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        done_criteria TEXT,
        status TEXT NOT NULL,
        assignee_user_id TEXT,
        order_index INTEGER NOT NULL,
        source TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        archived_at TEXT,
        created_by_user_id TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_project ON tasks(project_id, milestone_id, archived_at);
      CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);

      CREATE TABLE evidence (
        evidence_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        task_id TEXT,
        milestone_id TEXT,
        milestone_name_snapshot TEXT,
        user_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        did_what TEXT NOT NULL,
        found_what TEXT,
        still_unsure TEXT,
        attachment_name TEXT,
        status TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        redacted_at TEXT,
        UNIQUE(project_id, submission_id)
      );
      CREATE INDEX idx_evidence_project ON evidence(project_id, created_at);
      CREATE INDEX idx_evidence_task ON evidence(project_id, task_id);
      CREATE INDEX idx_evidence_milestone ON evidence(project_id, milestone_id);

      CREATE TABLE progress_records (
        progress_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        milestone_id TEXT,
        task_id TEXT,
        user_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        status TEXT NOT NULL,
        supersedes_progress_id TEXT,
        author_user_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX idx_progress_project ON progress_records(project_id, occurred_at);

      CREATE TABLE doubts (
        doubt_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        milestone_id TEXT,
        task_id TEXT,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        source_evidence_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_user_id TEXT
      );
      CREATE INDEX idx_doubts_project ON doubts(project_id, status);

      CREATE TABLE materials (
        material_id TEXT NOT NULL,
        material_version INTEGER NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        encoding TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        sha256 TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        PRIMARY KEY (material_id, material_version)
      );
      CREATE INDEX idx_materials_project ON materials(project_id, material_id, material_version);

      CREATE TABLE material_segments (
        material_id TEXT NOT NULL,
        material_version INTEGER NOT NULL,
        segment_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (material_id, material_version, segment_id)
      );

      CREATE TABLE understanding_items (
        item_id TEXT PRIMARY KEY,
        client_item_id TEXT,
        project_id TEXT NOT NULL,
        material_id TEXT NOT NULL,
        material_version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        original_text TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        confirmed_by_user_id TEXT,
        removed_at TEXT
      );
      CREATE INDEX idx_understanding_items_material
        ON understanding_items(material_id, material_version, status);

      CREATE TABLE chat_sessions (
        chat_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        milestone_id TEXT,
        user_id TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        chat_revision INTEGER NOT NULL DEFAULT 1,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE chat_messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_sessions(chat_id),
        project_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        fallback_reason TEXT,
        prompt_version TEXT,
        request_id TEXT,
        project_revision_at_send INTEGER NOT NULL,
        citations_json TEXT NOT NULL,
        client_message_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(chat_id, sequence)
      );
      CREATE UNIQUE INDEX uq_chat_client_message
        ON chat_messages(chat_id, client_message_id) WHERE client_message_id IS NOT NULL;

      CREATE TABLE milestone_candidates (
        candidate_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        goal TEXT,
        done_criteria TEXT,
        payload_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE idempotency_records (
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (user_id, idempotency_key)
      );
      CREATE INDEX idx_idempotency_expires ON idempotency_records(expires_at);

      CREATE TABLE local_migrations (
        user_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        client_project_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        id_map_json TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (user_id, migration_id),
        UNIQUE (user_id, client_project_id)
      );
    `,
  },
]

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>
  const applied = new Set(appliedRows.map((row) => row.version))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const run = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      )
    })
    run.immediate()
  }
}
