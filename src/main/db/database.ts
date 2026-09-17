import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import log from 'electron-log'
import { deriveDateScopedUploadRelativePath } from '@shared/day-folder'

let db: Database.Database | null = null

const DATA_MIGRATION_DATE_PATHS = 'data-migration:date-upload-paths:v1'
const DATA_MIGRATION_DESTINATIONS = 'data-migration:task-destinations:v1'

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('数据库未初始化')
  }
  return db
}

export function setDbForTests(database: Database.Database | null): void {
  db = database
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'uploader.db')
  log.info('数据库路径:', dbPath)

  db = new Database(dbPath)
  db.pragma('busy_timeout = 30000')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  log.info('开始检查数据库结构')
  runMigrations(db)
  reconcileStartupState(db)
  log.info('数据库初始化完成')
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_folders (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL UNIQUE,
      folder_name TEXT NOT NULL,
      date_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'collecting',
      child_folders_json TEXT NOT NULL DEFAULT '[]',
      total_children INTEGER NOT NULL DEFAULT 0,
      completed_children INTEGER NOT NULL DEFAULT 0,
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      ignored INTEGER NOT NULL DEFAULT 0,
      profile_id TEXT,
      group_key TEXT,
      variables_json TEXT NOT NULL DEFAULT '{}',
      upload_group_status TEXT NOT NULL DEFAULT 'open',
      discovered_at TEXT,
      last_content_activity_at TEXT,
      sealed_at TEXT,
      cleanable_at TEXT,
      cleaned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      oss_prefix TEXT,
      upload_target_mode TEXT NOT NULL DEFAULT 'aliyun',
      day_folder_id TEXT,
      upload_relative_path TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      source_type TEXT NOT NULL DEFAULT 'local',
      source_machine_id TEXT,
      profile_id TEXT,
      profile_name TEXT,
      profile_snapshot_json TEXT,
      group_variables_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (day_folder_id) REFERENCES day_folders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_files (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      oss_key TEXT,
      upload_id TEXT,
      error_message TEXT,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      source_status TEXT NOT NULL DEFAULT 'present',
      stable_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_destinations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      prefix TEXT NOT NULL DEFAULT '',
      upload_relative_path TEXT NOT NULL DEFAULT '',
      path_mode TEXT NOT NULL DEFAULT 'target-root',
      object_key_template TEXT,
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(task_id, connection_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_file_destinations (
      id TEXT PRIMARY KEY,
      task_file_id TEXT NOT NULL,
      task_destination_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      object_key TEXT,
      planned_object_key TEXT,
      upload_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_file_id, connection_id),
      FOREIGN KEY (task_file_id) REFERENCES task_files(id) ON DELETE CASCADE,
      FOREIGN KEY (task_destination_id) REFERENCES task_destinations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_files_status ON task_files(status);
    CREATE INDEX IF NOT EXISTS idx_task_destinations_task_id ON task_destinations(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_destinations_connection_status ON task_destinations(connection_id, status);
    CREATE INDEX IF NOT EXISTS idx_task_destinations_provider_status ON task_destinations(provider, status);
    CREATE INDEX IF NOT EXISTS idx_task_file_destinations_task_file_id ON task_file_destinations(task_file_id);
    CREATE INDEX IF NOT EXISTS idx_task_file_destinations_destination_id ON task_file_destinations(task_destination_id);
    CREATE INDEX IF NOT EXISTS idx_day_folders_status ON day_folders(status);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  const taskColumns = db.pragma('table_info(tasks)') as Array<{ name: string }>
  if (!taskColumns.some((c) => c.name === 'day_folder_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN day_folder_id TEXT REFERENCES day_folders(id) ON DELETE SET NULL`)
    log.info('迁移: tasks 表添加 day_folder_id 列')
  }
  if (!taskColumns.some((c) => c.name === 'upload_relative_path')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN upload_relative_path TEXT NOT NULL DEFAULT ''`)
    log.info('迁移: tasks 表添加 upload_relative_path 列')
  }
  if (!taskColumns.some((c) => c.name === 'upload_target_mode')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN upload_target_mode TEXT NOT NULL DEFAULT 'aliyun'`)
    log.info('迁移: tasks 表添加 upload_target_mode 列')
  }
  if (!taskColumns.some((c) => c.name === 'profile_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN profile_id TEXT`)
    log.info('迁移: tasks 表添加 profile_id 列')
  }
  if (!taskColumns.some((c) => c.name === 'profile_name')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN profile_name TEXT`)
    log.info('迁移: tasks 表添加 profile_name 列')
  }
  if (!taskColumns.some((c) => c.name === 'profile_snapshot_json')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN profile_snapshot_json TEXT`)
    log.info('迁移: tasks 表添加 profile_snapshot_json 列')
  }
  if (!taskColumns.some((c) => c.name === 'group_variables_json')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN group_variables_json TEXT NOT NULL DEFAULT '{}'`)
    log.info('迁移: tasks 表添加 group_variables_json 列')
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_day_folder_id ON tasks(day_folder_id)`)

  const taskDestinationColumns = db.pragma('table_info(task_destinations)') as Array<{ name: string }>
  const addedDestinationUploadPath = !taskDestinationColumns.some(
    (c) => c.name === 'upload_relative_path'
  )
  if (addedDestinationUploadPath) {
    db.exec(`ALTER TABLE task_destinations ADD COLUMN upload_relative_path TEXT NOT NULL DEFAULT ''`)
    log.info('迁移: task_destinations 表添加 upload_relative_path 列')
  }
  if (!taskDestinationColumns.some((c) => c.name === 'path_mode')) {
    db.exec(`ALTER TABLE task_destinations ADD COLUMN path_mode TEXT NOT NULL DEFAULT 'target-root'`)
    log.info('迁移: task_destinations 表添加 path_mode 列')
  }
  if (!taskDestinationColumns.some((c) => c.name === 'object_key_template')) {
    db.exec(`ALTER TABLE task_destinations ADD COLUMN object_key_template TEXT`)
    log.info('迁移: task_destinations 表添加 object_key_template 列')
  }
  if (!taskDestinationColumns.some((c) => c.name === 'connection_id')) {
    db.exec(`ALTER TABLE task_destinations ADD COLUMN connection_id TEXT`)
    log.info('迁移: task_destinations 表添加 connection_id 列')
  }
  if (!taskDestinationColumns.some((c) => c.name === 'connection_name')) {
    db.exec(`ALTER TABLE task_destinations ADD COLUMN connection_name TEXT`)
    log.info('迁移: task_destinations 表添加 connection_name 列')
  }

  const taskFileDestinationColumns = db.pragma('table_info(task_file_destinations)') as Array<{ name: string }>
  if (!taskFileDestinationColumns.some((c) => c.name === 'planned_object_key')) {
    db.exec(`ALTER TABLE task_file_destinations ADD COLUMN planned_object_key TEXT`)
    log.info('迁移: task_file_destinations 表添加 planned_object_key 列')
  }
  if (!taskFileDestinationColumns.some((c) => c.name === 'connection_id')) {
    db.exec(`ALTER TABLE task_file_destinations ADD COLUMN connection_id TEXT`)
    log.info('迁移: task_file_destinations 表添加 connection_id 列')
  }
  db.exec(`
    UPDATE task_destinations
    SET connection_id = CASE
          WHEN connection_id IS NOT NULL AND connection_id != '' THEN connection_id
          WHEN provider = 'aliyun' THEN 'aliyun-prod'
          WHEN provider = 'tencent' THEN 's3-compatible'
          ELSE provider
        END,
        connection_name = CASE
          WHEN connection_name IS NOT NULL AND connection_name != '' THEN connection_name
          WHEN provider = 'aliyun' THEN '阿里云 OSS'
          WHEN provider = 'tencent' THEN 'S3 兼容存储'
          ELSE provider
        END
    WHERE connection_id IS NULL OR connection_id = ''
  `)
  db.exec(`
    UPDATE task_file_destinations
    SET connection_id = COALESCE((
      SELECT connection_id
      FROM task_destinations
      WHERE task_destinations.id = task_file_destinations.task_destination_id
    ), CASE
      WHEN provider = 'aliyun' THEN 'aliyun-prod'
      WHEN provider = 'tencent' THEN 's3-compatible'
      ELSE provider
    END)
    WHERE connection_id IS NULL OR connection_id = ''
  `)
  migrateDestinationIdentityConstraints(db)

  const dayFolderColumns = db.pragma('table_info(day_folders)') as Array<{ name: string }>
  if (!dayFolderColumns.some((c) => c.name === 'ignored')) {
    db.exec(`ALTER TABLE day_folders ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0`)
    log.info('迁移: day_folders 表添加 ignored 列')
  }
  const dayFolderAdditions = [
    ['profile_id', 'TEXT'],
    ['group_key', 'TEXT'],
    ['variables_json', `TEXT NOT NULL DEFAULT '{}'`],
    ['upload_group_status', `TEXT NOT NULL DEFAULT 'open'`],
    ['discovered_at', 'TEXT'],
    ['last_content_activity_at', 'TEXT'],
    ['sealed_at', 'TEXT'],
    ['cleanable_at', 'TEXT'],
    ['cleaned_at', 'TEXT']
  ] as const
  for (const [name, definition] of dayFolderAdditions) {
    if (!dayFolderColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE day_folders ADD COLUMN ${name} ${definition}`)
      log.info(`迁移: day_folders 表添加 ${name} 列`)
    }
  }
  db.exec(`
    UPDATE day_folders
    SET group_key = COALESCE(group_key, date_value),
        variables_json = CASE
          WHEN variables_json IS NULL OR variables_json = '{}' THEN
            '{"date":"' || replace(date_value, '"', '\\"') || '"}'
          ELSE variables_json
        END,
        upload_group_status = CASE
          WHEN status IN ('completed', 'completed_with_skips')
            AND (upload_group_status IS NULL OR upload_group_status = '' OR upload_group_status = 'open') THEN 'sealed'
          WHEN status = 'blocked'
            AND (upload_group_status IS NULL OR upload_group_status = '' OR upload_group_status = 'open') THEN 'error'
          WHEN status = 'processing'
            AND (upload_group_status IS NULL OR upload_group_status = '' OR upload_group_status = 'open') THEN 'closing'
          WHEN upload_group_status IS NULL OR upload_group_status = '' THEN 'open'
          ELSE upload_group_status
        END,
        discovered_at = COALESCE(discovered_at, created_at),
        last_content_activity_at = COALESCE(
          last_content_activity_at,
          discovered_at,
          updated_at,
          created_at
        ),
        sealed_at = CASE
          WHEN sealed_at IS NULL AND status IN ('completed', 'completed_with_skips') THEN completed_at
          ELSE sealed_at
        END
  `)
  db.exec(`
    UPDATE tasks
    SET group_variables_json = COALESCE((
      SELECT variables_json
      FROM day_folders
      WHERE day_folders.id = tasks.day_folder_id
    ), group_variables_json, '{}')
    WHERE day_folder_id IS NOT NULL
      AND (group_variables_json IS NULL OR group_variables_json = '{}')
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_day_folders_upload_group_status
    ON day_folders(upload_group_status)
  `)

  const taskFileColumns = db.pragma('table_info(task_files)') as Array<{ name: string }>
  const taskFileAdditions = [
    ['mtime_ms', `INTEGER NOT NULL DEFAULT 0`],
    ['last_seen_at', `TEXT`],
    ['source_status', `TEXT NOT NULL DEFAULT 'present'`],
    ['stable_count', `INTEGER NOT NULL DEFAULT 0`],
    ['retry_count', `INTEGER NOT NULL DEFAULT 0`],
    ['next_retry_at', `TEXT`]
  ] as const
  for (const [name, definition] of taskFileAdditions) {
    if (!taskFileColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE task_files ADD COLUMN ${name} ${definition}`)
      log.info(`迁移: task_files 表添加 ${name} 列`)
    }
  }
  ensureUniqueTaskFilePathIndex(db)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_files_retry
    ON task_files(status, next_retry_at)
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_files_task_status
    ON task_files(task_id, status, source_status)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_file_destinations_status_file
    ON task_file_destinations(status, task_file_id)
  `)

  if (!isDataMigrationDone(db, DATA_MIGRATION_DATE_PATHS)) {
    const incompleteTasks = db.prepare(
      `SELECT id, folder_path, source_type, source_machine_id, upload_relative_path
       FROM tasks
       WHERE status != 'completed'`
    ).all() as Array<{
      id: string
      folder_path: string
      source_type: string
      source_machine_id: string | null
      upload_relative_path: string
    }>
    const updateUploadRelativePath = db.prepare(
      `UPDATE tasks
       SET upload_relative_path = ?, updated_at = ?
       WHERE id = ?`
    )
    let migratedDatePaths = 0
    for (const task of incompleteTasks) {
      const uploadRelativePath = deriveDateScopedUploadRelativePath(task.folder_path)

      if (
        uploadRelativePath &&
        task.upload_relative_path !== uploadRelativePath
      ) {
        updateUploadRelativePath.run(
          uploadRelativePath,
          new Date().toISOString(),
          task.id
        )
        migratedDatePaths++
      }
    }
    if (migratedDatePaths > 0) {
      log.info(`日期层路径迁移完成: ${migratedDatePaths} 个未完成任务`)
    }
    markDataMigrationDone(db, DATA_MIGRATION_DATE_PATHS)
  }

  if (addedDestinationUploadPath) {
    db.exec(`
      UPDATE task_destinations
      SET upload_relative_path = COALESCE((
        SELECT upload_relative_path
        FROM tasks
        WHERE tasks.id = task_destinations.task_id
      ), '')
    `)
    log.info('迁移: 已回填任务目标上传相对路径')
  }

  if (!isDataMigrationDone(db, DATA_MIGRATION_DESTINATIONS)) {
    const migratedDestinations = db.prepare(
      `INSERT OR IGNORE INTO task_destinations (
        id, task_id, provider, connection_id, connection_name, status, prefix, total_files, uploaded_files,
        total_bytes, uploaded_bytes, error_message, created_at, updated_at,
        completed_at, upload_relative_path, path_mode, object_key_template
      )
      SELECT lower(hex(randomblob(16))), id, 'aliyun', 'aliyun-prod', '阿里云 OSS',
        status, COALESCE(oss_prefix, ''),
        total_files, uploaded_files, total_bytes, uploaded_bytes, error_message,
        created_at, updated_at, completed_at, COALESCE(upload_relative_path, ''),
        'target-root', NULL
      FROM tasks t
      WHERE NOT EXISTS (
        SELECT 1 FROM task_destinations existing WHERE existing.task_id = t.id
      )`
    ).run().changes

    const migratedFileDestinations = db.prepare(
      `INSERT OR IGNORE INTO task_file_destinations (
        id, task_file_id, task_destination_id, provider, connection_id, status, object_key,
        upload_id, error_message, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), tf.id, td.id, 'aliyun', td.connection_id, tf.status,
        tf.oss_key, tf.upload_id, tf.error_message, tf.created_at, tf.updated_at
      FROM tasks t
      INNER JOIN task_files tf ON tf.task_id = t.id
      INNER JOIN task_destinations td
        ON td.task_id = t.id AND td.connection_id = 'aliyun-prod'
      WHERE t.status != 'completed'
        AND NOT EXISTS (
        SELECT 1
        FROM task_file_destinations existing
        WHERE existing.task_file_id = tf.id
      )`
    ).run().changes
    if (migratedDestinations > 0 || migratedFileDestinations > 0) {
      log.info(
        `双云任务迁移完成: ${migratedDestinations} 个任务目标, ` +
        `${migratedFileDestinations} 个文件目标`
      )
    }
    markDataMigrationDone(db, DATA_MIGRATION_DESTINATIONS)
  }
}

function migrateDestinationIdentityConstraints(db: Database.Database): void {
  const destinationReady =
    hasUniqueIndex(db, 'task_destinations', ['task_id', 'connection_id']) &&
    isNotNullColumn(db, 'task_destinations', 'connection_id')
  const fileDestinationReady =
    hasUniqueIndex(db, 'task_file_destinations', ['task_file_id', 'connection_id']) &&
    isNotNullColumn(db, 'task_file_destinations', 'connection_id')
  if (destinationReady && fileDestinationReady) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_destinations_connection_status
      ON task_destinations(connection_id, status)
    `)
    return
  }

  log.info('迁移: 重建任务目标唯一约束为 connection_id')
  const previousForeignKeys = db.pragma('foreign_keys', { simple: true }) as number
  db.pragma('foreign_keys = OFF')
  try {
    const transaction = db.transaction(() => {
      db.exec(`
        CREATE TABLE task_destinations_next (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          connection_name TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          prefix TEXT NOT NULL DEFAULT '',
          upload_relative_path TEXT NOT NULL DEFAULT '',
          path_mode TEXT NOT NULL DEFAULT 'target-root',
          object_key_template TEXT,
          total_files INTEGER NOT NULL DEFAULT 0,
          uploaded_files INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          uploaded_bytes INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(task_id, connection_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        WITH normalized AS (
          SELECT
            rowid,
            id,
            task_id,
            COALESCE(NULLIF(provider, ''), 'tencent') AS provider,
            CASE
              WHEN connection_id IS NOT NULL AND connection_id != '' THEN connection_id
              WHEN provider = 'aliyun' THEN 'aliyun-prod'
              WHEN provider = 'tencent' THEN 's3-compatible'
              ELSE COALESCE(NULLIF(provider, ''), 's3-compatible')
            END AS resolved_connection_id,
            CASE
              WHEN connection_name IS NOT NULL AND connection_name != '' THEN connection_name
              WHEN provider = 'aliyun' THEN '阿里云 OSS'
              WHEN provider = 'tencent' THEN 'S3 兼容存储'
              ELSE connection_name
            END AS resolved_connection_name,
            status,
            prefix,
            upload_relative_path,
            path_mode,
            object_key_template,
            total_files,
            uploaded_files,
            total_bytes,
            uploaded_bytes,
            error_message,
            created_at,
            updated_at,
            completed_at
          FROM task_destinations
        )
        INSERT INTO task_destinations_next (
          id, task_id, provider, connection_id, connection_name, status, prefix,
          upload_relative_path, path_mode, object_key_template, total_files,
          uploaded_files, total_bytes, uploaded_bytes, error_message,
          created_at, updated_at, completed_at
        )
        SELECT
          id, task_id, provider, resolved_connection_id, resolved_connection_name,
          status, COALESCE(prefix, ''), COALESCE(upload_relative_path, ''),
          COALESCE(path_mode, 'target-root'), object_key_template,
          COALESCE(total_files, 0), COALESCE(uploaded_files, 0),
          COALESCE(total_bytes, 0), COALESCE(uploaded_bytes, 0),
          error_message, created_at, updated_at, completed_at
        FROM normalized
        WHERE rowid IN (
          SELECT MIN(rowid)
          FROM normalized
          GROUP BY task_id, resolved_connection_id
        );

        CREATE TABLE task_file_destinations_next (
          id TEXT PRIMARY KEY,
          task_file_id TEXT NOT NULL,
          task_destination_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          object_key TEXT,
          planned_object_key TEXT,
          upload_id TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(task_file_id, connection_id),
          FOREIGN KEY (task_file_id) REFERENCES task_files(id) ON DELETE CASCADE,
          FOREIGN KEY (task_destination_id) REFERENCES task_destinations_next(id) ON DELETE CASCADE
        );

        WITH normalized AS (
          SELECT
            tfd.rowid,
            tfd.id,
            tfd.task_file_id,
            tf.task_id,
            COALESCE(NULLIF(tfd.provider, ''), 'tencent') AS provider,
            CASE
              WHEN tfd.connection_id IS NOT NULL AND tfd.connection_id != '' THEN tfd.connection_id
              WHEN tfd.provider = 'aliyun' THEN 'aliyun-prod'
              WHEN tfd.provider = 'tencent' THEN 's3-compatible'
              ELSE COALESCE(NULLIF(tfd.provider, ''), 's3-compatible')
            END AS resolved_connection_id,
            tfd.status,
            tfd.object_key,
            tfd.planned_object_key,
            tfd.upload_id,
            tfd.error_message,
            tfd.created_at,
            tfd.updated_at
          FROM task_file_destinations tfd
          INNER JOIN task_files tf ON tf.id = tfd.task_file_id
        )
        INSERT INTO task_file_destinations_next (
          id, task_file_id, task_destination_id, provider, connection_id,
          status, object_key, planned_object_key, upload_id, error_message,
          created_at, updated_at
        )
        SELECT
          normalized.id,
          normalized.task_file_id,
          td.id,
          normalized.provider,
          normalized.resolved_connection_id,
          normalized.status,
          normalized.object_key,
          normalized.planned_object_key,
          normalized.upload_id,
          normalized.error_message,
          normalized.created_at,
          normalized.updated_at
        FROM normalized
        INNER JOIN task_destinations_next td
          ON td.task_id = normalized.task_id
         AND td.connection_id = normalized.resolved_connection_id
        WHERE normalized.rowid IN (
          SELECT MIN(rowid)
          FROM normalized
          GROUP BY task_file_id, resolved_connection_id
        );
      `)

      const destinationCount = db.prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT task_id,
             CASE
               WHEN connection_id IS NOT NULL AND connection_id != '' THEN connection_id
               WHEN provider = 'aliyun' THEN 'aliyun-prod'
               WHEN provider = 'tencent' THEN 's3-compatible'
               ELSE COALESCE(NULLIF(provider, ''), 's3-compatible')
             END AS connection_id
           FROM task_destinations
           GROUP BY task_id, connection_id
         )`
      ).get() as { count: number }
      const copiedDestinationCount = db.prepare(
        'SELECT COUNT(*) AS count FROM task_destinations_next'
      ).get() as { count: number }
      if (destinationCount.count !== copiedDestinationCount.count) {
        throw new Error('task_destinations connection_id migration count mismatch')
      }

      const fileDestinationCount = db.prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT task_file_id,
             CASE
               WHEN connection_id IS NOT NULL AND connection_id != '' THEN connection_id
               WHEN provider = 'aliyun' THEN 'aliyun-prod'
               WHEN provider = 'tencent' THEN 's3-compatible'
               ELSE COALESCE(NULLIF(provider, ''), 's3-compatible')
             END AS connection_id
           FROM task_file_destinations
           GROUP BY task_file_id, connection_id
         )`
      ).get() as { count: number }
      const copiedFileDestinationCount = db.prepare(
        'SELECT COUNT(*) AS count FROM task_file_destinations_next'
      ).get() as { count: number }
      if (fileDestinationCount.count !== copiedFileDestinationCount.count) {
        throw new Error('task_file_destinations connection_id migration count mismatch')
      }

      db.exec(`
        DROP TABLE task_file_destinations;
        DROP TABLE task_destinations;
        ALTER TABLE task_destinations_next RENAME TO task_destinations;
        ALTER TABLE task_file_destinations_next RENAME TO task_file_destinations;

        CREATE INDEX IF NOT EXISTS idx_task_destinations_task_id ON task_destinations(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_destinations_connection_status ON task_destinations(connection_id, status);
        CREATE INDEX IF NOT EXISTS idx_task_destinations_provider_status ON task_destinations(provider, status);
        CREATE INDEX IF NOT EXISTS idx_task_file_destinations_task_file_id ON task_file_destinations(task_file_id);
        CREATE INDEX IF NOT EXISTS idx_task_file_destinations_destination_id ON task_file_destinations(task_destination_id);
        CREATE INDEX IF NOT EXISTS idx_task_file_destinations_status_file
        ON task_file_destinations(status, task_file_id);
      `)
    })
    transaction()
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`)
  }
  log.info('迁移: 任务目标唯一约束已切换为 connection_id')
}

function hasUniqueIndex(
  db: Database.Database,
  table: string,
  columns: string[]
): boolean {
  const indexes = db.pragma(`index_list(${table})`) as Array<{
    name: string
    unique: number
  }>
  return indexes.some((index) => {
    if (!index.unique) return false
    const indexedColumns = (db.pragma(`index_info(${index.name})`) as Array<{
      name: string
    }>).map((column) => column.name)
    return (
      indexedColumns.length === columns.length &&
      indexedColumns.every((column, index) => column === columns[index])
    )
  })
}

function isNotNullColumn(
  db: Database.Database,
  table: string,
  columnName: string
): boolean {
  const columns = db.pragma(`table_info(${table})`) as Array<{
    name: string
    notnull: number
  }>
  return columns.some((column) => column.name === columnName && Boolean(column.notnull))
}

function isDataMigrationDone(db: Database.Database, key: string): boolean {
  const row = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value === 'done'
}

function markDataMigrationDone(db: Database.Database, key: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES (?, 'done', ?)
     ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = ?`
  ).run(key, now, now)
}

function ensureUniqueTaskFilePathIndex(db: Database.Database): void {
  const existing = db.prepare(
    `SELECT 1
     FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_task_files_task_path'`
  ).get()
  if (existing) return

  log.info('迁移: 开始创建任务文件路径索引')
  try {
    db.exec(`
      CREATE UNIQUE INDEX idx_task_files_task_path
      ON task_files(task_id, relative_path)
    `)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes('unique constraint failed')) {
      throw error
    }

    log.warn('迁移: 发现重复任务文件记录，开始清理')
    const transaction = db.transaction(() => {
      db.exec(`
        DELETE FROM task_files
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM task_files
          GROUP BY task_id, relative_path
        )
      `)
      db.exec(`
        CREATE UNIQUE INDEX idx_task_files_task_path
        ON task_files(task_id, relative_path)
      `)
    })
    transaction()
  }
  log.info('迁移: 任务文件路径索引创建完成')
}

export function reconcileStartupState(db: Database.Database): void {
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE task_files
     SET status = 'pending', updated_at = ?
     WHERE status = 'uploading'`
  ).run(now)
  db.prepare(
    `UPDATE task_file_destinations
     SET status = 'pending', updated_at = ?
     WHERE status = 'uploading'`
  ).run(now)

  const monitorableTasks = db.prepare(
    `SELECT id, folder_path
     FROM tasks
     WHERE source_type = 'local'
       AND status NOT IN ('completed', 'synced', 'skipped')`
  ).all() as Array<{
    id: string
    folder_path: string
  }>

  const resetTasks = db.prepare(
    `UPDATE tasks
     SET status = 'pending', error_message = NULL,
         completed_at = NULL, updated_at = ?
     WHERE status NOT IN ('completed', 'synced', 'skipped')`
  )
  const resetDestinations = db.prepare(
    `UPDATE task_destinations
     SET status = CASE
           WHEN status IN ('completed', 'synced') THEN status
           WHEN status IN ('uploading', 'scanning', 'retrying', 'failed', 'paused') THEN 'pending'
           ELSE 'pending'
         END,
         error_message = NULL,
         completed_at = CASE
           WHEN status IN ('completed', 'synced') THEN completed_at
           ELSE NULL
         END,
         updated_at = ?
     WHERE task_id IN (
       SELECT id FROM tasks WHERE status NOT IN ('completed', 'synced', 'skipped')
     )`
  )
  const resetAllActiveFiles = db.prepare(
    `UPDATE task_files
     SET status = 'pending',
         error_message = NULL, retry_count = 0, next_retry_at = NULL,
         updated_at = ?
     WHERE source_status = 'present'
       AND status IN ('uploading', 'failed')
       AND task_id IN (
         SELECT id FROM tasks WHERE status NOT IN ('completed', 'synced', 'skipped')
       )`
  )
  const resetAllActiveFileDestinations = db.prepare(
    `UPDATE task_file_destinations
     SET status = 'pending', error_message = NULL, updated_at = ?
     WHERE status IN ('uploading', 'failed')
       AND task_file_id IN (
         SELECT tf.id
         FROM task_files tf
         INNER JOIN tasks t ON t.id = tf.task_id
         WHERE tf.source_status = 'present'
           AND t.status NOT IN ('completed', 'synced', 'skipped')
       )`
  )
  const skipTask = db.prepare(
    `UPDATE tasks
     SET status = 'skipped', error_message = '源目录已删除',
         completed_at = ?, updated_at = ?
     WHERE id = ?`
  )
  const skipDestinations = db.prepare(
    `UPDATE task_destinations
     SET status = CASE
           WHEN status IN ('completed', 'synced') THEN status
           ELSE 'skipped'
         END,
         error_message = CASE
           WHEN status IN ('completed', 'synced') THEN error_message
           ELSE '源目录已删除'
         END,
         completed_at = COALESCE(completed_at, ?), updated_at = ?
     WHERE task_id = ?`
  )

  const transaction = db.transaction(() => {
    for (const task of monitorableTasks) {
      if (!existsSync(task.folder_path)) {
        skipTask.run(now, now, task.id)
        skipDestinations.run(now, now, task.id)
      }
    }

    resetTasks.run(now)
    resetDestinations.run(now)
    resetAllActiveFiles.run(now)
    resetAllActiveFileDestinations.run(now)
  })
  transaction()
}
