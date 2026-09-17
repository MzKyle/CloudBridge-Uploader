import { v4 as uuid } from 'uuid'
import type {
  CloudProvider,
  FileStatus,
  LegacyCloudMode,
  TaskDestination,
  TaskFileDestination,
  TaskStatus,
  UploadPathMode
} from '@shared/types'
import { deriveLogicalFileStatus } from '@shared/cloud-upload'
import { getDb } from './database'

export interface TaskDestinationCreateInput {
  provider: CloudProvider
  connectionId: string
  connectionName?: string | null
  prefix?: string
  uploadRelativePath?: string
  pathMode?: UploadPathMode
  objectKeyTemplate?: string | null
}

export interface FileDestinationUploadTarget extends TaskFileDestination {
  taskId: string
  relativePath: string
  fileSize: number
  mtimeMs: number
  retryCount: number
  nextRetryAt: string | null
  sourceStatus: 'present' | 'missing'
  stableCount: number
}

export interface FileDestinationSummary {
  total: number
  totalBytes: number
  uploaded: number
  uploadedBytes: number
  failed: number
  pending: number
  skipped: number
  retryWaiting: number
}

function rowToDestination(row: Record<string, unknown>): TaskDestination {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    provider: row.provider as CloudProvider,
    connectionId: (row.connection_id as string) || legacyConnectionId(row.provider as CloudProvider),
    connectionName: (row.connection_name as string) || null,
    status: row.status as TaskStatus,
    prefix: (row.prefix as string) || '',
    uploadRelativePath: (row.upload_relative_path as string | null | undefined) ?? '',
    pathMode: (row.path_mode as UploadPathMode) || 'target-root',
    objectKeyTemplate: (row.object_key_template as string | null | undefined) || null,
    totalFiles: row.total_files as number,
    uploadedFiles: row.uploaded_files as number,
    totalBytes: row.total_bytes as number,
    uploadedBytes: row.uploaded_bytes as number,
    errorMessage: (row.error_message as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string) || null
  }
}

function rowToFileDestination(row: Record<string, unknown>): TaskFileDestination {
  return {
    id: row.id as string,
    taskFileId: row.task_file_id as string,
    taskDestinationId: row.task_destination_id as string,
    provider: row.provider as CloudProvider,
    connectionId: (row.connection_id as string) || legacyConnectionId(row.provider as CloudProvider),
    status: row.status as FileStatus,
    objectKey: (row.object_key as string) || null,
    plannedObjectKey: (row.planned_object_key as string) || null,
    uploadId: (row.upload_id as string) || null,
    errorMessage: (row.error_message as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class TaskDestinationRepo {
  ensureForTask(
    taskId: string,
    destinations: TaskDestinationCreateInput[],
    initialStatus: TaskStatus = 'pending',
  ): TaskDestination[] {
    const db = getDb()
    const now = new Date().toISOString()
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO task_destinations (
        id, task_id, provider, connection_id, connection_name, status, prefix, upload_relative_path,
        path_mode, object_key_template,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const completedAt =
      initialStatus === 'completed' ||
      initialStatus === 'failed' ||
      initialStatus === 'skipped'
        ? now
        : null
    const transaction = db.transaction(() => {
      for (const destination of destinations) {
        stmt.run(
          uuid(),
          taskId,
          destination.provider,
          destination.connectionId,
          destination.connectionName || null,
          initialStatus,
          destination.prefix || '',
          destination.uploadRelativePath ?? '',
          destination.pathMode || 'target-root',
          destination.objectKeyTemplate ?? null,
          now,
          now,
          completedAt
        )
      }
    })
    transaction()
    return this.listByTask(taskId)
  }

  listByTask(taskId: string): TaskDestination[] {
    return (
      getDb()
        .prepare('SELECT * FROM task_destinations WHERE task_id = ? ORDER BY provider')
        .all(taskId) as Record<string, unknown>[]
    ).map(rowToDestination)
  }

  listByTaskIds(taskIds: string[]): Map<string, TaskDestination[]> {
    const result = new Map<string, TaskDestination[]>()
    const uniqueIds = Array.from(new Set(taskIds)).filter(Boolean)
    if (uniqueIds.length === 0) return result

    const chunkSize = 500
    for (let index = 0; index < uniqueIds.length; index += chunkSize) {
      const chunk = uniqueIds.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = getDb()
        .prepare(
          `SELECT *
           FROM task_destinations
           WHERE task_id IN (${placeholders})
           ORDER BY task_id, provider`
        )
        .all(...chunk) as Record<string, unknown>[]

      for (const row of rows) {
        const destination = rowToDestination(row)
        const destinations = result.get(destination.taskId) || []
        destinations.push(destination)
        result.set(destination.taskId, destinations)
      }
    }

    return result
  }

  get(taskId: string, provider: CloudProvider): TaskDestination | null {
    const row = getDb()
      .prepare('SELECT * FROM task_destinations WHERE task_id = ? AND provider = ?')
      .get(taskId, provider) as Record<string, unknown> | undefined
    return row ? rowToDestination(row) : null
  }

  updateStatus(
    taskId: string,
    provider: CloudProvider,
    status: TaskStatus,
    errorMessage?: string
  ): void {
    const now = new Date().toISOString()
    const completedAt =
      status === 'completed' ||
      status === 'failed' ||
      status === 'skipped'
        ? now
        : null
    getDb()
      .prepare(
        `UPDATE task_destinations
         SET status = ?, error_message = ?, updated_at = ?, completed_at = ?
         WHERE task_id = ? AND provider = ?`
      )
      .run(status, errorMessage || null, now, completedAt, taskId, provider)
  }

  updateUploadRelativePath(
    taskId: string,
    provider: CloudProvider,
    uploadRelativePath: string
  ): void {
    getDb()
      .prepare(
        `UPDATE task_destinations
         SET upload_relative_path = ?, updated_at = ?
         WHERE task_id = ? AND provider = ?`
      )
      .run(uploadRelativePath, new Date().toISOString(), taskId, provider)
  }

  updateIncompleteStatuses(
    taskId: string,
    status: TaskStatus,
    errorMessage?: string
  ): void {
    const now = new Date().toISOString()
    const completedAt =
      status === 'completed' ||
      status === 'failed' ||
      status === 'skipped'
        ? now
        : null
    getDb()
      .prepare(
        `UPDATE task_destinations
         SET status = ?, error_message = ?, updated_at = ?, completed_at = ?
         WHERE task_id = ? AND status NOT IN ('completed', 'synced', 'skipped')`
      )
      .run(status, errorMessage || null, now, completedAt, taskId)
  }

  setTotals(taskId: string, provider: CloudProvider, totalFiles: number, totalBytes: number): void {
    getDb()
      .prepare(
        `UPDATE task_destinations
         SET total_files = ?, total_bytes = ?, updated_at = ?
         WHERE task_id = ? AND provider = ?`
      )
      .run(totalFiles, totalBytes, new Date().toISOString(), taskId, provider)
  }

  updateProgress(
    taskId: string,
    provider: CloudProvider,
    uploadedFiles: number,
    uploadedBytes: number
  ): void {
    getDb()
      .prepare(
        `UPDATE task_destinations
         SET uploaded_files = ?, uploaded_bytes = ?, updated_at = ?
         WHERE task_id = ? AND provider = ?`
      )
      .run(uploadedFiles, uploadedBytes, new Date().toISOString(), taskId, provider)
  }

  ensureForTaskFiles(taskId: string): void {
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR IGNORE INTO task_file_destinations (
        id, task_file_id, task_destination_id, provider, connection_id, status, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), tf.id, td.id, td.provider, td.connection_id, 'pending', ?, ?
      FROM task_files tf
      INNER JOIN task_destinations td ON td.task_id = tf.task_id
      WHERE tf.task_id = ?`
    ).run(now, now, taskId)
  }

  replacePlannedObjectKeys(
    taskId: string,
    plannedKeysByRelativePath: Map<string, string>
  ): void {
    const db = getDb()
    const now = new Date().toISOString()
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS tmp_planned_object_keys (
        relative_path TEXT PRIMARY KEY,
        object_key TEXT NOT NULL
      )
    `)
    const insertPlannedKey = db.prepare(
      `INSERT OR REPLACE INTO tmp_planned_object_keys (relative_path, object_key)
       VALUES (?, ?)`
    )
    const clearStale = db.prepare(
      `UPDATE task_file_destinations
       SET planned_object_key = NULL, updated_at = ?
       WHERE id IN (
         SELECT tfd.id
         FROM task_file_destinations tfd
         INNER JOIN task_files tf ON tf.id = tfd.task_file_id
         LEFT JOIN tmp_planned_object_keys planned
           ON planned.relative_path = tf.relative_path
         WHERE tf.task_id = ?
           AND tfd.planned_object_key IS NOT NULL
           AND planned.relative_path IS NULL
       )`
    )
    const updateChanged = db.prepare(
      `UPDATE task_file_destinations
       SET planned_object_key = (
           SELECT planned.object_key
           FROM task_files tf
           INNER JOIN tmp_planned_object_keys planned
             ON planned.relative_path = tf.relative_path
           WHERE tf.id = task_file_destinations.task_file_id
         ),
         updated_at = ?
       WHERE task_file_id IN (
         SELECT tf.id
         FROM task_files tf
         INNER JOIN tmp_planned_object_keys planned
           ON planned.relative_path = tf.relative_path
         WHERE tf.task_id = ?
       )
       AND (
         planned_object_key IS NULL
         OR planned_object_key != (
           SELECT planned.object_key
           FROM task_files tf
           INNER JOIN tmp_planned_object_keys planned
             ON planned.relative_path = tf.relative_path
           WHERE tf.id = task_file_destinations.task_file_id
         )
       )`
    )
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM tmp_planned_object_keys').run()
      for (const [relativePath, objectKey] of plannedKeysByRelativePath) {
        insertPlannedKey.run(relativePath, objectKey)
      }
      clearStale.run(now, taskId)
      updateChanged.run(now, taskId)
      db.prepare('DELETE FROM tmp_planned_object_keys').run()
    })
    transaction()
  }

  listFileTargets(taskId: string, provider?: CloudProvider): FileDestinationUploadTarget[] {
    const providerCondition = provider ? 'AND tfd.provider = ?' : ''
    const params: unknown[] = [taskId]
    if (provider) params.push(provider)
    const rows = getDb()
      .prepare(
        `SELECT tfd.*, tf.task_id, tf.relative_path, tf.file_size,
          tf.mtime_ms, tf.retry_count, tf.next_retry_at,
          tf.source_status, tf.stable_count
         FROM task_file_destinations tfd
         INNER JOIN task_files tf ON tf.id = tfd.task_file_id
         WHERE tf.task_id = ? ${providerCondition}
         ORDER BY tf.created_at, tfd.provider`
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => ({
      ...rowToFileDestination(row),
      taskId: row.task_id as string,
      relativePath: row.relative_path as string,
      fileSize: row.file_size as number,
      mtimeMs: Number(row.mtime_ms || 0),
      retryCount: Number(row.retry_count || 0),
      nextRetryAt: (row.next_retry_at as string) || null,
      sourceStatus: (row.source_status as 'present' | 'missing') || 'present',
      stableCount: Number(row.stable_count || 0)
    }))
  }

  listReadyFileTargets(
    taskId: string,
    requiredStableChecks: number,
    now = new Date().toISOString()
  ): FileDestinationUploadTarget[] {
    const rows = getDb()
      .prepare(
        `SELECT tfd.*, tf.task_id, tf.relative_path, tf.file_size,
          tf.mtime_ms, tf.retry_count, tf.next_retry_at,
          tf.source_status, tf.stable_count
         FROM task_file_destinations tfd
         INNER JOIN task_files tf ON tf.id = tfd.task_file_id
         WHERE tf.task_id = ?
           AND tfd.status = 'pending'
           AND tf.source_status = 'present'
           AND tf.stable_count >= ?
           AND (tf.next_retry_at IS NULL OR tf.next_retry_at <= ?)
         ORDER BY tf.created_at, tfd.provider`
      )
      .all(taskId, requiredStableChecks, now) as Record<string, unknown>[]
    return rows.map((row) => ({
      ...rowToFileDestination(row),
      taskId: row.task_id as string,
      relativePath: row.relative_path as string,
      fileSize: row.file_size as number,
      mtimeMs: Number(row.mtime_ms || 0),
      retryCount: Number(row.retry_count || 0),
      nextRetryAt: (row.next_retry_at as string) || null,
      sourceStatus: (row.source_status as 'present' | 'missing') || 'present',
      stableCount: Number(row.stable_count || 0)
    }))
  }

  summarizeFileTargets(
    taskId: string,
    provider: CloudProvider,
    now = new Date().toISOString()
  ): FileDestinationSummary {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(tf.file_size), 0) AS total_bytes,
         SUM(CASE WHEN tfd.status = 'completed' THEN 1 ELSE 0 END) AS uploaded,
         COALESCE(SUM(CASE WHEN tfd.status = 'completed' THEN tf.file_size ELSE 0 END), 0) AS uploaded_bytes,
         SUM(CASE WHEN tfd.status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN tfd.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN tfd.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE
           WHEN tfd.status = 'pending'
            AND tf.next_retry_at IS NOT NULL
            AND tf.next_retry_at > ?
           THEN 1 ELSE 0 END) AS retry_waiting
       FROM task_file_destinations tfd
       INNER JOIN task_files tf ON tf.id = tfd.task_file_id
       WHERE tf.task_id = ? AND tfd.provider = ?`
    ).get(now, taskId, provider) as Record<string, number>
    return {
      total: row.total || 0,
      totalBytes: row.total_bytes || 0,
      uploaded: row.uploaded || 0,
      uploadedBytes: row.uploaded_bytes || 0,
      failed: row.failed || 0,
      pending: row.pending || 0,
      skipped: row.skipped || 0,
      retryWaiting: row.retry_waiting || 0
    }
  }

  listFailedFileTargetExamples(
    taskId: string,
    provider: CloudProvider,
    limit = 3
  ): Array<{ relativePath: string; errorMessage: string | null }> {
    const rows = getDb().prepare(
      `SELECT tf.relative_path, tfd.error_message
       FROM task_file_destinations tfd
       INNER JOIN task_files tf ON tf.id = tfd.task_file_id
       WHERE tf.task_id = ? AND tfd.provider = ? AND tfd.status = 'failed'
       ORDER BY tf.created_at
       LIMIT ?`
    ).all(taskId, provider, Math.max(1, limit)) as Array<{
      relative_path: string
      error_message: string | null
    }>
    return rows.map((row) => ({
      relativePath: row.relative_path,
      errorMessage: row.error_message || null
    }))
  }

  updateFileStatus(
    id: string,
    status: FileStatus,
    objectKey?: string,
    uploadId?: string,
    errorMessage?: string
  ): void {
    const now = new Date().toISOString()
    getDb()
      .prepare(
        `UPDATE task_file_destinations
         SET status = ?, object_key = COALESCE(?, object_key),
           upload_id = COALESCE(?, upload_id), error_message = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, objectKey || null, uploadId || null, errorMessage || null, now, id)
  }

  recalculateLogicalFile(taskFileId: string): FileStatus {
    const rows = getDb()
      .prepare('SELECT status FROM task_file_destinations WHERE task_file_id = ?')
      .all(taskFileId) as Array<{ status: FileStatus }>
    const statuses = rows.map((row) => row.status)
    const status = deriveLogicalFileStatus(statuses)
    getDb()
      .prepare('UPDATE task_files SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), taskFileId)
    return status
  }

  recalculateProgress(taskId: string, provider: CloudProvider): void {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(tf.file_size), 0) AS total_bytes,
         SUM(CASE WHEN tfd.status = 'completed' THEN 1 ELSE 0 END) AS uploaded_files,
         COALESCE(SUM(CASE WHEN tfd.status = 'completed' THEN tf.file_size ELSE 0 END), 0) AS uploaded_bytes
       FROM task_file_destinations tfd
       INNER JOIN task_files tf ON tf.id = tfd.task_file_id
       WHERE tf.task_id = ? AND tfd.provider = ?`
    ).get(taskId, provider) as Record<string, number>
    this.setTotals(
      taskId,
      provider,
      row.total_files || 0,
      row.total_bytes || 0
    )
    this.updateProgress(
      taskId,
      provider,
      row.uploaded_files || 0,
      row.uploaded_bytes || 0
    )
  }

  resetFailed(taskId: string, provider?: CloudProvider): void {
    const db = getDb()
    const now = new Date().toISOString()
    const providerCondition = provider ? 'AND provider = ?' : ''
    const destinationParams: unknown[] = [now, taskId]
    const fileParams: unknown[] = [now, taskId]
    if (provider) {
      destinationParams.push(provider)
      fileParams.push(provider)
    }

    db.prepare(
      `UPDATE task_destinations
       SET status = CASE
             WHEN status IN ('completed', 'synced') THEN status
             ELSE 'pending'
           END,
         error_message = NULL,
         completed_at = CASE
           WHEN status IN ('completed', 'synced') THEN completed_at
           ELSE NULL
         END,
         updated_at = ?
       WHERE task_id = ? ${providerCondition}`
    ).run(...destinationParams)

    db.prepare(
      `UPDATE task_file_destinations
       SET status = CASE WHEN status = 'completed' THEN status ELSE 'pending' END,
         error_message = NULL, updated_at = ?
       WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)
       ${providerCondition}`
    ).run(...fileParams)

    const fileRows = db
      .prepare('SELECT id FROM task_files WHERE task_id = ?')
      .all(taskId) as Array<{ id: string }>
    for (const row of fileRows) this.recalculateLogicalFile(row.id)
  }
}

let instance: TaskDestinationRepo | null = null
export function getTaskDestinationRepo(): TaskDestinationRepo {
  if (!instance) instance = new TaskDestinationRepo()
  return instance
}

function legacyConnectionId(provider: CloudProvider): string {
  return provider === 'aliyun' ? 'aliyun-prod' : 's3-compatible'
}

export function legacyModeFromProviders(providers: CloudProvider[]): LegacyCloudMode {
  const unique = new Set(providers)
  if (unique.has('aliyun') && unique.has('tencent')) return 'both'
  if (unique.has('tencent')) return 'tencent'
  return 'aliyun'
}
