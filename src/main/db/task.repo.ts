import { getDb } from './database'
import { v4 as uuid } from 'uuid'
import { normalize } from 'path'
import type {
  CloudProvider,
  TaskListQuery,
  Task,
  TaskDestination,
  TaskFile,
  TaskFileDetail,
  TaskStatus,
  SourceType,
  UploadPathMode,
  UploadProfile,
  UploadTargetMode,
  PathVariables
} from '@shared/types'
import { getTaskDestinationRepo } from './task-destination.repo'
import { providersForMode } from '@shared/cloud-upload'

function normalizeFolderPath(p: string): string {
  return normalize(p).replace(/[\\/]+$/, '')
}

function rowToTask(
  row: Record<string, unknown>,
  destinations?: TaskDestination[]
): Task {
  const profileSnapshot =
    typeof row.profile_snapshot_json === 'string' && row.profile_snapshot_json
      ? safeParseProfile(row.profile_snapshot_json)
      : null
  return {
    id: row.id as string,
    folderPath: row.folder_path as string,
    folderName: row.folder_name as string,
    status: row.status as TaskStatus,
    totalFiles: row.total_files as number,
    uploadedFiles: row.uploaded_files as number,
    totalBytes: row.total_bytes as number,
    uploadedBytes: row.uploaded_bytes as number,
    ossPrefix: (row.oss_prefix as string) || '',
    uploadTargetMode: (row.upload_target_mode as UploadTargetMode) || 'aliyun',
    destinations:
      destinations ?? getTaskDestinationRepo().listByTask(row.id as string),
    dayFolderId: (row.day_folder_id as string) || null,
    uploadRelativePath: (row.upload_relative_path as string | null | undefined) ?? (row.folder_name as string),
    errorMessage: (row.error_message as string) || null,
    sourceType: row.source_type as SourceType,
    sourceMachineId: (row.source_machine_id as string) || null,
    profileId: (row.profile_id as string) || null,
    profileName: (row.profile_name as string) || null,
    profileSnapshot,
    groupVariables: safeParseVariables(row.group_variables_json),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string) || null
  }
}

function safeParseProfile(value: string): UploadProfile | null {
  try {
    return JSON.parse(value) as UploadProfile
  } catch {
    return null
  }
}

function safeParseVariables(value: unknown): PathVariables {
  if (typeof value !== 'string' || !value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, item]) => [key, String(item)])
    )
  } catch {
    return {}
  }
}

function markDayFolderContentActivity(dayFolderId: string | null | undefined, occurredAt: string): void {
  if (!dayFolderId) return
  getDb().prepare(
    `UPDATE day_folders
     SET last_content_activity_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(occurredAt, occurredAt, dayFolderId)
}

const UPLOAD_QUEUE_CANDIDATE_STATUSES: TaskStatus[] = [
  'pending',
  'scanning',
  'uploading',
  'retrying',
  'failed',
  'paused'
]

function rowToTaskFile(row: Record<string, unknown>): TaskFile {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    relativePath: row.relative_path as string,
    fileSize: row.file_size as number,
    status: row.status as TaskFile['status'],
    ossKey: (row.oss_key as string) || null,
    uploadId: (row.upload_id as string) || null,
    errorMessage: (row.error_message as string) || null,
    mtimeMs: Number(row.mtime_ms || 0),
    lastSeenAt: (row.last_seen_at as string) || null,
    sourceStatus: (row.source_status as TaskFile['sourceStatus']) || 'present',
    stableCount: Number(row.stable_count || 0),
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: (row.next_retry_at as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export interface TaskFileSummary {
  totalFiles: number
  totalBytes: number
  completedFiles: number
  completedBytes: number
  failedFiles: number
  skippedFiles: number
}

interface ReconcileFilesOptions {
  replacePlannedObjectKeys?: boolean
}

interface ReconcileScannedFile {
  relativePath: string
  size: number
  mtimeMs: number
  plannedObjectKey?: string
}

interface ReconcileFilesResult {
  changed: boolean
  readyFiles: number
  unstableFiles: number
  failedFiles: number
  skippedFiles: number
}

export class TaskRepo {
  private rowsToTasks(rows: Record<string, unknown>[]): Task[] {
    const destinationsByTask = getTaskDestinationRepo().listByTaskIds(
      rows.map((row) => row.id as string)
    )
    return rows.map((row) =>
      rowToTask(row, destinationsByTask.get(row.id as string) || [])
    )
  }

  listByStatus(status?: TaskStatus): Task[] {
    return this.listByQuery(status ? { status } : undefined)
  }

  listByQuery(query?: TaskListQuery): Task[] {
    const db = getDb()
    if (query?.statuses?.length) {
      const statuses = Array.from(new Set(query.statuses))
      const placeholders = statuses.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT * FROM tasks
           WHERE status IN (${placeholders})
           ORDER BY created_at DESC`
        )
        .all(...statuses) as Record<string, unknown>[]
      return this.rowsToTasks(rows)
    }
    if (query?.status) {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC')
        .all(query.status) as Record<string, unknown>[]
      return this.rowsToTasks(rows)
    }
    const rows = db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }

  listContinuouslyMonitored(groupKey?: string): Task[] {
    const params: unknown[] = []
	    const groupCondition = groupKey
	      ? 'AND COALESCE(df.group_key, df.date_value) = ?'
	      : ''
    if (groupKey) params.push(groupKey)
    const rows = getDb().prepare(
      `SELECT t.*
       FROM tasks t
       INNER JOIN day_folders df ON df.id = t.day_folder_id
       WHERE t.source_type = 'local'
         AND t.day_folder_id IS NOT NULL
         ${groupCondition}
         AND t.status NOT IN ('skipped', 'paused', 'completed')
       ORDER BY t.created_at ASC`
    ).all(...params) as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }

  listContinuouslyMonitoredTaskIds(groupKey?: string): string[] {
    const params: unknown[] = []
	    const groupCondition = groupKey
	      ? 'AND COALESCE(df.group_key, df.date_value) = ?'
	      : ''
    if (groupKey) params.push(groupKey)
    const rows = getDb().prepare(
      `SELECT t.id
       FROM tasks t
       INNER JOIN day_folders df ON df.id = t.day_folder_id
       WHERE t.source_type = 'local'
         AND t.day_folder_id IS NOT NULL
         ${groupCondition}
         AND t.status NOT IN ('skipped', 'paused', 'completed')
       ORDER BY t.created_at ASC`
    ).all(...params) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  listRunnable(now = new Date().toISOString(), limit?: number): Task[] {
    const params: unknown[] = [now]
    const boundedLimit =
      typeof limit === 'number' && limit > 0 ? Math.floor(limit) : null
    const limitClause = boundedLimit ? 'LIMIT ?' : ''
    if (boundedLimit) params.push(boundedLimit)
    const rows = getDb().prepare(
      `SELECT DISTINCT t.*
       FROM tasks t
       INNER JOIN task_files tf ON tf.task_id = t.id
       INNER JOIN task_file_destinations tfd ON tfd.task_file_id = tf.id
       WHERE t.status IN ('pending', 'retrying')
         AND tf.source_status = 'present'
         AND tf.stable_count >= CASE WHEN t.source_type = 'local' THEN 2 ELSE 1 END
         AND (tf.next_retry_at IS NULL OR tf.next_retry_at <= ?)
         AND tfd.status = 'pending'
       ORDER BY t.created_at ASC
       ${limitClause}`
    ).all(...params) as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }

  getById(id: string): Task | null {
    const db = getDb()
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToTask(row) : null
  }

  getByFolderPath(folderPath: string): Task | null {
    const db = getDb()
    const normalized = normalizeFolderPath(folderPath)
    const row = db.prepare('SELECT * FROM tasks WHERE folder_path = ? ORDER BY created_at DESC LIMIT 1').get(normalized) as Record<string, unknown> | undefined
    return row ? rowToTask(row) : null
  }

  /**
   * Find the task whose folderPath is a parent directory of the given file path.
   * Returns the most specific match (longest folderPath).
   */
  findTaskContainingFile(filePath: string): Task | null {
    const db = getDb()
    const normalized = normalize(filePath)
    const rows = db
      .prepare('SELECT * FROM tasks ORDER BY length(folder_path) DESC')
      .all() as Record<string, unknown>[]
    const tasks = this.rowsToTasks(rows)
    return tasks.find((t) => {
      const fp = t.folderPath
      return normalized.startsWith(fp + '/') || normalized.startsWith(fp + '\\')
    }) || null
  }

  create(params: {
    folderPath: string
    folderName: string
    ossPrefix?: string
    uploadTargetMode?: UploadTargetMode
    destinationPrefixes?: Partial<Record<CloudProvider, string>>
    destinationUploadRelativePaths?: Partial<Record<CloudProvider, string>>
    destinationPathModes?: Partial<Record<CloudProvider, UploadPathMode>>
    destinationObjectKeyTemplates?: Partial<Record<CloudProvider, string | null>>
    dayFolderId?: string
    uploadRelativePath?: string
    sourceType?: SourceType
    sourceMachineId?: string
    profileId?: string | null
    profileName?: string | null
    profileSnapshot?: UploadProfile | null
    groupVariables?: PathVariables
  }): Task {
    const db = getDb()
    const id = uuid()
    const now = new Date().toISOString()
    const normalizedPath = normalizeFolderPath(params.folderPath)
    const uploadTargetMode = params.uploadTargetMode || 'aliyun'
    const uploadRelativePath = params.uploadRelativePath ?? params.folderName
    const destinationUploadRelativePaths =
      params.destinationUploadRelativePaths ||
      Object.fromEntries(
        providersForMode(uploadTargetMode).map((provider) => [
          provider,
          uploadRelativePath
        ])
      )
    db.prepare(
      `INSERT INTO tasks (
        id, folder_path, folder_name, status, oss_prefix, upload_target_mode,
        day_folder_id, upload_relative_path, source_type, source_machine_id,
        profile_id, profile_name, profile_snapshot_json, group_variables_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      normalizedPath,
      params.folderName,
      params.ossPrefix || '',
      uploadTargetMode,
      params.dayFolderId || null,
      uploadRelativePath,
      params.sourceType || 'local',
      params.sourceMachineId || null,
      params.profileId || null,
      params.profileName || null,
      params.profileSnapshot ? JSON.stringify(params.profileSnapshot) : null,
      JSON.stringify(params.groupVariables || {}),
      now,
      now
    )
    getTaskDestinationRepo().ensureForTask(
      id,
      uploadTargetMode,
      params.destinationPrefixes || { aliyun: params.ossPrefix || '' },
      'pending',
      destinationUploadRelativePaths,
      params.destinationPathModes,
      params.destinationObjectKeyTemplates
    )
    markDayFolderContentActivity(params.dayFolderId, now)
    return this.getById(id)!
  }

  updateDayFolderId(id: string, dayFolderId: string): void {
    const now = new Date().toISOString()
    getDb().prepare(
      `UPDATE tasks
       SET day_folder_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(dayFolderId, now, id)
    markDayFolderContentActivity(dayFolderId, now)
  }

  updateDayFolderMetadata(id: string, dayFolderId: string, uploadRelativePath: string): void {
    const now = new Date().toISOString()
    getDb().prepare(
      `UPDATE tasks
       SET day_folder_id = ?, upload_relative_path = ?, updated_at = ?
       WHERE id = ?`
    ).run(dayFolderId, uploadRelativePath, now, id)
    markDayFolderContentActivity(dayFolderId, now)
  }

  updateGroupVariables(id: string, variables: PathVariables): void {
    getDb().prepare(
      `UPDATE tasks
       SET group_variables_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(variables), new Date().toISOString(), id)
  }

  updateUploadRelativePath(id: string, uploadRelativePath: string): void {
    getDb().prepare(
      `UPDATE tasks
       SET upload_relative_path = ?, updated_at = ?
       WHERE id = ?`
    ).run(uploadRelativePath, new Date().toISOString(), id)
  }

  listByDayFolder(dayFolderId: string): Task[] {
    const rows = getDb().prepare(
      'SELECT * FROM tasks WHERE day_folder_id = ? ORDER BY created_at DESC'
    ).all(dayFolderId) as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }

  updateStatus(id: string, status: TaskStatus, errorMessage?: string): void {
    const db = getDb()
    const now = new Date().toISOString()
    const completedAt =
      status === 'completed' ||
      status === 'failed' ||
      status === 'skipped'
        ? now
        : null
    db.prepare(
      'UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?'
    ).run(status, errorMessage || null, now, completedAt, id)
  }

  retry(id: string, provider?: CloudProvider): void {
    getTaskDestinationRepo().resetFailed(id, provider)
    getDb().prepare(
      `UPDATE task_files
       SET retry_count = 0, next_retry_at = NULL, error_message = NULL,
           status = CASE
             WHEN source_status = 'present' AND status != 'completed' THEN 'pending'
             ELSE status
           END,
           updated_at = ?
       WHERE task_id = ?`
    ).run(new Date().toISOString(), id)
    this.updateStatus(id, 'pending')
  }

  resumeForUpload(id: string): void {
    const task = this.getById(id)
    if (!task) return
    if (
      task.status === 'failed' ||
      task.status === 'paused' ||
      task.status === 'retrying'
    ) {
      this.retry(id)
    }
  }

  resumeManyForUpload(ids: string[]): void {
    for (const id of Array.from(new Set(ids))) {
      this.resumeForUpload(id)
    }
  }

  skip(id: string, reason = '用户跳过'): void {
    const db = getDb()
    const now = new Date().toISOString()
    const transaction = db.transaction(() => {
      db.prepare(
        `UPDATE tasks
         SET status = 'skipped', error_message = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(reason, now, now, id)
      db.prepare(
        `UPDATE task_destinations
         SET status = CASE WHEN status IN ('completed', 'synced') THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status IN ('completed', 'synced') THEN error_message ELSE ? END,
             completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE task_id = ?`
      ).run(reason, now, now, id)
      db.prepare(
        `UPDATE task_file_destinations
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE ? END,
             updated_at = ?
         WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)`
      ).run(reason, now, id)
      db.prepare(
        `UPDATE task_files
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE ? END,
             next_retry_at = NULL, updated_at = ?
         WHERE task_id = ?`
      ).run(reason, now, id)
    })
    transaction()
  }

  restore(id: string): void {
    const db = getDb()
    const now = new Date().toISOString()
    const transaction = db.transaction(() => {
      db.prepare(
        `UPDATE tasks
         SET status = 'scanning', error_message = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(now, id)
      db.prepare(
        `UPDATE task_destinations
         SET status = CASE WHEN status = 'skipped' THEN 'pending' ELSE status END,
             error_message = NULL,
             completed_at = CASE WHEN status = 'skipped' THEN NULL ELSE completed_at END,
             updated_at = ?
         WHERE task_id = ?`
      ).run(now, id)
      db.prepare(
        `UPDATE task_file_destinations
         SET status = CASE
               WHEN status = 'skipped'
                AND task_file_id IN (
                  SELECT id FROM task_files
                  WHERE task_id = ? AND source_status = 'present'
                )
               THEN 'pending'
               ELSE status
             END,
             error_message = NULL, updated_at = ?
         WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)`
      ).run(id, now, id)
      db.prepare(
        `UPDATE task_files
         SET status = CASE
               WHEN status = 'skipped' AND source_status = 'present' THEN 'pending'
               ELSE status
             END,
             retry_count = 0, next_retry_at = NULL, error_message = NULL,
             updated_at = ?
         WHERE task_id = ?`
      ).run(now, id)
    })
    transaction()
  }

  updateProgress(id: string, uploadedFiles: number, uploadedBytes: number): void {
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE tasks SET uploaded_files = ?, uploaded_bytes = ?, updated_at = ? WHERE id = ?'
    ).run(uploadedFiles, uploadedBytes, now, id)
  }

  setTotals(id: string, totalFiles: number, totalBytes: number): void {
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE tasks SET total_files = ?, total_bytes = ?, updated_at = ? WHERE id = ?'
    ).run(totalFiles, totalBytes, now, id)
  }

  // ---- task_files ----
  createFile(
    taskId: string,
    relativePath: string,
    fileSize: number,
    mtimeMs = 0
  ): TaskFile {
    const db = getDb()
    const id = uuid()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO task_files (
        id, task_id, relative_path, file_size, status, mtime_ms,
        last_seen_at, source_status, stable_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 'present', 1, ?, ?)`
    ).run(id, taskId, relativePath, fileSize, mtimeMs, now, now, now)
    this.markTaskContentActivity(taskId, now)
    return rowToTaskFile(db.prepare('SELECT * FROM task_files WHERE id = ?').get(id) as Record<string, unknown>)
  }

  bulkCreateFiles(
    taskId: string,
    files: Array<{ relativePath: string; fileSize: number; mtimeMs?: number }>
  ): void {
    const db = getDb()
    const now = new Date().toISOString()
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO task_files (
        id, task_id, relative_path, file_size, status, mtime_ms,
        last_seen_at, source_status, stable_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 'present', 1, ?, ?)`
    )
    let insertedRows = 0
    const transaction = db.transaction(() => {
      for (const f of files) {
        insertedRows += stmt.run(
          uuid(),
          taskId,
          f.relativePath,
          f.fileSize,
          f.mtimeMs || 0,
          now,
          now,
          now
        ).changes
      }
    })
    transaction()
    if (insertedRows > 0) this.markTaskContentActivity(taskId, now)
  }

  listFiles(taskId: string, status?: string): TaskFile[] {
    const db = getDb()
    if (status) {
      return (db.prepare('SELECT * FROM task_files WHERE task_id = ? AND status = ?').all(taskId, status) as Record<string, unknown>[]).map(rowToTaskFile)
    }
    return (db.prepare('SELECT * FROM task_files WHERE task_id = ?').all(taskId) as Record<string, unknown>[]).map(rowToTaskFile)
  }

  summarizeFiles(taskId: string): TaskFileSummary {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(file_size), 0) AS total_bytes,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_files,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END), 0) AS completed_bytes,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_files
       FROM task_files
       WHERE task_id = ?`
    ).get(taskId) as Record<string, number>
    return {
      totalFiles: row.total_files || 0,
      totalBytes: row.total_bytes || 0,
      completedFiles: row.completed_files || 0,
      completedBytes: row.completed_bytes || 0,
      failedFiles: row.failed_files || 0,
      skippedFiles: row.skipped_files || 0
    }
  }

  listFileDetails(taskId: string): TaskFileDetail[] {
    const files = this.listFiles(taskId)
    const destinations = getTaskDestinationRepo().listFileTargets(taskId)
    const destinationsByFile = new Map<string, typeof destinations>()
    for (const destination of destinations) {
      const list = destinationsByFile.get(destination.taskFileId) || []
      list.push(destination)
      destinationsByFile.set(destination.taskFileId, list)
    }
    return files.map((file) => ({
      ...file,
      destinations: (destinationsByFile.get(file.id) || [])
        .map(({ taskId: _taskId, relativePath: _path, fileSize: _size, ...destination }) => destination)
    }))
  }

  reconcileFiles(
    taskId: string,
    files: ReconcileScannedFile[],
    requiredStableChecks: number,
    options: ReconcileFilesOptions = {}
  ): ReconcileFilesResult {
    const db = getDb()
    const task = this.getById(taskId)
    if (!task || task.status === 'skipped' || task.status === 'paused') {
      return this.emptyReconcileResult()
    }

    const now = new Date().toISOString()
    const tempTable = this.createReconcileTempTable()
    const quotedTempTable = this.quoteIdentifier(tempTable)
    let hasPlannedObjectKeys = false
    let changed = false

    try {
      this.insertReconcileBatch(quotedTempTable, files, (hasPlannedObjectKey) => {
        hasPlannedObjectKeys = hasPlannedObjectKeys || hasPlannedObjectKey
      })
      changed = this.applyReconcileTempChanges(
        taskId,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks)
      )
    } catch (error) {
      db.prepare(`DROP TABLE IF EXISTS ${quotedTempTable}`).run()
      throw error
    }

    try {
      const result = this.completeReconcileFromTempTable(
        task,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks),
        changed,
        options.replacePlannedObjectKeys ?? hasPlannedObjectKeys
      )
      if (result.changed) markDayFolderContentActivity(task.dayFolderId, now)
      return result
    } finally {
      db.prepare(`DROP TABLE IF EXISTS ${quotedTempTable}`).run()
    }
  }

  async reconcileFileBatches(
    taskId: string,
    fileBatches: Iterable<ReconcileScannedFile[]> | AsyncIterable<ReconcileScannedFile[]>,
    requiredStableChecks: number,
    options: ReconcileFilesOptions = {}
  ): Promise<ReconcileFilesResult> {
    const db = getDb()
    const task = this.getById(taskId)
    if (!task || task.status === 'skipped' || task.status === 'paused') {
      return this.emptyReconcileResult()
    }

    const now = new Date().toISOString()
    const tempTable = this.createReconcileTempTable()
    const quotedTempTable = this.quoteIdentifier(tempTable)
    let hasPlannedObjectKeys = false
    let changed = false

    try {
      for await (const batch of fileBatches) {
        this.insertReconcileBatch(quotedTempTable, batch, (hasPlannedObjectKey) => {
          hasPlannedObjectKeys = hasPlannedObjectKeys || hasPlannedObjectKey
        })
      }
      changed = this.applyReconcileTempChanges(
        taskId,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks)
      )
      const result = this.completeReconcileFromTempTable(
        task,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks),
        changed,
        options.replacePlannedObjectKeys ?? hasPlannedObjectKeys
      )
      if (result.changed) markDayFolderContentActivity(task.dayFolderId, now)
      return result
    } finally {
      db.prepare(`DROP TABLE IF EXISTS ${quotedTempTable}`).run()
    }
  }

  private insertReconcileBatch(
    quotedTempTable: string,
    files: ReconcileScannedFile[],
    onPlannedObjectKeyPresence: (present: boolean) => void
  ): void {
    const insert = getDb().prepare(
      `INSERT OR REPLACE INTO ${quotedTempTable} (
        relative_path, file_size, mtime_ms, planned_object_key
      ) VALUES (?, ?, ?, ?)`
    )
    let hasPlannedObjectKey = false
    const transaction = getDb().transaction(() => {
      for (const file of files) {
        if (Object.prototype.hasOwnProperty.call(file, 'plannedObjectKey')) {
          hasPlannedObjectKey = true
        }
        insert.run(
          file.relativePath,
          file.size,
          file.mtimeMs,
          file.plannedObjectKey || null
        )
      }
    })
    transaction()
    onPlannedObjectKeyPresence(hasPlannedObjectKey)
  }

  private applyReconcileTempChanges(
    taskId: string,
    quotedTempTable: string,
    now: string,
    requiredStableChecks: number
  ): boolean {
    const db = getDb()
    let changed = false
    const transaction = db.transaction(() => {
      db.prepare(
        `UPDATE task_file_destinations
         SET status = 'pending', object_key = NULL, upload_id = NULL,
             error_message = NULL, updated_at = ?
         WHERE status != 'uploading'
           AND task_file_id IN (
             SELECT tf.id
             FROM task_files tf
             INNER JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.task_id = ?
               AND (
                 tf.file_size != scanned.file_size
                 OR tf.mtime_ms != scanned.mtime_ms
                 OR tf.source_status = 'missing'
               )
           )`
      ).run(now, taskId)

      db.prepare(
        `UPDATE task_files
         SET last_seen_at = ?,
             source_status = 'present',
             stable_count = MIN(stable_count + 1, ?),
             updated_at = ?
         WHERE task_id = ?
           AND source_status = 'present'
           AND stable_count < ?
           AND EXISTS (
             SELECT 1
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
               AND task_files.file_size = scanned.file_size
               AND task_files.mtime_ms = scanned.mtime_ms
           )`
      ).run(now, requiredStableChecks, now, taskId, requiredStableChecks)

      const changedRows = db.prepare(
        `UPDATE task_files
         SET file_size = (
             SELECT scanned.file_size
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
           ),
           mtime_ms = (
             SELECT scanned.mtime_ms
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
           ),
           last_seen_at = ?,
           source_status = 'present',
           stable_count = 1,
           status = 'pending',
           error_message = NULL,
           retry_count = 0,
           next_retry_at = NULL,
           updated_at = ?
         WHERE task_id = ?
           AND EXISTS (
             SELECT 1
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
               AND (
                 task_files.file_size != scanned.file_size
                 OR task_files.mtime_ms != scanned.mtime_ms
                 OR task_files.source_status = 'missing'
               )
           )`
      ).run(now, now, taskId).changes

      const insertedRows = db.prepare(
        `INSERT INTO task_files (
          id, task_id, relative_path, file_size, status, mtime_ms,
          last_seen_at, source_status, stable_count, created_at, updated_at
        )
        SELECT lower(hex(randomblob(16))), ?, scanned.relative_path,
          scanned.file_size, 'pending', scanned.mtime_ms, ?, 'present',
          1, ?, ?
        FROM ${quotedTempTable} scanned
        LEFT JOIN task_files existing
          ON existing.task_id = ?
         AND existing.relative_path = scanned.relative_path
        WHERE existing.id IS NULL`
      ).run(taskId, now, now, now, taskId).changes

      db.prepare(
        `UPDATE task_file_destinations
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE '源文件已删除' END,
             updated_at = ?
         WHERE status != 'uploading'
           AND task_file_id IN (
             SELECT tf.id
             FROM task_files tf
             LEFT JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.task_id = ?
               AND tf.source_status != 'missing'
               AND scanned.relative_path IS NULL
           )`
      ).run(now, taskId)

      const missingRows = db.prepare(
        `UPDATE task_files
         SET source_status = 'missing',
             status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE '源文件已删除' END,
             next_retry_at = NULL,
             updated_at = ?
         WHERE task_id = ?
           AND source_status != 'missing'
           AND NOT EXISTS (
             SELECT 1
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
           )`
      ).run(now, taskId).changes

      changed = changedRows > 0 || insertedRows > 0 || missingRows > 0
    })
    transaction()
    return changed
  }

  private completeReconcileFromTempTable(
    task: Task,
    quotedTempTable: string,
    now: string,
    requiredStableChecks: number,
    changed: boolean,
    shouldReplacePlannedObjectKeys: boolean
  ): ReconcileFilesResult {
    const db = getDb()
    const taskId = task.id
    const destinationRepo = getTaskDestinationRepo()

    destinationRepo.ensureForTaskFiles(taskId)
    if (shouldReplacePlannedObjectKeys) {
      this.replacePlannedObjectKeysFromTempTable(taskId, quotedTempTable, now)
    }

    const counts = db.prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(file_size), 0) AS total_bytes,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS uploaded_files,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END), 0) AS uploaded_bytes,
         SUM(CASE
           WHEN source_status = 'present'
            AND stable_count >= ?
            AND status IN ('pending', 'failed')
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
           THEN 1 ELSE 0 END) AS ready_files,
         SUM(CASE
           WHEN source_status = 'present' AND stable_count < ?
           THEN 1 ELSE 0 END) AS unstable_files,
         SUM(CASE
           WHEN source_status = 'present'
            AND status = 'pending'
            AND next_retry_at IS NOT NULL
            AND next_retry_at > ?
           THEN 1 ELSE 0 END) AS retry_waiting_files,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_files
       FROM task_files
       WHERE task_id = ?`
    ).get(
      requiredStableChecks,
      now,
      requiredStableChecks,
      now,
      taskId
    ) as Record<string, number>

    db.prepare(
      `UPDATE tasks
       SET total_files = ?, total_bytes = ?, uploaded_files = ?, uploaded_bytes = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      counts.total_files || 0,
      counts.total_bytes || 0,
      counts.uploaded_files || 0,
      counts.uploaded_bytes || 0,
      now,
      taskId
    )
    for (const destination of destinationRepo.listByTask(taskId)) {
      destinationRepo.recalculateProgress(taskId, destination.provider)
      const summary = destinationRepo.summarizeFileTargets(
        taskId,
        destination.provider,
        now
      )
      if (summary.failed > 0) {
        destinationRepo.updateStatus(
          taskId,
          destination.provider,
          'failed',
          '存在需要处理的上传失败文件'
        )
      } else if (summary.pending > 0) {
        destinationRepo.updateStatus(
          taskId,
          destination.provider,
          summary.retryWaiting > 0 ? 'retrying' : 'pending'
        )
      } else if (summary.total > 0) {
        destinationRepo.updateStatus(
          taskId,
          destination.provider,
          task.sourceType === 'local' && task.dayFolderId
            ? 'synced'
            : 'completed'
        )
      }
    }

    const latest = this.getById(taskId)
    if (latest && latest.status !== 'uploading') {
      if ((counts.failed_files || 0) > 0) {
        this.updateStatus(taskId, 'failed', '存在需要处理的上传失败文件')
      } else if ((counts.ready_files || 0) > 0) {
        this.updateStatus(taskId, 'pending')
      } else if ((counts.retry_waiting_files || 0) > 0) {
        this.updateStatus(taskId, 'retrying')
      } else if ((counts.unstable_files || 0) > 0) {
        this.updateStatus(taskId, 'scanning')
      } else {
        this.updateStatus(
          taskId,
          task.sourceType === 'local' && task.dayFolderId ? 'synced' : 'completed'
        )
      }
    }

    return {
      changed,
      readyFiles: counts.ready_files || 0,
      unstableFiles: counts.unstable_files || 0,
      failedFiles: counts.failed_files || 0,
      skippedFiles: counts.skipped_files || 0
    }
  }

  private createReconcileTempTable(): string {
    const name = `tmp_reconcile_files_${uuid().replace(/-/g, '')}`
    getDb().exec(`
      CREATE TEMP TABLE ${this.quoteIdentifier(name)} (
        relative_path TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        planned_object_key TEXT
      )
    `)
    return name
  }

  private replacePlannedObjectKeysFromTempTable(
    taskId: string,
    quotedTempTable: string,
    now: string
  ): void {
    const db = getDb()
    const transaction = db.transaction(() => {
      db.prepare(
        `UPDATE task_file_destinations
         SET planned_object_key = NULL, updated_at = ?
         WHERE planned_object_key IS NOT NULL
           AND id IN (
             SELECT tfd.id
             FROM task_file_destinations tfd
             INNER JOIN task_files tf ON tf.id = tfd.task_file_id
             LEFT JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
              AND scanned.planned_object_key IS NOT NULL
             WHERE tf.task_id = ?
               AND scanned.relative_path IS NULL
           )`
      ).run(now, taskId)

      db.prepare(
        `UPDATE task_file_destinations
         SET planned_object_key = (
             SELECT scanned.planned_object_key
             FROM task_files tf
             INNER JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.id = task_file_destinations.task_file_id
               AND scanned.planned_object_key IS NOT NULL
           ),
           updated_at = ?
         WHERE task_file_id IN (
           SELECT tf.id
           FROM task_files tf
           INNER JOIN ${quotedTempTable} scanned
             ON scanned.relative_path = tf.relative_path
           WHERE tf.task_id = ?
             AND scanned.planned_object_key IS NOT NULL
         )
         AND (
           planned_object_key IS NULL
           OR planned_object_key != (
             SELECT scanned.planned_object_key
             FROM task_files tf
             INNER JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.id = task_file_destinations.task_file_id
               AND scanned.planned_object_key IS NOT NULL
           )
         )`
      ).run(now, taskId)
    })
    transaction()
  }

  private emptyReconcileResult(): ReconcileFilesResult {
    return {
      changed: false,
      readyFiles: 0,
      unstableFiles: 0,
      failedFiles: 0,
      skippedFiles: 0
    }
  }

  private quoteIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid SQL identifier: ${identifier}`)
    }
    return `"${identifier}"`
  }

  private markTaskContentActivity(taskId: string, occurredAt: string): void {
    const row = getDb().prepare(
      `SELECT day_folder_id
       FROM tasks
       WHERE id = ?`
    ).get(taskId) as { day_folder_id: string | null } | undefined
    markDayFolderContentActivity(row?.day_folder_id, occurredAt)
  }

  markFileChanged(
    fileId: string,
    fileSize: number,
    mtimeMs: number
  ): void {
    const db = getDb()
    const now = new Date().toISOString()
    const row = db.prepare(
      `SELECT t.day_folder_id
       FROM task_files tf
       INNER JOIN tasks t ON t.id = tf.task_id
       WHERE tf.id = ?`
    ).get(fileId) as { day_folder_id: string | null } | undefined
    const transaction = db.transaction(() => {
      db.prepare(
        `UPDATE task_files
         SET file_size = ?, mtime_ms = ?, stable_count = 1,
             status = 'pending', source_status = 'present',
             error_message = NULL, retry_count = 0, next_retry_at = NULL,
             last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(fileSize, mtimeMs, now, now, fileId)
      db.prepare(
        `UPDATE task_file_destinations
         SET status = 'pending', object_key = NULL, upload_id = NULL,
             error_message = NULL, updated_at = ?
         WHERE task_file_id = ?`
      ).run(now, fileId)
    })
    transaction()
    markDayFolderContentActivity(row?.day_folder_id, now)
  }

  scheduleRetry(fileId: string, errorMessage: string, nextRetryAt: string): number {
    const now = new Date().toISOString()
    getDb().prepare(
      `UPDATE task_files
       SET status = 'pending', retry_count = retry_count + 1,
           next_retry_at = ?, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextRetryAt, errorMessage, now, fileId)
    const row = getDb().prepare(
      'SELECT retry_count FROM task_files WHERE id = ?'
    ).get(fileId) as { retry_count: number }
    return row.retry_count
  }

  clearRetry(fileId: string): void {
    getDb().prepare(
      `UPDATE task_files
       SET retry_count = 0, next_retry_at = NULL, error_message = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), fileId)
  }

  recalculateProgress(taskId: string): void {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(file_size), 0) AS total_bytes,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS uploaded_files,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END), 0) AS uploaded_bytes
       FROM task_files
       WHERE task_id = ?`
    ).get(taskId) as Record<string, number>
    getDb().prepare(
      `UPDATE tasks
       SET total_files = ?, total_bytes = ?, uploaded_files = ?,
           uploaded_bytes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      row.total_files || 0,
      row.total_bytes || 0,
      row.uploaded_files || 0,
      row.uploaded_bytes || 0,
      new Date().toISOString(),
      taskId
    )
  }

  updateFileStatus(fileId: string, status: string, ossKey?: string, uploadId?: string, errorMessage?: string): void {
    const db = getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE task_files SET status = ?, oss_key = COALESCE(?, oss_key), upload_id = COALESCE(?, upload_id), error_message = ?, updated_at = ? WHERE id = ?'
    ).run(status, ossKey || null, uploadId || null, errorMessage || null, now, fileId)
  }

  getUnfinishedTasks(): Task[] {
    const db = getDb()
    const rows = db.prepare(
      `SELECT * FROM tasks
       WHERE status IN ('pending', 'uploading', 'scanning', 'retrying', 'failed', 'paused')
       ORDER BY created_at ASC`
    ).all() as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }

  listPendingUploadTaskIds(): string[] {
    const placeholders = UPLOAD_QUEUE_CANDIDATE_STATUSES.map(() => '?').join(',')
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE status IN (${placeholders})
       ORDER BY created_at ASC`
    ).all(...UPLOAD_QUEUE_CANDIDATE_STATUSES) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  listPendingUploadTaskIdsByDayFolderIds(dayFolderIds: string[]): string[] {
    const uniqueIds = Array.from(new Set(dayFolderIds)).filter(Boolean)
    if (uniqueIds.length === 0) return []
    const folderPlaceholders = uniqueIds.map(() => '?').join(',')
    const statusPlaceholders = UPLOAD_QUEUE_CANDIDATE_STATUSES.map(() => '?').join(',')
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE day_folder_id IN (${folderPlaceholders})
         AND status IN (${statusPlaceholders})
       ORDER BY created_at ASC`
    ).all(...uniqueIds, ...UPLOAD_QUEUE_CANDIDATE_STATUSES) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  listMonitorableLocalUnfinishedTasks(): Task[] {
    const rows = getDb().prepare(
      `SELECT * FROM tasks
       WHERE source_type = 'local'
         AND day_folder_id IS NOT NULL
         AND status NOT IN ('completed', 'synced', 'skipped')
       ORDER BY created_at ASC`
    ).all() as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }

  listUnfinishedTaskIds(): string[] {
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE status IN ('pending', 'uploading', 'scanning', 'retrying', 'failed', 'paused')
       ORDER BY created_at ASC`
    ).all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  getCompletedForCleanup(retentionDays: number): Task[] {
    const db = getDb()
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
    const rows = db.prepare(
      `SELECT * FROM tasks
       WHERE status = 'completed'
         AND (source_type = 'rsync' OR (source_type = 'local' AND day_folder_id IS NULL))
         AND completed_at IS NOT NULL AND completed_at < ?
       ORDER BY completed_at ASC`
    ).all(cutoff) as Record<string, unknown>[]
    return this.rowsToTasks(rows)
  }
}

let instance: TaskRepo | null = null
export function getTaskRepo(): TaskRepo {
  if (!instance) instance = new TaskRepo()
  return instance
}
